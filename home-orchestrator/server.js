const express = require('express');
const http = require('http');
const https = require('https');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const cron = require('node-cron');
const { createClimate } = require('./climate');

const PORT = 5006;
const CONFIG_FILE = path.join(__dirname, 'config.json');
const LOG_FILE = path.join(__dirname, 'activity.log');
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let config = {};
let tvEveningMode = false;

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
      if (!config.daytimeGradient) config.daytimeGradient = { lights: [], openWeatherMap: { apiKey: '', lat: 0, lon: 0 } };
      if (!config.routineOrder) config.routineOrder = [];
      if (!config.sceneOrder) config.sceneOrder = [];
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
async function hueGetGroupState(id) { return hueRequest('GET', `/groups/${id}`); }

// ─── Scene Transition Helpers ────────────────────────────────────────────────
async function detectActiveScene(groupId) {
  // Get all scenes for this group
  const allScenes = await hueRequest('GET', '/scenes');
  const groupScenes = Object.entries(allScenes)
    .filter(([, sc]) => String(sc.group) === String(groupId))
    .map(([id, sc]) => ({ id, name: sc.name, lights: sc.lights }));

  if (groupScenes.length === 0) return null;

  // Get a sample light's current state
  const sampleLightId = groupScenes[0].lights[0];
  const currentLight = await hueGetLight(sampleLightId);
  if (!currentLight || !currentLight.state) return null;
  const currentXY = currentLight.state.xy;
  if (!currentXY) return null;

  // Get each scene's stored lightstate for the sample light and compare
  let bestMatch = null;
  let bestDist = Infinity;
  for (const scene of groupScenes) {
    try {
      const sceneDetail = await hueRequest('GET', `/scenes/${scene.id}`);
      const stored = sceneDetail.lightstates && sceneDetail.lightstates[String(sampleLightId)];
      if (stored && stored.xy) {
        const dx = currentXY[0] - stored.xy[0];
        const dy = currentXY[1] - stored.xy[1];
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < bestDist) { bestDist = dist; bestMatch = scene; }
      }
    } catch (e) { /* skip scenes we can't read */ }
  }
  return bestMatch;
}

function findMatchingScene(allScenes, sourceName, fromPrefixes, toPrefixes) {
  // Strip the from-prefix to get the base name
  let baseName = sourceName;
  for (const prefix of fromPrefixes) {
    if (sourceName.startsWith(prefix)) {
      baseName = sourceName.substring(prefix.length);
      break;
    }
  }

  // Try each to-prefix to find a matching scene
  for (const prefix of toPrefixes) {
    const targetName = prefix + baseName;
    const match = Object.entries(allScenes).find(([, sc]) => sc.name === targetName);
    if (match) return { id: match[0], name: match[1].name };
  }

  // Fuzzy fallback: find scenes starting with any toPrefix that contain the base name
  const baseNorm = baseName.toLowerCase().trim();
  for (const [id, sc] of Object.entries(allScenes)) {
    for (const prefix of toPrefixes) {
      if (sc.name.startsWith(prefix) && sc.name.toLowerCase().includes(baseNorm)) {
        return { id, name: sc.name };
      }
    }
  }
  return null;
}

async function executeSceneTransition(track) {
  if (!track.sceneTransition) return;
  const st = track.sceneTransition;
  try {
    const activeScene = await detectActiveScene(st.detectGroup);
    if (!activeScene) {
      logActivity('fade', `Scene transition: no active scene detected on group ${st.detectGroup}`);
      return;
    }
    logActivity('fade', `Scene transition: detected "${activeScene.name}" on group ${st.detectGroup}`);

    const allScenes = await hueRequest('GET', '/scenes');
    const target = findMatchingScene(allScenes, activeScene.name, st.fromPrefix, st.toPrefix);
    if (!target) {
      logActivity('fade', `Scene transition: no matching scene for "${activeScene.name}" with prefixes ${st.toPrefix.join(', ')}`);
      return;
    }
    const tt = st.transitionSeconds ? Math.round(st.transitionSeconds * 10) : undefined;
    const action = tt ? { scene: target.id, transitiontime: tt } : { scene: target.id };
    logActivity('fade', `Scene transition: "${activeScene.name}" -> "${target.name}" on group ${st.recallGroup}${tt ? ' over ' + st.transitionSeconds + 's' : ''}`);
    await hueGroupAction(st.recallGroup, action);
  } catch (e) {
    logActivity('fade', `Scene transition error: ${e.message}`);
  }
}

// ─── Scene Recall by Name ───────────────────────────────────────────────────
async function recallSceneByName(sceneName, groupId, transitiontime) {
  const allScenes = await hueRequest('GET', '/scenes');
  const nameNorm = sceneName.toLowerCase().trim();
  const match = Object.entries(allScenes).find(([, sc]) => sc.name.toLowerCase().trim() === nameNorm);
  if (!match) {
    logActivity('fade', `Scene recall: no scene found matching "${sceneName}"`);
    return false;
  }
  const action = { scene: match[0] };
  if (transitiontime != null) action.transitiontime = transitiontime;
  await hueGroupAction(groupId, action);
  logActivity('fade', `Scene recall: "${match[1].name}" on group ${groupId}`, { transitiontime });
  return true;
}

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

// Convert brightness percentage (1-100) to Hue bri (1-254)
function pctToHueBri(pct) { return Math.max(1, Math.min(254, Math.round(pct * 2.54))); }
function stateBriPct(state) { return state && state.bri != null ? { ...state, bri: pctToHueBri(state.bri) } : state; }

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

async function startRoutine(routineId, options = {}) {
  if (!config.routines[routineId]) throw new Error(`Routine "${routineId}" not found`);
  // Deep copy so dynamic start and runtime mutations don't alter config.json originals
  const routine = JSON.parse(JSON.stringify(config.routines[routineId]));

  // Cancel if already active
  if (activeRoutines[routineId]) {
    cancelRoutine(routineId);
  }

  // Cancel daytime gradient if this routine targets any gradient lights
  if (gradientState && config.daytimeGradient && config.daytimeGradient.lights) {
    const gradLights = new Set(config.daytimeGradient.lights.map(String));
    for (const track of routine.tracks) {
      if (track.lights && track.lights.some(l => gradLights.has(String(l)))) {
        logActivity('gradient', `Stopping gradient: routine "${routineId}" uses overlapping lights`);
        stopDaytimeGradient();
        break;
      }
    }
  }

  const durationMin = options.testDuration || routine.duration;
  const durationMs = durationMin * 60 * 1000;
  const tickMs = 10000; // 10 second tick interval
  const startTime = Date.now();

  const state = {
    id: routineId,
    name: routine.name,
    routine: routine,
    startTime,
    durationMs,
    tickMs,
    tickCount: 0,
    lastExpected: {},
    firedInstants: new Set(),
    excludedLights: new Set(),
    intervalHandle: null
  };

  // Snapshot current state of affected groups before scene starts
  const groupIdsToSnapshot = new Set();
  for (const track of routine.tracks) {
    if (track.groupId) groupIdsToSnapshot.add(String(track.groupId));
  }
  if (routine.actions) {
    for (const action of routine.actions) {
      if (action.group) groupIdsToSnapshot.add(String(action.group));
    }
  }
  if (groupIdsToSnapshot.size > 0) {
    state.snapshot = {};
    for (const gid of groupIdsToSnapshot) {
      try {
        const groupData = await hueGetGroupState(gid);
        if (groupData && groupData.action) {
          const a = groupData.action;
          const snap = { on: a.on };
          if (a.bri != null) snap.bri = a.bri;
          if (a.colormode === 'ct' && a.ct != null) snap.ct = a.ct;
          else if (a.xy) snap.xy = [...a.xy];
          snap.transitiontime = 10; // 1 second smooth restore
          state.snapshot[gid] = snap;
        }
      } catch (e) {
        logActivity('fade', `Snapshot failed for group ${gid}: ${e.message}`, { routineId });
      }
    }
    logActivity('fade', `Snapshot saved for groups: ${[...groupIdsToSnapshot].join(', ')}`, { routineId });
  }

  // Snapshot Nanoleaf state if any nanoleaf tracks exist
  const hasNanoleafTrack = routine.tracks.some(t => t.type === 'nanoleaf');
  if (hasNanoleafTrack) {
    try {
      const nlState = await nanoleafGetState();
      if (nlState) {
        if (!state.snapshot) state.snapshot = {};
        state.snapshot._nanoleaf = {
          brightness: nlState.state && nlState.state.brightness ? nlState.state.brightness.value : 50,
          effect: nlState.effects && nlState.effects.select ? nlState.effects.select : null,
          on: nlState.state && nlState.state.on ? nlState.state.on.value : true
        };
        logActivity('fade', `Snapshot saved Nanoleaf: bri=${state.snapshot._nanoleaf.brightness}, effect=${state.snapshot._nanoleaf.effect}`, { routineId });
      }
    } catch (e) {
      logActivity('fade', `Nanoleaf snapshot failed: ${e.message}`, { routineId });
    }
  }

  // Dynamic start: read current light state for t=0 on tracks that opt in
  for (const track of routine.tracks) {
    if (track.dynamicStart) {
      if (track.type === 'fade' && track.lights && track.lights.length > 0) {
        try {
          const currentLight = await hueGetLight(track.lights[0]);
          if (currentLight && currentLight.state) {
            const s = currentLight.state;
            const wp0 = { time: 0, bri: Math.round(s.bri / 2.54) };
            if (!track.brightnessOnly) {
              wp0.color = s.colormode === 'ct' ? { ct: s.ct } : { xy: s.xy };
            }
            track.waypoints[0] = wp0;
            logActivity('fade', `Dynamic start: light ${track.lights[0]} at bri:${wp0.bri}${wp0.color ? ' ' + JSON.stringify(wp0.color) : ''}`, { routineId });
          }
        } catch (e) {
          logActivity('fade', `Dynamic start failed for track, using fallback: ${e.message}`, { routineId });
        }
      }
    }
  }

  // Check excludeOnOverride before initial state (e.g., key lights already on)
  if (routine.excludeOnOverride) {
    for (const rule of routine.excludeOnOverride) {
      if (rule.hbAccessory && rule.lights) {
        try {
          const isOn = await hbGetOn(rule.hbAccessory);
          if (isOn) {
            for (const l of rule.lights) state.excludedLights.add(l);
            logActivity('fade', `Excluding ${rule.lights.length} lights at start: ${rule.description || rule.hbAccessory + ' is on'}`, { routineId });
          }
        } catch (e) { /* HAP check failed */ }
      }
    }
  }

  // Set initial state for each fade track (first waypoint)
  for (const track of routine.tracks) {
    if (track.type === 'fade' && track.waypoints && track.waypoints.length > 0) {
      const wp0 = track.waypoints[0];
      const hueBri = pctToHueBri(wp0.bri);
      const colorState = track.brightnessOnly ? {} : resolveColor(wp0.color);
      const lightState = track.brightnessOnly ? { bri: hueBri, transitiontime: 20 } : { on: true, bri: hueBri, transitiontime: 20, ...colorState };
      const initExcl = track.lights && track.lights.some(l => state.excludedLights.has(l));
      const initLights = initExcl ? track.lights.filter(l => !state.excludedLights.has(l)) : track.lights;
      if (track.groupId && !initExcl) {
        hueGroupAction(track.groupId, lightState).catch(e =>
          console.log(`[Fade] Initial set error group ${track.groupId}:`, e.message)
        );
      } else if (initLights && initLights.length > 0) {
        for (const lightId of initLights) {
          hueLightState(lightId, lightState).catch(e =>
            console.log(`[Fade] Initial set error light ${lightId}:`, e.message)
          );
        }
      }
      for (const lid of (initLights || track.lights || [])) state.lastExpected[lid] = hueBri;
    }
  }

  // Fire sonos action if configured (supports spotifyQueue, routine, or scene)
  if (routine.sonos) {
    let sonosUrl;
    let sonosBody;
    let label;
    if (routine.sonos.spotifyQueue && routine.sonos.spotifyQueue.length > 0) {
      sonosUrl = `${SONOS_BASE}/api/play-queue`;
      sonosBody = JSON.stringify({ uris: routine.sonos.spotifyQueue, volume: routine.sonos.volume || null, groupAll: true });
      label = `spotify queue: ${routine.sonos.spotifyQueue.length} tracks`;
    } else if (routine.sonos.routine) {
      sonosUrl = `${SONOS_BASE}/api/trigger/${encodeURIComponent(routine.sonos.routine)}`;
      label = `routine: ${routine.sonos.routine}`;
    } else if (routine.sonos.scene) {
      sonosUrl = `${SONOS_BASE}/api/scenes/${encodeURIComponent(routine.sonos.scene)}/execute`;
      label = `scene: ${routine.sonos.scene}`;
    }
    if (sonosUrl) {
      const sonosReq = http.request(sonosUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: 30000 }, (sonosRes) => {
        let d = ''; sonosRes.on('data', c => d += c);
        sonosRes.on('end', () => logActivity('fade', `Sonos trigger: ${label}`, { routineId }));
      });
      sonosReq.on('error', e => logActivity('fade', `Sonos trigger error: ${e.message}`, { routineId }));
      if (sonosBody) sonosReq.write(sonosBody);
      sonosReq.end();
    }
  }

  // Execute startup actions (scene recalls, etc.)
  if (routine.actions && Array.isArray(routine.actions)) {
    for (const action of routine.actions) {
      if (action.type === 'hue-scene') {
        recallSceneByName(action.sceneName, action.group, action.transitiontime).catch(e =>
          logActivity('fade', `Action error (hue-scene): ${e.message}`, { routineId })
        );
      } else if (action.type === 'hue-state') {
        hueGroupAction(action.group, stateBriPct(action.state)).then(() =>
          logActivity('fade', `Group state set on group ${action.group}`, { routineId, state: action.state })
        ).catch(e =>
          logActivity('fade', `Action error (hue-state): ${e.message}`, { routineId })
        );
      } else if (action.type === 'switchbot-scene') {
        switchbotRequest(`/scenes/${action.sceneId}/execute`, 'POST').then(() =>
          logActivity('fade', `SwitchBot scene: ${action.sceneName || action.sceneId}`, { routineId })
        ).catch(e =>
          logActivity('fade', `Action error (switchbot-scene): ${e.message}`, { routineId })
        );
      }
    }
  }

  // Set initial state for thunderstorm and pulse tracks (bri values are 0-100%, convert to Hue scale)
  for (const track of routine.tracks) {
    if (track.type === 'thunderstorm' && track.groupId) {
      const ambientState = track.ambientState || { on: true, bri: 8, xy: [0.25, 0.28], transitiontime: 20 };
      hueGroupAction(track.groupId, stateBriPct(ambientState)).catch(() => {});
    } else if (track.type === 'pulse' && track.groupId) {
      const baseState = track.baseState || { on: true, bri: 100, xy: [0.68, 0.31] };
      hueGroupAction(track.groupId, stateBriPct(baseState)).catch(() => {});
      // Start pulsing immediately
      setTimeout(() => hueGroupAction(track.groupId, { alert: 'lselect' }).catch(() => {}), 1000);
    } else if (track.type === 'nanoleaf' && track.waypoints && track.waypoints.length > 0) {
      // Apply first waypoint immediately for instant nanoleaf effects (e.g. Red Alert "Flames")
      const wp0 = track.waypoints[0];
      if (wp0.brightness != null) nanoleafSetBrightness(wp0.brightness, 1).catch(() => {});
      if (wp0.effect) nanoleafSetEffect(wp0.effect).catch(() => {});
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
          const finalState = track.brightnessOnly
            ? { bri: pctToHueBri(final.bri), transitiontime: 10 }
            : { on: true, bri: pctToHueBri(final.bri), transitiontime: 10, ...resolveColor(final.color) };
          const finalExcl = track.lights && track.lights.some(l => state.excludedLights.has(l));
          const finalLights = finalExcl ? track.lights.filter(l => !state.excludedLights.has(l)) : track.lights;
          if (track.groupId && !finalExcl) {
            hueGroupAction(track.groupId, finalState).catch(() => {});
          } else if (finalLights && finalLights.length > 0) {
            for (const lightId of finalLights) {
              hueLightState(lightId, finalState).catch(() => {});
            }
          }
        } else if (track.type === 'caseta' && track.waypoints && track.waypoints.length > 0) {
          const final = track.waypoints[track.waypoints.length - 1];
          for (const devKey of (track.devices || [])) {
            const dev = config.caseta && config.caseta.devices && config.caseta.devices[devKey];
            if (dev && dev.zoneId) casetaSetLevel(dev.zoneId, final.level, 1).catch(() => {});
          }
        } else if (track.type === 'nanoleaf' && track.waypoints && track.waypoints.length > 0) {
          const final = track.waypoints[track.waypoints.length - 1];
          nanoleafSetBrightness(final.brightness, 1).catch(() => {});
          if (final.effect) nanoleafSetEffect(final.effect).catch(() => {});
        } else if (track.type === 'homebridge' && track.waypoints && track.waypoints.length > 0 && track.accessory) {
          const final = track.waypoints[track.waypoints.length - 1];
          hbSetBrightness(track.accessory, final.brightness).catch(() => {});
        } else if (track.type === 'caseta-hap' && track.waypoints && track.waypoints.length > 0) {
          const final = track.waypoints[track.waypoints.length - 1];
          for (const devKey of (track.devices || [])) {
            casetaHapSetBrightness(devKey, final.brightness).catch(() => {});
          }
        } else if (track.type === 'thunderstorm') {
          // Restore ambient state on completion (bri is 0-100%, convert to Hue scale)
          const ambientState = track.ambientState || { on: true, bri: 8, xy: [0.25, 0.28], transitiontime: 10 };
          if (track.groupId) hueGroupAction(track.groupId, stateBriPct(ambientState)).catch(() => {});
        } else if (track.type === 'pulse') {
          // Stop pulsing on completion
          if (track.groupId) hueGroupAction(track.groupId, { alert: 'none' }).catch(() => {});
        } else if (track.type === 'tv' && track.actions && track.actions.length > 0) {
          const last = track.actions[track.actions.length - 1];
          const lastKey = `tv_${last.action}_${last.value || ''}_${last.time}`;
          if (!state.firedInstants.has(lastKey)) {
            if (last.action === 'input') samsungSetInput(last.value).catch(() => {});
            else if (last.action === 'power_on') samsungWakeOnLan().catch(() => {});
            else if (last.action === 'power_off') samsungSendKey('KEY_POWER').catch(() => {});
            else if (last.action === 'smart_power_on') samsungPowerOn().catch(() => {});
            else if (last.action === 'smart_power_off') samsungPowerOff().catch(() => {});
            else if (last.action === 'picture_mode') samsungSetPictureMode(last.value).catch(() => {});
            else if (last.action === 'volume') samsungSetVolume(last.value).catch(() => {});
            else if (last.action === 'ambient') samsungAmbientOn().catch(() => {});
          }
        }
      }

      // Execute scene transitions (skip if already fired mid-routine)
      for (const track of routine.tracks) {
        if (track.sceneTransition && !state.firedInstants.has('sceneTransition')) {
          executeSceneTransition(track).catch(e =>
            logActivity('fade', `Scene transition error: ${e.message}`)
          );
        }
      }

      clearInterval(state.intervalHandle);
      delete activeRoutines[routineId];
      logActivity('fade', `Routine "${routine.name}" completed`, { routineId, durationMin });
      return;
    }

    // Check excludeOnOverride rules (every 6th tick ~60s to avoid hammering HAP API)
    if (routine.excludeOnOverride && state.tickCount % 6 === 1) {
      for (const rule of routine.excludeOnOverride) {
        if (rule.hbAccessory && rule.lights) {
          try {
            const isOn = await hbGetOn(rule.hbAccessory);
            const alreadyExcluded = rule.lights.every(l => state.excludedLights.has(l));
            if (isOn && !alreadyExcluded) {
              for (const l of rule.lights) state.excludedLights.add(l);
              logActivity('fade', `Excluding ${rule.lights.length} lights: ${rule.description || rule.hbAccessory + ' is on'}`, { routineId });
            } else if (!isOn && alreadyExcluded) {
              for (const l of rule.lights) state.excludedLights.delete(l);
              logActivity('fade', `Re-including ${rule.lights.length} lights: ${rule.description || rule.hbAccessory + ' turned off'}`, { routineId });
            }
          } catch (e) { /* HAP check failed, keep current state */ }
        }
      }
    }

    // Drift detection: check every 3rd tick (~30s) using bulk API call
    if (routine.driftDetection && routine.driftDetection.enabled && state.tickCount % 3 === 0 && state.tickCount > 0) {
      await checkDriftDetection(state, routine);
    }

    // Mid-routine scene transitions (fire at configured time instead of waiting for completion)
    for (const track of routine.tracks) {
      if (track.sceneTransition && track.sceneTransition.time != null && !state.firedInstants.has('sceneTransition')) {
        const stTime = track.sceneTransition.time * (durationMin / routine.duration);
        if (elapsedMin >= stTime) {
          state.firedInstants.add('sceneTransition');
          executeSceneTransition(track).catch(e =>
            logActivity('fade', `Scene transition error: ${e.message}`)
          );
        }
      }
    }

    // Process each track
    for (const track of routine.tracks) {
      if (track.type === 'fade') {
        await processFadeTrack(track, elapsedMin, durationMin, state, routine);
      } else if (track.type === 'instant') {
        processInstantTrack(track, elapsedMin, state);
      } else if (track.type === 'caseta') {
        processCasetaTrack(track, elapsedMin, durationMin, state, routine);
      } else if (track.type === 'nanoleaf') {
        processNanoleafTrack(track, elapsedMin, durationMin, state, routine);
      } else if (track.type === 'homebridge') {
        processHomebridgeTrack(track, elapsedMin, durationMin, state, routine);
      } else if (track.type === 'caseta-hap') {
        processCasetaHapTrack(track, elapsedMin, durationMin, state, routine);
      } else if (track.type === 'thunderstorm') {
        processThunderstormTrack(track, elapsedMin, state);
      } else if (track.type === 'pulse') {
        processPulseTrack(track);
      } else if (track.type === 'tv') {
        processTvTrack(track, elapsedMin, state);
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

  // Filter excluded lights; fall back from group to individual commands if needed
  const hasExclusions = track.lights && track.lights.some(l => state.excludedLights.has(l));
  const effectiveLights = hasExclusions ? track.lights.filter(l => !state.excludedLights.has(l)) : track.lights;
  if (hasExclusions && effectiveLights.length === 0) return; // all lights excluded

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

  // Interpolate brightness (in percentage space)
  const briPct = prev.bri + (next.bri - prev.bri) * t;
  const bri = pctToHueBri(briPct);

  // Transition time = tick interval (smooth between ticks)
  const tt = Math.round(state.tickMs / 100);

  if (track.brightnessOnly) {
    // Only set brightness - preserve active Hue Dynamic scenes
    const briVal = Math.round(briPct * 2.54);
    const stateCmd = { bri: Math.max(1, Math.min(254, briVal)), transitiontime: tt };
    if (track.groupId && !hasExclusions) {
      hueGroupAction(track.groupId, stateCmd).catch(e =>
        console.log(`[Fade] Tick error group ${track.groupId}:`, e.message)
      );
    } else {
      for (const lightId of effectiveLights) {
        hueLightState(lightId, stateCmd).catch(e =>
          console.log(`[Fade] Tick error light ${lightId}:`, e.message)
        );
      }
    }
    for (const lid of effectiveLights) state.lastExpected[lid] = stateCmd.bri;
  } else {
    // Interpolate color only for non-brightnessOnly tracks
    const color = interpolateColor(prev.color, next.color, t);
    const colorState = color.xy ? { xy: color.xy } : color.ct ? { ct: color.ct } : {};

    // Override detection: check light-off every tick, brightness drift every 3rd tick
    if (routine.overrideDetection && state.lastExpected[track.lights[0]] !== undefined) {
      const checkId = track.lights[0];
      try {
        const current = await hueGetLight(checkId);
        // Light turned off = user wants to stop the routine (check every tick)
        if (current && current.state && !current.state.on) {
          logActivity('fade', `Override: light ${checkId} turned off, cancelling`, { routineId: state.id });
          cancelRoutine(state.id);
          return;
        }
        // Brightness drift check every 3rd tick (~30s) to catch manual adjustments
        if (state.tickCount % 3 === 0) {
          const actualBri = current && current.state && current.state.bri;
          const expectedBri = state.lastExpected[checkId];
          if (actualBri !== undefined && Math.abs(actualBri - expectedBri) > 20) {
            logActivity('fade', `Override: light ${checkId} bri=${actualBri} vs expected=${expectedBri}, cancelling`, { routineId: state.id });
            cancelRoutine(state.id);
            return;
          }
        }
      } catch (e) { /* ignore read errors */ }
    }

    // Send new state
    const stateCmd = { on: true, bri, transitiontime: tt, ...colorState };
    if (track.groupId && !hasExclusions) {
      hueGroupAction(track.groupId, stateCmd).catch(e =>
        console.log(`[Fade] Tick error group ${track.groupId}:`, e.message)
      );
    } else {
      for (const lightId of effectiveLights) {
        hueLightState(lightId, stateCmd).catch(e =>
          console.log(`[Fade] Tick error light ${lightId}:`, e.message)
        );
      }
    }
    for (const lid of effectiveLights) state.lastExpected[lid] = bri;
  }
}

async function checkDriftDetection(state, routine) {
  const dd = routine.driftDetection;
  if (!dd || !dd.enabled) return;

  // Determine which lights to monitor
  let monitorLights = dd.lights && dd.lights.length > 0 ? dd.lights : null;
  if (!monitorLights) {
    const allLights = new Set();
    for (const track of routine.tracks) {
      if (track.type === 'fade' && track.lights) {
        for (const l of track.lights) allLights.add(l);
      }
    }
    monitorLights = [...allLights];
  }

  // Filter out already excluded and lights we haven't sent a command to yet
  const toCheck = monitorLights.filter(l =>
    !state.excludedLights.has(l) && state.lastExpected[l] !== undefined
  );
  if (toCheck.length === 0) return;

  let allLightsData;
  try {
    allLightsData = await hueGetLights();
  } catch (e) { return; }

  const thresholdHue = Math.round((dd.thresholdPct || 8) * 2.54);

  for (const lightId of toCheck) {
    const lightData = allLightsData[String(lightId)];
    if (!lightData || !lightData.state) continue;

    if (!lightData.state.on) {
      state.excludedLights.add(lightId);
      const name = lightData.name || lightId;
      logActivity('fade', `Drift: light ${lightId} (${name}) turned off, excluding`, { routineId: state.id });
      continue;
    }

    const actualBri = lightData.state.bri;
    const expectedBri = state.lastExpected[lightId];
    if (actualBri !== undefined && Math.abs(actualBri - expectedBri) > thresholdHue) {
      const name = lightData.name || lightId;
      const actualPct = Math.round(actualBri / 2.54);
      const expectedPct = Math.round(expectedBri / 2.54);
      if (dd.cancelOnBrighterOverride && actualBri > expectedBri + thresholdHue) {
        logActivity('fade', `Drift: light ${lightId} (${name}) bri=${actualPct}% vs expected=${expectedPct}% — brighter override, cancelling routine`, { routineId: state.id });
        cancelRoutine(state.id);
        return;
      }
      state.excludedLights.add(lightId);
      logActivity('fade', `Drift: light ${lightId} (${name}) bri=${actualPct}% vs expected=${expectedPct}% (threshold ${dd.thresholdPct}%), excluding`, { routineId: state.id });
    }
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
    if (lightState.bri !== undefined) lightState.bri = pctToHueBri(lightState.bri);
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

function processCasetaTrack(track, elapsedMin, totalDurationMin, state, routine) {
  if (!track.waypoints || track.waypoints.length < 2 || !track.devices) return;
  const timeScale = totalDurationMin / routine.duration;
  const wps = track.waypoints;

  // Find surrounding waypoints
  let prev = wps[0], next = wps[wps.length - 1];
  for (let i = 0; i < wps.length - 1; i++) {
    const t0 = wps[i].time * timeScale;
    const t1 = wps[i + 1].time * timeScale;
    if (elapsedMin >= t0 && elapsedMin < t1) { prev = wps[i]; next = wps[i + 1]; break; }
  }

  // Caseta hardware handles the fade -- send GoToDimmedLevel with FadeTime = seconds to next waypoint
  // Only send at waypoint boundaries (when we cross into a new segment), not every tick
  const segKey = `caseta_${prev.time}_${next.time}`;
  if (state.firedInstants.has(segKey)) return;
  state.firedInstants.add(segKey);

  const fadeTimeSec = (next.time - prev.time) * timeScale * 60; // minutes to seconds
  for (const devKey of track.devices) {
    const dev = config.caseta && config.caseta.devices && config.caseta.devices[devKey];
    if (dev && dev.zoneId) {
      casetaSetLevel(dev.zoneId, next.level, fadeTimeSec).catch(e =>
        console.log(`[Fade] Caseta error ${devKey}:`, e.message)
      );
    }
  }
  logActivity('fade', `Caseta: ${track.devices.join(',')} -> level ${next.level} over ${Math.round(fadeTimeSec)}s`, { routineId: state.id });
}

function processNanoleafTrack(track, elapsedMin, totalDurationMin, state, routine) {
  if (!track.waypoints || track.waypoints.length === 0) return;
  // Single waypoint: already applied at startup, nothing to interpolate
  if (track.waypoints.length < 2) return;
  const timeScale = totalDurationMin / routine.duration;
  const wps = track.waypoints;

  // Find surrounding waypoints
  let prev = wps[0], next = wps[wps.length - 1];
  for (let i = 0; i < wps.length - 1; i++) {
    const t0 = wps[i].time * timeScale;
    const t1 = wps[i + 1].time * timeScale;
    if (elapsedMin >= t0 && elapsedMin < t1) { prev = wps[i]; next = wps[i + 1]; break; }
  }

  // Nanoleaf hardware handles smooth fading -- send brightness with duration
  const segKey = `nanoleaf_${prev.time}_${next.time}`;
  if (state.firedInstants.has(segKey)) return;
  state.firedInstants.add(segKey);

  const durationSec = (next.time - prev.time) * timeScale * 60;
  nanoleafSetBrightness(next.brightness, durationSec).catch(e =>
    console.log(`[Fade] Nanoleaf brightness error:`, e.message)
  );
  // Set effect if specified on the next waypoint (instant change)
  if (next.effect) {
    nanoleafSetEffect(next.effect).catch(e =>
      console.log(`[Fade] Nanoleaf effect error:`, e.message)
    );
  }
  logActivity('fade', `Nanoleaf: brightness ${next.brightness}% over ${Math.round(durationSec)}s${next.effect ? ', effect: ' + next.effect : ''}`, { routineId: state.id });
}

// ─── Homebridge HAP track (controls dummy dimmers via local HAP API) ───
const HB_HAP_PORT = 51698;
const HB_HAP_PIN = '708-41-495';
let hbAccessoryCache = null;

function hbHapRequest(method, urlPath, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1', port: HB_HAP_PORT, path: urlPath, method,
      headers: { 'Content-Type': 'application/json', 'Authorization': HB_HAP_PIN },
      timeout: 5000
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { resolve(data); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('HAP timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function hbFindAccessory(namePattern) {
  if (!hbAccessoryCache) {
    const resp = await hbHapRequest('GET', '/accessories');
    hbAccessoryCache = resp.accessories || [];
    // Cache for 5 min then refresh
    setTimeout(() => { hbAccessoryCache = null; }, 300000);
  }
  for (const acc of hbAccessoryCache) {
    const nameChr = acc.services.flatMap(s => s.characteristics).find(c => c.description === 'Name');
    if (nameChr && nameChr.value && nameChr.value.includes(namePattern)) {
      const briChr = acc.services.flatMap(s => s.characteristics).find(c => c.description === 'Brightness');
      const onChr = acc.services.flatMap(s => s.characteristics).find(c => c.description === 'On');
      if (briChr) return { aid: acc.aid, briIid: briChr.iid, onIid: onChr ? onChr.iid : null };
    }
  }
  return null;
}

async function hbSetBrightness(namePattern, pct) {
  const acc = await hbFindAccessory(namePattern);
  if (!acc) { console.log(`[homebridge] Accessory "${namePattern}" not found`); return; }
  const chars = [{ aid: acc.aid, iid: acc.briIid, value: Math.round(pct) }];
  if (acc.onIid && pct > 0) chars.push({ aid: acc.aid, iid: acc.onIid, value: true });
  await hbHapRequest('PUT', '/characteristics', { characteristics: chars });
}

async function hbGetOn(namePattern) {
  const acc = await hbFindAccessory(namePattern);
  if (!acc || !acc.onIid) return false;
  const resp = await hbHapRequest('GET', `/characteristics?id=${acc.aid}.${acc.onIid}`);
  const ch = resp && resp.characteristics && resp.characteristics[0];
  return ch ? !!ch.value : false;
}

function processHomebridgeTrack(track, elapsedMin, totalDurationMin, state, routine) {
  if (!track.waypoints || track.waypoints.length < 2 || !track.accessory) return;
  const timeScale = totalDurationMin / routine.duration;
  const wps = track.waypoints;

  // Find surrounding waypoints and interpolate (like Hue fade, but brightness only)
  let prev = wps[0], next = wps[wps.length - 1];
  for (let i = 0; i < wps.length - 1; i++) {
    const t0 = wps[i].time * timeScale;
    const t1 = wps[i + 1].time * timeScale;
    if (elapsedMin >= t0 && elapsedMin < t1) { prev = wps[i]; next = wps[i + 1]; break; }
  }

  const t0 = prev.time * timeScale, t1 = next.time * timeScale;
  const frac = t1 > t0 ? Math.min(1, (elapsedMin - t0) / (t1 - t0)) : 1;
  const bri = prev.brightness + (next.brightness - prev.brightness) * frac;

  hbSetBrightness(track.accessory, bri).catch(e =>
    console.log(`[Fade] Homebridge error (${track.accessory}):`, e.message)
  );
}

// ─── Caseta LEAP Client (lutron-leap) ───────────────────────────────────────
const CASETA_LEAP_FILE = path.join(__dirname, 'caseta-leap-creds.json');
let casetaLeapClient = null;
let casetaLeapCreds = null;
let casetaLeapDevices = null; // populated at startup

function loadCasetaLeapCreds() {
  if (!fs.existsSync(CASETA_LEAP_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(CASETA_LEAP_FILE, 'utf8')); }
  catch (e) { console.error('[Caseta LEAP] Creds load error:', e.message); return null; }
}

async function getCasetaLeapClient() {
  if (casetaLeapClient) return casetaLeapClient;
  if (!casetaLeapCreds) casetaLeapCreds = loadCasetaLeapCreds();
  if (!casetaLeapCreds) throw new Error('Caseta LEAP not paired');
  const { LeapClient } = require('lutron-leap');
  const client = new LeapClient(
    casetaLeapCreds.bridgeIp,
    casetaLeapCreds.leapPort || 8081,
    casetaLeapCreds.rootCert,
    casetaLeapCreds.privateKey,
    casetaLeapCreds.cert
  );
  await client.connect();
  casetaLeapClient = client;
  return client;
}

async function casetaHapSetBrightness(deviceKey, brightness) {
  // Resolve zone href from device key
  if (!casetaLeapDevices) throw new Error('Caseta LEAP devices not loaded');
  const dev = casetaLeapDevices[deviceKey];
  if (!dev) throw new Error(`Caseta device "${deviceKey}" not found`);
  const client = await getCasetaLeapClient();
  const level = Math.round(Math.max(0, Math.min(100, brightness)));
  await client.request('CreateRequest', `${dev.zoneHref}/commandprocessor`, {
    Command: { CommandType: 'GoToLevel', Parameter: [{ Type: 'Level', Value: level }] }
  });
}

function processCasetaHapTrack(track, elapsedMin, totalDurationMin, state, routine) {
  if (!track.waypoints || track.waypoints.length < 2 || !track.devices) return;
  const timeScale = totalDurationMin / routine.duration;
  const wps = track.waypoints;
  let prev = wps[0], next = wps[wps.length - 1];
  for (let i = 0; i < wps.length - 1; i++) {
    const t0 = wps[i].time * timeScale;
    const t1 = wps[i + 1].time * timeScale;
    if (elapsedMin >= t0 && elapsedMin < t1) { prev = wps[i]; next = wps[i + 1]; break; }
  }
  const t0 = prev.time * timeScale, t1 = next.time * timeScale;
  const frac = t1 > t0 ? Math.min(1, (elapsedMin - t0) / (t1 - t0)) : 1;
  const bri = prev.brightness + (next.brightness - prev.brightness) * frac;
  for (const devKey of track.devices) {
    casetaHapSetBrightness(devKey, bri).catch(e =>
      console.log(`[Fade] Caseta LEAP error (${devKey}):`, e.message)
    );
  }
}

function processThunderstormTrack(track, elapsedMin, state) {
  if (!track.groupId && !track.lights) return;
  const now = Date.now();
  const minGap = (track.minFlashInterval || 4) * 1000;
  const maxGap = (track.maxFlashInterval || 15) * 1000;
  if (!track._lastFlash) track._lastFlash = now - minGap;
  if (!track._nextGap) track._nextGap = minGap + Math.random() * (maxGap - minGap);

  if (now - track._lastFlash >= track._nextGap) {
    track._lastFlash = now;
    track._nextGap = minGap + Math.random() * (maxGap - minGap);
    // flashMaxBri is 0-100%, controls overall peak brightness for all flashes (default 67%)
    const maxBriHue = pctToHueBri(track.flashMaxBri || 67);
    const bri = (pct) => Math.max(1, Math.round(maxBriHue * pct));
    const flashBase = track.flashState || { on: true, ct: 153, transitiontime: 0 };
    const flash = { ...flashBase, bri: bri(1.0) };
    const ambient = stateBriPct(track.ambientState || { on: true, bri: 8, xy: [0.25, 0.28], transitiontime: 3 });
    const setFn = track.groupId
      ? (s) => hueGroupAction(track.groupId, s)
      : (s) => Promise.all(track.lights.map(id => hueLightState(id, s)));

    // Build a realistic lightning flicker sequence: rapid bursts of varying intensity
    const roll = Math.random();
    const flickers = [];
    if (roll < 0.25) {
      // Single quick flash (25%)
      flickers.push({ state: flash, hold: 80 });
      flickers.push({ state: ambient, hold: 0 });
    } else if (roll < 0.55) {
      // Double flash with brief dark gap (30%)
      flickers.push({ state: flash, hold: 60 });
      flickers.push({ state: ambient, hold: 120 });
      flickers.push({ state: flash, hold: 100 });
      flickers.push({ state: ambient, hold: 0 });
    } else if (roll < 0.80) {
      // Triple flicker -- rapid strobe burst (25%)
      flickers.push({ state: flash, hold: 50 });
      flickers.push({ state: { ...flashBase, bri: bri(0.5) }, hold: 80 });
      flickers.push({ state: flash, hold: 60 });
      flickers.push({ state: { ...flashBase, bri: bri(0.3) }, hold: 100 });
      flickers.push({ state: flash, hold: 40 });
      flickers.push({ state: ambient, hold: 0 });
    } else {
      // Long rolling flicker -- sustained lightning (20%)
      flickers.push({ state: { ...flashBase, bri: bri(0.7) }, hold: 100 });
      flickers.push({ state: flash, hold: 80 });
      flickers.push({ state: { ...flashBase, bri: bri(0.55) }, hold: 120 });
      flickers.push({ state: ambient, hold: 200 });
      flickers.push({ state: { ...flashBase, bri: bri(0.8) }, hold: 60 });
      flickers.push({ state: flash, hold: 90 });
      flickers.push({ state: { ...flashBase, bri: bri(0.4) }, hold: 150 });
      flickers.push({ state: ambient, hold: 0 });
    }

    // Execute the flicker sequence with setTimeout chain
    let delay = 0;
    for (const step of flickers) {
      setTimeout(() => setFn(step.state).catch(() => {}), delay);
      delay += step.hold;
    }
  }
}

function processPulseTrack(track) {
  if (!track.groupId) return;
  // Re-issue lselect alert each tick to keep pulsing (lselect lasts 15s, tick is 10s)
  hueGroupAction(track.groupId, { alert: 'lselect' }).catch(() => {});
}

function processTvTrack(track, elapsedMin, state) {
  if (!track.actions || track.actions.length === 0) return;
  for (const action of track.actions) {
    const key = `tv_${action.action}_${action.value || ''}_${action.time}`;
    if (elapsedMin >= action.time && !state.firedInstants.has(key)) {
      state.firedInstants.add(key);
      if (action.action === 'power_on') {
        samsungWakeOnLan().catch(e => console.log(`[Fade] Samsung WoL error:`, e.message));
      } else if (action.action === 'power_off') {
        samsungSendKey('KEY_POWER').catch(e => console.log(`[Fade] Samsung power off error:`, e.message));
      } else if (action.action === 'input') {
        samsungSetInput(action.value).catch(e => console.log(`[Fade] Samsung input error:`, e.message));
      } else if (action.action === 'key') {
        samsungSendKey(action.value).catch(e => console.log(`[Fade] Samsung key error:`, e.message));
      } else if (action.action === 'smart_power_on') {
        samsungPowerOn().catch(e => console.log(`[Fade] Samsung smart power on error:`, e.message));
      } else if (action.action === 'smart_power_off') {
        samsungPowerOff().catch(e => console.log(`[Fade] Samsung smart power off error:`, e.message));
      } else if (action.action === 'picture_mode') {
        samsungSetPictureMode(action.value).catch(e => console.log(`[Fade] Samsung picture mode error:`, e.message));
      } else if (action.action === 'volume') {
        samsungSetVolume(action.value).catch(e => console.log(`[Fade] Samsung volume error:`, e.message));
      } else if (action.action === 'ambient') {
        samsungAmbientOn().catch(e => console.log(`[Fade] Samsung ambient error:`, e.message));
      } else if (action.action === 'energy_saving') {
        samsungSetEnergySaving(action.value === 'on').catch(e => console.log(`[Fade] Samsung energy saving error:`, e.message));
      }
      logActivity('fade', `Samsung TV: ${action.action} ${action.value || ''}`, { routineId: state.id });
    }
  }
}

function cancelRoutine(routineId) {
  const state = activeRoutines[routineId];
  if (!state) return false;
  clearInterval(state.intervalHandle);

  // Run cleanup for special track types
  if (state.routine && state.routine.tracks) {
    for (const track of state.routine.tracks) {
      if (track.type === 'thunderstorm') {
        if (track.groupId) {
          // Send alert none to stop any pending flash, then restore
          hueGroupAction(track.groupId, { alert: 'none' }).catch(() => {});
        }
      } else if (track.type === 'pulse') {
        if (track.groupId) {
          hueGroupAction(track.groupId, { alert: 'none' }).catch(() => {});
        }
      }
    }
  }

  // Restore snapshot if available (previous light states before scene started)
  if (state.snapshot) {
    for (const [groupId, savedState] of Object.entries(state.snapshot)) {
      if (groupId === '_nanoleaf') continue; // handled separately below
      // Small delay to let alert:none take effect first
      setTimeout(() => {
        hueGroupAction(groupId, savedState).catch(() => {});
      }, 300);
    }
    // Restore Nanoleaf state
    if (state.snapshot._nanoleaf) {
      const nl = state.snapshot._nanoleaf;
      setTimeout(() => {
        if (nl.on === false) {
          nanoleafSetBrightness(0, 1).catch(() => {});
        } else {
          nanoleafSetBrightness(nl.brightness, 1).catch(() => {});
          if (nl.effect) nanoleafSetEffect(nl.effect).catch(() => {});
        }
      }, 300);
      logActivity('fade', `Restored Nanoleaf: bri=${nl.brightness}, effect=${nl.effect}`, { routineId });
    }
    logActivity('fade', `Restored snapshot for groups: ${Object.keys(state.snapshot).filter(k => k !== '_nanoleaf').join(', ')}`, { routineId });
  }

  // Stop Sonos music if this routine triggered it
  if (state.routine && state.routine.sonos) {
    const pauseReq = http.request(`${SONOS_BASE}/api/trigger/Sonos_Off`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: 5000 }, () => {
      logActivity('fade', `Sonos paused (scene cancel)`, { routineId });
    });
    pauseReq.on('error', () => {});
    pauseReq.end();
  }

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
    endsAt: new Date(state.startTime + state.durationMs).toISOString(),
    excludedLights: [...state.excludedLights]
  };
}

// ─── Daytime Gradient Engine ─────────────────────────────────────────────────
let gradientState = null;
let gradientTestState = null;

function fetchCloudCover() {
  return new Promise((resolve, reject) => {
    const cfg = config.daytimeGradient.openWeatherMap;
    const url = `/data/2.5/weather?lat=${cfg.lat}&lon=${cfg.lon}&appid=${cfg.apiKey}&units=metric`;
    const req = https.get({ hostname: 'api.openweathermap.org', path: url, timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.clouds && json.clouds.all != null) resolve(json.clouds.all);
          else reject(new Error('No cloud data in response'));
        } catch (e) { reject(new Error(`Weather parse error: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Weather API timeout')); });
  });
}

function ctToK(ct) { return '~' + Math.round(1e6 / ct) + 'K'; }

function cloudPctToCt(cloudPct) {
  const cfg = config.daytimeGradient;
  const sunnyCap = cfg.sunnyCapPct || 0;
  const cloudCap = cfg.cloudCapPct || 70;
  const sunny = (cfg.sunnyColor && cfg.sunnyColor.ct) || 233;
  const cloudy = (cfg.cloudyColor && cfg.cloudyColor.ct) || 343;
  if (cloudPct <= sunnyCap) return sunny;
  if (cloudPct >= cloudCap) return cloudy;
  const t = (cloudPct - sunnyCap) / (cloudCap - sunnyCap);
  return Math.round(sunny + (cloudy - sunny) * t);
}

async function startDaytimeGradient() {
  if (gradientState) stopDaytimeGradient();

  // Persist running state so gradient auto-resumes after service restart
  if (!config.daytimeGradient.gradientWasRunning) {
    config.daytimeGradient.gradientWasRunning = true;
    saveConfig();
  }

  const cfg = config.daytimeGradient;
  if (!cfg.openWeatherMap || !cfg.openWeatherMap.apiKey || cfg.openWeatherMap.apiKey === 'USER_KEY_HERE') {
    throw new Error('OpenWeatherMap API key not configured');
  }
  if (!cfg.lights || cfg.lights.length === 0) {
    throw new Error('No lights configured for daytime gradient');
  }

  // Cancel any conflicting active routines rather than blocking gradient start
  const gradientLightSet = new Set(cfg.lights.map(String));
  for (const [routineId, rState] of Object.entries(activeRoutines)) {
    if (rState.routine && rState.routine.tracks) {
      for (const track of rState.routine.tracks) {
        if (track.lights && track.lights.some(l => gradientLightSet.has(String(l)))) {
          logActivity('gradient', `Cancelling conflicting routine "${routineId}" to start gradient`);
          cancelRoutine(routineId);
          break;
        }
      }
    }
  }

  let initialCloudPct;
  try {
    initialCloudPct = await fetchCloudCover();
  } catch (e) {
    logActivity('gradient', `Weather fetch failed on start, using 50%: ${e.message}`);
    initialCloudPct = 50;
  }

  const initialCt = cloudPctToCt(initialCloudPct);
  const bri = pctToHueBri(cfg.brightness || 100);
  const tickSec = cfg.tickSeconds || 30;
  const pollMin = cfg.weatherPollMinutes || 5;
  const stepsPerPoll = (pollMin * 60) / tickSec;

  gradientState = {
    running: true,
    startTime: Date.now(),
    currentCt: initialCt,
    targetCt: initialCt,
    lastSentCt: initialCt,
    cloudPct: initialCloudPct,
    tickCount: 0,
    stepsPerPoll,
    lastWeatherPoll: new Date(),
    weatherError: null,
    overrideStrikes: 0,
    excludedLights: new Set(),
    weatherTimer: null,
    tickTimer: null
  };

  // Check excludeOnOverride at start (e.g., key lights already on)
  if (cfg.excludeOnOverride) {
    for (const rule of cfg.excludeOnOverride) {
      if (rule.hbAccessory && rule.lights) {
        try {
          const isOn = await hbGetOn(rule.hbAccessory);
          if (isOn) {
            for (const l of rule.lights) gradientState.excludedLights.add(l);
            logActivity('gradient', `Excluding ${rule.lights.length} lights at start: ${rule.description || rule.hbAccessory + ' is on'}`);
          }
        } catch (e) { /* HAP check failed */ }
      }
    }
  }

  // Apply initial state (staggered to avoid overwhelming bridge)
  const initLights = cfg.lights.filter(l => !gradientState.excludedLights.has(l));
  initLights.forEach((lightId, i) => {
    setTimeout(() => {
      hueLightState(lightId, { on: true, bri, ct: initialCt, transitiontime: 20 }).catch(e =>
        logActivity('gradient', `Initial set error light ${lightId}: ${e.message}`)
      );
    }, i * 100);
  });

  // Verify lights actually turned on after stagger completes, retry any that didn't respond
  setTimeout(async () => {
    if (!gradientState) return;
    try {
      const allLightsData = await hueGetLights();
      for (const lightId of initLights) {
        const ld = allLightsData[String(lightId)];
        if (ld && ld.state && !ld.state.on) {
          logActivity('gradient', `Retry: light ${lightId} (${ld.name}) did not turn on, resending`);
          hueLightState(lightId, { on: true, bri, ct: initialCt, transitiontime: 5 }).catch(e =>
            logActivity('gradient', `Retry error light ${lightId}: ${e.message}`)
          );
        }
      }
    } catch (e) { /* verification fetch failed, skip retry */ }
  }, initLights.length * 100 + 5000);

  // Weather polling
  gradientState.weatherTimer = setInterval(async () => {
    try {
      const cloudPct = await fetchCloudCover();
      gradientState.cloudPct = cloudPct;
      gradientState.targetCt = cloudPctToCt(cloudPct);
      gradientState.lastWeatherPoll = new Date();
      gradientState.weatherError = null;
      logActivity('gradient', `Weather: ${cloudPct}% clouds -> target ${ctToK(gradientState.targetCt)}`);
    } catch (e) {
      gradientState.weatherError = e.message;
      logActivity('gradient', `Weather poll failed (keeping target ${ctToK(gradientState.targetCt)}): ${e.message}`);
    }
  }, pollMin * 60 * 1000);

  // Tick loop
  const tickMs = tickSec * 1000;
  const overrideCtThresh = cfg.overrideThreshold || 50;

  // Helper: stagger light commands with 100ms gaps to avoid overwhelming the Hue bridge
  function staggerLightCommands(lights, state) {
    lights.forEach((lightId, i) => {
      setTimeout(() => {
        if (!gradientState) return;
        hueLightState(lightId, state).catch(e =>
          console.log(`[Gradient] Tick error light ${lightId}: ${e.message}`)
        );
      }, i * 100);
    });
  }

  // Helper: check a single light for override
  async function checkGradientOverride() {
    const groupId = (cfg.monitorGroups && cfg.monitorGroups[0]) || 8;
    const groupState = await hueGetGroupState(groupId);
    if (!groupState || !groupState.action) return null;
    const action = groupState.action;
    // Entire group turned off
    if (groupState.state && !groupState.state.any_on) {
      return { reason: `group ${groupId} all lights off`, immediate: true };
    }
    // Colormode shifted away from CT (scene applied XY/HS colors)
    if (action.colormode && action.colormode !== 'ct') {
      return { reason: `group ${groupId} colormode=${action.colormode} (expected ct)`, immediate: false };
    }
    // CT drift beyond threshold
    if (action.ct != null && gradientState.lastSentCt) {
      const drift = Math.abs(action.ct - gradientState.lastSentCt);
      if (drift > overrideCtThresh) {
        return { reason: `group ${groupId} ct=${action.ct} vs sent=${gradientState.lastSentCt} (drift=${drift})`, immediate: false };
      }
    }
    return null;
  }

  gradientState.tickTimer = setInterval(async () => {
    if (!gradientState) return;
    gradientState.tickCount++;

    // Check excludeOnOverride rules (every 6th tick ~3min at 30s ticks)
    if (cfg.excludeOnOverride && gradientState.tickCount % 6 === 1) {
      for (const rule of cfg.excludeOnOverride) {
        if (rule.hbAccessory && rule.lights) {
          try {
            const isOn = await hbGetOn(rule.hbAccessory);
            const alreadyExcluded = rule.lights.every(l => gradientState.excludedLights.has(l));
            if (isOn && !alreadyExcluded) {
              for (const l of rule.lights) gradientState.excludedLights.add(l);
              logActivity('gradient', `Excluding ${rule.lights.length} lights: ${rule.description || rule.hbAccessory + ' is on'}`);
            } else if (!isOn && alreadyExcluded) {
              for (const l of rule.lights) gradientState.excludedLights.delete(l);
              logActivity('gradient', `Re-including ${rule.lights.length} lights: ${rule.description || rule.hbAccessory + ' turned off'}`);
            }
          } catch (e) { /* HAP check failed */ }
        }
      }
    }

    // Override detection: group-level check every tick
    try {
      const override = await checkGradientOverride();
      if (override) {
        if (override.immediate) {
          logActivity('gradient', `Override: ${override.reason}, stopping immediately`);
          stopDaytimeGradient();
          return;
        }
        gradientState.overrideStrikes = (gradientState.overrideStrikes || 0) + 1;
        logActivity('gradient', `Override strike ${gradientState.overrideStrikes}/3: ${override.reason}`);
        if (gradientState.overrideStrikes >= 3) {
          // Confirm with scene detection before stopping
          let sceneName = null;
          try {
            const monitorGroups = cfg.monitorGroups || [8, 12];
            for (const gid of monitorGroups) {
              const scene = await detectActiveScene(gid);
              if (scene) { sceneName = scene.name; break; }
            }
          } catch (e) {}
          if (sceneName) {
            logActivity('gradient', `Override confirmed: scene "${sceneName}" active, stopping`);
          } else {
            logActivity('gradient', `Override confirmed: external change detected, stopping`);
          }
          stopDaytimeGradient();
          return;
        }
      } else {
        if (gradientState.overrideStrikes > 0) {
          logActivity('gradient', `Override cleared, resetting strikes`);
        }
        gradientState.overrideStrikes = 0;
      }
    } catch (e) { /* ignore read errors */ }

    // Smooth interpolation toward target
    const diff = gradientState.targetCt - gradientState.currentCt;
    if (Math.abs(diff) < 1) {
      gradientState.currentCt = gradientState.targetCt;
      return;
    }

    const stepSize = Math.max(1, Math.abs(diff) / gradientState.stepsPerPoll);
    gradientState.currentCt = Math.round(gradientState.currentCt + (diff > 0 ? Math.min(stepSize, diff) : Math.max(-stepSize, diff)));

    // Clamp to configured range
    const minCt = Math.min((cfg.sunnyColor && cfg.sunnyColor.ct) || 233, (cfg.cloudyColor && cfg.cloudyColor.ct) || 343);
    const maxCt = Math.max((cfg.sunnyColor && cfg.sunnyColor.ct) || 233, (cfg.cloudyColor && cfg.cloudyColor.ct) || 343);
    gradientState.currentCt = Math.max(minCt, Math.min(maxCt, gradientState.currentCt));

    const tt = Math.round(tickMs / 100);
    const effectiveGradLights = gradientState.excludedLights.size > 0 ? cfg.lights.filter(l => !gradientState.excludedLights.has(l)) : cfg.lights;
    if (effectiveGradLights.length > 0) staggerLightCommands(effectiveGradLights, { on: true, bri, ct: gradientState.currentCt, transitiontime: tt });
    gradientState.lastSentCt = gradientState.currentCt;
  }, tickMs);

  logActivity('gradient', `Started daytime gradient (${initialCloudPct}% clouds -> ${ctToK(initialCt)})`);
  return { cloudPct: initialCloudPct, ct: initialCt };
}

function stopDaytimeGradient() {
  if (!gradientState) return false;
  clearInterval(gradientState.weatherTimer);
  clearInterval(gradientState.tickTimer);
  const uptime = Math.round((Date.now() - gradientState.startTime) / 60000);
  logActivity('gradient', `Stopped daytime gradient (ran ${uptime} min)`);
  gradientState = null;
  // Persist stopped state
  if (config.daytimeGradient.gradientWasRunning) {
    config.daytimeGradient.gradientWasRunning = false;
    saveConfig();
  }
  return true;
}

async function testDaytimeGradient() {
  if (gradientState) stopDaytimeGradient();
  if (gradientTestState) { clearTimeout(gradientTestState._t2); clearTimeout(gradientTestState._t3); clearTimeout(gradientTestState._t4); clearTimeout(gradientTestState._tend); }
  const cfg = config.daytimeGradient;
  if (!cfg.lights || cfg.lights.length === 0) throw new Error('No lights configured');
  const sunnyCt = (cfg.sunnyColor && cfg.sunnyColor.ct) || 233;
  const cloudyCt = (cfg.cloudyColor && cfg.cloudyColor.ct) || 343;
  const midCt = Math.round((sunnyCt + cloudyCt) / 2);
  const bri = pctToHueBri(cfg.brightness || 100);

  const phases = [
    { at: 0, dur: 2, label: `Setting sunny (${ctToK(sunnyCt)})`, fromCt: sunnyCt, toCt: sunnyCt },
    { at: 2, dur: 20, label: `Fading sunny -> cloudy`, fromCt: sunnyCt, toCt: cloudyCt },
    { at: 24, dur: 20, label: `Fading cloudy -> sunny`, fromCt: cloudyCt, toCt: sunnyCt },
    { at: 46, dur: 14, label: `Fading to midpoint (${ctToK(midCt)})`, fromCt: sunnyCt, toCt: midCt }
  ];

  gradientTestState = { startTime: Date.now(), totalSeconds: 60, phases, currentPhase: 0, sunnyCt, cloudyCt, midCt, lights: cfg.lights.length };
  logActivity('gradient', `Test: cycling ${ctToK(sunnyCt)} -> ${ctToK(cloudyCt)} -> ${ctToK(sunnyCt)} -> ${ctToK(midCt)} over 60s on ${cfg.lights.length} lights`);

  // Stagger helper for test
  function testStagger(lights, state) {
    lights.forEach((lid, i) => setTimeout(() => hueLightState(lid, state).catch(() => {}), i * 100));
  }

  // Phase 1: Set to sunny (instant)
  testStagger(cfg.lights, { on: true, bri, ct: sunnyCt, transitiontime: 10 });

  // Phase 2: After 3s, fade to cloudy over 20s
  gradientTestState._t2 = setTimeout(() => {
    if (gradientTestState) gradientTestState.currentPhase = 1;
    testStagger(cfg.lights, { ct: cloudyCt, transitiontime: 200 });
  }, 3000);

  // Phase 3: After 25s, fade back to sunny over 20s
  gradientTestState._t3 = setTimeout(() => {
    if (gradientTestState) gradientTestState.currentPhase = 2;
    testStagger(cfg.lights, { ct: sunnyCt, transitiontime: 200 });
  }, 25000);

  // Phase 4: After 47s, fade to midpoint over 13s
  gradientTestState._t4 = setTimeout(() => {
    if (gradientTestState) gradientTestState.currentPhase = 3;
    testStagger(cfg.lights, { ct: midCt, transitiontime: 130 });
  }, 47000);

  // End: After 60s, clear test state
  gradientTestState._tend = setTimeout(() => {
    gradientTestState = null;
    logActivity('gradient', 'Test complete');
  }, 60000);

  return { sunnyCt, cloudyCt, midCt, lights: cfg.lights.length, duration: '60s' };
}

function getDaytimeGradientStatus() {
  const result = {};
  if (gradientState) {
    result.running = true;
    result.cloudPct = gradientState.cloudPct;
    result.currentCt = gradientState.currentCt;
    result.targetCt = gradientState.targetCt;
    result.lastWeatherPoll = gradientState.lastWeatherPoll;
    result.weatherError = gradientState.weatherError;
    result.uptime = Math.round((Date.now() - gradientState.startTime) / 60000);
    result.ticks = gradientState.tickCount;
  } else {
    result.running = false;
  }
  if (gradientTestState) {
    const elapsed = (Date.now() - gradientTestState.startTime) / 1000;
    const pct = Math.min(100, Math.round(elapsed / gradientTestState.totalSeconds * 100));
    const phase = gradientTestState.phases[gradientTestState.currentPhase];
    result.testing = true;
    result.testPct = pct;
    result.testElapsed = Math.round(elapsed);
    result.testTotal = gradientTestState.totalSeconds;
    result.testPhase = phase ? phase.label : 'Finishing';
    result.testPhaseIdx = gradientTestState.currentPhase;
    result.testPhases = gradientTestState.phases.map(p => ({ at: p.at, dur: p.dur, label: p.label, fromCt: p.fromCt, toCt: p.toCt }));
    result.testSunnyCt = gradientTestState.sunnyCt;
    result.testCloudyCt = gradientTestState.cloudyCt;
    result.testLights = gradientTestState.lights;
  }
  return result;
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

// ─── Caseta LEAP Client ──────────────────────────────────────────────────────
const CASETA_LEAP_PORT = 8081;
const CASETA_PAIR_PORT = 8083;
const CASETA_CERT_DIR = path.join(__dirname, 'caseta-certs');

// Hardcoded Lutron LAP certificates for pairing (publicly known, embedded in all open-source clients)
const LAP_CA = `-----BEGIN CERTIFICATE-----
MIIEsjCCA5qgAwIBAgIBATANBgkqhkiG9w0BAQ0FADCBlzELMAkGA1UEBhMCVVMx
FTATBgNVBAgTDFBlbm5zeWx2YW5pYTElMCMGA1UEChMcTHV0cm9uIEVsZWN0cm9u
aWNzIENvLiwgSW5jLjEUMBIGA1UEBxMLQ29vcGVyc2J1cmcxNDAyBgNVBAMTK0Nh
c2V0YSBMb2NhbCBBY2Nlc3MgUHJvdG9jb2wgQ2VydCBBdXRob3JpdHkwHhcNMTUx
MDMxMDAwMDAwWhcNMzUxMDMxMDAwMDAwWjCBlzELMAkGA1UEBhMCVVMxFTATBgNV
BAgTDFBlbm5zeWx2YW5pYTElMCMGA1UEChMcTHV0cm9uIEVsZWN0cm9uaWNzIENv
LiwgSW5jLjEUMBIGA1UEBxMLQ29vcGVyc2J1cmcxNDAyBgNVBAMTK0Nhc2V0YSBM
b2NhbCBBY2Nlc3MgUHJvdG9jb2wgQ2VydCBBdXRob3JpdHkwggEiMA0GCSqGSIb3
DQEBAQUAA4IBDwAwggEKAoIBAQDamUREO0dENJxvxdbsDATdDFq+nXdbe62XJ4hI
t15nrUolwv7S28M/6uPPFtRSJW9mwvk/OKDlz0G2D3jw6SdzV3I7tNzvDptvbAL2
aDy9YNp9wTub/pLF6ONDa56gfAxsPQnMBwgoZlKqNQQsjykiyBv8FX42h3Nsa+Bl
q3hjnZEdOAkdn0rvCWD605c0+VWWOWm2vv7bwyOsfgsvCPxooAyBhTDeA0JPjVE/
wHPfiDF3WqA8JzWv4Ibvkg1g33oD6lG8LulWKDS9TPBYF+cvJ40aFPMreMoAQcrX
uD15vaS7iWXKI+anVrBpqE6pRkwLhR+moFjv5GZ+9oP8eawzAgMBAAGjggEFMIIB
ATAMBgNVHRMEBTADAQH/MB0GA1UdDgQWBBSB7qznOajKywOtZypVvV7ECAsgZjCB
xAYDVR0jBIG8MIG5gBSB7qznOajKywOtZypVvV7ECAsgZqGBnaSBmjCBlzELMAkG
A1UEBhMCVVMxFTATBgNVBAgTDFBlbm5zeWx2YW5pYTElMCMGA1UEChMcTHV0cm9u
IEVsZWN0cm9uaWNzIENvLiwgSW5jLjEUMBIGA1UEBxMLQ29vcGVyc2J1cmcxNDAy
BgNVBAMTK0Nhc2V0YSBMb2NhbCBBY2Nlc3MgUHJvdG9jb2wgQ2VydCBBdXRob3Jp
dHmCAQEwCwYDVR0PBAQDAgG+MA0GCSqGSIb3DQEBDQUAA4IBAQB9UDVi2DQI7vHp
F2Lape8SCtcdGEY/7BV4a3F+Xp9WxpE4bVtwoHlb+HG4tYQk9LO7jReE3VBmzvmU
aj+Y3xa25PSb+/q6U6MuY5OscyWo6ZGwtlsrWcP5xsey950WLwW6i8mfIkqFf6uT
gPbUjLsOstB4p7PQVpFgS2rP8h50Psue+XtUKRpR+JSBrHXKX9VuU/aM4PYexSvF
WSHa2HEbjvp6ccPm53/9/EtOtzcUMNspKt3YzABAoQ5/69nebRtC5lWjFI0Ga6kv
zKyu/aZJXWqskHkMz+Mbnky8tP37NmVkMnmRLCfdCG0gHiq/C2tjWDfPQID6HY0s
zq38av5E
-----END CERTIFICATE-----`;

const LAP_CERT = `-----BEGIN CERTIFICATE-----
MIIECjCCAvKgAwIBAgIBAzANBgkqhkiG9w0BAQ0FADCBlzELMAkGA1UEBhMCVVMx
FTATBgNVBAgTDFBlbm5zeWx2YW5pYTElMCMGA1UEChMcTHV0cm9uIEVsZWN0cm9u
aWNzIENvLiwgSW5jLjEUMBIGA1UEBxMLQ29vcGVyc2J1cmcxNDAyBgNVBAMTK0Nh
c2V0YSBMb2NhbCBBY2Nlc3MgUHJvdG9jb2wgQ2VydCBBdXRob3JpdHkwHhcNMTUx
MDMxMDAwMDAwWhcNMzUxMDMxMDAwMDAwWjB+MQswCQYDVQQGEwJVUzEVMBMGA1UE
CBMMUGVubnN5bHZhbmlhMSUwIwYDVQQKExxMdXRyb24gRWxlY3Ryb25pY3MgQ28u
LCBJbmMuMRQwEgYDVQQHEwtDb29wZXJzYnVyZzEbMBkGA1UEAxMSQ2FzZXRhIEFw
cGxpY2F0aW9uMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAyAOELqTw
WNkF8ofSYJ9QkOHAYMmkVSRjVvZU2AqFfaZYCfWLoors7EBeQrsuGyojqxCbtRUd
l2NQrkPrGVw9cp4qsK54H8ntVadNsYi7KAfDW8bHQNf3hzfcpe8ycXcdVPZram6W
pM9P7oS36jV2DLU59A/OGkcO5AkC0v5ESqzab3qaV3ZvELP6qSt5K4MaJmm8lZT2
6deHU7Nw3kR8fv41qAFe/B0NV7IT+hN+cn6uJBxG5IdAimr4Kl+vTW9tb+/Hh+f+
pQ8EzzyWyEELRp2C72MsmONarnomei0W7dVYbsgxUNFXLZiXBdtNjPCMv1u6Znhm
QMIu9Fhjtz18LwIDAQABo3kwdzAJBgNVHRMEAjAAMB0GA1UdDgQWBBTiN03yqw/B
WK/jgf6FNCZ8D+SgwDAfBgNVHSMEGDAWgBSB7qznOajKywOtZypVvV7ECAsgZjAL
BgNVHQ8EBAMCBaAwHQYDVR0lBBYwFAYIKwYBBQUHAwEGCCsGAQUFBwMCMA0GCSqG
SIb3DQEBDQUAA4IBAQABdgPkGvuSBCwWVGO/uzFEIyRius/BF/EOZ7hMuZluaF05
/FT5PYPWg+UFPORUevB6EHyfezv+XLLpcHkj37sxhXdDKB4rrQPNDY8wzS9DAqF4
WQtGMdY8W9z0gDzajrXRbXkYLDEXnouUWA8+AblROl1Jr2GlUsVujI6NE6Yz5JcJ
zDLVYx7pNZkhYcmEnKZ30+ICq6+0GNKMW+irogm1WkyFp4NHiMCQ6D2UMAIMfeI4
xsamcaGquzVMxmb+Py8gmgtjbpnO8ZAHV6x3BG04zcaHRDOqyA4g+Xhhbxp291c8
B31ZKg0R+JaGyy6ZpE5UPLVyUtLlN93V2V8n66kR
-----END CERTIFICATE-----`;

const LAP_KEY = `-----BEGIN RSA PRIVATE KEY-----
MIIEpQIBAAKCAQEAyAOELqTwWNkF8ofSYJ9QkOHAYMmkVSRjVvZU2AqFfaZYCfWL
oors7EBeQrsuGyojqxCbtRUdl2NQrkPrGVw9cp4qsK54H8ntVadNsYi7KAfDW8bH
QNf3hzfcpe8ycXcdVPZram6WpM9P7oS36jV2DLU59A/OGkcO5AkC0v5ESqzab3qa
V3ZvELP6qSt5K4MaJmm8lZT26deHU7Nw3kR8fv41qAFe/B0NV7IT+hN+cn6uJBxG
5IdAimr4Kl+vTW9tb+/Hh+f+pQ8EzzyWyEELRp2C72MsmONarnomei0W7dVYbsgx
UNFXLZiXBdtNjPCMv1u6ZnhmQMIu9Fhjtz18LwIDAQABAoIBAQCXDtDNyZQcBgwP
17RzdN8MDPOWJbQO+aRtES2S3J9k/jSPkPscj3/QDe0iyOtRaMn3cFuor4HhzAgr
FPCB/sAJyJrFRX9DwuWUQv7SjkmLOhG5Rq9FsdYoMXBbggO+3g8xE8qcX1k2r7vW
kDW2lRnLDzPtt+IYxoHgh02yvIYnPn1VLuryM0+7eUrTVmdHQ1IGS5RRAGvtoFjf
4QhkkwLzZzCBly/iUDtNiincwRx7wUG60c4ZYu/uBbdJKT+8NcDLnh6lZyJIpGns
jjZvvYA9kgCB2QgQ0sdvm0rA31cbc72Y2lNdtE30DJHCQz/K3X7T0PlfR191NMiX
E7h2I/oBAoGBAPor1TqsQK0tT5CftdN6j49gtHcPXVoJQNhPyQldKXADIy8PVGnn
upG3y6wrKEb0w8BwaZgLAtqOO/TGPuLLFQ7Ln00nEVsCfWYs13IzXjCCR0daOvcF
3FCb0IT/HHym3ebtk9gvFY8Y9AcV/GMH5WkAufWxAbB7J82M//afSghPAoGBAMys
g9D0FYO/BDimcBbUBpGh7ec+XLPaB2cPM6PtXzMDmkqy858sTNBLLEDLl+B9yINi
FYcxpR7viNDAWtilVGKwkU3hM514k+xrEr7jJraLzd0j5mjp55dnmH0MH0APjEV0
qum+mIJmWXlkfKKIiIDgr6+FwIiF5ttSbX1NwnYhAoGAMRvjqrXfqF8prEk9xzra
7ZldM7YHbEI+wXfADh+En+FtybInrvZ3UF2VFMIQEQXBW4h1ogwfTkn3iRBVje2x
v4rHRbzykjwF48XPsTJWPg2E8oPK6Wz0F7rOjx0JOYsEKm3exORRRhru5Gkzdzk4
lok29/z8SOmUIayZHo+cV88CgYEAgPsmhoOLG19A9cJNWNV83kHBfryaBu0bRSMb
U+6+05MtpG1pgaGVNp5o4NxsdZhOyB0DnBL5D6m7+nF9zpFBwH+s0ftdX5sg/Rfs
1Eapmtg3f2ikRvFAdPVf7024U9J4fzyqiGsICQUe1ZUxxetsumrdzCrpzh80AHrN
bO2X4oECgYEAxoVXNMdFH5vaTo3X/mOaCi0/j7tOgThvGh0bWcRVIm/6ho1HXk+o
+kY8ld0vCa7VvqT+iwPt+7x96qesVPyWQN3+uLz9oL3hMOaXCpo+5w8U2Qxjinod
uHnNjMTXCVxNy4tkARwLRwI+1aV5PMzFSi+HyuWmBaWOe19uz3SFbYs=
-----END RSA PRIVATE KEY-----`;

let casetaSocket = null;
let casetaTagId = 0;
let casetaPendingCallbacks = {};

function casetaCertsExist() {
  return fs.existsSync(path.join(CASETA_CERT_DIR, 'ca.pem')) &&
         fs.existsSync(path.join(CASETA_CERT_DIR, 'cert.pem')) &&
         fs.existsSync(path.join(CASETA_CERT_DIR, 'key.pem'));
}

function casetaConnect() {
  if (!config.caseta || !config.caseta.bridgeIp || !casetaCertsExist()) return Promise.resolve(null);
  if (casetaSocket && !casetaSocket.destroyed) return Promise.resolve(casetaSocket);

  return new Promise((resolve, reject) => {
    const ca = fs.readFileSync(path.join(CASETA_CERT_DIR, 'ca.pem'), 'utf8');
    const cert = fs.readFileSync(path.join(CASETA_CERT_DIR, 'cert.pem'), 'utf8');
    const key = fs.readFileSync(path.join(CASETA_CERT_DIR, 'key.pem'), 'utf8');

    const socket = tls.connect(CASETA_LEAP_PORT, config.caseta.bridgeIp, {
      ca, cert, key, rejectUnauthorized: false
    });

    let buffer = '';
    socket.on('secureConnect', () => {
      casetaSocket = socket;
      // Ping every 60s to keep alive
      socket._pingInterval = setInterval(() => {
        casetaSend({ CommuniqueType: 'ReadRequest', Header: { Url: '/server/1/status/ping' } }).catch(() => {});
      }, 60000);
      resolve(socket);
    });

    socket.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\r\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          const tag = msg.Header && msg.Header.ClientTag;
          if (tag && casetaPendingCallbacks[tag]) {
            casetaPendingCallbacks[tag](msg);
            delete casetaPendingCallbacks[tag];
          }
        } catch (e) { /* ignore parse errors */ }
      }
    });

    socket.on('error', (e) => {
      console.log(`[Caseta] Connection error: ${e.message}`);
      casetaSocket = null;
      reject(e);
    });
    socket.on('close', () => {
      if (socket._pingInterval) clearInterval(socket._pingInterval);
      casetaSocket = null;
    });
    socket.setTimeout(10000, () => { socket.destroy(); reject(new Error('Caseta connect timeout')); });
  });
}

function casetaSend(msg) {
  return new Promise((resolve, reject) => {
    if (!casetaSocket || casetaSocket.destroyed) return reject(new Error('Caseta not connected'));
    const tag = `tag-${++casetaTagId}`;
    if (!msg.Header) msg.Header = {};
    msg.Header.ClientTag = tag;
    casetaPendingCallbacks[tag] = resolve;
    casetaSocket.write(JSON.stringify(msg) + '\r\n');
    setTimeout(() => { if (casetaPendingCallbacks[tag]) { delete casetaPendingCallbacks[tag]; reject(new Error('Caseta response timeout')); } }, 10000);
  });
}

async function casetaGetDevices() {
  await casetaConnect();
  const resp = await casetaSend({ CommuniqueType: 'ReadRequest', Header: { Url: '/device' } });
  return (resp.Body && resp.Body.Devices) || [];
}

async function casetaSetLevel(zoneId, level, fadeTimeSec = 0) {
  await casetaConnect();
  const body = {
    Command: fadeTimeSec > 0
      ? { CommandType: 'GoToDimmedLevel', DimmedLevelParameters: { Level: level, FadeTime: formatFadeTime(fadeTimeSec) } }
      : { CommandType: 'GoToLevel', Parameter: [{ Type: 'Level', Value: level }] }
  };
  return casetaSend({ CommuniqueType: 'CreateRequest', Header: { Url: `/zone/${zoneId}/commandprocessor` }, Body: body });
}

async function casetaGetZoneLevel(zoneId) {
  await casetaConnect();
  const resp = await casetaSend({ CommuniqueType: 'ReadRequest', Header: { Url: `/zone/${zoneId}/status` } });
  return resp.Body && resp.Body.ZoneStatus && resp.Body.ZoneStatus.Level;
}

function formatFadeTime(sec) {
  const s = Math.floor(sec) % 60;
  const m = Math.floor(sec / 60) % 60;
  const h = Math.floor(sec / 3600);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

async function casetaPair(bridgeIp) {
  // Generate RSA key pair using openssl
  if (!fs.existsSync(CASETA_CERT_DIR)) fs.mkdirSync(CASETA_CERT_DIR, { recursive: true });
  const keyFile = path.join(CASETA_CERT_DIR, 'key.pem');
  const csrFile = path.join(CASETA_CERT_DIR, 'csr.pem');
  execSync(`openssl genrsa -out "${keyFile}" 2048 2>/dev/null`);
  execSync(`openssl req -new -key "${keyFile}" -out "${csrFile}" -subj "/CN=home-orchestrator" 2>/dev/null`);
  const csrPem = fs.readFileSync(csrFile, 'utf8');

  return new Promise((resolve, reject) => {
    const socket = tls.connect(CASETA_PAIR_PORT, bridgeIp, {
      ca: LAP_CA, cert: LAP_CERT, key: LAP_KEY,
      rejectUnauthorized: false,
      checkServerIdentity: () => undefined,
      minVersion: 'TLSv1.2',
      maxVersion: 'TLSv1.2'
    });

    let buffer = '';
    let state = 'waiting_for_button';
    let resolved = false;

    socket.on('secureConnect', () => {
      logActivity('caseta', `Paired TLS connected. Cipher: ${socket.getCipher().name}, Protocol: ${socket.getProtocol()}. Waiting up to 3 min for button...`);
    });

    socket.on('data', (data) => {
      const raw = data.toString();
      logActivity('caseta', `RAW DATA (${raw.length} chars): ${raw.substring(0, 300)}`);
      buffer += raw;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        logActivity('caseta', `Pair recv: ${line.substring(0, 200)}`);
        try {
          const msg = JSON.parse(line);
          if (state === 'waiting_for_button') {
            const perms = msg.Body && msg.Body.Status && msg.Body.Status.Permissions;
            if (perms && perms.includes('PhysicalAccess')) {
              state = 'waiting_for_cert';
              logActivity('caseta', 'Button press detected! Sending CSR...');
              socket.write(JSON.stringify({
                Header: { RequestType: 'Execute', Url: '/pair', ClientTag: 'get-cert' },
                Body: { CommandType: 'CSR', Parameters: { CSR: csrPem, DisplayName: 'home-orchestrator', DeviceUID: '000000000000', Role: 'Admin' } }
              }) + '\r\n');
            }
          } else if (state === 'waiting_for_cert') {
            if (msg.Header && msg.Header.ClientTag === 'get-cert' && msg.Body && msg.Body.SigningResult) {
              const ca = msg.Body.SigningResult.RootCertificate;
              const cert = msg.Body.SigningResult.Certificate;
              fs.writeFileSync(path.join(CASETA_CERT_DIR, 'ca.pem'), ca);
              fs.writeFileSync(path.join(CASETA_CERT_DIR, 'cert.pem'), cert);
              socket.end();
              logActivity('caseta', 'Pairing complete! Certificates saved.');
              resolved = true;
              resolve({ ok: true });
            }
          }
        } catch (e) { logActivity('caseta', `Pair parse error: ${e.message}`); }
      }
    });

    socket.on('error', (e) => { if (!resolved) reject(new Error(`Caseta pairing error: ${e.message}`)); });
    setTimeout(() => { if (!resolved) { socket.destroy(); reject(new Error('Pairing timeout (180s) - press the small button on back of bridge, then retry')); } }, 180000);
  });
}

// ─── Nanoleaf Client ─────────────────────────────────────────────────────────
function nanoleafRequest(method, urlPath, body = null) {
  if (!config.nanoleaf || !config.nanoleaf.ip || !config.nanoleaf.token) return Promise.reject(new Error('Nanoleaf not configured'));
  return new Promise((resolve, reject) => {
    const options = {
      hostname: config.nanoleaf.ip,
      port: 16021,
      path: `/api/v1/${config.nanoleaf.token}${urlPath}`,
      method,
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { resolve(data); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Nanoleaf timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function nanoleafSetBrightness(pct, durationSec = 0) {
  const body = { brightness: { value: Math.round(pct), duration: Math.round(durationSec) } };
  return nanoleafRequest('PUT', '/state', body);
}

async function nanoleafSetEffect(name) {
  return nanoleafRequest('PUT', '/effects', { select: name });
}

async function nanoleafGetState() {
  return nanoleafRequest('GET', '');
}

async function nanoleafPairToken(ip) {
  return new Promise((resolve, reject) => {
    const options = { hostname: ip, port: 16021, path: '/api/v1/new', method: 'POST', timeout: 10000 };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try { resolve(JSON.parse(data)); } catch (e) { resolve(data); }
        } else {
          reject(new Error(`Nanoleaf auth failed (${res.statusCode}). Hold power button 5-7s first.`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Nanoleaf pair timeout')); });
    req.end();
  });
}

// ─── Samsung TV Client (WebSocket + WoL) ────────────────────────────────────
function samsungConnect(keyCode, useToken = true) {
  return new Promise((resolve, reject) => {
    if (!config.samsung || !config.samsung.ip) return reject(new Error('Samsung TV not configured'));
    const WebSocket = require('ws');
    const token = (useToken && config.samsung.token) ? `&token=${config.samsung.token}` : '';
    const name = Buffer.from(config.samsung.appName || 'HomeHub').toString('base64');
    const url = `wss://${config.samsung.ip}:8002/api/v2/channels/samsung.remote.control?name=${name}${token}`;

    const ws = new WebSocket(url, { rejectUnauthorized: false });
    let responded = false;
    let keySent = false;

    const timeout = setTimeout(() => {
      if (!responded) { responded = true; try { ws.close(); } catch (e) {} reject(new Error('Samsung TV timeout (10s)')); }
    }, 10000);

    function sendKey() {
      if (keySent) return;
      keySent = true;
      ws.send(JSON.stringify({
        method: 'ms.remote.control',
        params: { Cmd: 'Click', DataOfCmd: keyCode, Option: false, TypeOfRemote: 'SendRemoteKey' }
      }));
      setTimeout(() => { try { ws.close(); } catch (e) {} }, 1500);
    }

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        // Auto-capture token from TV response
        if (msg.data && msg.data.token && msg.data.token !== config.samsung.token) {
          config.samsung.token = msg.data.token;
          saveConfig();
          logActivity('samsung', `Token updated: ${msg.data.token}`);
        }
        // Wait for ms.channel.connect before sending key (2025+ protocol)
        if (msg.event === 'ms.channel.connect') {
          sendKey();
          if (!responded) { responded = true; clearTimeout(timeout); resolve(msg); }
        }
        // Token expired or unauthorized -- signal caller to retry
        if (msg.event === 'ms.channel.timeOut') {
          try { ws.close(); } catch (e) {}
          if (!responded) { responded = true; clearTimeout(timeout); reject(new Error('TOKEN_EXPIRED')); }
        }
        if (msg.event === 'ms.error') {
          try { ws.close(); } catch (e) {}
          const errMsg = msg.data && msg.data.message || 'Samsung TV error';
          if (!responded) { responded = true; clearTimeout(timeout); reject(new Error(errMsg === 'No Authorized' ? 'TOKEN_EXPIRED' : errMsg)); }
        }
      } catch (e) { /* non-JSON message */ }
    });

    // Fallback: if no ms.channel.connect within 3s, send key anyway (older TVs)
    ws.on('open', () => {
      setTimeout(() => { if (!keySent) sendKey(); }, 3000);
    });

    ws.on('close', () => {
      if (!responded) { responded = true; clearTimeout(timeout); resolve({ event: 'closed' }); }
    });

    ws.on('error', (err) => {
      if (!responded) { responded = true; clearTimeout(timeout); reject(err); }
    });
  });
}

async function samsungSendKey(keyCode) {
  try {
    return await samsungConnect(keyCode, true);
  } catch (e) {
    if (e.message === 'TOKEN_EXPIRED' && config.samsung.token) {
      // Token expired -- clear it and retry without token to get a fresh one
      logActivity('samsung', 'Token expired, retrying without token...');
      config.samsung.token = '';
      saveConfig();
      return await samsungConnect(keyCode, false);
    }
    throw e;
  }
}

function samsungWakeOnLan() {
  return new Promise((resolve, reject) => {
    if (!config.samsung || !config.samsung.mac) return reject(new Error('Samsung TV MAC not configured'));
    const dgram = require('dgram');
    const mac = config.samsung.mac.replace(/[:\-]/g, '');
    if (mac.length !== 12) return reject(new Error('Invalid MAC address'));

    const macBytes = Buffer.from(mac, 'hex');
    const magic = Buffer.alloc(6 + 16 * 6);
    magic.fill(0xFF, 0, 6);
    for (let i = 0; i < 16; i++) macBytes.copy(magic, 6 + i * 6);

    // Send to both global and subnet broadcast on ports 7 and 9
    const targets = [['255.255.255.255', 9], ['192.168.1.255', 9], ['255.255.255.255', 7], ['192.168.1.255', 7]];
    const socket = dgram.createSocket('udp4');
    socket.on('error', (e) => { socket.close(); reject(e); });
    socket.bind(() => {
      socket.setBroadcast(true);
      let sent = 0;
      const total = targets.length * 3;
      for (const [addr, port] of targets) {
        for (let i = 0; i < 3; i++) {
          socket.send(magic, 0, magic.length, port, addr, () => {
            sent++;
            if (sent >= total) { socket.close(); resolve({ sent: total }); }
          });
        }
      }
    });
  });
}

// ─── SmartThings API Client ─────────────────────────────────────────────────
function _smartThingsHttp(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.smartthings.com',
      path: `/v1${path}`,
      method: method,
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
    };
    if (bodyStr) options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = data ? JSON.parse(data) : {};
          resolve({ statusCode: res.statusCode, data: parsed, raw: data });
        } catch (e) { resolve({ statusCode: res.statusCode, data: null, raw: data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('SmartThings timeout')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function smartThingsRequest(method, path, body) {
  const st = config.samsung && config.samsung.smartThings;
  if (!st) throw new Error('SmartThings not configured');
  const token = st.accessToken || st.pat;
  if (!token) throw new Error('No SmartThings token available');
  let resp = await _smartThingsHttp(method, path, body, token);
  // Auto-retry on 401: refresh token and retry once
  if (resp.statusCode === 401 && st.refreshToken && st.clientId) {
    try {
      logActivity('samsung', 'Token expired, auto-refreshing...');
      await smartThingsRefreshToken();
      const newToken = st.accessToken;
      resp = await _smartThingsHttp(method, path, body, newToken);
    } catch (refreshErr) {
      throw new Error(`SmartThings 401 + refresh failed: ${refreshErr.message}`);
    }
  }
  if (resp.statusCode >= 200 && resp.statusCode < 300) return resp.data;
  throw new Error(`SmartThings ${resp.statusCode}: ${resp.raw}`);
}

function smartThingsCommand(capability, command, args) {
  const st = config.samsung && config.samsung.smartThings;
  if (!st || !st.deviceId) return Promise.reject(new Error('SmartThings device not configured'));
  return smartThingsRequest('POST', `/devices/${st.deviceId}/commands`, {
    commands: [{ component: 'main', capability, command, arguments: args || [] }]
  });
}

async function samsungSetInput(hdmiPort) {
  const port = hdmiPort.toUpperCase();
  const validPorts = ['HDMI1', 'HDMI2', 'HDMI3', 'HDMI4', 'dtv'];
  if (!validPorts.includes(port)) throw new Error(`Unknown input: ${hdmiPort}`);
  return smartThingsCommand('samsungvd.mediaInputSource', 'setInputSource', [port]);
}

// ─── SmartThings OAuth Token Auto-Refresh ───────────────────────────────────
function smartThingsRefreshToken() {
  return new Promise((resolve, reject) => {
    const st = config.samsung && config.samsung.smartThings;
    if (!st || !st.refreshToken || !st.clientId || !st.clientSecret) {
      return reject(new Error('SmartThings OAuth not configured for refresh'));
    }
    const https = require('https');
    const auth = Buffer.from(`${st.clientId}:${st.clientSecret}`).toString('base64');
    const body = `grant_type=refresh_token&client_id=${st.clientId}&refresh_token=${st.refreshToken}`;
    const req = https.request({
      hostname: 'api.smartthings.com', path: '/oauth/token', method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode === 200 && parsed.access_token) {
            st.accessToken = parsed.access_token;
            st.refreshToken = parsed.refresh_token;
            saveConfig();
            logActivity('samsung', 'SmartThings OAuth token refreshed');
            resolve(parsed);
          } else {
            reject(new Error(`SmartThings refresh failed (${res.statusCode}): ${data}`));
          }
        } catch (e) { reject(new Error(`SmartThings refresh parse error: ${data}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('SmartThings refresh timeout')); });
    req.write(body);
    req.end();
  });
}

// Refresh every 12 hours (tokens last 24h, refresh well before expiry)
let smartThingsRefreshTimer = null;
function startSmartThingsRefreshTimer() {
  const st = config.samsung && config.samsung.smartThings;
  if (!st || !st.refreshToken || !st.clientId) return;
  if (smartThingsRefreshTimer) clearInterval(smartThingsRefreshTimer);
  const TWELVE_HOURS = 12 * 60 * 60 * 1000;
  smartThingsRefreshTimer = setInterval(() => {
    smartThingsRefreshToken().catch(e =>
      logActivity('samsung', `SmartThings refresh error: ${e.message}`)
    );
  }, TWELVE_HOURS);
  logActivity('samsung', 'SmartThings token refresh timer started (every 12h)');
}

function samsungIsAvailable() {
  return new Promise((resolve) => {
    if (!config.samsung || !config.samsung.ip) return resolve(false);
    const net = require('net');
    const socket = new net.Socket();
    socket.setTimeout(2000);
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('error', () => resolve(false));
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
    socket.connect(8002, config.samsung.ip);
  });
}

// ─── SmartThings Extended Functions ──────────────────────────────────────────

// Send a SmartThings command with retry logic for post-boot timing gap.
// After WoL the TV takes ~25s to accept commands. Retries handle ACCEPTED (queued) and errors.
async function smartThingsCommandRetry(capability, command, args, maxRetries = 6) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const result = await smartThingsCommand(capability, command, args);
      const allCompleted = result && result.results &&
        result.results.every(r => r.status === 'COMPLETED');
      if (allCompleted) {
        if (i > 0) logActivity('samsung', `Command completed on attempt ${i + 1}`);
        return result;
      }
      logActivity('samsung', `Command attempt ${i + 1}/${maxRetries}: ${result?.results?.[0]?.status || 'unknown'}`);
    } catch (e) {
      if (i >= maxRetries - 1) throw e;
      logActivity('samsung', `Command attempt ${i + 1}/${maxRetries}: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 4000));
  }
  return await smartThingsCommand(capability, command, args);
}

// Ensure TV is on and ready for SmartThings commands.
// Returns 'already' if was on, 'woken' if had to wake.
async function ensureTvReady() {
  // Quick check -- if port 8002 responds, TV is definitely on
  if (await samsungIsAvailable()) return 'already';
  // Not online -- wake via WoL and give TV time to boot
  await samsungWakeOnLan();
  logActivity('samsung', 'WoL sent, waiting for TV boot...');
  // Wait 20s for initial boot, then let the retry loop handle the rest
  await new Promise(r => setTimeout(r, 20000));
  return 'woken';
}

async function samsungPowerOn() {
  await samsungWakeOnLan();
  logActivity('samsung', 'TV power on (WoL)');
}

async function samsungPowerOff() {
  await smartThingsCommand('switch', 'off', []);
  logActivity('samsung', 'TV power off (SmartThings)');
}

async function samsungSetPictureMode(mode) {
  const modeMap = { 'movie_calibrated': 'Movie', 'filmmaker': 'FILMMAKER MODE', 'movie': 'Movie', 'dynamic': 'Dynamic', 'standard': 'Standard', 'eco': 'Eco' };
  const resolved = modeMap[mode.toLowerCase().replace(/\s+/g, '_')] || mode;
  const valid = ['Dynamic', 'Standard', 'Movie', 'FILMMAKER MODE', 'Eco'];
  if (!valid.includes(resolved)) throw new Error(`Unknown picture mode: ${mode}. Valid: ${valid.join(', ')}`);
  await smartThingsCommand('samsungvd.pictureMode', 'setPictureMode', [resolved]);
  logActivity('samsung', `Picture mode: ${resolved}`);
  return resolved;
}

async function samsungSetVolume(level) {
  const vol = Math.max(0, Math.min(100, parseInt(level)));
  if (isNaN(vol)) throw new Error('Volume must be 0-100');
  await smartThingsCommand('audioVolume', 'setVolume', [vol]);
  logActivity('samsung', `Volume: ${vol}`);
  return vol;
}

async function samsungSetMute(muted) {
  await smartThingsCommand('audioMute', muted ? 'mute' : 'unmute', []);
  logActivity('samsung', muted ? 'TV muted' : 'TV unmuted');
}

async function samsungAmbientOn() {
  await smartThingsCommand('samsungvd.ambient', 'setAmbientOn', []);
  const scene = config.samsung && config.samsung.ambientScene;
  if (scene && scene !== 'none') {
    await new Promise(r => setTimeout(r, 2000));
    await smartThingsCommand('samsungvd.ambient', 'sendData', [{
      bg_content_name: `com.samsung.tv.ambientbg-${scene}`
    }]);
    logActivity('samsung', `Ambient mode activated (scene: ${scene})`);
  } else {
    logActivity('samsung', 'Ambient mode activated');
  }
  fireAmbientSonosRoutine();
}

function fireAmbientSonosRoutine() {
  const routineId = config.samsung && config.samsung.ambientRoutine;
  if (!routineId) return;
  const url = `http://localhost:5005/api/trigger/${encodeURIComponent(routineId)}`;
  const req = http.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: 10000 });
  req.on('error', e => logActivity('samsung', `Ambient Sonos follow-up error: ${e.message}`));
  req.end();
  logActivity('samsung', `Ambient follow-up: ${routineId}`);
}

async function samsungSetEnergySaving(on) {
  await smartThingsCommand('custom.energyType', 'setEnergySavingLevel', [on ? 1 : 0]);
  logActivity('samsung', on ? 'Energy saving ON' : 'Energy saving OFF');
}

async function samsungLaunchApp(appId) {
  await smartThingsCommand('custom.launchapp', 'launchApp', [appId]);
  logActivity('samsung', `Launched app: ${appId}`);
}

async function samsungGetFullStatus() {
  const st = config.samsung && config.samsung.smartThings;
  if (!st || !st.deviceId) throw new Error('SmartThings not configured');
  const status = await smartThingsRequest('GET', `/devices/${st.deviceId}/components/main/status`);
  const health = await smartThingsRequest('GET', `/devices/${st.deviceId}/health`);
  return {
    power: status.switch && status.switch.switch ? status.switch.switch.value : 'unknown',
    health: health.state,
    pictureMode: status['samsungvd.pictureMode'] && status['samsungvd.pictureMode'].pictureMode ? status['samsungvd.pictureMode'].pictureMode.value : 'unknown',
    volume: status.audioVolume && status.audioVolume.volume ? status.audioVolume.volume.value : null,
    mute: status.audioMute && status.audioMute.mute ? status.audioMute.mute.value : null,
    input: status['samsungvd.mediaInputSource'] && status['samsungvd.mediaInputSource'].inputSource ? status['samsungvd.mediaInputSource'].inputSource.value : 'unknown',
    energySaving: status['custom.energyType'] && status['custom.energyType'].energySavingOperation ? status['custom.energyType'].energySavingOperation.value : null
  };
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
  // Sort by routineOrder if defined
  if (config.routineOrder && config.routineOrder.length) {
    const orderMap = {};
    config.routineOrder.forEach((id, i) => orderMap[id] = i);
    list.sort((a, b) => (orderMap[a.id] ?? 9999) - (orderMap[b.id] ?? 9999));
  }
  res.json({ ok: true, routines: list });
});

app.get('/api/routines/:id', (req, res) => {
  const routine = config.routines[req.params.id];
  if (!routine) return res.status(404).json({ ok: false, error: 'Not found' });
  res.json({ ok: true, id: req.params.id, ...routine, active: !!activeRoutines[req.params.id] });
});

app.post('/api/routines', (req, res) => {
  try {
    const { id, name, duration, durationUnit, tracks, overrideDetection, excludeOnOverride, driftDetection } = req.body;
    const routineId = id || name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    if (config.routines[routineId]) return res.status(409).json({ ok: false, error: 'ID already exists' });
    const routineObj = { name, duration: duration || 10, durationUnit: durationUnit || 'minutes', tracks: tracks || [], overrideDetection: overrideDetection !== false };
    if (excludeOnOverride) routineObj.excludeOnOverride = excludeOnOverride;
    if (driftDetection) routineObj.driftDetection = driftDetection;
    config.routines[routineId] = routineObj;
    if (!config.routineOrder.includes(routineId)) config.routineOrder.push(routineId);
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
  config.routineOrder = config.routineOrder.filter(id => id !== req.params.id);
  saveConfig();
  logActivity('config', `Deleted routine "${name}"`, { routineId: req.params.id });
  res.json({ ok: true });
});

app.post('/api/routines/:id/start', async (req, res) => {
  try {
    const result = await startRoutine(req.params.id, req.body || {});
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

// ─── API Routes: Caseta ──────────────────────────────────────────────────────
app.post('/api/caseta/pair', async (req, res) => {
  try {
    const ip = (config.caseta && config.caseta.bridgeIp) || req.body.bridgeIp;
    if (!ip) return res.status(400).json({ ok: false, error: 'No bridge IP configured' });
    const result = await casetaPair(ip);
    res.json(result);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/caseta/devices', async (req, res) => {
  try {
    const devices = await casetaGetDevices();
    const mapped = devices.filter(d => d.LocalZones && d.LocalZones.length > 0).map(d => ({
      name: d.Name,
      fullName: d.FullyQualifiedName ? d.FullyQualifiedName.join(' > ') : d.Name,
      deviceType: d.DeviceType,
      model: d.ModelNumber,
      zoneId: d.LocalZones[0].href.match(/\/zone\/(\d+)/)?.[1],
      href: d.href
    }));
    res.json({ ok: true, devices: mapped });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.put('/api/caseta/device/:key', async (req, res) => {
  try {
    const dev = config.caseta && config.caseta.devices && config.caseta.devices[req.params.key];
    if (!dev) return res.status(404).json({ ok: false, error: 'Device not found in config' });
    const { level, fadeTime } = req.body;
    await casetaSetLevel(dev.zoneId, level, fadeTime || 0);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/caseta/zone/:id/status', async (req, res) => {
  try {
    const level = await casetaGetZoneLevel(parseInt(req.params.id));
    res.json({ ok: true, level });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─── API Routes: Caseta HAP/LEAP ────────────────────────────────────────────
app.get('/api/caseta-hap/devices', (req, res) => {
  if (!casetaLeapDevices) return res.json({ ok: false, devices: [], error: 'Not paired' });
  const devices = Object.entries(casetaLeapDevices).map(([key, dev]) => ({
    key, name: dev.name, zoneHref: dev.zoneHref
  }));
  res.json({ ok: true, devices });
});

app.get('/api/homebridge/accessories', async (req, res) => {
  try {
    const resp = await hbHapRequest('GET', '/accessories');
    const accs = (resp.accessories || []).map(acc => {
      const nameChr = acc.services.flatMap(s => s.characteristics).find(c => c.description === 'Name');
      const onChr = acc.services.flatMap(s => s.characteristics).find(c => c.description === 'On');
      return nameChr && onChr ? { aid: acc.aid, name: nameChr.value } : null;
    }).filter(Boolean);
    // Deduplicate by name
    const seen = new Set();
    const unique = accs.filter(a => { if (seen.has(a.name)) return false; seen.add(a.name); return true; });
    res.json({ ok: true, accessories: unique });
  } catch (e) { res.json({ ok: true, accessories: [] }); }
});

// ─── API Routes: Nanoleaf ────────────────────────────────────────────────────
app.post('/api/nanoleaf/pair', async (req, res) => {
  try {
    const ip = (config.nanoleaf && config.nanoleaf.ip) || req.body.ip;
    if (!ip) return res.status(400).json({ ok: false, error: 'No Nanoleaf IP configured' });
    const result = await nanoleafPairToken(ip);
    if (result && result.auth_token) {
      if (!config.nanoleaf) config.nanoleaf = {};
      config.nanoleaf.ip = ip;
      config.nanoleaf.token = result.auth_token;
      saveConfig();
      logActivity('nanoleaf', `Paired with Nanoleaf at ${ip}`);
      res.json({ ok: true, token: result.auth_token });
    } else {
      res.json({ ok: false, error: 'No token returned', raw: result });
    }
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/nanoleaf/state', async (req, res) => {
  try {
    const state = await nanoleafGetState();
    res.json({ ok: true, ...state });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.put('/api/nanoleaf/state', async (req, res) => {
  try {
    const { brightness, duration, effect } = req.body;
    if (brightness !== undefined) await nanoleafSetBrightness(brightness, duration || 0);
    if (effect) await nanoleafSetEffect(effect);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/nanoleaf/effects', async (req, res) => {
  try {
    const result = await nanoleafRequest('GET', '/effects/effectsList');
    res.json({ ok: true, effects: result });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─── API Routes: Samsung TV ──────────────────────────────────────────────────
app.post('/api/tv/pair', async (req, res) => {
  try {
    if (!config.samsung) config.samsung = { ip: '192.168.1.193', mac: '74:6D:FA:31:6E:CE', appName: 'HomeOrchestrator', inputs: {} };
    if (req.body.ip) config.samsung.ip = req.body.ip;
    if (req.body.mac) config.samsung.mac = req.body.mac;
    const result = await samsungSendKey('KEY_HOME');
    logActivity('samsung', `Pairing initiated with TV at ${config.samsung.ip}`);
    res.json({ ok: true, message: 'Check TV screen for Allow/Deny prompt. If allowed, token is saved automatically.', result });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/tv/input/:port', async (req, res) => {
  try {
    const result = await samsungSetInput(req.params.port);
    logActivity('samsung', `Input switched to ${req.params.port}`);
    res.json({ ok: true, input: req.params.port, result });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/tv/power/on', async (req, res) => {
  try {
    const result = await samsungWakeOnLan();
    logActivity('samsung', 'TV power on (WoL)');
    res.json({ ok: true, action: 'power_on', result });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/tv/power/off', async (req, res) => {
  try {
    const result = await samsungSendKey('KEY_POWER');
    logActivity('samsung', 'TV power off');
    res.json({ ok: true, action: 'power_off', result });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/tv/key/:key', async (req, res) => {
  try {
    const keyCode = req.params.key.startsWith('KEY_') ? req.params.key : `KEY_${req.params.key.toUpperCase()}`;
    const result = await samsungSendKey(keyCode);
    logActivity('samsung', `Key sent: ${keyCode}`);
    res.json({ ok: true, key: keyCode, result });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/tv/info', async (req, res) => {
  try {
    const available = await samsungIsAvailable();
    const st = config.samsung && config.samsung.smartThings;
    res.json({
      ok: true,
      configured: !!(config.samsung && config.samsung.ip),
      paired: !!(config.samsung && config.samsung.token),
      available,
      ip: config.samsung && config.samsung.ip,
      mac: config.samsung && config.samsung.mac,
      inputs: (config.samsung && config.samsung.inputs) || {},
      smartThings: { configured: !!(st && st.deviceId), hasToken: !!(st && (st.accessToken || st.pat)) }
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/tv/smartthings/status', async (req, res) => {
  try {
    const st = config.samsung && config.samsung.smartThings;
    if (!st || !st.deviceId) return res.json({ ok: false, error: 'SmartThings not configured' });
    const health = await smartThingsRequest('GET', `/devices/${st.deviceId}/health`);
    const status = await smartThingsRequest('GET', `/devices/${st.deviceId}/components/main/capabilities/samsungvd.mediaInputSource/status`);
    res.json({ ok: true, health: health.state, currentInput: status.inputSource && status.inputSource.value, inputs: status.supportedInputSourcesMap && status.supportedInputSourcesMap.value });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/tv/smartthings/refresh', async (req, res) => {
  try {
    const result = await smartThingsRefreshToken();
    res.json({ ok: true, expiresIn: result.expires_in });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Smart power -- on waits for TV to be ONLINE before returning
app.post('/api/tv/smartpower/on', async (req, res) => {
  try {
    const ready = await ensureTvReady();
    res.json({ ok: true, action: 'smart_power_on', tvOnline: !!ready });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/tv/smartpower/off', async (req, res) => {
  try { await samsungPowerOff(); res.json({ ok: true, action: 'smart_power_off' }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// --- Climate (LG ThinQ portable ACs) ---
const climate = createClimate({
  getConfig: () => config,
  logActivity,
});

app.get('/api/climate/state', async (req, res) => {
  try {
    const fresh = await climate.readAll();
    res.json({ ok: true, ...climate.getSnapshot(), devices: fresh.devices });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/climate/devices/:slot', async (req, res) => {
  try {
    const dev = (config.climate && config.climate.devices && config.climate.devices[req.params.slot]) || null;
    if (!dev) return res.status(404).json({ ok: false, error: 'unknown slot' });
    const reading = await climate.readDevice(req.params.slot, dev.deviceId);
    res.json({ ok: true, slot: req.params.slot, ...reading });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/climate/enable', (req, res) => {
  if (!config.climate) config.climate = {};
  config.climate.enabled = true;
  saveConfig();
  logActivity('climate', 'enabled');
  res.json({ ok: true, enabled: true });
});

app.post('/api/climate/disable', (req, res) => {
  if (!config.climate) config.climate = {};
  config.climate.enabled = false;
  saveConfig();
  logActivity('climate', 'disabled');
  res.json({ ok: true, enabled: false });
});

app.post('/api/climate/tick', async (req, res) => {
  try {
    const result = await climate.tick(saveConfig);
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Manual control endpoints. Each write also seeds lastWritten so the override
// detector won't immediately flag your own UI action as a manual override.
app.post('/api/climate/:slot/target', async (req, res) => {
  try {
    const targetF = Number(req.body && req.body.targetF);
    if (!Number.isFinite(targetF)) return res.status(400).json({ ok: false, error: 'targetF required' });
    const result = await climate.setTargetTempF(req.params.slot, targetF, saveConfig);
    res.json({ ok: true, slot: req.params.slot, targetF, result });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/climate/:slot/fan', async (req, res) => {
  try {
    const speed = req.body && req.body.speed;
    if (!speed) return res.status(400).json({ ok: false, error: 'speed required (low|mid|high)' });
    const result = await climate.setFanSpeed(req.params.slot, speed, saveConfig);
    res.json({ ok: true, slot: req.params.slot, speed, result });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/climate/:slot/power', async (req, res) => {
  try {
    const on = !!(req.body && (req.body.on || req.body.power === 'on' || req.body.power === true));
    const result = await climate.setPower(req.params.slot, on, saveConfig);
    res.json({ ok: true, slot: req.params.slot, on, result });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Pause / resume. Body: { minutes: 30 } or { until: <epoch ms> }. Default 30m.
app.post('/api/climate/:scope/pause', (req, res) => {
  const scope = req.params.scope; // 'global' | 'office' | 'kitchen'
  const minutes = Number((req.body && req.body.minutes) ?? 30);
  if (!Number.isFinite(minutes) || minutes <= 0) return res.status(400).json({ ok: false, error: 'minutes must be > 0' });
  const result = climate.setPause(scope, minutes * 60 * 1000, saveConfig);
  res.json({ ok: true, scope, until: result.until });
});

app.post('/api/climate/:scope/resume', (req, res) => {
  climate.clearPause(req.params.scope, saveConfig);
  res.json({ ok: true, scope: req.params.scope });
});

// Patch climate config (schedule, ladder, override cooldown). Body keys are merged.
// Allowed top-level keys only; nested keys merged 1 level deep.
app.patch('/api/climate/config', (req, res) => {
  const allowed = ['schedule', 'fanRamp', 'ladder', 'overrideCooldownMs'];
  const patch = req.body || {};
  if (!config.climate) config.climate = {};
  for (const k of Object.keys(patch)) {
    if (!allowed.includes(k)) continue;
    if (typeof patch[k] === 'object' && !Array.isArray(patch[k]) && patch[k] !== null) {
      config.climate[k] = { ...(config.climate[k] || {}), ...patch[k] };
    } else {
      config.climate[k] = patch[k];
    }
  }
  saveConfig();
  logActivity('climate', `config patched: ${Object.keys(patch).join(', ')}`);
  res.json({ ok: true, climate: { schedule: config.climate.schedule, fanRamp: config.climate.fanRamp, ladder: config.climate.ladder, overrideCooldownMs: config.climate.overrideCooldownMs } });
});

// Get sanitized climate config for the UI (omits PAT and deviceIds).
app.get('/api/climate/config', (req, res) => {
  const c = config.climate || {};
  res.json({
    ok: true,
    enabled: !!c.enabled,
    schedule: c.schedule || {},
    fanRamp: c.fanRamp || {},
    ladder: c.ladder || {},
    overrideCooldownMs: c.overrideCooldownMs ?? null,
    devices: Object.fromEntries(Object.entries(c.devices || {}).map(([k, v]) => [k, { displayName: v.displayName }])),
  });
});

// Kick off the polling loop. tickInterval gates itself on config.climate.enabled.
climate.start(saveConfig);

// Picture mode
app.post('/api/tv/picture-mode/:mode', async (req, res) => {
  try {
    const resolved = await samsungSetPictureMode(req.params.mode);
    res.json({ ok: true, pictureMode: resolved });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Volume / Mute
app.post('/api/tv/volume/:level', async (req, res) => {
  try { const vol = await samsungSetVolume(req.params.level); res.json({ ok: true, volume: vol }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/tv/mute/:state', async (req, res) => {
  try {
    const muted = req.params.state === 'on' || req.params.state === 'true';
    await samsungSetMute(muted);
    res.json({ ok: true, muted });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Ambient mode (ensures TV online, then enters ambient with configured scene)
app.post('/api/tv/ambient', async (req, res) => {
  try {
    const tvState = await ensureTvReady();
    if (tvState === 'woken') {
      await smartThingsCommandRetry('samsungvd.ambient', 'setAmbientOn', []);
      const scene = config.samsung && config.samsung.ambientScene;
      if (scene && scene !== 'none') {
        await new Promise(r => setTimeout(r, 2000));
        await smartThingsCommandRetry('samsungvd.ambient', 'sendData', [{
          bg_content_name: `com.samsung.tv.ambientbg-${scene}`
        }]);
        logActivity('samsung', `Ambient mode activated (scene: ${scene})`);
      } else {
        logActivity('samsung', 'Ambient mode activated');
      }
      fireAmbientSonosRoutine();
    } else {
      await samsungAmbientOn(); // already handles scene + fireAmbientSonosRoutine
    }
    res.json({ ok: true, action: 'ambient' });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Ambient routine config (which Sonos routine to chain after ambient)
app.get('/api/tv/ambient-routine', (req, res) => {
  res.json({ ok: true, routine: (config.samsung && config.samsung.ambientRoutine) || '' });
});
app.post('/api/tv/ambient-routine', express.json(), (req, res) => {
  if (!config.samsung) config.samsung = {};
  config.samsung.ambientRoutine = req.body.routine || '';
  saveConfig();
  logActivity('samsung', `Ambient follow-up routine: ${config.samsung.ambientRoutine || '(none)'}`);
  res.json({ ok: true, routine: config.samsung.ambientRoutine });
});

// Ambient scene config (which scene to show on ambient mode)
app.get('/api/tv/ambient-scene', (req, res) => {
  res.json({ ok: true, scene: (config.samsung && config.samsung.ambientScene) || '', scenes: ['none','featured','blossom','tranquilnature','islandflyover','fireplace','sparkle','wish','window','journey','spring'] });
});
app.post('/api/tv/ambient-scene', express.json(), (req, res) => {
  if (!config.samsung) config.samsung = {};
  config.samsung.ambientScene = req.body.scene || '';
  saveConfig();
  logActivity('samsung', `Ambient scene: ${config.samsung.ambientScene || '(last used)'}`);
  res.json({ ok: true, scene: config.samsung.ambientScene });
});

// Evening mode (energy saving)
app.post('/api/tv/evening-mode/on', async (req, res) => {
  try {
    await samsungSetEnergySaving(true);
    tvEveningMode = true;
    res.json({ ok: true, eveningMode: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/tv/evening-mode/off', async (req, res) => {
  try {
    await samsungSetEnergySaving(false);
    tvEveningMode = false;
    res.json({ ok: true, eveningMode: false });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.get('/api/tv/evening-mode', (req, res) => {
  res.json({ ok: true, eveningMode: tvEveningMode });
});

// Full status (single API call for all capabilities)
app.get('/api/tv/status', async (req, res) => {
  try {
    const status = await samsungGetFullStatus();
    status.eveningMode = tvEveningMode;
    res.json({ ok: true, ...status });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// App launch
app.post('/api/tv/app/:appId', async (req, res) => {
  try { await samsungLaunchApp(req.params.appId); res.json({ ok: true, appId: req.params.appId }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─── API Routes: Reorder ────────────────────────────────────────────────────
app.post('/api/routines/reorder', (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order)) return res.status(400).json({ ok: false, error: 'order must be an array' });
  config.routineOrder = order;
  saveConfig();
  res.json({ ok: true });
});

app.post('/api/scenes/reorder', (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order)) return res.status(400).json({ ok: false, error: 'order must be an array' });
  config.sceneOrder = order;
  saveConfig();
  res.json({ ok: true });
});

app.get('/api/scenes/order', (req, res) => {
  res.json({ ok: true, order: config.sceneOrder || [] });
});

// ─── API Routes: Generic Trigger ────────────────────────────────────────────
app.post('/api/trigger/:id', async (req, res) => {
  const id = req.params.id;

  // Check fade routines
  if (config.routines[id]) {
    try {
      const result = await startRoutine(id, req.body || {});
      return res.json({ ok: true, type: 'routine', ...result });
    } catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
  }

  // Check daytime gradient triggers
  if (id === 'daytime_gradient') {
    try {
      const result = await startDaytimeGradient();
      return res.json({ ok: true, type: 'daytime_gradient', ...result });
    } catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
  }
  if (id === 'daytime_gradient_stop') {
    return res.json({ ok: true, type: 'daytime_gradient', stopped: stopDaytimeGradient() });
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

  // Check Samsung TV input triggers (auto-powers on TV if needed)
  const tvInputMap = { input_apple_tv: 'HDMI1', input_ps5: 'HDMI2', input_xbox: 'HDMI3' };
  if (tvInputMap[id]) {
    try {
      const tvState = await ensureTvReady();
      const port = tvInputMap[id];
      // If TV was just woken, SmartThings needs time -- retry until COMPLETED
      const result = tvState === 'woken'
        ? await smartThingsCommandRetry('samsungvd.mediaInputSource', 'setInputSource', [port])
        : await samsungSetInput(port);
      logActivity('trigger', `TV input: ${id} -> ${port}`);
      return res.json({ ok: true, type: 'tv_input', input: port, result });
    } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }

  // Samsung TV power/mode triggers
  if (id === 'tv_on') {
    try { await samsungPowerOn(); return res.json({ ok: true, type: 'tv_power', action: 'on' }); }
    catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (id === 'tv_off') {
    try { await samsungPowerOff(); return res.json({ ok: true, type: 'tv_power', action: 'off' }); }
    catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (id === 'tv_ambient') {
    try { await samsungAmbientOn(); return res.json({ ok: true, type: 'tv_ambient' }); }
    catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (id === 'tv_evening_on') {
    try { await samsungSetEnergySaving(true); tvEveningMode = true; return res.json({ ok: true, type: 'tv_evening', eveningMode: true }); }
    catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (id === 'tv_evening_off') {
    try { await samsungSetEnergySaving(false); tvEveningMode = false; return res.json({ ok: true, type: 'tv_evening', eveningMode: false }); }
    catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }

  res.status(404).json({ ok: false, error: `Unknown trigger "${id}"` });
});

// ─── API Routes: Daytime Gradient ───────────────────────────────────────────
app.post('/api/daytime-gradient/start', async (req, res) => {
  try {
    const result = await startDaytimeGradient();
    res.json({ ok: true, ...result });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

app.post('/api/daytime-gradient/stop', (req, res) => {
  res.json({ ok: true, stopped: stopDaytimeGradient() });
});

app.post('/api/daytime-gradient/test', async (req, res) => {
  try {
    const result = await testDaytimeGradient();
    res.json({ ok: true, ...result });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.get('/api/daytime-gradient/status', (req, res) => {
  res.json({ ok: true, ...getDaytimeGradientStatus() });
});

app.get('/api/daytime-gradient/config', (req, res) => {
  const cfg = config.daytimeGradient || {};
  res.json({ ok: true, config: {
    lights: cfg.lights || [],
    lightNames: cfg.lightNames || [],
    sunnyColor: cfg.sunnyColor || { ct: 233 },
    cloudyColor: cfg.cloudyColor || { ct: 343 },
    sunnyCapPct: cfg.sunnyCapPct || 0,
    cloudCapPct: cfg.cloudCapPct || 70,
    brightness: cfg.brightness || 100,
    weatherPollMinutes: cfg.weatherPollMinutes || 5,
    tickSeconds: cfg.tickSeconds || 30,
    monitorGroups: cfg.monitorGroups || [8, 12],
    overrideThreshold: cfg.overrideThreshold || 50,
    excludeOnOverride: cfg.excludeOnOverride || []
  }});
});

app.put('/api/daytime-gradient/config', (req, res) => {
  const updates = req.body;
  const allowed = ['lights','lightNames','monitorGroups','sunnyColor','cloudyColor','sunnyCapPct','cloudCapPct','brightness',
    'weatherPollMinutes','tickSeconds','overrideThreshold','excludeOnOverride'];
  for (const key of Object.keys(updates)) {
    if (allowed.includes(key)) config.daytimeGradient[key] = updates[key];
  }
  saveConfig();
  logActivity('gradient', 'Config updated', { keys: Object.keys(updates).filter(k => allowed.includes(k)) });
  // If running, restart to pick up new config
  if (gradientState) {
    stopDaytimeGradient();
    startDaytimeGradient().catch(e => logActivity('gradient', `Restart after config update failed: ${e.message}`));
  }
  res.json({ ok: true });
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
    switchbot: { configured: !!config.switchbot.token },
    samsung: { configured: !!(config.samsung && config.samsung.ip), paired: !!(config.samsung && config.samsung.token) },
    daytimeGradient: getDaytimeGradientStatus()
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
    const hex = xyBriToHex(xy[0], xy[1], pctToHueBri(bri || 100));
    res.json({ ok: true, xy, hex });
  } else {
    res.json({ ok: true, xy: null, hex: '#000000' });
  }
});

// ─── Sonos Commander Proxy ───────────────────────────────────────────────────
const SONOS_BASE = 'http://localhost:5005';

app.use('/api/sonos', (req, res) => {
  const target = `${SONOS_BASE}${req.originalUrl.replace('/api/sonos', '/api')}`;
  const url = new URL(target);
  const options = {
    hostname: url.hostname,
    port: url.port,
    path: url.pathname + url.search,
    method: req.method,
    headers: { 'Content-Type': 'application/json' },
    timeout: 15000
  };
  const proxy = http.request(options, (proxyRes) => {
    let data = '';
    proxyRes.on('data', chunk => data += chunk);
    proxyRes.on('end', () => {
      res.status(proxyRes.statusCode);
      try { res.json(JSON.parse(data)); } catch (e) { res.send(data); }
    });
  });
  proxy.on('error', (e) => res.status(502).json({ ok: false, error: `Sonos Commander: ${e.message}` }));
  proxy.on('timeout', () => { proxy.destroy(); res.status(504).json({ ok: false, error: 'Sonos Commander timeout' }); });
  if (req.body && Object.keys(req.body).length > 0) proxy.write(JSON.stringify(req.body));
  proxy.end();
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

  // Connect to Caseta if paired
  if (config.caseta && config.caseta.bridgeIp && casetaCertsExist()) {
    try {
      await casetaConnect();
      console.log(`  Caseta Bridge: connected (${config.caseta.bridgeIp})`);
    } catch (e) {
      console.log(`  Caseta Bridge: NOT reachable (${config.caseta.bridgeIp}) - ${e.message}`);
    }
  } else {
    console.log(`  Caseta Bridge: ${config.caseta && config.caseta.bridgeIp ? 'not paired (run /api/caseta/pair)' : 'not configured'}`);
  }

  // Caseta LEAP
  casetaLeapCreds = loadCasetaLeapCreds();
  if (casetaLeapCreds) {
    try {
      const leapClient = await getCasetaLeapClient();
      const { SmartBridge } = require('lutron-leap');
      const bridge = new SmartBridge('caseta', leapClient);
      const devices = await bridge.getDeviceInfo();
      // Build device map: key -> { name, zoneHref }
      casetaLeapDevices = {};
      for (const d of devices) {
        if (!d.LocalZones || d.LocalZones.length === 0) continue;
        const rawName = d.FullyQualifiedName || d.Name || '';
        const name = typeof rawName === 'string' ? rawName : Array.isArray(rawName) ? rawName.join(',') : String(rawName);
        const key = name.split(',').pop().trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
        casetaLeapDevices[key] = { name, zoneHref: d.LocalZones[0].href, href: d.href };
      }
      const devKeys = Object.keys(casetaLeapDevices);
      console.log(`  Caseta LEAP: connected (${casetaLeapCreds.bridgeIp}) - ${devKeys.length} devices (${devKeys.join(', ')})`);
    } catch (e) {
      console.log(`  Caseta LEAP: paired but unreachable - ${e.message}`);
      casetaLeapClient = null;
    }
  } else {
    console.log('  Caseta LEAP: not paired (run: node pair-caseta-leap.js)');
  }

  // Test Nanoleaf
  if (config.nanoleaf && config.nanoleaf.ip && config.nanoleaf.token) {
    try {
      const nl = await nanoleafGetState();
      console.log(`  Nanoleaf: connected (${config.nanoleaf.ip}) - ${nl.name || 'ok'}`);
    } catch (e) {
      console.log(`  Nanoleaf: NOT reachable (${config.nanoleaf.ip}) - ${e.message}`);
    }
  } else {
    console.log(`  Nanoleaf: ${config.nanoleaf && config.nanoleaf.ip ? 'not paired (run /api/nanoleaf/pair)' : 'not configured'}`);
  }

  // Check Samsung TV
  if (config.samsung && config.samsung.ip) {
    const tvAvail = await samsungIsAvailable();
    console.log(`  Samsung TV: ${tvAvail ? 'reachable' : 'NOT reachable'} (${config.samsung.ip})${config.samsung.token ? ' - paired' : ' - not paired (POST /api/tv/pair)'}`);
    const st = config.samsung.smartThings;
    if (st && st.deviceId) {
      console.log(`  SmartThings: ${st.accessToken ? 'OAuth' : st.pat ? 'PAT' : 'no token'} | device ${st.deviceId.substring(0, 8)}...`);
      // Refresh token on startup to ensure it's fresh
      if (st.refreshToken && st.clientId) {
        smartThingsRefreshToken()
          .then(() => console.log('  SmartThings: token refreshed on startup'))
          .catch(e => console.log(`  SmartThings: startup refresh failed (${e.message}) - may need re-auth`));
      }
      startSmartThingsRefreshTimer();
      // Reset evening mode daily at 5AM
      cron.schedule('0 5 * * *', () => {
        if (tvEveningMode) {
          samsungSetEnergySaving(false).then(() => {
            tvEveningMode = false;
            logActivity('samsung', 'Evening mode auto-reset (5AM cron)');
          }).catch(e => logActivity('samsung', `Evening mode reset failed: ${e.message}`));
        }
      });
      console.log('  Cron: evening mode reset scheduled (daily 5AM)');
    }
  } else {
    console.log('  Samsung TV: not configured');
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n${'═'.repeat(55)}`);
    console.log(`  Home Orchestrator running at http://0.0.0.0:${PORT}`);
    console.log(`  Routines: ${Object.keys(config.routines).length}  |  Hue: ${config.hue.bridgeIp}  |  SwitchBot: ${config.switchbot.token ? 'configured' : 'not set'}`);
    console.log(`${'═'.repeat(55)}\n`);
    logActivity('startup', `Started with ${Object.keys(config.routines).length} routines`);

    // Auto-resume daytime gradient if it was running before restart
    if (config.daytimeGradient && config.daytimeGradient.gradientWasRunning) {
      logActivity('gradient', 'Auto-resuming daytime gradient (was running before restart)');
      startDaytimeGradient().catch(e => logActivity('gradient', `Auto-resume failed: ${e.message}`));
    }
  });
}

start();
