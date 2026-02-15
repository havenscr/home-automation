const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = 5006;
const CONFIG_FILE = path.join(__dirname, 'config.json');
const LOG_FILE = path.join(__dirname, 'activity.log');
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let config = {};

// ─── Activity Log (Buffered) ────────────────────────────────────────────────
let logBuffer = [];

function logActivity(type, message, details = {}) {
  const entry = JSON.stringify({ ts: new Date().toISOString(), type, message, ...details });
  logBuffer.push(entry);
  console.log(`[${type}] ${message}`);
}

function flushLog() {
  if (logBuffer.length === 0) return;
  const entries = logBuffer.splice(0);
  try {
    fs.appendFileSync(LOG_FILE, entries.join('\n') + '\n');
    const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean);
    const max = (config.log && config.log.maxLines) || 500;
    if (lines.length > max) fs.writeFileSync(LOG_FILE, lines.slice(-max).join('\n') + '\n');
  } catch (e) { /* ignore log errors */ }
}

// Flush every 5s, and on exit
setInterval(flushLog, (config.log && config.log.flushIntervalMs) || 5000);
process.on('SIGTERM', () => { flushLog(); process.exit(0); });
process.on('SIGINT', () => { flushLog(); process.exit(0); });

// ─── Config Management ──────────────────────────────────────────────────────
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      if (!config.routines) config.routines = {};
      if (!config.schedules) config.schedules = {};
      if (!config.hue) config.hue = { bridgeIp: '192.168.1.2', apiKey: '' };
      if (!config.switchbot) config.switchbot = { token: '', secret: '', sceneMap: {} };
      if (!config.log) config.log = { maxLines: 500, flushIntervalMs: 5000 };
    } else {
      config = { hue: { bridgeIp: '192.168.1.2', apiKey: '' }, switchbot: { token: '', secret: '', sceneMap: {} }, routines: {}, schedules: {}, log: { maxLines: 500, flushIntervalMs: 5000 } };
      saveConfig();
    }
  } catch (e) {
    console.error('Config error:', e.message);
    config = { hue: {}, switchbot: {}, routines: {}, schedules: {}, log: {} };
  }
}

function saveConfig() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// ─── Hue Bridge Client ──────────────────────────────────────────────────────
function hueRequest(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: config.hue.bridgeIp,
      port: 80,
      path: `/api/${config.hue.apiKey}${urlPath}`,
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      timeout: 8000
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { resolve(data); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Hue request timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function hueLightState(id, state) { return hueRequest('PUT', `/lights/${id}/state`, state); }
function hueGroupAction(id, state) { return hueRequest('PUT', `/groups/${id}/action`, state); }
function hueGetLights() { return hueRequest('GET', '/lights'); }
function hueGetGroups() { return hueRequest('GET', '/groups'); }
function hueGetLight(id) { return hueRequest('GET', `/lights/${id}`); }

// ─── Color Utilities ────────────────────────────────────────────────────────

// Convert color temperature (mirek) to CIE xy coordinates
function ctToXy(mirek) {
  const kelvin = 1000000 / mirek;
  let x, y;
  const k2 = kelvin * kelvin, k3 = k2 * kelvin;
  if (kelvin <= 4000) {
    x = -0.2661239e9 / k3 - 0.2343589e6 / k2 + 0.8776956e3 / kelvin + 0.17991;
  } else {
    x = -3.0258469e9 / k3 + 2.1070379e6 / k2 + 0.2226347e3 / kelvin + 0.24039;
  }
  if (kelvin <= 2222) {
    y = -1.1063814 * x * x * x - 1.3481102 * x * x + 2.1855583 * x - 0.2021968;
  } else if (kelvin <= 4000) {
    y = -0.9549476 * x * x * x - 1.3741859 * x * x + 2.0913702 * x - 0.1674887;
  } else {
    y = 3.081758 * x * x * x - 5.8733867 * x * x + 3.75113 * x - 0.3700148;
  }
  return [Math.max(0, Math.min(1, x)), Math.max(0, Math.min(1, y))];
}

// Convert hex color to RGB
function hexToRgb(hex) {
  hex = hex.replace('#', '');
  return [parseInt(hex.slice(0, 2), 16) / 255, parseInt(hex.slice(2, 4), 16) / 255, parseInt(hex.slice(4, 6), 16) / 255];
}

// Convert RGB to CIE xy (using Hue's wide gamut)
function rgbToXy(r, g, b) {
  // Gamma correction
  r = r > 0.04045 ? Math.pow((r + 0.055) / 1.055, 2.4) : r / 12.92;
  g = g > 0.04045 ? Math.pow((g + 0.055) / 1.055, 2.4) : g / 12.92;
  b = b > 0.04045 ? Math.pow((b + 0.055) / 1.055, 2.4) : b / 12.92;
  const X = r * 0.664511 + g * 0.154324 + b * 0.162028;
  const Y = r * 0.283881 + g * 0.668433 + b * 0.047685;
  const Z = r * 0.000088 + g * 0.072310 + b * 0.986039;
  const sum = X + Y + Z;
  if (sum === 0) return [0.3127, 0.3291]; // D65 white point
  return [X / sum, Y / sum];
}

// Convert any color format to xy for interpolation
function colorToXy(color) {
  if (!color) return null;
  if (color.xy) return color.xy;
  if (color.ct) return ctToXy(color.ct);
  if (color.hex) { const [r, g, b] = hexToRgb(color.hex); return rgbToXy(r, g, b); }
  if (color.hs) {
    // HSV to RGB to XY
    const h = (color.hs.hue / 65535) * 360, s = color.hs.sat / 254, v = 1;
    const c = v * s, x2 = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c;
    let r, g, b;
    if (h < 60) { r = c; g = x2; b = 0; }
    else if (h < 120) { r = x2; g = c; b = 0; }
    else if (h < 180) { r = 0; g = c; b = x2; }
    else if (h < 240) { r = 0; g = x2; b = c; }
    else if (h < 300) { r = x2; g = 0; b = c; }
    else { r = c; g = 0; b = x2; }
    return rgbToXy(r + m, g + m, b + m);
  }
  return null;
}

// Build Hue state object from a color spec
function resolveColor(color) {
  if (!color) return {};
  if (color.xy) return { xy: color.xy };
  if (color.ct) return { ct: color.ct };
  if (color.hs) return { hue: color.hs.hue, sat: color.hs.sat };
  if (color.hex) { const [r, g, b] = hexToRgb(color.hex); return { xy: rgbToXy(r, g, b) }; }
  return {};
}

// Interpolate between two colors at factor t (0-1)
function interpolateColor(c1, c2, t) {
  // Same-type fast paths
  if (c1.ct && c2.ct) return { ct: Math.round(c1.ct + (c2.ct - c1.ct) * t) };
  if (c1.xy && c2.xy) return { xy: [c1.xy[0] + (c2.xy[0] - c1.xy[0]) * t, c1.xy[1] + (c2.xy[1] - c1.xy[1]) * t] };

  // Mixed types: convert both to xy and interpolate
  const xy1 = colorToXy(c1);
  const xy2 = colorToXy(c2);
  if (xy1 && xy2) {
    return { xy: [xy1[0] + (xy2[0] - xy1[0]) * t, xy1[1] + (xy2[1] - xy1[1]) * t] };
  }

  // Fallback: snap
  return t < 0.5 ? resolveColor(c1) : resolveColor(c2);
}

// Convert xy to approximate hex for UI display
function xyBriToHex(x, y, bri) {
  const z = 1.0 - x - y;
  const Y = bri / 254;
  const X = (Y / y) * x;
  const Z = (Y / y) * z;
  let r = X * 1.656492 - Y * 0.354851 - Z * 0.255038;
  let g = -X * 0.707196 + Y * 1.655397 + Z * 0.036152;
  let b = X * 0.051713 - Y * 0.121364 + Z * 1.011530;
  r = r <= 0.0031308 ? 12.92 * r : (1.055) * Math.pow(r, 1.0 / 2.4) - 0.055;
  g = g <= 0.0031308 ? 12.92 * g : (1.055) * Math.pow(g, 1.0 / 2.4) - 0.055;
  b = b <= 0.0031308 ? 12.92 * b : (1.055) * Math.pow(b, 1.0 / 2.4) - 0.055;
  r = Math.max(0, Math.min(1, r));
  g = Math.max(0, Math.min(1, g));
  b = Math.max(0, Math.min(1, b));
  return '#' + [r, g, b].map(c => Math.round(c * 255).toString(16).padStart(2, '0')).join('');
}

// ─── Fade Engine ────────────────────────────────────────────────────────────
const activeRoutines = {};

function startRoutine(routineId, options = {}) {
  const routine = config.routines[routineId];
  if (!routine) throw new Error(`Routine "${routineId}" not found`);

  // Cancel if already active
  if (activeRoutines[routineId]) {
    cancelRoutine(routineId);
  }

  const durationMin = options.testDuration || routine.duration;
  const durationMs = durationMin * 60 * 1000;
  const tickMs = 10000; // 10 second tick interval
  const startTime = Date.now();

  const state = {
    id: routineId,
    name: routine.name,
    startTime,
    durationMs,
    tickMs,
    tickCount: 0,
    lastExpected: {},
    firedInstants: new Set(),
    intervalHandle: null
  };

  // Set initial state for each fade track (first waypoint)
  for (const track of routine.tracks) {
    if (track.type === 'fade' && track.waypoints && track.waypoints.length > 0) {
      const wp0 = track.waypoints[0];
      const colorState = resolveColor(wp0.color);
      for (const lightId of track.lights) {
        const lightState = { on: true, bri: wp0.bri, transitiontime: 20, ...colorState };
        hueLightState(lightId, lightState).catch(e =>
          console.log(`[Fade] Initial set error light ${lightId}:`, e.message)
        );
        state.lastExpected[lightId] = wp0.bri;
      }
    }
  }

  // Tick loop
  state.intervalHandle = setInterval(async () => {
    state.tickCount++;
    const elapsed = Date.now() - startTime;
    const elapsedMin = elapsed / 60000;
    const progress = Math.min(1, elapsed / durationMs);

    // Done?
    if (progress >= 1) {
      // Set final state for each track
      for (const track of routine.tracks) {
        if (track.type === 'fade' && track.waypoints.length > 0) {
          const final = track.waypoints[track.waypoints.length - 1];
          const colorState = resolveColor(final.color);
          for (const lightId of track.lights) {
            hueLightState(lightId, { on: true, bri: final.bri, transitiontime: 10, ...colorState }).catch(() => {});
          }
        }
      }
      clearInterval(state.intervalHandle);
      delete activeRoutines[routineId];
      logActivity('fade', `Routine "${routine.name}" completed`, { routineId, durationMin });
      return;
    }

    // Process each track
    for (const track of routine.tracks) {
      if (track.type === 'fade') {
        await processFadeTrack(track, elapsedMin, durationMin, state, routine);
      } else if (track.type === 'instant') {
        processInstantTrack(track, elapsedMin, state);
      }
    }
  }, tickMs);

  activeRoutines[routineId] = state;
  logActivity('fade', `Started "${routine.name}" (${durationMin} min)`, { routineId, durationMin });

  return {
    id: routineId,
    name: routine.name,
    duration: durationMin,
    endsAt: new Date(startTime + durationMs).toISOString()
  };
}

async function processFadeTrack(track, elapsedMin, totalDurationMin, state, routine) {
  const wps = track.waypoints;
  if (wps.length < 2) return;

  // Scale waypoint times if testDuration differs from routine duration
  const timeScale = totalDurationMin / routine.duration;

  // Find surrounding waypoints
  let prev = wps[0], next = wps[wps.length - 1];
  for (let i = 0; i < wps.length - 1; i++) {
    const t0 = wps[i].time * timeScale;
    const t1 = wps[i + 1].time * timeScale;
    if (elapsedMin >= t0 && elapsedMin < t1) {
      prev = wps[i];
      next = wps[i + 1];
      break;
    }
  }

  // Interpolation factor within this segment
  const segStart = prev.time * timeScale;
  const segEnd = next.time * timeScale;
  const segDuration = segEnd - segStart;
  const t = segDuration > 0 ? Math.max(0, Math.min(1, (elapsedMin - segStart) / segDuration)) : 1;

  // Interpolate brightness and color
  const bri = Math.round(prev.bri + (next.bri - prev.bri) * t);
  const color = interpolateColor(prev.color, next.color, t);
  const colorState = color.xy ? { xy: color.xy } : color.ct ? { ct: color.ct } : {};

  // Transition time = tick interval (smooth between ticks)
  const tt = Math.round(state.tickMs / 100);

  for (const lightId of track.lights) {
    // Override detection: every 3rd tick (~30s), check if user manually changed
    if (routine.overrideDetection && state.tickCount % 3 === 0 && state.lastExpected[lightId] !== undefined) {
      try {
        const current = await hueGetLight(lightId);
        const actualBri = current && current.state && current.state.bri;
        const expectedBri = state.lastExpected[lightId];
        // If light is off or brightness differs by >20, user overrode
        if (current && current.state && !current.state.on) {
          logActivity('fade', `Override: light ${lightId} turned off, cancelling`, { routineId: state.id });
          cancelRoutine(state.id);
          return;
        }
        if (actualBri !== undefined && Math.abs(actualBri - expectedBri) > 20) {
          logActivity('fade', `Override: light ${lightId} bri=${actualBri} vs expected=${expectedBri}, cancelling`, { routineId: state.id });
          cancelRoutine(state.id);
          return;
        }
      } catch (e) { /* ignore read errors */ }
    }

    // Send new state
    hueLightState(lightId, { on: true, bri, transitiontime: tt, ...colorState }).catch(e =>
      console.log(`[Fade] Tick error light ${lightId}:`, e.message)
    );
    state.lastExpected[lightId] = bri;
  }
}

function processInstantTrack(track, elapsedMin, state) {
  // Scale time for test duration
  const timeScale = state.durationMs / (60000 * (config.routines[state.id] && config.routines[state.id].duration || 1));
  const triggerTime = track.time * (timeScale > 0 ? timeScale : 1);
  const key = `instant_${track.lights.join(',')}_${track.time}`;

  if (elapsedMin >= triggerTime && !state.firedInstants.has(key)) {
    state.firedInstants.add(key);
    const lightState = { ...track.state };
    if (lightState.ct || lightState.xy || lightState.bri !== undefined) {
      lightState.on = lightState.on !== undefined ? lightState.on : true;
    }
    for (const lightId of track.lights) {
      hueLightState(lightId, lightState).catch(e =>
        console.log(`[Fade] Instant event error light ${lightId}:`, e.message)
      );
    }
    logActivity('fade', `Instant event at ${track.time}min: lights [${track.lights}]`, { routineId: state.id });
  }
}

function cancelRoutine(routineId) {
  const state = activeRoutines[routineId];
  if (!state) return false;
  clearInterval(state.intervalHandle);
  delete activeRoutines[routineId];
  logActivity('fade', `Cancelled "${state.name}"`, { routineId });
  return true;
}

function getRoutineStatus(routineId) {
  const state = activeRoutines[routineId];
  if (!state) return { active: false };
  const elapsed = Date.now() - state.startTime;
  const progress = Math.min(100, (elapsed / state.durationMs) * 100);
  const remaining = Math.max(0, state.durationMs - elapsed);
  return {
    active: true,
    id: routineId,
    name: state.name,
    progress: Math.round(progress * 10) / 10,
    elapsed: Math.round(elapsed / 1000),
    remaining: Math.round(remaining / 1000),
    ticks: state.tickCount,
    startedAt: new Date(state.startTime).toISOString(),
    endsAt: new Date(state.startTime + state.durationMs).toISOString()
  };
}

// ─── SwitchBot Client ───────────────────────────────────────────────────────
function switchbotSign() {
  const token = config.switchbot.token;
  const secret = config.switchbot.secret;
  const t = Date.now().toString();
  const nonce = crypto.randomUUID();
  const data = token + t + nonce;
  const sign = crypto.createHmac('sha256', secret).update(data).digest('base64');
  return { t, sign, nonce };
}

function switchbotRequest(urlPath, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const { t, sign, nonce } = switchbotSign();
    const options = {
      hostname: 'api.switch-bot.com',
      port: 443,
      path: `/v1.1${urlPath}`,
      method,
      headers: {
        'Authorization': config.switchbot.token,
        'sign': sign,
        't': t,
        'nonce': nonce,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { resolve(data); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('SwitchBot request timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ─── API Routes: Routines ───────────────────────────────────────────────────
app.get('/api/routines', (req, res) => {
  const list = Object.entries(config.routines).map(([id, r]) => ({
    id,
    name: r.name,
    duration: r.duration,
    durationUnit: r.durationUnit || 'minutes',
    trackCount: (r.tracks || []).length,
    lightCount: (r.tracks || []).reduce((sum, t) => sum + (t.lights || []).length, 0),
    active: !!activeRoutines[id]
  }));
  res.json({ ok: true, routines: list });
});

app.get('/api/routines/:id', (req, res) => {
  const routine = config.routines[req.params.id];
  if (!routine) return res.status(404).json({ ok: false, error: 'Not found' });
  res.json({ ok: true, id: req.params.id, ...routine, active: !!activeRoutines[req.params.id] });
});

app.post('/api/routines', (req, res) => {
  try {
    const { id, name, duration, durationUnit, tracks, overrideDetection } = req.body;
    const routineId = id || name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    if (config.routines[routineId]) return res.status(409).json({ ok: false, error: 'ID already exists' });
    config.routines[routineId] = { name, duration: duration || 10, durationUnit: durationUnit || 'minutes', tracks: tracks || [], overrideDetection: overrideDetection !== false };
    saveConfig();
    logActivity('config', `Created routine "${name}"`, { routineId });
    res.json({ ok: true, id: routineId });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

app.put('/api/routines/:id', (req, res) => {
  if (!config.routines[req.params.id]) return res.status(404).json({ ok: false, error: 'Not found' });
  const updates = req.body;
  Object.assign(config.routines[req.params.id], updates);
  saveConfig();
  logActivity('config', `Updated routine "${config.routines[req.params.id].name}"`, { routineId: req.params.id });
  res.json({ ok: true, routine: config.routines[req.params.id] });
});

app.delete('/api/routines/:id', (req, res) => {
  if (!config.routines[req.params.id]) return res.status(404).json({ ok: false, error: 'Not found' });
  if (activeRoutines[req.params.id]) cancelRoutine(req.params.id);
  const name = config.routines[req.params.id].name;
  delete config.routines[req.params.id];
  saveConfig();
  logActivity('config', `Deleted routine "${name}"`, { routineId: req.params.id });
  res.json({ ok: true });
});

app.post('/api/routines/:id/start', (req, res) => {
  try {
    const result = startRoutine(req.params.id, req.body || {});
    res.json({ ok: true, ...result });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

app.post('/api/routines/:id/cancel', (req, res) => {
  const cancelled = cancelRoutine(req.params.id);
  res.json({ ok: true, cancelled });
});

app.get('/api/routines/:id/status', (req, res) => {
  res.json({ ok: true, ...getRoutineStatus(req.params.id) });
});

// ─── API Routes: Hue Proxy ─────────────────────────────────────────────────
app.get('/api/hue/lights', async (req, res) => {
  try {
    const lights = await hueGetLights();
    res.json({ ok: true, lights });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/hue/groups', async (req, res) => {
  try {
    const groups = await hueGetGroups();
    res.json({ ok: true, groups });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.put('/api/hue/lights/:id/state', async (req, res) => {
  try {
    const result = await hueLightState(req.params.id, req.body);
    res.json({ ok: true, result });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.put('/api/hue/groups/:id/action', async (req, res) => {
  try {
    const result = await hueGroupAction(req.params.id, req.body);
    res.json({ ok: true, result });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─── API Routes: SwitchBot ──────────────────────────────────────────────────
app.get('/api/switchbot/devices', async (req, res) => {
  try {
    const result = await switchbotRequest('/devices');
    res.json({ ok: true, ...result.body });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/switchbot/scenes', async (req, res) => {
  try {
    const result = await switchbotRequest('/scenes');
    res.json({ ok: true, scenes: result.body || [] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/switchbot/scene/:sceneId', async (req, res) => {
  try {
    const result = await switchbotRequest(`/scenes/${req.params.sceneId}/execute`, 'POST');
    logActivity('switchbot', `Executed scene ${req.params.sceneId}`);
    res.json({ ok: true, result: result.body });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/switchbot/other-lights/:mode', async (req, res) => {
  const mode = req.params.mode;
  const key = `other_lights_${mode}`;
  const sceneIds = config.switchbot.sceneMap && config.switchbot.sceneMap[key];
  if (!sceneIds || sceneIds.length === 0) {
    return res.status(404).json({ ok: false, error: `No scenes mapped for mode "${mode}"` });
  }
  try {
    const results = [];
    for (const sceneId of sceneIds) {
      const result = await switchbotRequest(`/scenes/${sceneId}/execute`, 'POST');
      results.push({ sceneId, result: result.body });
    }
    logActivity('switchbot', `Other Lights: ${mode}`, { scenes: sceneIds });
    res.json({ ok: true, mode, executed: results });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─── API Routes: Generic Trigger ────────────────────────────────────────────
app.post('/api/trigger/:id', (req, res) => {
  const id = req.params.id;

  // Check fade routines
  if (config.routines[id]) {
    try {
      const result = startRoutine(id, req.body || {});
      return res.json({ ok: true, type: 'routine', ...result });
    } catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
  }

  // Check SwitchBot scene map aliases
  if (config.switchbot.sceneMap && config.switchbot.sceneMap[id]) {
    const sceneIds = config.switchbot.sceneMap[id];
    Promise.all(sceneIds.map(sid => switchbotRequest(`/scenes/${sid}/execute`, 'POST')))
      .then(results => {
        logActivity('trigger', `Triggered ${id} (switchbot scenes)`, { scenes: sceneIds });
        res.json({ ok: true, type: 'switchbot', scenes: sceneIds, results: results.map(r => r.body) });
      })
      .catch(e => res.status(500).json({ ok: false, error: e.message }));
    return;
  }

  res.status(404).json({ ok: false, error: `Unknown trigger "${id}"` });
});

// ─── API Routes: Admin ──────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  const active = Object.keys(activeRoutines).map(id => getRoutineStatus(id));
  const mem = process.memoryUsage();
  res.json({
    ok: true,
    uptime: Math.round(process.uptime()),
    memory: { rss: Math.round(mem.rss / 1024 / 1024), heap: Math.round(mem.heapUsed / 1024 / 1024) },
    activeRoutines: active,
    routineCount: Object.keys(config.routines).length,
    hue: { bridgeIp: config.hue.bridgeIp, configured: !!config.hue.apiKey },
    switchbot: { configured: !!config.switchbot.token }
  });
});

app.get('/api/log', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  try {
    flushLog();
    if (!fs.existsSync(LOG_FILE)) return res.json({ ok: true, entries: [] });
    const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean);
    const entries = lines.slice(-limit).reverse().map(line => {
      try { return JSON.parse(line); } catch (e) { return { raw: line }; }
    });
    res.json({ ok: true, entries });
  } catch (e) { res.json({ ok: true, entries: [] }); }
});

app.get('/api/config/export', (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename=home-orchestrator-config.json');
  res.json(config);
});

app.post('/api/config/import', (req, res) => {
  try {
    const imported = req.body;
    if (imported.routines) config.routines = imported.routines;
    if (imported.schedules) config.schedules = imported.schedules;
    if (imported.hue) config.hue = imported.hue;
    if (imported.switchbot) config.switchbot = imported.switchbot;
    saveConfig();
    logActivity('config', 'Config imported');
    res.json({ ok: true, routines: Object.keys(config.routines).length });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// ─── Color Preview Endpoint (for UI) ────────────────────────────────────────
app.post('/api/color/preview', (req, res) => {
  const { color, bri } = req.body;
  const xy = colorToXy(color);
  if (xy) {
    const hex = xyBriToHex(xy[0], xy[1], bri || 254);
    res.json({ ok: true, xy, hex });
  } else {
    res.json({ ok: true, xy: null, hex: '#000000' });
  }
});

// ─── Startup ────────────────────────────────────────────────────────────────
async function start() {
  loadConfig();

  // Verify Hue bridge
  try {
    const bridgeConfig = await hueRequest('GET', '/config');
    console.log(`  Hue Bridge: ${bridgeConfig.name || 'connected'} (${config.hue.bridgeIp})`);
  } catch (e) {
    console.log(`  Hue Bridge: NOT reachable (${config.hue.bridgeIp}) - ${e.message}`);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n${'═'.repeat(55)}`);
    console.log(`  Home Orchestrator running at http://0.0.0.0:${PORT}`);
    console.log(`  Routines: ${Object.keys(config.routines).length}  |  Hue: ${config.hue.bridgeIp}  |  SwitchBot: ${config.switchbot.token ? 'configured' : 'not set'}`);
    console.log(`${'═'.repeat(55)}\n`);
    logActivity('startup', `Started with ${Object.keys(config.routines).length} routines`);
  });
}

start();
