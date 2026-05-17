#!/usr/bin/env node
// Hue bridge whitelist cleanup. Lists every API key the bridge knows about,
// flags candidates for deletion (stale beyond a threshold, plus an explicit
// always-keep list), and either prints the plan (--dry-run, default) or
// actually deletes (--apply).
//
// Run on the Pi:
//   node /opt/home-orchestrator/scripts/hue-whitelist-cleanup.js
//   node /opt/home-orchestrator/scripts/hue-whitelist-cleanup.js --apply
//
// Safety:
//   - Hardcoded KEEP_NAMES never get deleted regardless of age
//   - Bridge will refuse to delete the key making the request, so the
//     orchestrator's own key is safe even if you forget to add it
//   - Default mode is dry-run

const fs = require('fs');
const http = require('http');
const path = require('path');

const CONFIG_FILE = '/opt/home-orchestrator/config.json';
const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
const BRIDGE = cfg.hue.bridgeIp;
const APIKEY = cfg.hue.apiKey;

// Any whitelist entry whose `name` matches one of these (substring, case-sensitive)
// is always preserved, regardless of age. Be specific -- broad names like
// "homebridge-hue" match dead duplicates from past installs too.
const KEEP_NAMES = [
  'Hue Sync#Samsung TV',          // active TV entertainment integration
  'hue-alexa-smarthome-skill',    // Alexa to Hue
];

// Any whitelist entry whose `keyid` matches these is always preserved.
// Pin specific keyids for active integrations whose names are too generic
// (multiple entries share the same name across years -- only the newest is live).
const KEEP_KEYIDS = [
  APIKEY,                         // never delete the orchestrator's own key
  '3b190e20-dd2f-4f',             // unknown key user wants to keep (lZo6R169...)
  'abc8e2cd-4652-42',             // active iftttv2 (newer of two)
  '8dd36b08-9124-43',             // active Hue Sync#OMEGAPC (newest of four)
  'f6eaf8a0-6b04-4e',             // active Hue#Reid's iPhone (newer of two)
];

// Names to ALWAYS delete regardless of recency. Overrides the stale window.
const DELETE_NAMES = [
  'HueSyncMusic',  // third-party music sync app, 10 stale duplicates
];

// Stale threshold: anything older than this is a deletion candidate.
const STALE_MONTHS = 6;

function hueGet(urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: BRIDGE,
      port: 80,
      path: `/api/${APIKEY}${urlPath}`,
      method: 'GET',
      timeout: 8000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { resolve(data); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

function hueDelete(keyid) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: BRIDGE,
      port: 80,
      path: `/api/${APIKEY}/config/whitelist/${keyid}`,
      method: 'DELETE',
      timeout: 8000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { resolve(data); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

function shouldKeep(keyid, name) {
  // Force-delete overrides keep rules.
  for (const del of DELETE_NAMES) {
    if (name && name.includes(del)) return null;
  }
  if (KEEP_KEYIDS.some(k => keyid.startsWith(k))) return 'KEEP (keyid pinned)';
  for (const keep of KEEP_NAMES) {
    if (name && name.includes(keep)) return `KEEP (name match: "${keep}")`;
  }
  return null;
}

function isStale(lastUse) {
  if (!lastUse) return true;  // never used -> stale
  const cutoff = Date.now() - (STALE_MONTHS * 30 * 24 * 3600 * 1000);
  return new Date(lastUse).getTime() < cutoff;
}

function countdown(seconds) {
  return new Promise((resolve) => {
    let remaining = seconds;
    process.stdout.write(`Starting deletion in ${remaining}s... `);
    const t = setInterval(() => {
      remaining--;
      process.stdout.write(`${remaining} `);
      if (remaining <= 0) {
        clearInterval(t);
        process.stdout.write('\nGO\n');
        resolve();
      }
    }, 1000);
  });
}

async function main() {
  const apply = process.argv.includes('--apply');
  console.log(`Hue whitelist cleanup -- ${apply ? 'APPLY MODE (will delete)' : 'DRY RUN (no changes)'}`);
  console.log(`Bridge: ${BRIDGE}  Threshold: stale > ${STALE_MONTHS} months\n`);

  if (apply) {
    console.log('Hue bridge requires the physical LINK BUTTON to be pressed before whitelist DELETEs work.');
    console.log('You have 30 seconds: walk to the Hue bridge and press the round button on top NOW.\n');
    await countdown(30);
    console.log('Deleting (racing the 30s window from button press)...\n');
  }

  const config = await hueGet('/config');
  if (!config || !config.whitelist) {
    console.error('Could not fetch /config or no whitelist returned');
    process.exit(1);
  }
  const wl = config.whitelist;
  const entries = Object.entries(wl).map(([kid, info]) => ({
    keyid: kid,
    name: info.name || '(unnamed)',
    lastUse: info['last use date'] || null,
    created: info['create date'] || null,
  }));

  let keep = 0, deleted = 0, failed = 0, errors = [];
  entries.sort((a, b) => (b.lastUse || '').localeCompare(a.lastUse || ''));
  for (const e of entries) {
    const keepReason = shouldKeep(e.keyid, e.name);
    const forceDelete = DELETE_NAMES.some(d => e.name && e.name.includes(d));
    if (keepReason) {
      console.log(`KEEP    ${e.lastUse || 'never'} | ${e.name.padEnd(40)} | ${e.keyid.slice(0, 16)}... | ${keepReason}`);
      keep++;
      continue;
    }
    if (!isStale(e.lastUse) && !forceDelete) {
      console.log(`KEEP    ${e.lastUse || 'never'} | ${e.name.padEnd(40)} | ${e.keyid.slice(0, 16)}... | recent (within ${STALE_MONTHS}mo)`);
      keep++;
      continue;
    }
    // Candidate for deletion.
    if (apply) {
      try {
        const result = await hueDelete(e.keyid);
        const ok = Array.isArray(result) && result[0] && (result[0].success || (result[0].error == null));
        if (ok) {
          console.log(`DELETE  ${e.lastUse || 'never'} | ${e.name.padEnd(40)} | ${e.keyid.slice(0, 16)}... | OK`);
          deleted++;
        } else {
          console.log(`FAIL    ${e.lastUse || 'never'} | ${e.name.padEnd(40)} | ${e.keyid.slice(0, 16)}... | ${JSON.stringify(result)}`);
          failed++;
          errors.push({ keyid: e.keyid, result });
        }
        // No rate limit -- the 30s link-button window is tight, 91 deletes
        // at 300ms apart = 27s, no margin. Bridge handles bursts fine.
      } catch (err) {
        console.log(`FAIL    ${e.lastUse || 'never'} | ${e.name.padEnd(40)} | ${e.keyid.slice(0, 16)}... | ${err.message}`);
        failed++;
      }
    } else {
      console.log(`WOULD-DELETE ${e.lastUse || 'never'} | ${e.name.padEnd(40)} | ${e.keyid.slice(0, 16)}...`);
    }
  }
  console.log(`\nSummary: ${entries.length} total, ${keep} kept, ${apply ? deleted + ' deleted, ' + failed + ' failed' : (entries.length - keep) + ' would be deleted'}`);
  if (!apply) console.log('\nRe-run with --apply to actually delete.');
}

main().catch(e => { console.error(e); process.exit(1); });
