const express = require('express');
const { DeviceDiscovery, Sonos } = require('sonos');
const fs = require('fs');
const path = require('path');
const http = require('http');

const PORT = 5005;
const CONFIG_FILE = path.join(__dirname, 'config.json');
const LOG_FILE = path.join(__dirname, 'activity.log');
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let speakers = {}, speakerInfo = {}, favorites = [], config = {};

// ─── Activity Log ───────────────────────────────────────────────────────────
function logActivity(type, message, details = {}) {
  const entry = JSON.stringify({ ts: new Date().toISOString(), type, message, ...details });
  try { fs.appendFileSync(LOG_FILE, entry + '\n'); } catch (e) {}
  // trim to 500 lines
  try {
    const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean);
    if (lines.length > 500) fs.writeFileSync(LOG_FILE, lines.slice(-500).join('\n') + '\n');
  } catch (e) {}
}

// ─── Config ─────────────────────────────────────────────────────────────────
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      // migrate: add scenes/groupPresets if missing
      if (!config.scenes) config.scenes = getDefaultScenes();
      if (!config.groupPresets) config.groupPresets = getDefaultGroupPresets();
      saveConfig();
    } else {
      config = { routines: getDefaultRoutines(), scenes: getDefaultScenes(), groupPresets: getDefaultGroupPresets() };
      saveConfig();
    }
  } catch (e) {
    console.error('Config error:', e.message);
    config = { routines: getDefaultRoutines(), scenes: getDefaultScenes(), groupPresets: getDefaultGroupPresets() };
    saveConfig();
  }
}
function saveConfig() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function getDefaultRoutines() {
  return {
    Music_Morning:    { name:"Morning Music",    type:"music", favorite:"", volume:5,  groupAll:true, coordinator:"", enabled:true },
    Day_Music:        { name:"Day Music",        type:"music", favorite:"", volume:10, groupAll:true, coordinator:"", enabled:true },
    Evening_Music:    { name:"Evening Music",    type:"music", favorite:"", volume:10, groupAll:true, coordinator:"", enabled:true },
    Late_Night_Music: { name:"Late Night Music", type:"music", favorite:"", volume:5,  groupAll:true, coordinator:"", enabled:true },
    Music_Workday:    { name:"Workday Music",    type:"music", favorite:"", volume:10, groupAll:true, coordinator:"", enabled:true },
    Upbeat_Music:     { name:"Upbeat Music",     type:"music", favorite:"", volume:10, groupAll:true, coordinator:"", enabled:true },
    Reading_Music:    { name:"Reading Music",    type:"music", favorite:"", volume:10, groupAll:true, coordinator:"", enabled:true },
    Romantic_Playlist:{ name:"Romantic Playlist", type:"music", favorite:"", volume:10, groupAll:true, coordinator:"", enabled:true },
    White_Noise_Sleep:{ name:"White Noise Sleep", type:"music", favorite:"", volume:5, groupAll:true, coordinator:"", enabled:true,
                        sleepTimer:{ enabled:false, minutes:60, fadeMinutes:5 } },
    Sonos_Off:        { name:"Sonos Off",        type:"control", action:"pauseAll", enabled:true },
    Sonos_Group:      { name:"Group All",        type:"control", action:"groupAll", coordinator:"", enabled:true },
    Sonos_Non_LR_Pause: { name:"Pause Non-LR",  type:"control", action:"pauseExcept", exceptRooms:[], volumeRoom:"", volumeLevel:45, enabled:true },
    Sonos_Pause_Music_LR_and_Office: { name:"Pause Non-LR (Office On)", type:"control", action:"pauseExcept", exceptRooms:[], volumeRoom:"", volumeLevel:45, enabled:true },
    bedroom_tv_down:  { name:"Bedroom TV Vol Down", type:"control", action:"volumeAdjust", targetRoom:"", volumeAdjust:-5, enabled:true },
    bedroom_tv_up:    { name:"Bedroom TV Vol Up",   type:"control", action:"volumeAdjust", targetRoom:"", volumeAdjust:5,  enabled:true },
    Fireplace_On:     { name:"Fireplace On",  type:"webhook", webhookUrl:"", webhookMethod:"POST", enabled:false, notes:"Configure with local smart plug IP/API" },
    Fireplace_Off:    { name:"Fireplace Off", type:"webhook", webhookUrl:"", webhookMethod:"POST", enabled:false, notes:"Configure with local smart plug IP/API" },
    Candles_On:       { name:"Candles On",    type:"webhook", webhookUrl:"", webhookMethod:"POST", enabled:false, notes:"Configure with local smart plug IP/API" },
    Candles_Off:      { name:"Candles Off",   type:"webhook", webhookUrl:"", webhookMethod:"POST", enabled:false, notes:"Configure with local smart plug IP/API" },
    Office_Candles_On:{ name:"Office Candles On",      type:"webhook", webhookUrl:"", webhookMethod:"POST", enabled:false, notes:"Configure with local smart plug IP/API" },
    Common_Candles_Off:{ name:"Common Candles Off",    type:"webhook", webhookUrl:"", webhookMethod:"POST", enabled:false, notes:"Configure with local smart plug IP/API" }
  };
}

function getDefaultScenes() {
  return {
    background_work: { name:"Background Work", icon:"💻", description:"Low volume, single room", actions:[{type:"ungroupAll"},{type:"setVolume",room:"",volume:15}] },
    movie_night:     { name:"Movie Night",     icon:"🎬", description:"Playbase loud, others off", actions:[{type:"pauseExcept",exceptRooms:[]},{type:"setVolume",room:"",volume:45}] },
    party:           { name:"Party Mode",      icon:"🎉", description:"All speakers, volume up",  actions:[{type:"groupAll"},{type:"setVolumeAll",volume:25}] },
    recording:       { name:"Recording Mode",  icon:"🎙️", description:"Mute everything",          actions:[{type:"pauseAll"}] },
    late_night:      { name:"Late Night",       icon:"🌙", description:"All grouped, whisper vol", actions:[{type:"groupAll"},{type:"setVolumeAll",volume:5}] }
  };
}

function getDefaultGroupPresets() {
  return {
    all:          { name:"All Speakers",  icon:"🏠", rooms:[] },
    office_kitchen:{ name:"Office + Kitchen", icon:"☕", rooms:[] },
    bedrooms:     { name:"Bedrooms Only", icon:"🛏️", rooms:[] },
    common_areas: { name:"Common Areas",  icon:"🛋️", rooms:[] }
  };
}

// ─── Sonos Discovery ────────────────────────────────────────────────────────
async function discoverSpeakers() {
  return new Promise((resolve) => {
    console.log('Discovering speakers...');
    speakers = {}; speakerInfo = {};
    const discovery = DeviceDiscovery({ timeout: 10000 });
    discovery.on('DeviceAvailable', async (device) => {
      try {
        const sonos = new Sonos(device.host);
        const desc = await sonos.deviceDescription();
        const room = desc.roomName;
        if (!speakers[room]) {
          speakers[room] = sonos;
          speakerInfo[room] = { ip: device.host, model: desc.modelName || 'Unknown', name: room };
          console.log(`  Found: ${room} (${desc.modelName}) @ ${device.host}`);
        }
      } catch (e) { console.error(`  Error: ${device.host}: ${e.message}`); }
    });
    setTimeout(async () => {
      try { discovery.destroy(); } catch(e) {}
      await ensureCoordinators();
      logActivity('discovery', `Found ${Object.keys(speakers).length} speakers`, { rooms: Object.keys(speakerInfo) });
      resolve(speakers);
    }, 12000);
  });
}

async function ensureCoordinators() {
  // For stereo pairs / surround setups, ensure we store the coordinator (master) not the slave/satellite.
  // Uses each member's Location URL (always points to the correct device for that room,
  // even when speakers are in a multi-room group) instead of group.host (which is the
  // multi-room group coordinator and would incorrectly point all speakers to one IP).
  const anyRoom = Object.keys(speakers).find(n => !isBoost(n));
  if (!anyRoom) return;
  try {
    const groups = await speakers[anyRoom].getAllGroups();
    for (const group of groups) {
      const members = Array.isArray(group.ZoneGroupMember) ? group.ZoneGroupMember : [group.ZoneGroupMember];
      const processed = new Set();
      for (const member of members) {
        const room = member.ZoneName;
        if (!speakers[room] || isBoost(room)) continue;
        // Skip invisible members (stereo pair slaves, surround satellites)
        if (member.Invisible) continue;
        // Skip rooms already processed (safety for duplicate entries)
        if (processed.has(room)) continue;
        processed.add(room);
        // Extract IP from member's own Location URL (e.g. http://192.168.1.31:1400/xml/...)
        const locMatch = member.Location && member.Location.match(/\/\/([^:\/]+)/);
        if (!locMatch) continue;
        const memberIP = locMatch[1];
        if (speakers[room].host !== memberIP) {
          console.log(`  ${room}: swapping to ${memberIP} (was ${speakers[room].host})`);
          const memberSonos = new Sonos(memberIP);
          speakers[room] = memberSonos;
          speakerInfo[room].ip = memberIP;
          try {
            const desc = await memberSonos.deviceDescription();
            speakerInfo[room].model = desc.modelName || speakerInfo[room].model;
          } catch (e) {}
        }
      }
    }
    console.log('  Final speaker IPs: ' + Object.entries(speakerInfo).filter(([n]) => !isBoost(n)).map(([n,i]) => `${n}=${i.ip}`).join(', '));
  } catch (e) {
    console.log('  Coordinator check failed: ' + e.message);
  }
}

async function loadFavorites() {
  const rooms = Object.keys(speakers).filter(r => speakerInfo[r].model.indexOf('Boost') === -1);
  if (rooms.length === 0) return [];
  for (const room of rooms) {
    try {
      const favs = await speakers[room].getFavorites();
      favorites = (favs.items || []).map(f => ({ title: f.title, uri: f.uri, metadata: f.metadata || '' }));
      console.log('Loaded ' + favorites.length + ' favorites from ' + room);
      return favorites;
    } catch (e) { console.log('Favorites skip ' + room + ': ' + e.message); }
  }
  console.error('Could not load favorites from any speaker');
  return [];
}

// ─── Core Sonos Actions ─────────────────────────────────────────────────────
async function getState(roomName) {
  const d = speakers[roomName];
  if (!d) return null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const [state, vol, track] = await Promise.all([
        d.getCurrentState(), d.getVolume(), d.currentTrack().catch(()=>null)
      ]);
      const uri = track?.uri || '';
      let inputSource = null;
      if (uri.startsWith('x-rincon-stream:')) inputSource = 'Line In';
      else if (uri.startsWith('x-sonos-vli:') || uri.startsWith('x-sonos-htastream:')) inputSource = 'TV';
      // Resolve relative album art URLs to full URLs via the speaker's IP
      let artURI = track?.albumArtURI || null;
      if (artURI && artURI.startsWith('/')) artURI = 'http://' + d.host + ':1400' + artURI;
      return { state, volume: vol, track: track?.title, artist: track?.artist,
               album: track?.album, albumArtURI: artURI,
               duration: track?.duration, position: track?.position, inputSource };
    } catch (e) {
      if (attempt === 0) { await new Promise(r => setTimeout(r, 2000)); continue; }
      return { state: 'error', error: e.message };
    }
  }
}

// Helper: wrap async call with timeout
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout: ' + label + ' after ' + ms + 'ms')), ms))
  ]);
}

async function groupAllSpeakers(coordName) {
  coordName = coordName || Object.keys(speakers).filter(n => !n.toLowerCase().includes("boost"))[0];
  if (!speakers[coordName]) throw new Error(`Coordinator "${coordName}" not found`);
  const results = [];
  for (const [name, device] of Object.entries(speakers)) {
    if (name === coordName || name.toLowerCase().includes("boost")) continue;
    if (name.toLowerCase().includes('boost')) continue;
    try { await withTimeout(device.joinGroup(coordName), 5000, `join ${name}`); results.push({room:name,status:'joined'}); }
    catch (e) { results.push({room:name,status:'error',error:e.message}); }
  }
  return results;
}

async function groupRooms(roomNames, coordName) {
  coordName = coordName || roomNames[0];
  if (!speakers[coordName]) throw new Error(`Coordinator "${coordName}" not found`);
  const results = [];
  for (const name of roomNames) {
    if (name === coordName || !speakers[name]) continue;
    try { await speakers[name].joinGroup(coordName); results.push({room:name,status:'joined'}); }
    catch (e) { results.push({room:name,status:'error',error:e.message}); }
  }
  return results;
}

async function ungroupAll() {
  for (const [name, device] of Object.entries(speakers)) {
    try { await device.leaveGroup(); } catch (e) {}
  }
}

async function pauseAll() {
  for (const [name, device] of Object.entries(speakers)) {
    try { await device.pause(); } catch (e) {}
  }
}

async function pauseExcept(exceptRooms = []) {
  for (const [name, device] of Object.entries(speakers)) {
    if (exceptRooms.includes(name)) continue;
    try { await device.pause(); } catch (e) {}
  }
}

async function playFavorite(favName, coordName) {
  const fav = favorites.find(f => f.title === favName);
  if (!fav) throw new Error(`Favorite "${favName}" not found`);
  coordName = coordName || Object.keys(speakers).filter(n => !n.toLowerCase().includes("boost"))[0];
  const device = speakers[coordName];
  if (!device) throw new Error(`Speaker "${coordName}" not found`);
  // Spotify URIs need special handling -- extract spotify:type:id and use native play()
  const spotifyMatch = fav.uri.match(/spotify%3a(?:user%3a[^%]+%3a)?(playlist|album|track|episode)%3a([a-zA-Z0-9]+)/i);
  if (spotifyMatch) {
    await device.play(`spotify:${spotifyMatch[1]}:${spotifyMatch[2]}`);
  } else {
    await device.setAVTransportURI({ uri: fav.uri, metadata: fav.metadata });
    await device.play();
  }
  return { playing: favName, on: coordName };
}

// ─── Sleep Timer System ─────────────────────────────────────────────────────
let activeSleepTimers = {};

function startSleepTimer(id, minutes, fadeMinutes) {
  cancelSleepTimer(id);
  const totalMs = minutes * 60000;
  const fadeMs = fadeMinutes * 60000;
  const fadeStart = totalMs - fadeMs;
  const timer = { endsAt: new Date(Date.now() + totalMs).toISOString(), minutes, fadeMinutes };

  timer.fadeTimeout = setTimeout(() => {
    // start fading
    timer.fadeInterval = setInterval(async () => {
      for (const [name, device] of Object.entries(speakers)) {
        try {
          const vol = await device.getVolume();
          if (vol > 1) await device.setVolume(Math.max(1, vol - 2));
        } catch (e) {}
      }
    }, 10000);
  }, fadeStart);

  timer.stopTimeout = setTimeout(async () => {
    if (timer.fadeInterval) clearInterval(timer.fadeInterval);
    await pauseAll();
    // restore volumes to 10
    for (const [name, device] of Object.entries(speakers)) {
      try { await device.setVolume(10); } catch (e) {}
    }
    delete activeSleepTimers[id];
    logActivity('sleep', `Sleep timer ${id} completed`);
  }, totalMs);

  activeSleepTimers[id] = timer;
  logActivity('sleep', `Sleep timer started: ${minutes}min (${fadeMinutes}min fade)`);
}

function cancelSleepTimer(id) {
  const t = activeSleepTimers[id];
  if (!t) return;
  if (t.fadeTimeout) clearTimeout(t.fadeTimeout);
  if (t.stopTimeout) clearTimeout(t.stopTimeout);
  if (t.fadeInterval) clearInterval(t.fadeInterval);
  delete activeSleepTimers[id];
  logActivity('sleep', `Sleep timer ${id} cancelled`);
}

// ─── Queue System ───────────────────────────────────────────────────────────
let activeQueues = {};

function startQueue(id, items, coordinator) {
  cancelQueue(id);
  const q = { items, currentIndex: 0, coordinator: coordinator || Object.keys(speakers)[0] };
  activeQueues[id] = q;
  playQueueItem(id);
  logActivity('queue', `Queue started: ${items.length} items`);
}

async function playQueueItem(id) {
  const q = activeQueues[id];
  if (!q || q.currentIndex >= q.items.length) { delete activeQueues[id]; return; }
  const item = q.items[q.currentIndex];
  try {
    await playFavorite(item.favorite, q.coordinator);
    if (item.durationMinutes) {
      q.advanceTimeout = setTimeout(() => {
        q.currentIndex++;
        playQueueItem(id);
      }, item.durationMinutes * 60000);
    }
  } catch (e) { console.error('Queue error:', e.message); }
}

function cancelQueue(id) {
  const q = activeQueues[id];
  if (!q) return;
  if (q.advanceTimeout) clearTimeout(q.advanceTimeout);
  delete activeQueues[id];
}

// ─── Group Presets ──────────────────────────────────────────────────────────
async function applyGroupPreset(presetId) {
  const preset = config.groupPresets[presetId];
  if (!preset) throw new Error(`Group preset "${presetId}" not found`);
  await ungroupAll();
  await new Promise(r => setTimeout(r, 1000));
  let rooms = preset.rooms && preset.rooms.length > 0 ? preset.rooms : Object.keys(speakers);
  if (rooms.length < 2) return { preset: presetId, rooms };
  await groupRooms(rooms, rooms[0]);
  logActivity('group_preset', `Applied: ${preset.name}`, { rooms });
  return { preset: presetId, rooms };
}

// ─── Scene Execution ────────────────────────────────────────────────────────
async function executeScene(sceneId) {
  const scene = config.scenes[sceneId];
  if (!scene) throw new Error(`Scene "${sceneId}" not found`);
  for (const action of (scene.actions || [])) {
    switch (action.type) {
      case 'pauseAll': await pauseAll(); break;
      case 'pauseExcept': await pauseExcept(action.exceptRooms || []); break;
      case 'groupAll': await groupAllSpeakers(action.coordinator); break;
      case 'ungroupAll': await ungroupAll(); break;
      case 'setVolumeAll':
        for (const d of Object.values(speakers)) { try { await d.setVolume(action.volume); } catch(e){} }
        break;
      case 'setVolume':
        if (action.room && speakers[action.room]) await speakers[action.room].setVolume(action.volume);
        break;
      case 'playFavorite': await playFavorite(action.favorite, action.coordinator); break;
      case 'delay': await new Promise(r => setTimeout(r, (action.seconds||1)*1000)); break;
      case 'groupPreset': await applyGroupPreset(action.preset); break;
    }
  }
  logActivity('scene', `Executed: ${scene.name}`);
}

// ─── State-Aware Routine Execution ──────────────────────────────────────────
async function checkRoutineState(routine) {
  if (!routine.stateCheck) return true;
  const rooms = Object.keys(speakers);
  if (rooms.length === 0) return true;
  try {
    const state = await speakers[rooms[0]].getCurrentState();
    if (routine.stateCheck.onlyIfPlaying && state !== 'playing') return false;
    if (routine.stateCheck.onlyIfStopped && state === 'playing') return false;
  } catch (e) {}
  return true;
}

async function executeRoutine(id, options = {}) {
  console.log(`[Routine] Executing: ${id}`);
  const routine = config.routines[id];
  if (!routine) throw new Error(`Routine "${id}" not found`);
  if (!routine.enabled) throw new Error(`Routine "${id}" is disabled`);

  if (options.checkState !== false) {
    const ok = await checkRoutineState(routine);
    if (!ok) { logActivity('routine', `Skipped (state check): ${routine.name}`); return { skipped: true }; }
  }

  let result = {};

  if (routine.type === 'music') {
    if (!routine.favorite) throw new Error('No favorite configured');
    let coord;
    if (routine.rooms && routine.rooms.length > 0) {
      coord = routine.coordinator || routine.rooms[0];
      console.log(`[Routine] Grouping selected rooms [${routine.rooms.join(', ')}] to ${coord}`);
      await groupRooms(routine.rooms, coord);
      await new Promise(r => setTimeout(r, 800));
      for (const n of routine.rooms) { if (speakers[n]) try { await speakers[n].setVolume(routine.volume || 10); } catch(e){} }
    } else if (routine.groupAll) {
      coord = routine.coordinator || Object.keys(speakers).filter(n => !n.toLowerCase().includes("boost"))[0];
      console.log(`[Routine] Grouping all speakers to ${coord}`);
      await groupAllSpeakers(coord);
      await new Promise(r => setTimeout(r, 800));
      for (const [n, d] of Object.entries(speakers)) { if (n.toLowerCase().includes('boost')) continue; try { await d.setVolume(routine.volume || 10); } catch(e){} }
    } else {
      coord = routine.coordinator || Object.keys(speakers).filter(n => !n.toLowerCase().includes("boost"))[0];
      if (speakers[coord]) try { await speakers[coord].setVolume(routine.volume || 10); } catch(e){}
    }
    await new Promise(r => setTimeout(r, 200));
    console.log(`[Routine] Playing favorite: ${routine.favorite} on ${coord}`);
    await playFavorite(routine.favorite, coord);
    console.log(`[Routine] playFavorite succeeded`);
    if (routine.sleepTimer && routine.sleepTimer.enabled) {
      startSleepTimer(id, routine.sleepTimer.minutes || 60, routine.sleepTimer.fadeMinutes || 5);
    }
    result = { played: routine.favorite, volume: routine.volume, rooms: routine.rooms };
  } else if (routine.type === 'control') {
    switch (routine.action) {
      case 'pauseAll': await pauseAll(); break;
      case 'groupAll': await groupAllSpeakers(routine.coordinator); break;
      case 'ungroupAll': await ungroupAll(); break;
      case 'pauseExcept':
        await pauseExcept(routine.exceptRooms || []);
        if (routine.volumeRoom && speakers[routine.volumeRoom]) {
          await speakers[routine.volumeRoom].setVolume(routine.volumeLevel || 45);
        }
        break;
      case 'volumeAdjust':
        if (routine.targetRoom && speakers[routine.targetRoom]) {
          const vol = await speakers[routine.targetRoom].getVolume();
          await speakers[routine.targetRoom].setVolume(Math.max(0, Math.min(100, vol + (routine.volumeAdjust || 5))));
        }
        break;
    }
    result = { action: routine.action };
  } else if (routine.type === 'webhook') {
    if (routine.webhookUrl) {
      const method = routine.webhookMethod || 'POST';
      try {
        await fetch(routine.webhookUrl, { method });
        result = { webhook: routine.webhookUrl, method };
      } catch (e) { result = { webhook: routine.webhookUrl, error: e.message }; }
    }
    result = { type: 'webhook' };
  }

  logActivity('routine', `Executed: ${routine.name}`, result);
  return result;
}

// ─── Helpers ────────────────────────────────────────────────────────────────
function isBoost(name) {
  const info = speakerInfo[name];
  return info && info.model && info.model.indexOf('Boost') !== -1;
}
function speakerNames() { return Object.keys(speakers).filter(n => !isBoost(n)); }

// ─── API: Speakers ──────────────────────────────────────────────────────────
app.get('/api/speakers', (req, res) => {
  const filtered = {};
  for (const [name, info] of Object.entries(speakerInfo)) {
    if (!isBoost(name)) filtered[name] = info;
  }
  res.json(filtered);
});
app.post('/api/speakers/discover', async (req, res) => {
  await discoverSpeakers(); await loadFavorites();
  const names = speakerNames();
  res.json({ speakers: names, count: names.length });
});

// ─── API: Status & Now Playing ──────────────────────────────────────────────
app.get('/api/status', async (req, res) => {
  const result = {};
  for (const name of speakerNames()) { result[name] = await getState(name); }
  res.json(result);
});
app.get('/api/now-playing', async (req, res) => {
  const result = {};
  for (const name of speakerNames()) {
    const s = await getState(name);
    if (s && s.state === 'playing') result[name] = s;
  }
  res.json(result);
});

// ─── API: Favorites ─────────────────────────────────────────────────────────
app.get('/api/favorites', (req, res) => res.json(favorites));
app.post('/api/favorites/refresh', async (req, res) => {
  await loadFavorites(); res.json(favorites);
});

// ─── API: Routines ──────────────────────────────────────────────────────────
app.get('/api/routines', (req, res) => res.json(config.routines));
app.put('/api/routines/:id', (req, res) => {
  if (!config.routines[req.params.id]) return res.status(404).json({ error: 'Not found' });
  Object.assign(config.routines[req.params.id], req.body);
  saveConfig(); res.json(config.routines[req.params.id]);
});
app.post('/api/routines', (req, res) => {
  const id = req.body.id || `custom_${Date.now()}`;
  config.routines[id] = { name: req.body.name || id, type: req.body.type || 'music', enabled: true, ...req.body };
  saveConfig(); res.json({ id, routine: config.routines[id] });
});
app.delete('/api/routines/:id', (req, res) => {
  delete config.routines[req.params.id]; saveConfig(); res.json({ deleted: req.params.id });
});
app.post('/api/trigger/:id', async (req, res) => {
  try { const r = await executeRoutine(req.params.id); res.json({ ok: true, ...r }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ─── API: Scenes ────────────────────────────────────────────────────────────
app.get('/api/scenes', (req, res) => res.json(config.scenes));
app.get('/api/scenes/:id', (req, res) => {
  if (!config.scenes[req.params.id]) return res.status(404).json({ error: 'Not found' });
  res.json(config.scenes[req.params.id]);
});
app.put('/api/scenes/:id', (req, res) => {
  if (!config.scenes[req.params.id]) return res.status(404).json({ error: 'Not found' });
  Object.assign(config.scenes[req.params.id], req.body);
  saveConfig(); res.json(config.scenes[req.params.id]);
});
app.post('/api/scenes', (req, res) => {
  const id = req.body.id || `scene_${Date.now()}`;
  config.scenes[id] = { name: req.body.name || id, actions: [], ...req.body };
  saveConfig(); res.json({ id, scene: config.scenes[id] });
});
app.delete('/api/scenes/:id', (req, res) => {
  delete config.scenes[req.params.id]; saveConfig(); res.json({ deleted: req.params.id });
});
app.post('/api/scenes/:id/execute', async (req, res) => {
  try { await executeScene(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ─── API: Group Presets ─────────────────────────────────────────────────────
app.get('/api/group-presets', (req, res) => res.json(config.groupPresets));
app.get('/api/group-presets/:id', (req, res) => {
  if (!config.groupPresets[req.params.id]) return res.status(404).json({ error: 'Not found' });
  res.json(config.groupPresets[req.params.id]);
});
app.put('/api/group-presets/:id', (req, res) => {
  if (!config.groupPresets[req.params.id]) return res.status(404).json({ error: 'Not found' });
  Object.assign(config.groupPresets[req.params.id], req.body);
  saveConfig(); res.json(config.groupPresets[req.params.id]);
});
app.post('/api/group-presets', (req, res) => {
  const id = req.body.id || `preset_${Date.now()}`;
  config.groupPresets[id] = { name: req.body.name || id, rooms: [], ...req.body };
  saveConfig(); res.json({ id, preset: config.groupPresets[id] });
});
app.delete('/api/group-presets/:id', (req, res) => {
  delete config.groupPresets[req.params.id]; saveConfig(); res.json({ deleted: req.params.id });
});
app.post('/api/group-presets/:id/apply', async (req, res) => {
  try { const r = await applyGroupPreset(req.params.id); res.json({ ok: true, ...r }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ─── API: Sleep Timers ──────────────────────────────────────────────────────
app.get('/api/sleep-timers', (req, res) => {
  const result = {};
  for (const [id, t] of Object.entries(activeSleepTimers)) {
    result[id] = { endsAt: t.endsAt, minutes: t.minutes, fadeMinutes: t.fadeMinutes };
  }
  res.json(result);
});
app.post('/api/sleep-timer', (req, res) => {
  const id = `sleep_${Date.now()}`;
  startSleepTimer(id, req.body.minutes || 60, req.body.fadeMinutes || 5);
  res.json({ id, endsAt: activeSleepTimers[id].endsAt });
});
app.delete('/api/sleep-timer/:id', (req, res) => {
  cancelSleepTimer(req.params.id); res.json({ cancelled: req.params.id });
});

// ─── API: Queues ────────────────────────────────────────────────────────────
app.get('/api/queues', (req, res) => {
  const result = {};
  for (const [id, q] of Object.entries(activeQueues)) {
    result[id] = { items: q.items, currentIndex: q.currentIndex, coordinator: q.coordinator };
  }
  res.json(result);
});
app.post('/api/queue', (req, res) => {
  const id = `queue_${Date.now()}`;
  startQueue(id, req.body.items || [], req.body.coordinator);
  res.json({ id });
});
app.delete('/api/queue/:id', (req, res) => {
  cancelQueue(req.params.id); res.json({ cancelled: req.params.id });
});
app.post('/api/queue/:id/skip', (req, res) => {
  const q = activeQueues[req.params.id];
  if (!q) return res.status(404).json({ error: 'Queue not found' });
  if (q.advanceTimeout) clearTimeout(q.advanceTimeout);
  q.currentIndex++;
  playQueueItem(req.params.id);
  res.json({ skipped: true, currentIndex: q.currentIndex });
});

// ─── API: Incoming Webhooks ─────────────────────────────────────────────────
app.post('/api/incoming/:action', async (req, res) => {
  const action = req.params.action;
  logActivity('incoming', `Webhook: ${action}`, { body: req.body });
  try {
    if (config.routines[action]) { await executeRoutine(action); return res.json({ ok: true, type: 'routine' }); }
    if (config.scenes[action]) { await executeScene(action); return res.json({ ok: true, type: 'scene' }); }
    if (config.groupPresets[action]) { await applyGroupPreset(action); return res.json({ ok: true, type: 'group_preset' }); }
    res.status(404).json({ error: `No routine, scene, or preset named "${action}"` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: Quick Actions ─────────────────────────────────────────────────────
app.post('/api/action/pause-all', async (req, res) => { await pauseAll(); res.json({ ok: true }); });
app.post('/api/action/group-all', async (req, res) => {
  await groupAllSpeakers(req.body?.coordinator); res.json({ ok: true });
});
app.post('/api/action/ungroup-all', async (req, res) => { await ungroupAll(); res.json({ ok: true }); });
app.post('/api/action/volume', async (req, res) => {
  const { room, volume } = req.body;
  if (room && speakers[room]) { await speakers[room].setVolume(volume); }
  else { for (const d of Object.values(speakers)) { try { await d.setVolume(volume); } catch(e){} } }
  res.json({ ok: true });
});
app.post('/api/action/play-favorite', async (req, res) => {
  try { const r = await playFavorite(req.body.favorite, req.body.coordinator); res.json({ ok: true, ...r }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ─── API: Activity Log ──────────────────────────────────────────────────────
app.get('/api/log', (req, res) => {
  try {
    const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean);
    const limit = parseInt(req.query.limit) || 50;
    const entries = lines.slice(-limit).reverse().map(l => { try { return JSON.parse(l); } catch(e) { return null; } }).filter(Boolean);
    res.json(entries);
  } catch (e) { res.json([]); }
});
app.delete('/api/log', (req, res) => {
  try { fs.writeFileSync(LOG_FILE, ''); } catch(e) {}
  res.json({ cleared: true });
});

// ─── API: Config Export/Import ──────────────────────────────────────────────
app.get('/api/config/export', (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename=sonos-commander-config.json');
  res.json(config);
});
app.post('/api/config/import', (req, res) => {
  try {
    const imported = req.body;
    if (imported.routines) config.routines = imported.routines;
    if (imported.scenes) config.scenes = imported.scenes;
    if (imported.groupPresets) config.groupPresets = imported.groupPresets;
    saveConfig();
    logActivity('config', 'Config imported', { routines: Object.keys(config.routines).length, scenes: Object.keys(config.scenes).length });
    res.json({ ok: true, routines: Object.keys(config.routines).length, scenes: Object.keys(config.scenes).length, groupPresets: Object.keys(config.groupPresets).length });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ─── Startup ────────────────────────────────────────────────────────────────
async function start() {
  loadConfig();
  await discoverSpeakers();
  await loadFavorites();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n${'═'.repeat(51)}`);
    console.log(`  Sonos Commander running at http://0.0.0.0:${PORT}`);
    console.log(`  Speakers: ${Object.keys(speakers).length}  |  Favorites: ${favorites.length}  |  Routines: ${Object.keys(config.routines).length}`);
    console.log(`${'═'.repeat(51)}\n`);
    logActivity('startup', `Started with ${Object.keys(speakers).length} speakers, ${favorites.length} favorites`);
  });
}
start();
