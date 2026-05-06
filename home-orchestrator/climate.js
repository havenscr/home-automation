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
// Note: COOL<->FAN auto-switching was removed; the LG unit's native thermostat handles
// compressor cycling at target. The setJobMode helper is kept for the manual UI button.

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
    const sum = h.reduce((a, b) => a + b, 0);
    return sum / h.length;
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

  function normalizeDeviceState(raw) {
    const r = raw && (raw.response || raw);
    if (!r) return null;
    const t = r.temperature || {};
    const unit = t.unit || 'C';
    const currentC = unit === 'C' ? t.currentTemperature : fToC(t.currentTemperatureF ?? t.currentTemperature);
    const targetC = unit === 'C' ? t.targetTemperature : fToC(t.targetTemperatureF ?? t.targetTemperature);
    return {
      power: r.operation?.airConOperationMode || null,
      jobMode: r.airConJobMode?.currentJobMode || null,
      windStrength: r.airFlow?.windStrength || null,
      unitNative: unit,
      currentC,
      currentF: cToF(currentC),
      targetC,
      targetF: cToF(targetC),
      raw: r,
    };
  }

  function rateLimitedNow(slot) {
    const rl = rateLimit[slot];
    return rl && rl.nextAt && Date.now() < rl.nextAt;
  }

  function trackRateLimit(slot, errMsg) {
    const isRateLimit = errMsg && (/1314/.test(errMsg) || /Exceeded User API/i.test(errMsg));
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

  async function writeControl(slot, deviceId, payload, intent, saveConfigFn) {
    if (!payload || !Object.keys(payload).length) return null;
    if (rateLimitedNow(slot)) {
      throw new Error('rate-limit backoff active for ' + slot);
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

      // 3a.5) Mode awareness only -- no auto-switching.
      // The LG unit's native thermostat handles compressor cycling: when room reaches
      // target in COOL mode, the unit shuts the compressor off but keeps the fan running.
      // The loop used to write COOL<->FAN every few minutes; that was unnecessary churn
      // (~133 writes/day in production). AIR_DRY is left alone (user intent).
      // The override detector still watches jobMode for external manual changes.
      if (observed.jobMode && observed.jobMode !== 'COOL' && observed.jobMode !== 'FAN') {
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
      if (fanMismatch && isStepUp && ageOfLastFanWriteMs < dwellMs) {
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

  function start(saveConfigFn) {
    const cfg = getConfig().climate || {};
    const intervalSec = (cfg.fanRamp && cfg.fanRamp.pollSeconds) || 60;
    setInterval(() => {
      const c = getConfig().climate || {};
      if (!c.enabled) return;
      tick(saveConfigFn).catch(e => {
        if (logActivity) logActivity('climate', `tick error: ${e.message}`);
      });
    }, intervalSec * 1000);
    if (logActivity) logActivity('climate', `controller started (poll ${intervalSec}s)`);
  }

  // ---- Public snapshot ----

  function getSnapshot() {
    const cfg = getConfig().climate || {};
    const slots = Object.keys(cfg.devices || {});
    const pauses = {};
    for (const s of slots) pauses[s] = getPauseState(s);
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
      cache,
    };
  }

  return {
    readAll,
    readDevice,
    getSnapshot,
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

module.exports = { createClimate, cToF, fToC, WIND_MAP };
