#!/usr/bin/env node
// One-time script to pair with Caseta Smart Bridge via HAP protocol.
// Run: node pair-caseta.js
// The bridge must be on the network. No button press needed for HAP pairing.

const fs = require('fs');
const path = require('path');

const CASETA_IP = '192.168.1.14';
const SETUP_CODE = '370-63-674';
const PAIRING_FILE = path.join(__dirname, 'caseta-hap-pairing.json');

async function main() {
  const { HttpClient, IPDiscovery } = require('hap-controller');

  console.log(`Discovering Caseta bridge at ${CASETA_IP}...`);

  // Discover the bridge via mDNS or direct connection
  let client;
  try {
    const discovery = new IPDiscovery();
    const devices = [];
    discovery.on('serviceUp', (device) => {
      console.log(`  Found: ${device.name} at ${device.address}:${device.port} (id: ${device.id})`);
      devices.push(device);
    });
    discovery.start();

    // Wait up to 15s for discovery
    await new Promise((resolve) => {
      const check = setInterval(() => {
        const match = devices.find(d => d.address === CASETA_IP);
        if (match) { clearInterval(check); resolve(); }
      }, 500);
      setTimeout(() => { clearInterval(check); resolve(); }, 15000);
    });
    discovery.stop();

    const device = devices.find(d => d.address === CASETA_IP);
    if (!device) {
      console.log('Bridge not found via mDNS. Trying direct connection on port 80...');
      client = new HttpClient(null, CASETA_IP, 80);
    } else {
      console.log(`Using discovered bridge: ${device.name} at port ${device.port}`);
      client = new HttpClient(device.id, device.address, device.port);
    }
  } catch (e) {
    console.log(`Discovery error: ${e.message}. Trying direct connection...`);
    client = new HttpClient(null, CASETA_IP, 80);
  }

  console.log(`\nPairing with setup code ${SETUP_CODE}...`);
  try {
    await client.pairSetup(SETUP_CODE);
  } catch (e) {
    console.error(`Pairing failed: ${e.message}`);
    console.error('Make sure the setup code is correct and the bridge is not already paired to max controllers.');
    process.exit(1);
  }
  console.log('Pairing successful!');

  console.log('\nDiscovering accessories...');
  let accessories;
  try {
    accessories = await client.getAccessories();
  } catch (e) {
    console.error(`Accessory discovery failed: ${e.message}`);
    process.exit(1);
  }

  // Map accessories - find ones with Brightness characteristic
  const HAP_TYPES = {
    name: '00000023-0000-1000-8000-0026BB765291',
    brightness: '00000008-0000-1000-8000-0026BB765291',
    on: '00000025-0000-1000-8000-0026BB765291'
  };

  const accessoryMap = {};
  for (const acc of accessories.accessories) {
    const chars = acc.services.flatMap(s => s.characteristics);
    const nameChar = chars.find(c => c.type === HAP_TYPES.name || c.type === '23');
    const briChar = chars.find(c => c.type === HAP_TYPES.brightness || c.type === '8');
    const onChar = chars.find(c => c.type === HAP_TYPES.on || c.type === '25');

    const name = nameChar ? nameChar.value : `accessory_${acc.aid}`;
    console.log(`  aid:${acc.aid} "${name}" ${briChar ? '(dimmable)' : '(no brightness)'}`);

    if (briChar) {
      const key = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
      accessoryMap[key] = {
        aid: acc.aid,
        briIid: briChar.iid,
        onIid: onChar ? onChar.iid : null,
        name: name
      };
    }
  }

  const result = {
    bridgeIp: CASETA_IP,
    port: client._port || 80,
    pairingData: client.getLongTermData(),
    accessories: accessoryMap
  };

  fs.writeFileSync(PAIRING_FILE, JSON.stringify(result, null, 2));
  fs.chmodSync(PAIRING_FILE, 0o600);
  console.log(`\nSaved pairing data to ${PAIRING_FILE}`);
  console.log(`Accessories: ${Object.keys(accessoryMap).join(', ')}`);
  console.log('Done!');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
