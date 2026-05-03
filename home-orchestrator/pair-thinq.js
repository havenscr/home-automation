#!/usr/bin/env node
// One-time script to discover LG ThinQ devices via PAT and write IDs into config.json.
// Run: node pair-thinq.js
// Requires: config.climate.thinq.pat and config.climate.thinq.country to be set first.

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const CONFIG_FILE = path.join(__dirname, 'config.json');

const COUNTRY_TO_REGION = {
  AG:'aic', AR:'aic', AW:'aic', BB:'aic', BO:'aic', BR:'aic', BS:'aic', BZ:'aic',
  CA:'aic', CL:'aic', CO:'aic', CR:'aic', CU:'aic', DM:'aic', DO:'aic', EC:'aic',
  GD:'aic', GT:'aic', GY:'aic', HN:'aic', HT:'aic', JM:'aic', KN:'aic', LC:'aic',
  MX:'aic', NI:'aic', PA:'aic', PE:'aic', PR:'aic', PY:'aic', SR:'aic', SV:'aic',
  TT:'aic', US:'aic', UY:'aic', VC:'aic', VE:'aic',
};

const API_KEY = 'v6GFvkweNo7DK7yD3ylIZ9w52aKBU0eJ7wLXkSR3';

function thinqRequest({ pat, country, clientId, pathname, method = 'GET', body = null }) {
  const region = COUNTRY_TO_REGION[country] || 'aic';
  const host = `api-${region}.lgthinq.com`;
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
    const req = https.request({ host, path: pathname, method, headers }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch (e) { reject(new Error(`Bad JSON: ${data.slice(0, 200)}`)); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function main() {
  const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  if (!config.climate || !config.climate.thinq || !config.climate.thinq.pat) {
    console.error('config.climate.thinq.pat is missing. Add it to config.json first.');
    process.exit(1);
  }

  const { pat, country = 'US' } = config.climate.thinq;
  let { clientId } = config.climate.thinq;
  if (!clientId) {
    clientId = crypto.randomUUID();
    config.climate.thinq.clientId = clientId;
    console.log(`Generated clientId: ${clientId}`);
  }

  console.log(`Listing devices for country=${country}...`);
  const list = await thinqRequest({ pat, country, clientId, pathname: '/devices' });
  const devices = (list.response && list.response) || list || [];
  const arr = Array.isArray(devices) ? devices : (devices.devices || []);

  if (!arr.length) {
    console.error('No devices returned. Response:', JSON.stringify(list).slice(0, 500));
    process.exit(1);
  }

  console.log(`\nFound ${arr.length} device(s):\n`);
  for (const dev of arr) {
    const id = dev.deviceId || dev.id;
    const type = dev.deviceInfo?.deviceType || dev.deviceType || 'unknown';
    const alias = dev.deviceInfo?.alias || dev.alias || dev.deviceInfo?.name || '(no name)';
    console.log(`  ${alias}`);
    console.log(`    deviceId: ${id}`);
    console.log(`    deviceType: ${type}`);
  }

  // Filter to ACs and pull each profile so we know exact property keys/temp unit.
  const acs = arr.filter(d => {
    const t = d.deviceInfo?.deviceType || d.deviceType || '';
    return t === 'DEVICE_AIR_CONDITIONER' || /AIR_CONDITIONER|AC/.test(t);
  });
  if (!acs.length) {
    console.error('\nNo air conditioners found. ACs may need to be DEVICE_AIR_CONDITIONER type.');
    process.exit(1);
  }

  console.log(`\nFetching profile + state for ${acs.length} AC(s)...`);
  const enriched = [];
  for (const ac of acs) {
    const id = ac.deviceId || ac.id;
    const alias = ac.deviceInfo?.alias || ac.alias || id;
    try {
      const profile = await thinqRequest({ pat, country, clientId, pathname: `/devices/${id}/profile` });
      const state = await thinqRequest({ pat, country, clientId, pathname: `/devices/${id}/state` });
      enriched.push({ id, alias, profile: profile.response || profile, state: state.response || state });
      console.log(`  ${alias}: profile + state ok`);
    } catch (e) {
      console.error(`  ${alias}: failed -- ${e.message}`);
    }
  }

  // Print summary so user can map alias -> office/kitchen.
  console.log('\n--- AC summary ---');
  for (const ac of enriched) {
    console.log(`\n${ac.alias} (${ac.id})`);
    console.log(`  state.airFlow.windStrength = ${JSON.stringify(ac.state?.airFlow?.windStrength)}`);
    console.log(`  state.temperature = ${JSON.stringify(ac.state?.temperature)}`);
    console.log(`  state.operation = ${JSON.stringify(ac.state?.operation)}`);
    console.log(`  state.airConJobMode = ${JSON.stringify(ac.state?.airConJobMode)}`);
  }

  // Auto-assign by alias hint; user can edit config.json afterward to fix mapping.
  if (!config.climate.devices) config.climate.devices = {};
  for (const ac of enriched) {
    const lower = (ac.alias || '').toLowerCase();
    let slot = null;
    if (/office|study|den/.test(lower)) slot = 'office';
    else if (/kitchen|living|dining/.test(lower)) slot = 'kitchen';
    if (slot) {
      config.climate.devices[slot] = {
        deviceId: ac.id,
        displayName: ac.alias,
      };
      console.log(`  assigned ${slot} <- ${ac.alias}`);
    }
  }
  if (!config.climate.devices.office || !config.climate.devices.kitchen) {
    console.log('\nNote: could not auto-assign both rooms by name.');
    console.log('Edit config.climate.devices manually to map office and kitchen to the right deviceIds.');
  }

  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  console.log('\nSaved deviceIds (and clientId if new) to config.json.');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
