#!/usr/bin/env node
// One-time script to pair with Samsung TV via WebSocket.
// Run: node pair-samsung-tv.js [TV_IP]
// The TV must be ON. Accept the "Allow" prompt that appears on the TV screen.

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const TV_IP = process.argv[2] || '192.168.1.193';
const APP_NAME = 'HomeOrchestrator';
const CONFIG_FILE = path.join(__dirname, 'config.json');

console.log(`Connecting to Samsung TV at ${TV_IP}:8002...`);
console.log('>>> LOOK AT YOUR TV SCREEN and press ALLOW <<<\n');

const name = Buffer.from(APP_NAME).toString('base64');
const url = `wss://${TV_IP}:8002/api/v2/channels/samsung.remote.control?name=${name}`;

const ws = new WebSocket(url, { rejectUnauthorized: false });

ws.on('open', () => {
  console.log('Connected to TV. Sending KEY_MUTE to trigger auth prompt...');
  ws.send(JSON.stringify({
    method: 'ms.remote.control',
    params: { Cmd: 'Click', DataOfCmd: 'KEY_MUTE', Option: false, TypeOfRemote: 'SendRemoteKey' }
  }));
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  console.log('TV response:', JSON.stringify(msg, null, 2));

  if (msg.data && msg.data.token) {
    console.log(`\nToken received: ${msg.data.token}`);
    try {
      const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      if (!config.samsung) config.samsung = {};
      config.samsung.ip = TV_IP;
      config.samsung.token = msg.data.token;
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
      console.log('Token saved to config.json');
    } catch (e) {
      console.error('Could not save to config.json:', e.message);
      console.log('Manually set samsung.token in config.json to:', msg.data.token);
    }

    // Test: send volume up as proof of life
    console.log('\nSending KEY_VOLUP as test...');
    ws.send(JSON.stringify({
      method: 'ms.remote.control',
      params: { Cmd: 'Click', DataOfCmd: 'KEY_VOLUP', Option: false, TypeOfRemote: 'SendRemoteKey' }
    }));
    setTimeout(() => { ws.close(); process.exit(0); }, 1000);
  }

  if (msg.event === 'ms.error.deniedByUser') {
    console.error('\nDENIED: You pressed Deny on the TV. Run this script again and press Allow.');
    ws.close();
    process.exit(1);
  }
});

ws.on('error', (err) => {
  console.error('Connection error:', err.message);
  if (err.message.includes('ECONNREFUSED')) {
    console.log('TV is not responding on port 8002. Make sure the TV is ON.');
    console.log('Also check: TV Settings > General > External Device Manager > Device Connection Manager');
  }
  process.exit(1);
});

// Timeout after 30 seconds
setTimeout(() => {
  console.log('\nTimeout: No token received after 30 seconds.');
  console.log('Make sure:');
  console.log('  1. TV is ON and on the same network');
  console.log('  2. You pressed ALLOW on the TV screen');
  console.log('  3. Port 8002 is accessible (try: curl -sk https://' + TV_IP + ':8002/api/v2/)');
  ws.close();
  process.exit(1);
}, 30000);
