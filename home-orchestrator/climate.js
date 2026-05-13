// Smart climate controller for LG ThinQ portable ACs.
// Phase 2: setpoint writes + manual-override detection + pause/resume.
// Phase 3: priority-ladder fan control with hysteresis + cross-room ramp.

const https = require('https');
const crypto = require('crypto');

const COUNTRY_TO_REGION = {
  AG:'aic', AR:'aic', AW:'aic', BB:'aic', BO:'aic', BR:'aic', BS:'aic', BZ:'aic',
  CA:'aic', CL:'aic', CO:'aic', CR:'aic', CU:'aic', DM:'aic', DO:'aic', EC:'aic',
  GD:'aic', GT:'aic', GY:'aic', HN:'aic', HT:'aic', JM:'aic', KN:'aic', LC:'aic',
  MX:'aic', NI:'aic', PA:'aic', PE:'aic', PR:'aic', PY:'aic', SR:'aic', SV:'aic',
  TT:'aic', US:'aic', UY:'aic', VC:'aic', VE:'aic',
};
const API_KEY = 'v6GFvkweNo7DK7yD3ylIZ9w52aKBU0eJ7wLXkSR3';
const WIND_MAP = { low: 'LOW', mid: 'MID', medium: 'MID', high: 'HIGH' };
const WIND_RANK = { LOW: 1, MID: 2, HIGH: 3 };
const RANK_TO_WIND = { 1: 'LOW', 2: 'MID', 3: 'HIGH' };
const DEFAULT_OVERRIDE_COOLDOWN_MS = 30 * 60 * 1000;
const SETPOINT_TOLERANCE_C = 0.6;
// Pressure thresholds in F. Engaging rung N requires pressure to cross thresholds[N-1].
// Hysteresis: stepping down requires pressure to drop HYSTERESIS_F below the threshold that engaged it.
// Quieter-by-default: previous values were 0.5/1.5/2.5/3.5 (too eager -- ramped fans on tiny
// overshoots). Now small overshoots stay at baseline LOW and ramping only kicks in when the
// apartment is actually uncomfortable.
const RUNG_THRESHOLDS_F = [1.5, 2.5, 3.5, 4.5];
const HYSTERESIS_F = 0.5;
// Mode-switch deadband. We initially removed auto-switching but reinstated it after
// observing that LG units sometimes keep the compressor running against stale internal
// sensor readings even when room is well below target. Forcing FAN mode is a hard
// guarantee that the compressor cannot run. Deadband + dwell prevent flapping.
//   - Switch COOL -> FAN when room drops MODE_DEADBAND_F below target
//   - Switch FAN -> COOL when room rises MODE_DEADBAND_F above target
// Widened from 1.0F/5min to 2.0F/10min after observing 5-6 min COOL<->FAN cycles
// overnight: the room walked the 2F band in ~5 min, so dwell never braked anything.
const MODE_DEADBAND_F = 2.0;
const MODE_DWELL_MS = 10 * 60 * 1000;  // min time between mode writes per slot

// Predicate: does this LG error string indicate the per-account API rate limit
// was hit? LG's live API returns code "1314" with message "Exceeded User API
// calls" (verified against production journal logs May 4 2026). LG's own
// official SDK error table lists 1306 as EXCEEDED_API_CALLS instead -- their
// docs are out of sync with the running service. Match both codes for
// forward-compat plus the message text as belt-and-suspenders.
function isRateLimitError(errMsg) {
  if (!errMsg) return false;
  return /\b1314\b/.test(errMsg) ||
         /\b1306\b/.test(errMsg) ||
         /Exceeded User API/i.test(errMsg);
}

// Predicate: did LG reject the command because the AC is in a mode that doesn't
// accept it? Code 2305 = COMMAND_NOT_SUPPORTED_IN_MODE per LG's SDK error table.
// Identifying this explicitly lets us answer the long-standing question of whether
// our "setpoint silently ignored in FAN mode" defensive code is actually preventing
// 2305s, or whether 2305s never happen in the first place because the API does
// silently accept-and-discard.
function isModeRejectedError(errMsg) {
  if (!errMsg) return false;
  return /\b2305\b/.test(errMsg) ||
         /COMMAND_NOT_SUPPORTED_IN_MODE/i.test(errMsg);
}

// Predicate: did LG reject the call because our PAT was revoked? Codes 1103
// (INVALID_TOKEN) and 1218 (INVALID_TOKEN_AGAIN) per LG's SDK. If this fires,
// every subsequent call will fail until the PAT is rotated -- we should pause
// the climate loop and log loudly rather than silently retry every 60s.
function isRevokedTokenError(errMsg) {
  if (!errMsg) return false;
  return /\b1103\b/.test(errMsg) ||
         /\b1218\b/.test(errMsg) ||
         /INVALID_TOKEN/i.test(errMsg);
}

// Normalize a /devices/{id}/state response into our internal shape.
// Pure function -- no I/O, no state. Exported for tests.
// LG's ThinQ Connect API exposes both Celsius and Fahrenheit fields on every
// AC payload (verified against thinq-connect/pythinqconnect air_conditioner.py
// profile_map). t.unit is the user's display preference, not the data format.
// Prefer the native unit field when present and use cToF/fToC as a fallback
// for older payloads that might only return one half.
function normalizeDeviceState(raw) {
  const r = raw && (raw.response || raw);
  if (!r) return null;
  const t = r.temperature || {};
  const unit = t.unit || 'C';
  const apiCurrentC = t.currentTemperatureC ?? (unit === 'C' ? t.currentTemperature : null);
  const apiCurrentF = t.currentTemperatureF ?? (unit === 'F' ? t.currentTemperature : null);
  const apiTargetC = t.targetTemperatureC ?? (unit === 'C' ? t.targetTemperature : null);
  const apiTargetF = t.targetTemperatureF ?? (unit === 'F' ? t.targetTemperature : null);
  const currentC = apiCurrentC ?? (apiCurrentF != null ? fToC(apiCurrentF) : null);
  const currentF = apiCurrentF ?? (apiCurrentC != null ? cToF(apiCurrentC) : null);
  const targetC = apiTargetC ?? (apiTargetF != null ? fToC(apiTargetF) : null);
  const targetF = apiTargetF ?? (apiTargetC != null ? cToF(apiTargetC) : null);
  return {
    power: r.operation?.airConOperationMode || null,
    jobMode: r.airConJobMode?.currentJobMode || null,
    windStrength: r.airFlow?.windStrength || null,
    unitNative: unit,
    currentC,
    currentF,
    targetC,
    targetF,
    raw: r,
  };
}

function cToF(c) { return c == null ? null : Math.round((c * 9 / 5 + 32) * 10) / 10; }
function fToC(f) { return f == null ? null : Math.round(((f - 32) * 5 / 9) * 10) / 10; }
function roundC(c) { return Math.round(c * 2) / 2; }

function createClimate({ getConfig, logActivity }) {
  // In-memory state. config.json holds the persistent half (lastWritten, pauseUntil).
  let cache = { fetchedAt: 0, devices: {} };
  let lastTickAt = 0;
  let inFlightTick = null;
  // Per-slot rate-limit backoff: { nextAt: epochMs, currentBackoffMs }.
  // Triggered by HTTP 401 with LG code 1314 ("Exceeded User API calls").
  const rateLimit = {};
  const RL_BASE_MS = 60 * 1000;
  const RL_MAX_MS = 10 * 60 * 1000;
  // Runaway-write circuit breaker. Tracks per-slot write timestamps in a rolling
  // 10-minute window. If a slot crosses RUNAWAY_WRITE_THRESHOLD in that window,
  // engage a global 30-min pause so a bug or stuck state can't burn the LG API
  // quota (or wear the hardware). The breaker self-clears when the pause expires.
  const writeTimestamps = {};
  const RUNAWAY_WINDOW_MS = 10 * 60 * 1000;
  const RUNAWAY_WRITE_THRESHOLD = 30;  // > 3 writes/min sustained = something's wrong
  const RUNAWAY_PAUSE_MS = 30 * 60 * 1000;
  const breakerState = { lastTrippedAt: null, lastTrippedSlot: null, lastTrippedCount: null };
  // Per-slot ring buffer of recent currentF readings, used to smooth pressure
  // calculation. The AC reports temp at 0.5F resolution which causes ladder rungs to
  // flap when room is between two adjacent values. The 3-sample average eliminates this.
  const tempHistory = {};
  const TEMP_HISTORY_LEN = 3;

  function pushTempReading(slot, currentF) {
    if (currentF == null) return;
    if (!tempHistory[slot]) tempHistory[slot] = [];
    tempHistory[slot].push(currentF);
    if (tempHistory[slot].length > TEMP_HISTORY_LEN) tempHistory[slot].shift();
  }

  function smoothedTempF(slot, fallback) {
    const h = tempHistory[slot];
    if (!h || !h.length) return fallback;
    // Median of the buffered samples. Median (not mean) so a single outlier
    // reading from the LG API doesn't propagate -- with mean, one bad sample
    // creates a ~3 min "pressure ghost" that engages ladder rungs and writes
    // fan changes the loop will immediately want to undo.
    const sorted = [...h].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
  }

  function thinq({ pathname, method = 'GET', body = null }) {
    const cfg = getConfig().climate || {};
    const thinqCfg = cfg.thinq || {};
    const pat = thinqCfg.pat;
    const country = thinqCfg.country || 'US';
    const clientId = thinqCfg.clientId;
    if (!pat) return Promise.reject(new Error('climate.thinq.pat missing'));
    if (!clientId) return Promise.reject(new Error('climate.thinq.clientId missing -- run pair-thinq.js'));

    const region = COUNTRY_TO_REGION[country] || 'aic';
    const headers = {
      'Authorization': `Bearer ${pat}`,
      'x-country': country,
      'x-message-id': crypto.randomBytes(16).toString('base64url').slice(0, 22),
      'x-client-id': clientId,
      'x-api-key': API_KEY,
      'x-service-phase': 'OP',
      'Accept': 'application/json',
    };
    if (body) headers['Content-Type'] = 'application/json';
    // LG's official SDK auto-adds this header on control writes (POST). Without it,
    // some control writes may fail state-consistency checks at LG's edge. See
    // thinq-connect/pythinqconnect thinq_api.py async_post.
    if (method === 'POST') headers['x-conditional-control'] = 'true';

    return new Promise((resolve, reject) => {
      const req = https.request({
        host: `api-${region}.lgthinq.com`,
        path: pathname,
        method,
        headers,
        timeout: 8000,
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(data)); }
            catch (e) { reject(new Error(`bad json: ${data.slice(0, 200)}`)); }
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          }
        });
      });
      req.on('timeout', () => { req.destroy(new Error('thinq request timed out')); });
      req.on('error', reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  // normalizeDeviceState lives at module scope below so it's exported and testable.

  function rateLimitedNow(slot) {
    const rl = rateLimit[slot];
    return rl && rl.nextAt && Date.now() < rl.nextAt;
  }

  function trackRateLimit(slot, errMsg) {
    const isRateLimit = isRateLimitError(errMsg);
    if (!isRateLimit) {
      // Any non-rate-limit error: clear backoff so we don't compound penalties.
      delete rateLimit[slot];
      return;
    }
    const cur = rateLimit[slot] || { currentBackoffMs: RL_BASE_MS };
    cur.currentBackoffMs = Math.min(cur.currentBackoffMs * 2, RL_MAX_MS);
    cur.nextAt = Date.now() + cur.currentBackoffMs;
    rateLimit[slot] = cur;
    if (logActivity) logActivity('climate',
      `${slot} rate-limited by LG; backing off ${Math.round(cur.currentBackoffMs / 1000)}s`);
  }

  function clearRateLimit(slot) {
    if (rateLimit[slot]) delete rateLimit[slot];
  }

  // De-dup state for the revoked-token loud-log. Without this, every 60s poll
  // would re-log the same "PAT revoked" message until rotated.
  const revokedTokenState = { lastLoggedAt: 0 };
  const REVOKED_TOKEN_PAUSE_MS = 12 * 60 * 60 * 1000;     // 12h pause -- long enough to give Reid time to rotate
  const REVOKED_TOKEN_RELOG_MS = 60 * 60 * 1000;          // re-log once an hour while still revoked

  function handleRevokedToken(errMsg, saveConfigFn) {
    const cfg = getConfig().climate || (getConfig().climate = {});
    if (!cfg.lastState) cfg.lastState = {};
    const now = Date.now();
    // Pause the climate loop for 12h so the rate-limit handler doesn't keep
    // hammering a dead PAT. Reid clears via POST /api/climate/global/resume
    // after rotating the PAT via the LG developer portal.
    const currentPauseUntil = cfg.lastState.pausedUntil || 0;
    if (currentPauseUntil < now + REVOKED_TOKEN_PAUSE_MS - 60_000) {
      cfg.lastState.pausedUntil = now + REVOKED_TOKEN_PAUSE_MS;
      cfg.lastState.pausedReason = `PAT revoked (${(errMsg || '').slice(0, 120)})`;
      if (saveConfigFn) saveConfigFn();
    }
    // Loud log, rate-limited to once per hour while still in the revoked state.
    if (now - revokedTokenState.lastLoggedAt >= REVOKED_TOKEN_RELOG_MS) {
      revokedTokenState.lastLoggedAt = now;
      if (logActivity) logActivity('climate',
        `PAT REVOKED -- climate control paused 12h. Rotate via LG developer portal then POST /api/climate/global/resume. Error: ${(errMsg || '').slice(0, 200)}`);
    }
  }

  async function readDevice(slot, deviceId) {
    if (rateLimitedNow(slot)) {
      // Don't even hit the API. Return last cached value (if any) marked as stale.
      const stale = cache.devices[slot];
      if (stale) return { ...stale, ok: false, error: 'rate-limit backoff', fetchedAt: Date.now() };
      cache.devices[slot] = { ok: false, deviceId, error: 'rate-limit backoff', fetchedAt: Date.now() };
      return cache.devices[slot];
    }
    try {
      const res = await thinq({ pathname: `/devices/${deviceId}/state` });
      const norm = normalizeDeviceState(res);
      cache.devices[slot] = { ok: true, deviceId, ...norm, fetchedAt: Date.now() };
      pushTempReading(slot, norm && norm.currentF);
      clearRateLimit(slot);
      return cache.devices[slot];
    } catch (e) {
      trackRateLimit(slot, e.message);
      if (isRevokedTokenError(e.message)) {
        // Don't pass saveConfigFn here -- readDevice doesn't have one.
        // handleRevokedToken's de-dup logic still ensures we only log once.
        handleRevokedToken(e.message, null);
      }
      cache.devices[slot] = { ok: false, deviceId, error: e.message, fetchedAt: Date.now() };
      if (logActivity) logActivity('climate', `read ${slot} failed: ${e.message}`);
      return cache.devices[slot];
    }
  }

  async function readAll() {
    const cfg = getConfig().climate || {};
    const devs = cfg.devices || {};
    const slots = Object.keys(devs);
    if (!slots.length) return { devices: {} };
    await Promise.all(slots.map(s => readDevice(s, devs[s].deviceId)));
    cache.fetchedAt = Date.now();
    return { devices: cache.devices };
  }

  function parseHM(s) {
    const [h, m] = (s || '0:0').split(':').map(Number);
    return h * 60 + m;
  }

  function getMode() {
    const cfg = getConfig().climate || {};
    const sched = cfg.schedule || {};
    const now = new Date();
    const hm = now.getHours() * 60 + now.getMinutes();
    const dayStart = parseHM(sched.dayStart || '08:00');
    const nightStart = parseHM(sched.nightStart || '22:00');
    const isDay = hm >= dayStart && hm < nightStart;
    return {
      mode: isDay ? 'day' : 'night',
      targetF: isDay ? (sched.dayTargetF ?? 74) : (sched.nightTargetF ?? 70),
    };
  }

  // Effective target for a specific room. Per-room overrides win when present;
  // otherwise falls back to the global day/night target.
  // sched.overrides[slot] = { dayTargetF?, nightTargetF? } -- either or both optional.
  function getEffectiveTargetF(slot) {
    const cfg = getConfig().climate || {};
    const sched = cfg.schedule || {};
    const { mode, targetF: globalTarget } = getMode();
    const override = (sched.overrides && sched.overrides[slot]) || null;
    if (!override) return globalTarget;
    const key = mode === 'day' ? 'dayTargetF' : 'nightTargetF';
    const v = override[key];
    return (v == null || v === '') ? globalTarget : Number(v);
  }

  function getActiveLadder() {
    const cfg = getConfig().climate || {};
    const sched = cfg.schedule || {};
    const ladder = cfg.ladder || {};
    const now = new Date();
    const dow = now.getDay();
    const hm = now.getHours() * 60 + now.getMinutes();
    const quietDays = sched.officeQuietDays || [1, 2, 3, 4, 5];
    const quietStart = parseHM(sched.officeQuietStart || '10:00');
    const quietEnd = parseHM(sched.officeQuietEnd || '18:00');
    const inQuiet = quietDays.includes(dow) && hm >= quietStart && hm < quietEnd;
    return {
      name: inQuiet ? 'officeQuiet' : 'default',
      rungs: inQuiet ? (ladder.officeQuiet || []) : (ladder.default || []),
    };
  }

  // ---- Pause / override state ----

  function getPauseState(slot) {
    const cfg = getConfig().climate || {};
    const ls = cfg.lastState || {};
    const now = Date.now();
    const globalUntil = ls.pausedUntil || 0;
    const slotUntil = (ls[slot] && ls[slot].pausedUntil) || 0;
    const overrideUntil = (ls[slot] && ls[slot].overrideUntil) || 0;
    const until = Math.max(globalUntil, slotUntil, overrideUntil);
    return {
      paused: until > now,
      until,
      reason: until > now
        ? (overrideUntil >= globalUntil && overrideUntil >= slotUntil ? 'manual-override'
          : (slotUntil >= globalUntil ? 'slot-pause' : 'global-pause'))
        : null,
    };
  }

  function setPause(scope, ms, saveConfigFn) {
    const cfg = getConfig().climate || (getConfig().climate = {});
    if (!cfg.lastState) cfg.lastState = {};
    const until = Date.now() + ms;
    if (scope === 'global') {
      cfg.lastState.pausedUntil = until;
    } else {
      if (!cfg.lastState[scope]) cfg.lastState[scope] = {};
      cfg.lastState[scope].pausedUntil = until;
    }
    if (saveConfigFn) saveConfigFn();
    if (logActivity) logActivity('climate', `pause ${scope} for ${Math.round(ms / 60000)}m`);
    return { until };
  }

  function clearPause(scope, saveConfigFn) {
    const cfg = getConfig().climate || {};
    if (!cfg.lastState) return;
    if (scope === 'global') {
      delete cfg.lastState.pausedUntil;
    } else if (cfg.lastState[scope]) {
      delete cfg.lastState[scope].pausedUntil;
      delete cfg.lastState[scope].overrideUntil;
    }
    if (saveConfigFn) saveConfigFn();
    if (logActivity) logActivity('climate', `clear pause ${scope}`);
  }

  // Compare what we last wrote to the AC against what it now reports.
  // If they diverge, a human/app changed something -> pause this slot for cooldown.
  // Fields are checked individually with their own per-field timestamps. A field is only
  // compared if it was written between SETTLE_MS and STALE_MS ago. After STALE_MS without
  // a refresh, the field is forgotten so it can't trigger spurious overrides from old writes.
  function detectManualOverride(slot, observed, saveConfigFn) {
    const SETTLE_MS = 15 * 1000;       // skip checks within 15s of write (let AC reflect it)
    const STALE_MS = 5 * 60 * 1000;    // forget fields not refreshed within 5 minutes
    const cfg = getConfig().climate || {};
    const ls = (cfg.lastState && cfg.lastState[slot]) || {};
    const lw = ls.lastWritten;
    if (!lw) return false;

    const cooldownMs = (cfg.overrideCooldownMs ?? DEFAULT_OVERRIDE_COOLDOWN_MS);
    const now = Date.now();
    let diverged = false;
    const reasons = [];

    // Per-field timestamp: lw[`${field}At`] holds when that field was last written.
    // Falls back to lw.at for backwards compatibility with old config entries.
    const fieldTime = (field) => lw[`${field}At`] ?? lw.at ?? 0;
    const fieldFresh = (field) => {
      const t = fieldTime(field);
      if (!t) return false;
      const age = now - t;
      return age >= SETTLE_MS && age <= STALE_MS;
    };

    // Only compare target setpoint when both writer and reader were in COOL mode.
    // In FAN/AIR_DRY the AC's reported "target" can drift independently of what we wrote
    // (the unit's display target tracks differently per mode), and that's not a real override.
    const targetComparable = (lw.jobMode == null || lw.jobMode === 'COOL')
      && (observed.jobMode == null || observed.jobMode === 'COOL');
    if (targetComparable && lw.targetC != null && observed.targetC != null && fieldFresh('targetC')) {
      if (Math.abs(lw.targetC - observed.targetC) > SETPOINT_TOLERANCE_C) {
        diverged = true;
        reasons.push(`target ${lw.targetC}C->${observed.targetC}C`);
      }
    }
    // Grace period: if we wrote jobMode within the last MODE_GRACE_MS, ignore fan
    // divergence. LG portable ACs auto-reset fan speed on mode transitions, and the
    // next tick's force-rewrite will correct it without needing an override pause.
    const MODE_GRACE_MS = 75 * 1000;
    const recentModeWrite = lw.jobModeAt && (now - lw.jobModeAt) < MODE_GRACE_MS;
    if (lw.windStrength && observed.windStrength && fieldFresh('windStrength')
        && lw.windStrength !== observed.windStrength
        && !recentModeWrite) {
      diverged = true;
      reasons.push(`fan ${lw.windStrength}->${observed.windStrength}`);
    }
    if (lw.power && observed.power && fieldFresh('power') && lw.power !== observed.power) {
      diverged = true;
      reasons.push(`power ${lw.power}->${observed.power}`);
    }
    if (lw.jobMode && observed.jobMode && fieldFresh('jobMode')
        && lw.jobMode !== observed.jobMode) {
      diverged = true;
      reasons.push(`mode ${lw.jobMode}->${observed.jobMode}`);
    }

    // Garbage-collect stale fields so they don't accumulate forever in config.
    let gcChanged = false;
    for (const f of ['targetC', 'targetF', 'windStrength', 'power', 'jobMode']) {
      const t = lw[`${f}At`] ?? lw.at;
      if (t && (now - t) > STALE_MS) {
        delete lw[f];
        delete lw[`${f}At`];
        gcChanged = true;
      }
    }

    if (diverged) {
      if (!cfg.lastState) cfg.lastState = {};
      if (!cfg.lastState[slot]) cfg.lastState[slot] = {};
      cfg.lastState[slot].overrideUntil = Date.now() + cooldownMs;
      cfg.lastState[slot].overrideReason = reasons.join(', ');
      // Diagnostic: capture the exact field comparison that triggered the override.
      // Helps tell genuine human/app overrides apart from spurious ones where the
      // AC's reported state lags or differs from what we wrote (e.g. LG dropping
      // fan to LOW on mode transition before our regrace logic kicks in).
      const ageMs = (f) => {
        const t = lw[`${f}At`] ?? lw.at;
        return t ? Math.round((Date.now() - t) / 1000) : null;
      };
      cfg.lastState[slot].overrideEvidence = {
        at: new Date(now).toISOString(),
        reasons,
        wrote: {
          targetC: lw.targetC, windStrength: lw.windStrength,
          power: lw.power, jobMode: lw.jobMode,
          ageSec: { targetC: ageMs('targetC'), windStrength: ageMs('windStrength'),
                    power: ageMs('power'), jobMode: ageMs('jobMode') },
        },
        observed: {
          targetC: observed.targetC, windStrength: observed.windStrength,
          power: observed.power, jobMode: observed.jobMode,
        },
      };
      // Clear lastWritten so we don't re-detect the same change on the next poll.
      delete cfg.lastState[slot].lastWritten;
      if (saveConfigFn) saveConfigFn();
      if (logActivity) logActivity('climate',
        `manual override on ${slot} (${reasons.join(', ')}) -- pausing ${Math.round(cooldownMs / 60000)}m`);
      return true;
    }
    if (gcChanged && saveConfigFn) saveConfigFn();
    return false;
  }

  // ---- Writes ----

  // Returns true if the runaway-write breaker is currently engaged for this slot.
  // Side effect: trips the breaker (records timestamp, sets global pause via config)
  // when the per-slot write rate crosses the threshold within the rolling window.
  function checkRunawayBreaker(slot, saveConfigFn) {
    const now = Date.now();
    if (!writeTimestamps[slot]) writeTimestamps[slot] = [];
    const buf = writeTimestamps[slot];
    // Evict samples older than the window.
    while (buf.length && buf[0] < now - RUNAWAY_WINDOW_MS) buf.shift();
    if (buf.length >= RUNAWAY_WRITE_THRESHOLD) {
      const cfg = getConfig().climate || (getConfig().climate = {});
      if (!cfg.lastState) cfg.lastState = {};
      const until = now + RUNAWAY_PAUSE_MS;
      cfg.lastState.pausedUntil = until;
      cfg.lastState.pausedReason = `runaway breaker: ${slot} did ${buf.length} writes in ${Math.round(RUNAWAY_WINDOW_MS / 60000)}m`;
      breakerState.lastTrippedAt = new Date(now).toISOString();
      breakerState.lastTrippedSlot = slot;
      breakerState.lastTrippedCount = buf.length;
      buf.length = 0; // reset so the next genuine write doesn't immediately re-trip
      if (saveConfigFn) saveConfigFn();
      if (logActivity) logActivity('climate',
        `RUNAWAY BREAKER tripped: ${slot} did ${RUNAWAY_WRITE_THRESHOLD}+ writes in ${Math.round(RUNAWAY_WINDOW_MS / 60000)}m -- pausing all climate ${Math.round(RUNAWAY_PAUSE_MS / 60000)}m`);
      return true;
    }
    return false;
  }

  async function writeControl(slot, deviceId, payload, intent, saveConfigFn) {
    if (!payload || !Object.keys(payload).length) return null;
    if (rateLimitedNow(slot)) {
      throw new Error('rate-limit backoff active for ' + slot);
    }
    // Record the write attempt and check the breaker BEFORE making the HTTPS call.
    // If a bug is causing the loop to flap, we want to stop hammering the API,
    // not measure post-hoc how much damage was done.
    writeTimestamps[slot] = writeTimestamps[slot] || [];
    writeTimestamps[slot].push(Date.now());
    if (checkRunawayBreaker(slot, saveConfigFn)) {
      throw new Error('runaway-write breaker tripped; global climate paused');
    }
    let res;
    try {
      res = await thinq({
        pathname: `/devices/${deviceId}/control`,
        method: 'POST',
        body: payload,
      });
      clearRateLimit(slot);
    } catch (e) {
      trackRateLimit(slot, e.message);
      // Specific LG errors get clearer log lines so future audits can tell
      // them apart from generic transient failures. The flow continues to throw
      // -- callers handle the actual control flow -- but the log entry is more
      // useful for the bi-weekly audit and the diagnostics tab.
      if (isModeRejectedError(e.message)) {
        if (logActivity) logActivity('climate',
          `mode-rejected ${slot}: LG returned 2305 COMMAND_NOT_SUPPORTED_IN_MODE for ${JSON.stringify(intent)}; AC is in a mode that does not accept this write`);
      } else if (isRevokedTokenError(e.message)) {
        handleRevokedToken(e.message, saveConfigFn);
      }
      throw e;
    }
    const cfg = getConfig().climate || (getConfig().climate = {});
    if (!cfg.lastState) cfg.lastState = {};
    if (!cfg.lastState[slot]) cfg.lastState[slot] = {};
    const now = Date.now();
    const merged = { ...(cfg.lastState[slot].lastWritten || {}), ...intent, at: now };
    // Per-field timestamps: stamp every field included in this intent. The override
    // detector uses these to decide when a field is fresh enough to compare.
    for (const k of Object.keys(intent)) {
      merged[`${k}At`] = now;
    }
    cfg.lastState[slot].lastWritten = merged;
    if (saveConfigFn) saveConfigFn();
    if (logActivity) logActivity('climate', `write ${slot}: ${JSON.stringify(intent)}`);
    return res;
  }

  async function setTargetTempF(slot, targetF, saveConfigFn) {
    const cfg = getConfig().climate || {};
    const dev = (cfg.devices || {})[slot];
    if (!dev) throw new Error(`unknown slot: ${slot}`);
    const targetC = roundC(fToC(targetF));
    const payload = { temperature: { targetTemperature: targetC, unit: 'C' } };
    return writeControl(slot, dev.deviceId, payload, { targetC, targetF }, saveConfigFn);
  }

  async function setFanSpeed(slot, speed, saveConfigFn) {
    const cfg = getConfig().climate || {};
    const dev = (cfg.devices || {})[slot];
    if (!dev) throw new Error(`unknown slot: ${slot}`);
    const wind = WIND_MAP[String(speed).toLowerCase()] || speed;
    const payload = { airFlow: { windStrength: wind } };
    return writeControl(slot, dev.deviceId, payload, { windStrength: wind }, saveConfigFn);
  }

  async function setPower(slot, on, saveConfigFn) {
    const cfg = getConfig().climate || {};
    const dev = (cfg.devices || {})[slot];
    if (!dev) throw new Error(`unknown slot: ${slot}`);
    const power = on ? 'POWER_ON' : 'POWER_OFF';
    const payload = { operation: { airConOperationMode: power } };
    return writeControl(slot, dev.deviceId, payload, { power }, saveConfigFn);
  }

  // Set the AC's job mode (COOL / FAN / AIR_DRY). Records lastWritten.jobMode so
  // the override detector knows we made this change and won't flag it as manual.
  async function setJobMode(slot, jobMode, saveConfigFn) {
    const cfg = getConfig().climate || {};
    const dev = (cfg.devices || {})[slot];
    if (!dev) throw new Error(`unknown slot: ${slot}`);
    const payload = { airConJobMode: { currentJobMode: jobMode } };
    return writeControl(slot, dev.deviceId, payload, { jobMode }, saveConfigFn);
  }

  // Map heat pressure (F above target) to a rung-count, applying hysteresis
  // against the previously-engaged rung count so we don't flap at thresholds.
  function pressureToRungCount(pressureF, prevCount, totalRungs) {
    if (totalRungs <= 0) return 0;
    let target = 1;
    for (let i = 0; i < RUNG_THRESHOLDS_F.length; i++) {
      if (pressureF >= RUNG_THRESHOLDS_F[i]) target = i + 2;
    }
    target = Math.min(target, totalRungs);
    if (pressureF < 0) target = 1; // at or below target temp -> baseline (1 rung)

    if (prevCount == null) return target;
    if (target > prevCount) return target; // step up immediately
    // Step down only if pressure dropped HYSTERESIS_F below the threshold that engaged prevCount.
    // The threshold for being at prevCount rungs is RUNG_THRESHOLDS_F[prevCount - 2] (when prevCount >= 2).
    if (prevCount >= 2) {
      const stepDownAt = RUNG_THRESHOLDS_F[prevCount - 2] - HYSTERESIS_F;
      if (pressureF >= stepDownAt) return prevCount;
    }
    return target;
  }

  // From an engaged-rung list and a slot, find the highest fan rank requested for that slot.
  // Returns 0 if the slot is not in any engaged rung (baseline = LOW).
  function highestRankForSlot(slot, engagedRungs) {
    let best = 0;
    for (const [room, speed] of engagedRungs) {
      if (room !== slot) continue;
      const rank = WIND_RANK[WIND_MAP[String(speed).toLowerCase()] || speed.toUpperCase()] || 0;
      if (rank > best) best = rank;
    }
    return best;
  }

  // ---- Control loop tick ----

  async function tickOnce(saveConfigFn) {
    const cfg = getConfig().climate || {};
    if (!cfg.enabled) return { skipped: 'disabled' };

    const fresh = await readAll();
    const devs = cfg.devices || {};
    const slots = Object.keys(devs);
    if (!slots.length) return { skipped: 'no devices' };

    const { mode, targetF: globalTargetF } = getMode();
    const ladder = getActiveLadder();
    const actions = [];

    // Phase 1: classify each slot (user-off | unreachable | paused | active)
    // and compute heat pressure across only the active ones. Pressure is the
    // worst delta across rooms, where each room is judged against ITS OWN
    // effective target (per-room override if set, else global).
    let pressureF = 0;
    const slotData = {};
    for (const slot of slots) {
      const slotTargetF = getEffectiveTargetF(slot);
      const observed = fresh.devices[slot];
      if (!observed || !observed.ok) {
        slotData[slot] = { observed: null, paused: false, userOff: false, slotTargetF, skipReason: 'unreachable' };
        continue;
      }
      // User intentionally turned the unit off: leave it alone, exclude from pressure.
      if (observed.power === 'POWER_OFF') {
        slotData[slot] = { observed, paused: false, userOff: true, slotTargetF, skipReason: 'user-off' };
        continue;
      }
      detectManualOverride(slot, observed, saveConfigFn);
      const pause = getPauseState(slot);
      slotData[slot] = { observed, paused: pause.paused, userOff: false, slotTargetF, pause };
      if (!pause.paused && observed.currentF != null) {
        // Use smoothed temp (3-sample moving avg) for pressure calc to avoid rung
        // flapping caused by 0.5F-resolution sensor reads. Display value stays raw.
        const smoothed = smoothedTempF(slot, observed.currentF);
        const delta = smoothed - slotTargetF;
        if (delta > pressureF) pressureF = delta;
      }
    }

    // Phase 2: rung-count selection with hysteresis.
    const ls = (cfg.lastState && cfg.lastState.engagedRungCount) || null;
    const rungCount = pressureToRungCount(pressureF, ls, ladder.rungs.length);
    const engagedRungs = ladder.rungs.slice(0, rungCount);

    // Persist engaged-rung count for hysteresis on next tick.
    if (!cfg.lastState) cfg.lastState = {};
    if (cfg.lastState.engagedRungCount !== rungCount || cfg.lastState.engagedLadder !== ladder.name) {
      cfg.lastState.engagedRungCount = rungCount;
      cfg.lastState.engagedLadder = ladder.name;
      if (saveConfigFn) saveConfigFn();
      if (logActivity) logActivity('climate', `ladder=${ladder.name} pressure=${pressureF.toFixed(1)}F rungs=${rungCount}/${ladder.rungs.length}`);
    }

    // Phase 3: per-AC enforcement. User-off and unreachable already have skipReason set.
    for (const slot of slots) {
      const sd = slotData[slot];
      if (sd.skipReason) { actions.push({ slot, skipped: sd.skipReason }); continue; }
      if (sd.paused) { actions.push({ slot, skipped: 'paused', until: sd.pause.until, reason: sd.pause.reason }); continue; }

      const observed = sd.observed;
      const slotActions = { slot, wrote: {} };
      const slotTargetF = sd.slotTargetF;
      const slotTargetC = roundC(fToC(slotTargetF));

      // 3a) Setpoint enforcement using THIS room's effective target.
      // Only enforce while in COOL mode -- the AC ignores setpoint writes in FAN/AIR_DRY,
      // which led to redundant writes every poll forever. The setpoint will be re-asserted
      // automatically when the loop's mode-switch logic moves the unit back to COOL.
      const setpointEnforceable = observed.jobMode === 'COOL';
      if (setpointEnforceable && observed.targetC != null
          && Math.abs(observed.targetC - slotTargetC) > SETPOINT_TOLERANCE_C) {
        try {
          await setTargetTempF(slot, slotTargetF, saveConfigFn);
          slotActions.wrote.targetF = slotTargetF;
        } catch (e) {
          if (logActivity) logActivity('climate', `setpoint ${slot} failed: ${e.message}`);
          slotActions.error = (slotActions.error ? slotActions.error + '; ' : '') + 'setpoint: ' + e.message;
        }
      } else if (!setpointEnforceable && observed.targetC != null
          && Math.abs(observed.targetC - slotTargetC) > SETPOINT_TOLERANCE_C) {
        slotActions.setpointDeferred = `${observed.jobMode || 'unknown'} mode -- will set when COOL`;
      }

      // 3a.5) COOL <-> FAN auto-switch (with protective tuning).
      // Reinstated after observing LG units keep compressor running against stale
      // internal sensor reads even when room is below target. FAN mode is a hard
      // guarantee that compressor cannot run.
      // Protection against the flapping that earlier removal was intended to fix:
      //   - 1.0F deadband (was 0.5F) -- room must be 1F below to go FAN, 1F above to go COOL
      //   - 5-min dwell -- mode can only flip every 5 min
      //   - Median temp smoothing already in place upstream
      // AIR_DRY (or any non-COOL/non-FAN mode) is left alone -- user intent.
      let didModeSwitch = false;
      if (observed.jobMode === 'COOL' || observed.jobMode === 'FAN') {
        const wantCool = observed.jobMode === 'COOL'
          ? observed.currentF >= slotTargetF - MODE_DEADBAND_F   // stay COOL until 1F below target
          : observed.currentF >= slotTargetF + MODE_DEADBAND_F;  // need 1F above to flip back to COOL
        const desiredMode = wantCool ? 'COOL' : 'FAN';
        const lwSlotForMode = (cfg.lastState && cfg.lastState[slot] && cfg.lastState[slot].lastWritten) || {};
        const ageOfLastModeWriteMs = lwSlotForMode.jobModeAt
          ? Date.now() - lwSlotForMode.jobModeAt
          : Number.POSITIVE_INFINITY;
        slotActions.modeDecision = { current: observed.jobMode, desired: desiredMode, currentF: observed.currentF, targetF: slotTargetF };
        if (desiredMode !== observed.jobMode && ageOfLastModeWriteMs < MODE_DWELL_MS) {
          slotActions.modeDwellHeld = `holding ${observed.jobMode}; want ${desiredMode} but last mode write was ${Math.round(ageOfLastModeWriteMs / 1000)}s ago (dwell ${Math.round(MODE_DWELL_MS / 1000)}s)`;
        } else if (desiredMode !== observed.jobMode) {
          try {
            await setJobMode(slot, desiredMode, saveConfigFn);
            slotActions.wrote.jobMode = desiredMode;
            didModeSwitch = true;
          } catch (e) {
            if (logActivity) logActivity('climate', `mode ${slot} failed: ${e.message}`);
            slotActions.error = (slotActions.error ? slotActions.error + '; ' : '') + 'mode: ' + e.message;
          }
        }
      } else if (observed.jobMode) {
        // AIR_DRY or other non-COOL/non-FAN -- user picked it, leave it alone.
        slotActions.modeDecision = { current: observed.jobMode, leftAlone: true };
      }

      // 3b) Fan speed from ladder.
      // ASYMMETRIC dwell: block stepping UP (to a louder fan) until dwellMs has
      // passed since the last fan write, but ALWAYS allow stepping DOWN to a quieter
      // fan. Stepping up is what causes the LOW->HIGH micro-cycles we want to suppress;
      // stepping down is always safe and desirable (quieter, less wear, less power).
      // Without this asymmetry, a transient pressure spike could leave fans pinned
      // high for 5 minutes even after the room cooled below target.
      const dwellMs = (cfg.fanDwellMinutes ?? 5) * 60 * 1000;
      const desiredRank = highestRankForSlot(slot, engagedRungs) || WIND_RANK.LOW;
      const desiredWind = RANK_TO_WIND[desiredRank];
      const observedRank = WIND_RANK[observed.windStrength] || 0;
      const lwSlot = (cfg.lastState && cfg.lastState[slot] && cfg.lastState[slot].lastWritten) || {};
      const ageOfLastFanWriteMs = lwSlot.windStrengthAt
        ? Date.now() - lwSlot.windStrengthAt
        : Number.POSITIVE_INFINITY;
      const fanMismatch = observed.windStrength && observed.windStrength !== desiredWind;
      const isStepUp = desiredRank > observedRank;
      // Bypass dwell after a mode switch (LG ACs auto-reset fan speed on mode transitions,
      // so we must rewrite immediately or the unit could be stuck at the wrong speed).
      if (fanMismatch && isStepUp && ageOfLastFanWriteMs < dwellMs && !didModeSwitch) {
        slotActions.fanDwellHeld = `holding ${observed.windStrength}; want step-up to ${desiredWind} but last fan write was ${Math.round(ageOfLastFanWriteMs / 1000)}s ago (dwell ${Math.round(dwellMs / 1000)}s)`;
      } else if (fanMismatch) {
        try {
          await setFanSpeed(slot, desiredWind.toLowerCase(), saveConfigFn);
          slotActions.wrote.windStrength = desiredWind;
        } catch (e) {
          if (logActivity) logActivity('climate', `fan ${slot} failed: ${e.message}`);
          slotActions.error = (slotActions.error ? slotActions.error + '; ' : '') + 'fan: ' + e.message;
        }
      }

      if (!Object.keys(slotActions.wrote).length && !slotActions.error) slotActions.ok = 'matches';
      actions.push(slotActions);
    }

    lastTickAt = Date.now();
    const slotTargets = {};
    for (const slot of slots) slotTargets[slot] = slotData[slot].slotTargetF;
    return {
      mode,
      globalTargetF,
      slotTargets,
      ladder: ladder.name,
      pressureF: Math.round(pressureF * 10) / 10,
      engagedRungCount: rungCount,
      engagedRungs,
      actions,
    };
  }

  async function tick(saveConfigFn) {
    if (inFlightTick) return inFlightTick;
    inFlightTick = tickOnce(saveConfigFn).finally(() => { inFlightTick = null; });
    return inFlightTick;
  }

  // Boot-time validator: walks config.climate.ladder and surfaces drift that
  // we've manually fixed before so the next occurrence shows up in the log
  // immediately instead of waiting for a symptom. Warn-only -- never mutates
  // config. Returns an array of warning strings (also pushed to activity log).
  function validateLadder() {
    const warnings = [];
    const cfg = getConfig().climate || {};
    const ladder = cfg.ladder;
    if (ladder == null) {
      warnings.push('ladder missing entirely; control loop will be a no-op until populated');
      return warnings;
    }
    if (typeof ladder !== 'object' || Array.isArray(ladder)) {
      warnings.push(`ladder must be a plain object, got ${Array.isArray(ladder) ? 'array' : typeof ladder}`);
      return warnings;
    }
    // Numeric/junk keys from a prior char-spread corruption bug.
    const junkKeys = Object.keys(ladder).filter(k => /^\d+$/.test(k));
    if (junkKeys.length) {
      warnings.push(`ladder has ${junkKeys.length} numeric junk keys (likely leftover from a string-spread bug): ${junkKeys.join(',')}`);
    }
    // Each named ladder must be an array of [room, speed] pairs with allowed speeds.
    const allowedSpeeds = new Set(['low', 'mid', 'medium', 'high']);
    const slotNames = new Set(Object.keys(cfg.devices || {}));
    for (const name of Object.keys(ladder)) {
      if (/^\d+$/.test(name)) continue; // already flagged
      const rungs = ladder[name];
      if (!Array.isArray(rungs)) {
        warnings.push(`ladder.${name} must be an array of [room, speed] pairs, got ${typeof rungs}`);
        continue;
      }
      rungs.forEach((rung, i) => {
        if (!Array.isArray(rung) || rung.length !== 2) {
          warnings.push(`ladder.${name}[${i}] must be a 2-element [room, speed] tuple`);
          return;
        }
        const [room, speed] = rung;
        if (typeof room !== 'string' || !room.length) {
          warnings.push(`ladder.${name}[${i}] room must be a non-empty string`);
        } else if (slotNames.size && !slotNames.has(room)) {
          warnings.push(`ladder.${name}[${i}] references unknown room "${room}" (known slots: ${[...slotNames].join(', ')})`);
        }
        if (typeof speed !== 'string' || !allowedSpeeds.has(String(speed).toLowerCase())) {
          warnings.push(`ladder.${name}[${i}] speed "${speed}" not in ${[...allowedSpeeds].join('|')}`);
        }
      });
    }
    // Drift checks: officeQuiet ladder shouldn't allow office HIGH (per project memory).
    // This is a known historical drift; warn but don't fix -- forces a human decision.
    const oq = Array.isArray(ladder.officeQuiet) ? ladder.officeQuiet : [];
    const officeHighInQuiet = oq.find(r => Array.isArray(r) && r[0] === 'office' && String(r[1]).toLowerCase() === 'high');
    if (officeHighInQuiet) {
      warnings.push('ladder.officeQuiet contains ["office","high"] -- project convention caps office at MID during quiet hours; drop the rung or move the cap');
    }
    // Sanity: default and officeQuiet should both exist.
    if (!ladder.default) warnings.push('ladder.default missing -- the controller will engage zero rungs outside office quiet hours');
    if (!ladder.officeQuiet) warnings.push('ladder.officeQuiet missing -- weekday 10-6 will fall back to default ladder');
    return warnings;
  }

  function start(saveConfigFn) {
    const cfg = getConfig().climate || {};
    const intervalSec = (cfg.fanRamp && cfg.fanRamp.pollSeconds) || 60;
    const ladderWarnings = validateLadder();
    for (const w of ladderWarnings) {
      if (logActivity) logActivity('climate', `ladder-validator: ${w}`);
    }
    setInterval(() => {
      const c = getConfig().climate || {};
      if (!c.enabled) return;
      tick(saveConfigFn).catch(e => {
        if (logActivity) logActivity('climate', `tick error: ${e.message}`);
      });
    }, intervalSec * 1000);
    if (logActivity) logActivity('climate', `controller started (poll ${intervalSec}s, ${ladderWarnings.length} ladder warnings)`);
  }

  // ---- Public snapshot ----

  function getSnapshot() {
    const cfg = getConfig().climate || {};
    const slots = Object.keys(cfg.devices || {});
    const pauses = {};
    const overrideEvidence = {};
    for (const s of slots) {
      pauses[s] = getPauseState(s);
      const ls = (cfg.lastState && cfg.lastState[s]) || {};
      if (ls.overrideEvidence) overrideEvidence[s] = ls.overrideEvidence;
    }
    const globalPause = (() => {
      const until = (cfg.lastState && cfg.lastState.pausedUntil) || 0;
      return { paused: until > Date.now(), until };
    })();
    const { mode, targetF: globalTargetF } = getMode();
    // Per-room effective targets (overrides applied), and pressure measured
    // against each room's own target. Skip paused, unreachable, user-off.
    const slotTargets = {};
    let pressureF = 0;
    for (const s of slots) {
      slotTargets[s] = getEffectiveTargetF(s);
      const d = cache.devices[s];
      if (!d || !d.ok || !d.currentF) continue;
      if (pauses[s].paused) continue;
      if (d.power === 'POWER_OFF') continue;
      const smoothed = smoothedTempF(s, d.currentF);
      const delta = smoothed - slotTargets[s];
      if (delta > pressureF) pressureF = delta;
    }
    const engagedRungCount = (cfg.lastState && cfg.lastState.engagedRungCount) || 0;
    return {
      enabled: !!cfg.enabled,
      mode,
      globalTargetF,
      // Back-compat: old UI consumers read s.targetF; keep it pointing at global.
      targetF: globalTargetF,
      slotTargets,
      ladder: getActiveLadder(),
      pressureF: Math.round(pressureF * 10) / 10,
      engagedRungCount,
      lastTickAt,
      globalPause,
      pauses,
      overrideEvidence,
      breaker: {
        ...breakerState,
        windowWrites: Object.fromEntries(
          Object.entries(writeTimestamps).map(([s, ts]) => {
            const cutoff = Date.now() - RUNAWAY_WINDOW_MS;
            return [s, ts.filter(t => t >= cutoff).length];
          })
        ),
        windowMinutes: Math.round(RUNAWAY_WINDOW_MS / 60000),
        threshold: RUNAWAY_WRITE_THRESHOLD,
      },
      cache,
    };
  }

  return {
    readAll,
    readDevice,
    getSnapshot,
    validateLadder,
    pressureToRungCount,
    getMode,
    getActiveLadder,
    setTargetTempF,
    setFanSpeed,
    setPower,
    setJobMode,
    setPause,
    clearPause,
    getPauseState,
    tick,
    start,
    _thinqRequest: thinq,
  };
}

module.exports = {
  createClimate, cToF, fToC, WIND_MAP,
  isRateLimitError, isModeRejectedError, isRevokedTokenError,
  normalizeDeviceState,
};
