#!/usr/bin/env node
// One-time script to pair with Caseta Smart Bridge 2 via LEAP protocol.
// Run: node pair-caseta-leap.js
// Press the button on the bridge when prompted.

const fs = require('fs');
const path = require('path');
const { PairingClient } = require('lutron-leap');
const { execSync } = require('child_process');

const CASETA_IP = '192.168.1.14';
const CASETA_PAIR_PORT = 8083;
const CREDS_FILE = path.join(__dirname, 'caseta-leap-creds.json');

function generateCSR() {
  const tmpKey = '/tmp/caseta-pair-key.pem';
  const tmpCsr = '/tmp/caseta-pair-csr.pem';
  execSync(`openssl req -new -newkey rsa:2048 -nodes -keyout ${tmpKey} -out ${tmpCsr} -subj "/CN=home-orchestrator"`, { stdio: 'pipe' });
  const privateKey = fs.readFileSync(tmpKey, 'utf8');
  const csr = fs.readFileSync(tmpCsr, 'utf8');
  try { fs.unlinkSync(tmpKey); fs.unlinkSync(tmpCsr); } catch(e) {}
  return { csr, privateKey };
}

async function tryPair(client, csr, attemptNum) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('timeout')), 15000);

    const handler = (response) => {
      console.log(`  [attempt ${attemptNum}] Response:`, JSON.stringify(response).substring(0, 200));

      if (response.Body && response.Body.SigningResult) {
        clearTimeout(timeout);
        client.removeListener('message', handler);
        resolve(response.Body.SigningResult);
      }

      if (response.Body && response.Body.Exception) {
        clearTimeout(timeout);
        client.removeListener('message', handler);
        reject(new Error(response.Body.Exception.Message));
      }

      // Button press notification -- send CSR again
      if (response.Body && response.Body.Status && response.Body.Status.Permissions) {
        const perms = response.Body.Status.Permissions;
        console.log(`  Permissions: ${perms.join(', ')}`);
        if (perms.includes('PhysicalAccess')) {
          console.log('  Button detected! Sending CSR...');
          client.requestPair(csr);
        }
      }
    };

    client.on('message', handler);
    client.requestPair(csr);
  });
}

async function main() {
  console.log('Generating key pair and CSR...');
  const { csr, privateKey } = generateCSR();

  console.log(`Connecting to Caseta bridge at ${CASETA_IP}:${CASETA_PAIR_PORT}...`);
  const client = new PairingClient(CASETA_IP, CASETA_PAIR_PORT);
  await client.connect();
  console.log('Connected!\n');

  // Attempt 1: try immediately (might work if button was recently pressed)
  console.log('Attempt 1: Sending CSR (in case button was already pressed)...');
  try {
    const result = await tryPair(client, csr, 1);
    return saveAndFinish(result, privateKey);
  } catch (e) {
    console.log(`  Result: ${e.message}\n`);
  }

  // Attempt 2-5: ask user to press button and retry
  for (let attempt = 2; attempt <= 6; attempt++) {
    console.log('========================================');
    console.log('  Press the button on the bridge NOW');
    console.log(`  Attempt ${attempt}/6 -- waiting 15s...`);
    console.log('========================================\n');

    // Small delay to let user press button
    await new Promise(r => setTimeout(r, 3000));

    // Reconnect (bridge may close connection after rejection)
    try {
      const client2 = new PairingClient(CASETA_IP, CASETA_PAIR_PORT);
      await client2.connect();
      console.log(`  Connected, sending CSR...`);
      const result = await tryPair(client2, csr, attempt);
      return saveAndFinish(result, privateKey);
    } catch (e) {
      console.log(`  Result: ${e.message}\n`);
    }
  }

  console.error('All attempts failed. Make sure you are pressing the small button on the BACK of the bridge.');
  process.exit(1);
}

async function saveAndFinish(signingResult, privateKey) {
  console.log('\nPairing successful! Certificate received.');

  const creds = {
    bridgeIp: CASETA_IP,
    leapPort: 8081,
    cert: signingResult.Certificate,
    rootCert: signingResult.RootCertificate,
    privateKey: privateKey,
    pairedAt: new Date().toISOString(),
  };

  fs.writeFileSync(CREDS_FILE, JSON.stringify(creds, null, 2));
  fs.chmodSync(CREDS_FILE, 0o600);
  console.log(`Saved credentials to ${CREDS_FILE}`);

  // Try to list devices
  console.log('\nConnecting via LEAP to list devices...');
  try {
    const { SmartBridge, LeapClient } = require('lutron-leap');
    const leapClient = new LeapClient(CASETA_IP, 8081, creds.cert, creds.privateKey, creds.rootCert);
    await leapClient.connect();
    const bridge = new SmartBridge('caseta', leapClient);
    const devices = await bridge.getDeviceInfo();
    console.log(`Found ${devices.length} devices:`);
    for (const dev of devices) {
      const zones = dev.LocalZones ? dev.LocalZones.map(z => z.href).join(', ') : 'none';
      console.log(`  ${dev.FullyQualifiedName || dev.Name || 'Unknown'} (href: ${dev.href}, zones: ${zones})`);
    }
    bridge.close();
  } catch (e) {
    console.log(`Device listing failed (${e.message}), but credentials are saved.`);
  }

  console.log('\nDone!');
  process.exit(0);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
