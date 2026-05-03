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
const RUNG_THRESHOLDS_F = [0.5, 1.5, 2.5, 3.5];
const HYSTERESIS_F = 0.5;

function cToF(c) { return c == null ? null : Math.round((c * 9 / 5 + 32) * 10) / 10; }
function fToC(f) { return f == null ? null : Math.round(((f - 32) * 5 / 9) * 10) / 10; }
function roundC(c) { return Math.round(c * 2) / 2; }

function createClimate({ getConfig, logActivity }) {
  // In-memory state. config.json holds the persistent half (lastWritten, pauseUntil).
  let cache = { fetchedAt: 0, devices: {} };
  let lastTickAt = 0;
  let inFlightTick = null;

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

  async function readDevice(slot, deviceId) {
    try {
      const res = await thinq({ pathname: `/devices/${deviceId}/state` });
      const norm = normalizeDeviceState(res);
      cache.devices[slot] = { ok: true, deviceId, ...norm, fetchedAt: Date.now() };
      return cache.devices[slot];
    } catch (e) {
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
  function detectManualOverride(slot, observed, saveConfigFn) {
    const cfg = getConfig().climate || {};
    const ls = (cfg.lastState && cfg.lastState[slot]) || {};
    const lastWritten = ls.lastWritten;
    if (!lastWritten || !lastWritten.at) return false;

    // Allow ~15s for the AC to reflect our write before checking divergence.
    if (Date.now() - lastWritten.at < 15000) return false;

    const cooldownMs = (cfg.overrideCooldownMs ?? DEFAULT_OVERRIDE_COOLDOWN_MS);
    let diverged = false;
    const reasons = [];

    if (lastWritten.targetC != null && observed.targetC != null) {
      if (Math.abs(lastWritten.targetC - observed.targetC) > SETPOINT_TOLERANCE_C) {
        diverged = true;
        reasons.push(`target ${lastWritten.targetC}C->${observed.targetC}C`);
      }
    }
    if (lastWritten.windStrength && observed.windStrength
        && lastWritten.windStrength !== observed.windStrength) {
      diverged = true;
      reasons.push(`fan ${lastWritten.windStrength}->${observed.windStrength}`);
    }
    if (lastWritten.power && observed.power && lastWritten.power !== observed.power) {
      diverged = true;
      reasons.push(`power ${lastWritten.power}->${observed.power}`);
    }

    if (diverged) {
      if (!cfg.lastState) cfg.lastState = {};
      if (!cfg.lastState[slot]) cfg.lastState[slot] = {};
      cfg.lastState[slot].overrideUntil = Date.now() + cooldownMs;
      cfg.lastState[slot].overrideReason = reasons.join(', ');
      // Clear lastWritten so we don't re-detect the same change repeatedly.
      delete cfg.lastState[slot].lastWritten;
      if (saveConfigFn) saveConfigFn();
      if (logActivity) logActivity('climate',
        `manual override on ${slot} (${reasons.join(', ')}) -- pausing ${Math.round(cooldownMs / 60000)}m`);
      return true;
    }
    return false;
  }

  // ---- Writes ----

  async function writeControl(slot, deviceId, payload, intent, saveConfigFn) {
    if (!payload || !Object.keys(payload).length) return null;
    const res = await thinq({
      pathname: `/devices/${deviceId}/control`,
      method: 'POST',
      body: payload,
    });
    const cfg = getConfig().climate || (getConfig().climate = {});
    if (!cfg.lastState) cfg.lastState = {};
    if (!cfg.lastState[slot]) cfg.lastState[slot] = {};
    cfg.lastState[slot].lastWritten = { ...(cfg.lastState[slot].lastWritten || {}), ...intent, at: Date.now() };
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

    const { mode, targetF } = getMode();
    const targetC = roundC(fToC(targetF));
    const ladder = getActiveLadder();
    const actions = [];

    // Phase 1: detect overrides + compute heat pressure across non-paused, reachable ACs.
    let pressureF = 0;
    const slotData = {};
    for (const slot of slots) {
      const observed = fresh.devices[slot];
      if (!observed || !observed.ok) {
        slotData[slot] = { observed: null, paused: false, skipReason: 'unreachable' };
        continue;
      }
      detectManualOverride(slot, observed, saveConfigFn);
      const pause = getPauseState(slot);
      slotData[slot] = { observed, paused: pause.paused, pause };
      if (!pause.paused && observed.currentF != null) {
        const delta = observed.currentF - targetF;
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

    // Phase 3: per-AC enforcement.
    for (const slot of slots) {
      const sd = slotData[slot];
      if (sd.skipReason) { actions.push({ slot, skipped: sd.skipReason }); continue; }
      if (sd.paused) { actions.push({ slot, skipped: 'paused', until: sd.pause.until, reason: sd.pause.reason }); continue; }

      const observed = sd.observed;
      const slotActions = { slot, wrote: {} };

      // 3a) Setpoint enforcement.
      if (observed.targetC != null && Math.abs(observed.targetC - targetC) > SETPOINT_TOLERANCE_C) {
        try {
          await setTargetTempF(slot, targetF, saveConfigFn);
          slotActions.wrote.targetF = targetF;
        } catch (e) {
          if (logActivity) logActivity('climate', `setpoint ${slot} failed: ${e.message}`);
          slotActions.error = (slotActions.error ? slotActions.error + '; ' : '') + 'setpoint: ' + e.message;
        }
      }

      // 3b) Fan speed from ladder.
      const desiredRank = highestRankForSlot(slot, engagedRungs) || WIND_RANK.LOW;
      const desiredWind = RANK_TO_WIND[desiredRank];
      if (observed.windStrength && observed.windStrength !== desiredWind) {
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
    return {
      mode, targetF,
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
    const { mode, targetF } = getMode();
    // Compute current pressure from cached readings (no fresh fetch).
    let pressureF = 0;
    for (const s of slots) {
      const d = cache.devices[s];
      if (!d || !d.ok || !d.currentF) continue;
      if (pauses[s].paused) continue;
      const delta = d.currentF - targetF;
      if (delta > pressureF) pressureF = delta;
    }
    const engagedRungCount = (cfg.lastState && cfg.lastState.engagedRungCount) || 0;
    return {
      enabled: !!cfg.enabled,
      mode, targetF,
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
    setPause,
    clearPause,
    getPauseState,
    tick,
    start,
    _thinqRequest: thinq,
  };
}

module.exports = { createClimate, cToF, fToC, WIND_MAP };
