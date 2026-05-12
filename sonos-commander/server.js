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
      // migrate: add scenes/groupPresets/knownSpeakers if missing
      if (!config.scenes) config.scenes = getDefaultScenes();
      if (!config.groupPresets) config.groupPresets = getDefaultGroupPresets();
      if (!config.knownSpeakers) config.knownSpeakers = {};
      saveConfig();
    } else {
      config = { routines: getDefaultRoutines(), scenes: getDefaultScenes(), groupPresets: getDefaultGroupPresets(), knownSpeakers: {} };
      saveConfig();
    }
  } catch (e) {
    console.error('Config error:', e.message);
    config = { routines: getDefaultRoutines(), scenes: getDefaultScenes(), groupPresets: getDefaultGroupPresets(), knownSpeakers: {} };
    saveConfig();
  }
}
function saveConfig() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}
function saveKnownSpeakers() {
  const known = {};
  for (const [name, info] of Object.entries(speakerInfo)) {
    if (isBoost(name)) continue;
    known[name] = { ip: info.ip, model: info.model, capabilities: info.capabilities };
  }
  config.knownSpeakers = known;
  saveConfig();
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

// ─── Speaker Capabilities ────────────────────────────────────────────────────
function getModelCapabilities(model) {
  const m = (model || '').toLowerCase();
  const caps = [];
  // Speakers with line-in (3.5mm or auto-detect)
  if (m.includes('five') || m.includes('play:5') || m.includes('port') || m.includes('amp') || m.includes('connect')) caps.push('lineIn');
  // Speakers with TV input (HDMI ARC / optical)
  if (m.includes('playbase') || m.includes('playbar') || m.includes('beam') || m.includes('arc') || m.includes('ray')) caps.push('tv');
  return caps;
}

// ─── Sonos Discovery ────────────────────────────────────────────────────────
async function discoverSpeakers() {
  return new Promise((resolve) => {
    console.log('Discovering speakers...');

    // Pre-populate from known speakers (all start as offline)
    for (const [name, known] of Object.entries(config.knownSpeakers || {})) {
      if (!speakerInfo[name]) {
        speakerInfo[name] = { ip: known.ip, model: known.model, name, rincon: '', capabilities: known.capabilities || [], online: false };
      } else {
        speakerInfo[name].online = false;
      }
      // Create Sonos object from last-known IP (may work if still reachable)
      if (!speakers[name]) {
        speakers[name] = new Sonos(known.ip);
      }
    }

    const discovered = new Set();
    const discovery = DeviceDiscovery({ timeout: 10000 });
    discovery.on('DeviceAvailable', async (device) => {
      try {
        const sonos = new Sonos(device.host);
        const desc = await sonos.deviceDescription();
        const room = desc.roomName;
        if (!discovered.has(room)) {
          discovered.add(room);
          speakers[room] = sonos;
          const caps = getModelCapabilities(desc.modelName || '');
          speakerInfo[room] = { ip: device.host, model: desc.modelName || 'Unknown', name: room, rincon: speakerInfo[room]?.rincon || '', capabilities: caps, online: true };
          console.log(`  Found: ${room} (${desc.modelName}) @ ${device.host}`);
        }
      } catch (e) { console.error(`  Error: ${device.host}: ${e.message}`); }
    });
    setTimeout(async () => {
      try { discovery.destroy(); } catch(e) {}

      // Supplement SSDP with group topology (catches speakers SSDP misses)
      const anyOnline = Object.keys(speakers).find(n => !isBoost(n) && speakerInfo[n]?.online);
      if (anyOnline) {
        try {
          const groups = await speakers[anyOnline].getAllGroups();
          for (const group of groups) {
            const members = Array.isArray(group.ZoneGroupMember) ? group.ZoneGroupMember : [group.ZoneGroupMember];
            for (const member of members) {
              const room = member.ZoneName;
              if (discovered.has(room) || isBoost(room) || member.Invisible) continue;
              const locMatch = member.Location && member.Location.match(/\/\/([^:\/]+)/);
              if (!locMatch) continue;
              const memberIP = locMatch[1];
              try {
                const sonos = new Sonos(memberIP);
                const desc = await withTimeout(sonos.deviceDescription(), 3000, `topology ${room}`);
                discovered.add(room);
                speakers[room] = sonos;
                const caps = getModelCapabilities(desc.modelName || '');
                speakerInfo[room] = { ip: memberIP, model: desc.modelName || 'Unknown', name: room, rincon: member.UUID || '', capabilities: caps, online: true };
                console.log(`  Found: ${room} (${desc.modelName}) @ ${memberIP} (via topology)`);
              } catch (e) {
                console.log(`  Topology: ${room} @ ${memberIP} unreachable: ${e.message}`);
              }
            }
          }
        } catch (e) {
          console.log(`  Topology check failed: ${e.message}`);
        }
      }

      // Try to reach known speakers still not found
      const missed = Object.entries(speakerInfo).filter(([name, info]) => !discovered.has(name) && !isBoost(name));
      if (missed.length > 0) {
        console.log(`  Checking ${missed.length} known speaker(s) not found by SSDP or topology...`);
        await Promise.all(missed.map(async ([name, info]) => {
          try {
            const sonos = new Sonos(info.ip);
            const desc = await withTimeout(sonos.deviceDescription(), 3000, `ping ${name}`);
            speakers[name] = sonos;
            speakerInfo[name].online = true;
            speakerInfo[name].model = desc.modelName || info.model;
            console.log(`  Reached: ${name} (${desc.modelName}) @ ${info.ip} (direct ping)`);
          } catch (e) {
            console.log(`  Offline: ${name} @ ${info.ip}`);
            speakerInfo[name].online = false;
          }
        }));
      }

      await ensureCoordinators();
      // Recompute capabilities after ensureCoordinators may have updated models
      for (const [room, info] of Object.entries(speakerInfo)) {
        info.capabilities = getModelCapabilities(info.model);
      }

      // Save known speakers to config for persistence
      saveKnownSpeakers();

      const onlineCount = Object.values(speakerInfo).filter(i => i.online).length;
      const totalCount = Object.keys(speakerInfo).filter(n => !isBoost(n)).length;
      logActivity('discovery', `Found ${onlineCount}/${totalCount} speakers online`, { rooms: Object.keys(speakerInfo) });
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
        // Capture RINCON UUID from group topology (most reliable source)
        if (member.UUID && speakerInfo[room]) {
          speakerInfo[room].rincon = member.UUID;
        }
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
      favorites = (favs.items || []).map(f => {
        const uri = f.uri || '';
        const isSpotify = uri.startsWith('x-rincon-cpcontainer:') && uri.includes('spotify');
        return { title: f.title, uri, metadata: f.metadata || '', type: isSpotify ? 'spotify' : (uri.startsWith('x-sonosapi-radio:') ? 'radio' : 'other'), shuffleable: isSpotify };
      });
      console.log('Loaded ' + favorites.length + ' favorites from ' + room);
      return favorites;
    } catch (e) { console.log('Favorites skip ' + room + ': ' + e.message); }
  }
  console.error('Could not load favorites from any speaker');
  return [];
}

// Find the actual group coordinator for a speaker (may differ from requested coord due to stereo pairs)
async function findGroupCoordinator(roomName) {
  try {
    const groups = await speakers[roomName].getAllGroups();
    for (const g of groups) {
      const members = Array.isArray(g.ZoneGroupMember) ? g.ZoneGroupMember : [g.ZoneGroupMember];
      if (members.some(m => m.ZoneName === roomName)) {
        const coordEntry = Object.entries(speakerInfo).find(([n, i]) => i.ip === g.host && !isBoost(n));
        return coordEntry ? coordEntry[0] : roomName;
      }
    }
  } catch (e) {}
  return roomName;
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
      else if (uri.startsWith('x-sonos-vli:') || uri.startsWith('x-sonos-htastream:')) {
        // Playbars/Playbases retain TV URI in metadata even when playing streaming music.
        // Only report TV if there's no streaming content (title + external album art).
        const hasStreamingContent = track?.title && track?.albumArtURI &&
          !track.albumArtURI.startsWith('/');
        inputSource = hasStreamingContent ? null : 'TV';
      }
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
  // Check which speakers are already in coordName's group (only if coordName is the actual coordinator)
  let alreadyGrouped = new Set();
  try {
    const coordIP = speakerInfo[coordName]?.ip;
    const groups = await speakers[coordName].getAllGroups();
    for (const g of groups) {
      if (g.host !== coordIP) continue; // Only skip if coordName is actually the group coordinator
      const members = Array.isArray(g.ZoneGroupMember) ? g.ZoneGroupMember : [g.ZoneGroupMember];
      members.forEach(m => { if (!m.Invisible) alreadyGrouped.add(m.ZoneName); });
      break;
    }
  } catch (e) {}
  let toJoin = Object.entries(speakers)
    .filter(([name]) => name !== coordName && !isBoost(name) && !alreadyGrouped.has(name));
  // Preflight: skip TV-capable speakers (Playbar/Playbase) that are currently on
  // their TV input. They refuse to become slaves (UPnP 402 "Invalid Args") and the
  // routine ends up coordinating from the TV speaker anyway via the
  // findGroupCoordinator fallback. Querying state is cheap and parallel-safe.
  const tvSkips = [];
  const stateChecks = await Promise.all(toJoin.map(async ([name]) => {
    const caps = (speakerInfo[name] && speakerInfo[name].capabilities) || [];
    if (!caps.includes('tv')) return { name, onTv: false };
    try {
      const st = await withTimeout(getState(name), 2000, `state ${name}`);
      return { name, onTv: !!(st && st.inputSource === 'TV') };
    } catch (e) {
      return { name, onTv: false };
    }
  }));
  for (const c of stateChecks) if (c.onTv) tvSkips.push(c.name);
  if (tvSkips.length) {
    toJoin = toJoin.filter(([name]) => !tvSkips.includes(name));
    console.log(`  Skipping ${tvSkips.length} TV-mode speakers: ${tvSkips.join(', ')}`);
  }
  if (toJoin.length === 0) {
    console.log('  All speakers already grouped under ' + coordName + ', skipping joins');
    return tvSkips.map(name => ({ room: name, status: 'skipped-tv' }));
  }
  console.log(`  Joining ${toJoin.length} speakers to ${coordName} (${Math.max(0, alreadyGrouped.size - 1)} already grouped)`);
  const results = await Promise.all(toJoin.map(([name, device]) =>
    withTimeout(device.joinGroup(coordName), 5000, `join ${name}`)
      .then(() => ({ room: name, status: 'joined' }))
      .catch(e => ({ room: name, status: 'error', error: e.message }))
  ));
  // Retry any failed joins once
  const failed = results.filter(r => r.status === 'error');
  if (failed.length > 0) {
    console.log(`  Retrying ${failed.length} failed joins: ${failed.map(r => r.room).join(', ')}`);
    await new Promise(r => setTimeout(r, 1000));
    for (const f of failed) {
      if (speakers[f.room]) {
        try {
          await withTimeout(speakers[f.room].joinGroup(coordName), 5000, `retry join ${f.room}`);
          f.status = 'joined';
          console.log(`  Retry succeeded: ${f.room}`);
        } catch (e) {
          // UPnP 402 on a TV-capable speaker means it can't be a slave right now
          // (TV input just released, or some other transient mode). Benign: the
          // findGroupCoordinator fallback uses it as coordinator instead. Log
          // it once at a calmer severity so the audit doesn't flag it as a problem.
          const caps = (speakerInfo[f.room] && speakerInfo[f.room].capabilities) || [];
          const is402 = /errorCode>402</.test(e.message);
          if (is402 && caps.includes('tv')) {
            console.log(`  Note: ${f.room} declined to join as slave (likely TV-mode quirk on S1 Playbar/Playbase); will fall back to it as coordinator if needed`);
          } else {
            console.log(`  Retry failed: ${f.room}: ${e.message}`);
          }
        }
      }
    }
  }
  // Include preflight-skipped speakers in the result so callers see them.
  for (const name of tvSkips) results.push({ room: name, status: 'skipped-tv' });
  return results;
}

async function groupRooms(roomNames, coordName) {
  coordName = coordName || roomNames[0];
  if (!speakers[coordName]) throw new Error(`Coordinator "${coordName}" not found`);
  const joins = roomNames
    .filter(name => name !== coordName && speakers[name])
    .map(name =>
      withTimeout(speakers[name].joinGroup(coordName), 5000, `join ${name}`)
        .then(() => ({ room: name, status: 'joined' }))
        .catch(e => ({ room: name, status: 'error', error: e.message }))
    );
  return Promise.all(joins);
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
  // Episodes/podcasts can't use device.play() -- they need setAVTransportURI with the Sonos-native URI
  const spotifyMatch = fav.uri.match(/spotify%3a(?:user%3a[^%]+%3a)?(playlist|album|track|episode)%3a([a-zA-Z0-9]+)/i);
  if (spotifyMatch && spotifyMatch[1] !== 'episode') {
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

// ─── Input Source ───────────────────────────────────────────────────────────
async function applyInputSource(coordRoom, input) {
  const device = speakers[coordRoom];
  if (!device) return;
  if (input.type === 'favorite') {
    const fav = favorites.find(f => f.title === input.name);
    if (!fav) throw new Error(`Favorite "${input.name}" not found`);
    await device.setAVTransportURI({ uri: fav.uri, metadata: fav.metadata });
    await device.play();
    console.log(`  Input: playing favorite "${input.name}" on ${coordRoom}`);
  } else if (input.type === 'lineIn') {
    const sourceRoom = input.room || coordRoom;
    const info = speakerInfo[sourceRoom];
    if (!info || !info.rincon) throw new Error(`No RINCON for "${sourceRoom}"`);
    const uri = `x-rincon-stream:${info.rincon}`;
    await device.setAVTransportURI({ uri, metadata: '' });
    await device.play();
    console.log(`  Input: line-in from ${sourceRoom} on ${coordRoom}`);
  } else if (input.type === 'tv') {
    const sourceRoom = input.room || coordRoom;
    const info = speakerInfo[sourceRoom];
    if (!info || !info.rincon) throw new Error(`No RINCON for "${sourceRoom}"`);
    const uri = `x-sonos-htastream:${info.rincon}:spdif`;
    await device.setAVTransportURI({ uri, metadata: '' });
    console.log(`  Input: TV from ${sourceRoom} on ${coordRoom}`);
  }
}

// ─── Group Presets ──────────────────────────────────────────────────────────
async function applyGroupPreset(presetId) {
  const preset = config.groupPresets[presetId];
  if (!preset) throw new Error(`Group preset "${presetId}" not found`);

  // Ungroup everything first
  await ungroupAll();
  await new Promise(r => setTimeout(r, 1000));

  if (preset.groups && preset.groups.length > 0) {
    // Multi-group mode: each sub-group gets its own coordinator and volume
    for (const group of preset.groups) {
      const groupRoomsList = group.rooms || [];
      if (groupRoomsList.length === 0) continue;

      if (groupRoomsList.length > 1) {
        await groupRooms(groupRoomsList, groupRoomsList[0]);
        await new Promise(r => setTimeout(r, 800));
      }

      // Set volume for each room in this sub-group (skip if setVolume is explicitly false)
      if (group.volume != null && group.setVolume !== false) {
        for (const roomName of groupRoomsList) {
          if (speakers[roomName]) {
            try { await speakers[roomName].setVolume(group.volume); } catch(e) {}
          }
        }
      }

      // Set input source on the coordinator (first room in the group)
      const coord = groupRoomsList[0];
      if (group.input && speakers[coord]) {
        try { await applyInputSource(coord, group.input); } catch(e) { console.log(`  Input source error for ${coord}: ${e.message}`); }
      }
    }
    logActivity('group_preset', `Applied: ${preset.name} (${preset.groups.length} groups)`, { presetId });
    return { preset: presetId, groups: preset.groups };
  } else {
    // Legacy mode: single rooms array, optional volume
    let rooms = preset.rooms && preset.rooms.length > 0 ? preset.rooms : Object.keys(speakers).filter(n => !n.toLowerCase().includes('boost'));
    if (rooms.length >= 2) {
      await groupRooms(rooms, rooms[0]);
    }
    if (preset.volume != null) {
      for (const roomName of rooms) {
        if (speakers[roomName]) {
          try { await speakers[roomName].setVolume(preset.volume); } catch(e) {}
        }
      }
    }
    logActivity('group_preset', `Applied: ${preset.name}`, { rooms });
    return { preset: presetId, rooms };
  }
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
  // Legacy stateCheck support
  if (routine.stateCheck) {
    const rooms = Object.keys(speakers);
    if (rooms.length > 0) {
      try {
        const state = await speakers[rooms[0]].getCurrentState();
        if (routine.stateCheck.onlyIfPlaying && state !== 'playing') return false;
        if (routine.stateCheck.onlyIfStopped && state === 'playing') return false;
      } catch (e) {}
    }
  }
  // Conditions system: skip based on input source state
  // conditionLogic: "any" (OR, default) = skip if ANY matches; "all" (AND) = skip only if ALL match
  if (routine.conditions && routine.conditions.length > 0) {
    const useAll = routine.conditionLogic === 'all';
    const results = [];
    for (const cond of routine.conditions) {
      if (!cond.speaker || !cond.source || !speakers[cond.speaker]) continue;
      try {
        const st = await getState(cond.speaker);
        const srcNorm = cond.source.toLowerCase().replace(/\s/g, '');
        const sourceActive = st && st.inputSource &&
          st.inputSource.toLowerCase().replace(/\s/g, '') === srcNorm;
        const wantOn = (cond.is || 'on') === 'on';
        const matches = (wantOn && sourceActive) || (!wantOn && !sourceActive);
        results.push({ cond, matches });
        if (matches) console.log(`[Routine] Condition match: ${cond.speaker} ${wantOn ? 'IS' : 'is NOT'} on ${cond.source}`);
      } catch (e) {
        console.log(`[Routine] Condition check error for ${cond.speaker}: ${e.message}`);
        results.push({ cond, matches: false });
      }
    }
    if (results.length > 0) {
      const shouldSkip = useAll
        ? results.every(r => r.matches)   // AND: skip only if ALL match
        : results.some(r => r.matches);   // OR: skip if ANY matches
      if (shouldSkip) {
        console.log(`[Routine] Skipping — conditions met (logic: ${useAll ? 'ALL' : 'ANY'})`);
        return false;
      }
    }
  }
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
    if (!routine.favorite && !routine.spotifyUri && !(routine.spotifyQueue && routine.spotifyQueue.length > 0)) throw new Error('No favorite, spotifyUri, or spotifyQueue configured');
    // Cancel any active sleep timers that might interfere with volume
    for (const timerId of Object.keys(activeSleepTimers)) {
      console.log(`[Routine] Cancelling active sleep timer: ${timerId}`);
      cancelSleepTimer(timerId);
    }
    // Pause all speakers first so joining speakers don't inherit stale playback
    console.log(`[Routine] Pausing all speakers before setup`);
    await pauseAll();
    await new Promise(r => setTimeout(r, 300));
    let coord;
    if (routine.rooms && routine.rooms.length > 0) {
      coord = routine.coordinator || routine.rooms[0];
      // Ungroup selected rooms first so they leave any existing group
      for (const n of routine.rooms) { if (speakers[n]) try { await speakers[n].leaveGroup(); } catch(e){} }
      await new Promise(r => setTimeout(r, 500));
      if (routine.rooms.length > 1) {
        console.log(`[Routine] Grouping selected rooms [${routine.rooms.join(', ')}] to ${coord}`);
        await groupRooms(routine.rooms, coord);
        await new Promise(r => setTimeout(r, 800));
      } else {
        console.log(`[Routine] Single room: ${coord}`);
      }
      for (const n of routine.rooms) {
        if (speakers[n]) try {
          await speakers[n].setVolume(routine.volume || 10);
          console.log(`[Routine] Volume set: ${n} -> ${routine.volume || 10}`);
        } catch(e) { console.log(`[Routine] Volume FAILED: ${n}: ${e.message}`); }
      }
    } else if (routine.groupAll) {
      coord = routine.coordinator || Object.keys(speakers).filter(n => !n.toLowerCase().includes("boost"))[0];
      console.log(`[Routine] Grouping all speakers to ${coord}`);
      await groupAllSpeakers(coord);
      await new Promise(r => setTimeout(r, 800));
      for (const [n, d] of Object.entries(speakers)) {
        if (n.toLowerCase().includes('boost')) continue;
        try {
          await d.setVolume(routine.volume || 10);
          console.log(`[Routine] Volume set: ${n} -> ${routine.volume || 10}`);
        } catch(e) { console.log(`[Routine] Volume FAILED: ${n}: ${e.message}`); }
      }
    } else {
      coord = routine.coordinator || Object.keys(speakers).filter(n => !n.toLowerCase().includes("boost"))[0];
      // Ungroup the target speaker so it plays independently (avoids coordinator mismatch)
      if (speakers[coord]) try { await speakers[coord].leaveGroup(); await new Promise(r => setTimeout(r, 500)); } catch(e){}
      if (speakers[coord]) try {
        await speakers[coord].setVolume(routine.volume || 10);
        console.log(`[Routine] Volume set: ${coord} -> ${routine.volume || 10}`);
      } catch(e) { console.log(`[Routine] Volume FAILED: ${coord}: ${e.message}`); }
    }
    await new Promise(r => setTimeout(r, 200));
    // Must use actual group coordinator for playback (calling play on a member causes it to leave the group)
    const actualCoord = await findGroupCoordinator(coord);
    if (actualCoord !== coord) console.log(`[Routine] Actual coordinator: ${actualCoord} (requested: ${coord})`);
    if (routine.spotifyQueue && routine.spotifyQueue.length > 0) {
      // Multi-track Spotify queue playback
      console.log(`[Routine] Queuing ${routine.spotifyQueue.length} Spotify tracks on ${actualCoord}`);
      await speakers[actualCoord].flush();
      for (const uri of routine.spotifyQueue) {
        try {
          await speakers[actualCoord].queue(uri);
          console.log(`[Routine] Queued: ${uri}`);
        } catch (e) {
          console.log(`[Routine] Queue failed for ${uri}: ${e.message}`);
        }
      }
      await speakers[actualCoord].selectQueue();
      await speakers[actualCoord].selectTrack(1);
      await speakers[actualCoord].play();
      console.log(`[Routine] Playing queue of ${routine.spotifyQueue.length} tracks (starting from track 1)`);
    } else if (routine.spotifyUri) {
      console.log(`[Routine] Playing Spotify URI: ${routine.spotifyUri} on ${actualCoord}`);
      // Episodes/podcasts need Sonos-native URI format (node-sonos queue() doesn't handle them)
      const episodeMatch = routine.spotifyUri.match(/^spotify:episode:([a-zA-Z0-9]+)$/);
      if (episodeMatch) {
        const sonosUri = `x-sonos-spotify:spotify%3aepisode%3a${episodeMatch[1]}?sid=12&flags=8&sn=1`;
        console.log(`[Routine] Episode detected, using Sonos URI: ${sonosUri}`);
        await speakers[actualCoord].setAVTransportURI({ uri: sonosUri, metadata: '' });
        await speakers[actualCoord].play();
      } else {
        // Tracks/albums/playlists: queue-based playback
        await speakers[actualCoord].flush();
        await speakers[actualCoord].queue(routine.spotifyUri);
        await speakers[actualCoord].selectQueue();
        await speakers[actualCoord].play();
      }
    } else if (routine.favorite) {
      console.log(`[Routine] Playing favorite: ${routine.favorite} on ${actualCoord}`);
      const fav = favorites.find(f => f.title === routine.favorite);
      const spotifyMatch = fav && fav.uri.match(/spotify%3a(?:user%3a[^%]+%3a)?(playlist|album|track|episode)%3a([a-zA-Z0-9]+)/i);
      if (routine.shuffle && spotifyMatch) {
        // Queue-based shuffle for Spotify: flush → queue → selectQueue → play → shuffle → next
        const spotifyUri = `spotify:${spotifyMatch[1]}:${spotifyMatch[2]}`;
        console.log(`[Routine] Shuffle mode: queuing ${spotifyUri}`);
        await speakers[actualCoord].flush();
        const qResult = await speakers[actualCoord].queue(spotifyUri);
        console.log(`[Routine] Queued ${qResult.NumTracksAdded} tracks`);
        await speakers[actualCoord].selectQueue();
        await speakers[actualCoord].play();
        await new Promise(r => setTimeout(r, 1500));
        await speakers[actualCoord].setPlayMode('SHUFFLE');
        await speakers[actualCoord].next();
        console.log(`[Routine] Shuffle enabled, skipped to random track`);
      } else {
        await playFavorite(routine.favorite, actualCoord);
        console.log(`[Routine] playFavorite succeeded`);
        if (routine.shuffle) {
          console.log(`[Routine] Shuffle requested but favorite is not a Spotify playlist - skipping shuffle`);
        }
      }
    }
    // Seek to beginning if configured
    if (routine.seekToStart) {
      await new Promise(r => setTimeout(r, 500));
      try { await speakers[actualCoord].seek(0); console.log(`[Routine] Seeked to start`); } catch(e) { console.log(`[Routine] Seek failed: ${e.message}`); }
    }
    if (routine.sleepTimer && routine.sleepTimer.enabled) {
      startSleepTimer(id, routine.sleepTimer.minutes || 60, routine.sleepTimer.fadeMinutes || 5);
    }
    // Handle "other speakers" (speakers not in this routine's rooms)
    if (routine.otherSpeakers && routine.rooms && routine.rooms.length > 0) {
      let otherNames = Object.keys(speakers)
        .filter(n => !isBoost(n) && !routine.rooms.includes(n));
      // Skip speakers on Line In for stop/pause -- pausing them triggers auto-play rebound
      // that interferes with routine speaker volumes via Sonos group volume management
      if (routine.otherSpeakers.action === 'stop' || routine.otherSpeakers.action === 'pause') {
        const skipNames = [];
        for (const n of otherNames) {
          try {
            const st = await getState(n);
            if (st && st.inputSource === 'Line In') {
              skipNames.push(n);
              console.log(`[Routine] Skipping ${n} (Line In active)`);
            }
          } catch(e) {}
        }
        otherNames = otherNames.filter(n => !skipNames.includes(n));
      }
      if (otherNames.length > 0) {
        const action = routine.otherSpeakers.action;
        console.log(`[Routine] Handling ${otherNames.length} other speakers: ${action}`);
        // Ungroup others so they're independent
        for (const n of otherNames) {
          try { await speakers[n].leaveGroup(); } catch(e) {}
        }
        await new Promise(r => setTimeout(r, 500));
        // Only group others together for volume-based actions (not stop/pause)
        if (action !== 'stop' && action !== 'pause' && otherNames.length > 1) {
          await groupRooms(otherNames, otherNames[0]);
          await new Promise(r => setTimeout(r, 800));
        }
        for (const n of otherNames) {
          try {
            switch (action) {
              case 'stop': case 'pause':
                await speakers[n].pause(); break;
              case 'mute':
                await speakers[n].setVolume(0); break;
              case 'setVolume':
                await speakers[n].setVolume(routine.otherSpeakers.volume || 0); break;
            }
          } catch(e) { /* 701 = already stopped, expected */ }
        }
        console.log(`[Routine] Other speakers: ${action} complete`);
      }
    }
    // Post-playback volume verification -- catches drift from transport changes
    await new Promise(r => setTimeout(r, 1000));
    const targetVol = routine.volume || 10;
    const volSpeakers = routine.rooms && routine.rooms.length > 0
      ? routine.rooms : Object.keys(speakers).filter(n => !isBoost(n));
    for (const n of volSpeakers) {
      if (speakers[n]) {
        try {
          const currentVol = await speakers[n].getVolume();
          if (currentVol !== targetVol) {
            console.log(`[Routine] Volume drift: ${n} at ${currentVol}, correcting to ${targetVol}`);
            await speakers[n].setVolume(targetVol);
          }
        } catch(e) {}
      }
    }
    result = { played: routine.favorite, volume: routine.volume, rooms: routine.rooms, shuffle: !!routine.shuffle };
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
      case 'tvVolume': {
        // Smart TV volume: checks autoSkip rules to skip speakers when their input source is active
        const volumes = routine.volumes || {};
        const autoSkipRules = Array.isArray(routine.autoSkip) ? routine.autoSkip : (routine.autoSkip && routine.autoSkip.speaker ? [routine.autoSkip] : []);
        const skippedSpeakers = new Set();
        for (const rule of autoSkipRules) {
          if (!rule.speaker || !rule.source || !speakers[rule.speaker]) continue;
          try {
            const skipSt = await getState(rule.speaker);
            const srcMatch = skipSt && skipSt.inputSource &&
              skipSt.inputSource.toLowerCase().replace(/\s/g, '') === rule.source.toLowerCase();
            if (srcMatch) {
              skippedSpeakers.add(rule.speaker);
              console.log(`[Routine] tvVolume: autoSkip ${rule.speaker} (${rule.source}) = ACTIVE`);
            } else {
              console.log(`[Routine] tvVolume: autoSkip ${rule.speaker} (${rule.source}) = inactive`);
            }
          } catch (e) { console.log(`[Routine] tvVolume: autoSkip ${rule.speaker} check failed: ${e.message}`); }
        }
        if (!autoSkipRules.length) console.log(`[Routine] tvVolume: no autoSkip rules`);
        const tvSpeakerSet = new Set(routine.pauseExcept || []);
        for (const [room, vol] of Object.entries(volumes)) {
          if (!speakers[room] || isBoost(room)) continue;
          if (skippedSpeakers.has(room)) {
            console.log(`[Routine] tvVolume: skipping ${room} (input active)`);
            continue;
          }
          if (tvSpeakerSet.has(room)) {
            console.log(`[Routine] tvVolume: ${room} vol=${vol} (delayed 5s for CEC)`);
            continue; // TV speakers set after delay to override CEC/ARC
          }
          try {
            if (vol === 0 && routine.muteIsOff) {
              await speakers[room].pause();
              console.log(`[Routine] tvVolume: ${room} paused (vol=0)`);
            } else {
              await speakers[room].setVolume(vol);
              console.log(`[Routine] tvVolume: ${room} vol=${vol}`);
            }
          } catch (e) { console.log(`[Routine] tvVolume: ${room} error: ${e.message}`); }
        }
        // Pause non-TV speakers if configured
        if (tvSpeakerSet.size > 0) {
          const except = new Set(tvSpeakerSet);
          for (const s of skippedSpeakers) except.add(s);
          for (const name of Object.keys(speakers)) {
            if (isBoost(name) || except.has(name)) continue;
            try { await speakers[name].pause(); } catch (e) { /* 701 = already stopped */ }
          }
          console.log(`[Routine] tvVolume: paused non-TV speakers (except ${[...except].join(', ')})`);
        }
        // Delayed volume set for TV speakers to override CEC/ARC volume commands
        if (tvSpeakerSet.size > 0) {
          const tvToSet = [...tvSpeakerSet].filter(s => speakers[s] && !skippedSpeakers.has(s) && volumes[s] !== undefined);
          if (tvToSet.length > 0) {
            setTimeout(async () => {
              for (const name of tvToSet) {
                try {
                  await speakers[name].setVolume(volumes[name]);
                  console.log(`[Routine] tvVolume: CEC override ${name} vol=${volumes[name]}`);
                } catch (e) { console.log(`[Routine] tvVolume: CEC override ${name} error: ${e.message}`); }
              }
            }, 5000);
          }
        }
        // Trigger sub-routines (like Bedroom TV Up/Down)
        if (routine.subRoutines) {
          for (const subId of routine.subRoutines) {
            if (config.routines[subId] && config.routines[subId].enabled) {
              try { await executeRoutine(subId); } catch (e) { console.log(`[Routine] sub-routine ${subId} error: ${e.message}`); }
            }
          }
        }
        result = { action: 'tvVolume', skipped: [...skippedSpeakers] };
        break;
      }
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
app.get('/api/groups', async (req, res) => {
  const anyRoom = Object.keys(speakers).find(n => !isBoost(n) && speakerInfo[n]?.online !== false);
  if (!anyRoom) return res.json([]);
  try {
    const groups = await speakers[anyRoom].getAllGroups();
    const result = [];
    for (const g of groups) {
      const members = Array.isArray(g.ZoneGroupMember) ? g.ZoneGroupMember : [g.ZoneGroupMember];
      const visible = members.filter(m => m && !m.Invisible && !isBoost(m.ZoneName));
      if (visible.length === 0) continue;
      const coordEntry = Object.entries(speakerInfo).find(([n, i]) => i.ip === g.host && !isBoost(n));
      const coordName = coordEntry ? coordEntry[0] : visible[0].ZoneName;
      result.push({
        id: g.ID || coordName,
        coordinator: coordName,
        members: visible.map(m => m.ZoneName),
        memberCount: visible.length
      });
    }
    res.json(result);
  } catch (e) {
    console.error('Groups API error:', e.message);
    res.json([]);
  }
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
  const force = req.query.force === 'true' || req.body?.force === true;
  try { const r = await executeRoutine(req.params.id, { checkState: !force }); res.json({ ok: true, ...r }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/play-queue', async (req, res) => {
  try {
    const { uris, volume, groupAll } = req.body;
    if (!uris || !uris.length) return res.status(400).json({ error: 'No URIs provided' });

    let coord;
    if (groupAll !== false) {
      coord = Object.keys(speakers).filter(n => !n.toLowerCase().includes('boost'))[0];
      console.log(`[play-queue] Grouping all speakers to ${coord}`);
      await groupAllSpeakers(coord);
      await new Promise(r => setTimeout(r, 800));
      console.log(`[play-queue] Grouping complete`);
    } else {
      coord = Object.keys(speakers).filter(n => !n.toLowerCase().includes('boost'))[0];
    }

    if (volume != null) {
      console.log(`[play-queue] Setting volume to ${volume}`);
      for (const [n, d] of Object.entries(speakers)) {
        if (n.toLowerCase().includes('boost')) continue;
        try { await d.setVolume(volume); } catch(e) {}
      }
    }

    const actualCoord = await findGroupCoordinator(coord);
    console.log(`[play-queue] Coordinator: ${actualCoord}, queueing ${uris.length} tracks`);
    await speakers[actualCoord].flush();
    for (const uri of uris) {
      try {
        await speakers[actualCoord].queue(uri);
        console.log(`[play-queue] Queued: ${uri}`);
      } catch(e) { console.log(`[play-queue] Queue failed: ${uri}: ${e.message}`); }
    }
    await speakers[actualCoord].selectQueue();
    await speakers[actualCoord].selectTrack(1);
    await speakers[actualCoord].play();
    console.log(`[play-queue] Playing ${uris.length} tracks from track 1`);

    logActivity('play-queue', `Playing ${uris.length} tracks on ${actualCoord}`, { volume });
    res.json({ ok: true, tracks: uris.length, coordinator: actualCoord });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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

// ─── Periodic Speaker Health Check ──────────────────────────────────────────
const HEALTH_CHECK_INTERVAL = 2 * 60 * 1000; // 2 minutes
let healthCheckRunning = false;

async function speakerHealthCheck() {
  if (healthCheckRunning) return;
  healthCheckRunning = true;
  try {
    const offlineSpeakers = Object.entries(speakerInfo).filter(([name, info]) => !info.online && !isBoost(name));
    if (offlineSpeakers.length === 0) return;

    const totalSpeakers = Object.keys(speakerInfo).filter(n => !isBoost(n)).length;
    const allOffline = offlineSpeakers.length === totalSpeakers;

    if (allOffline) {
      // All speakers offline (power outage recovery): full rediscovery
      console.log('[Health] All speakers offline, running full rediscovery...');
      await discoverSpeakers();
      await loadFavorites();
      const recovered = Object.values(speakerInfo).filter(i => i.online).length;
      if (recovered > 0) {
        console.log(`[Health] Recovered ${recovered}/${totalSpeakers} speakers`);
        logActivity('health', `Power recovery: found ${recovered}/${totalSpeakers} speakers`);
      }
    } else {
      // Some offline: lightweight ping check
      let recovered = 0;
      await Promise.all(offlineSpeakers.map(async ([name, info]) => {
        try {
          const sonos = new Sonos(info.ip);
          const desc = await withTimeout(sonos.deviceDescription(), 3000, `health ${name}`);
          speakers[name] = sonos;
          speakerInfo[name].online = true;
          speakerInfo[name].model = desc.modelName || info.model;
          speakerInfo[name].capabilities = getModelCapabilities(desc.modelName || info.model);
          recovered++;
          console.log(`[Health] Recovered: ${name} @ ${info.ip}`);
        } catch (e) { /* still offline */ }
      }));
      if (recovered > 0) {
        saveKnownSpeakers();
        logActivity('health', `Recovered ${recovered} speaker(s): ${offlineSpeakers.filter(([n]) => speakerInfo[n].online).map(([n]) => n).join(', ')}`);
      }
    }
  } catch (e) {
    console.error('[Health] Check failed:', e.message);
  } finally {
    healthCheckRunning = false;
  }
}

// ─── Startup ────────────────────────────────────────────────────────────────
async function start() {
  loadConfig();
  await discoverSpeakers();
  await loadFavorites();
  // Start periodic health check for offline speaker recovery
  setInterval(speakerHealthCheck, HEALTH_CHECK_INTERVAL);
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n${'═'.repeat(51)}`);
    console.log(`  Sonos Commander running at http://0.0.0.0:${PORT}`);
    console.log(`  Speakers: ${Object.keys(speakers).length}  |  Favorites: ${favorites.length}  |  Routines: ${Object.keys(config.routines).length}`);
    console.log(`${'═'.repeat(51)}\n`);
    logActivity('startup', `Started with ${Object.keys(speakers).length} speakers, ${favorites.length} favorites`);
  });
}
start();
