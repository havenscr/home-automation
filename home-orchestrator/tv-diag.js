// Samsung TV diagnostic v8 - test UPnP port 7676 + improved source nav
const WebSocket = require('ws');
const http = require('http');
const net = require('net');
const fs = require('fs');
const config = JSON.parse(fs.readFileSync('/opt/home-orchestrator/config.json', 'utf8'));

const log = [];
function L(msg) { const line = `[${new Date().toISOString()}] ${msg}`; console.log(line); log.push(line); }
function save() { fs.writeFileSync('/tmp/tv-diag.log', log.join('\n') + '\n'); }

const tvIp = config.samsung.ip;

// === TEST 1: Check if UPnP port 7676 is open ===
function testPort(port) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(3000);
    sock.on('connect', () => { sock.destroy(); resolve(true); });
    sock.on('timeout', () => { sock.destroy(); resolve(false); });
    sock.on('error', () => { sock.destroy(); resolve(false); });
    sock.connect(port, tvIp);
  });
}

// === TEST 2: Try UPnP SOAP SetMainTVSource ===
function upnpSetSource(source, sourceId) {
  return new Promise((resolve) => {
    const body = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:SetMainTVSource xmlns:u="urn:samsung.com:service:MainTVAgent2:1">
      <Source>${source}</Source>
      <ID>${sourceId}</ID>
      <UiID>-1</UiID>
    </u:SetMainTVSource>
  </s:Body>
</s:Envelope>`;
    const req = http.request({
      hostname: tvIp, port: 7676, path: '/smp_4_', method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset="utf-8"', 'SOAPACTION': '"urn:samsung.com:service:MainTVAgent2:1#SetMainTVSource"' },
      timeout: 5000
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.write(body);
    req.end();
  });
}

// === TEST 3: WebSocket source nav with better timing ===
function wsSourceNav(target) {
  return new Promise((resolve) => {
    const name = Buffer.from(config.samsung.appName || 'HomeHub').toString('base64');
    const token = config.samsung.token ? `&token=${config.samsung.token}` : '';
    const url = `wss://${tvIp}:8002/api/v2/channels/samsung.remote.control?name=${name}${token}`;

    const ws = new WebSocket(url, { rejectUnauthorized: false });

    function sendKey(keyCode) {
      ws.send(JSON.stringify({
        method: 'ms.remote.control',
        params: { Cmd: 'Click', DataOfCmd: keyCode, Option: false, TypeOfRemote: 'SendRemoteKey' }
      }));
      L(`  KEY: ${keyCode}`);
    }

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.data && msg.data.token && msg.data.token !== config.samsung.token) {
          config.samsung.token = msg.data.token;
          fs.writeFileSync('/opt/home-orchestrator/config.json', JSON.stringify(config, null, 2));
          L(`  Token updated: ${msg.data.token}`);
        }
        if (msg.event === 'ms.channel.connect') {
          L('  Connected, opening source menu...');

          // Sequences from source menu grid:
          // [TV]          [HDMI3/Xbox]
          // [Apple TV]    [192.168.1...]
          // [PlayStation] [192.168.1...]
          // Reset to top-left, then navigate
          const sequences = {
            apple_tv: ['KEY_UP','KEY_UP','KEY_UP','KEY_LEFT','KEY_LEFT', 'KEY_DOWN','KEY_ENTER'],
            ps5:      ['KEY_UP','KEY_UP','KEY_UP','KEY_LEFT','KEY_LEFT', 'KEY_DOWN','KEY_DOWN','KEY_ENTER'],
            xbox:     ['KEY_UP','KEY_UP','KEY_UP','KEY_LEFT','KEY_LEFT', 'KEY_RIGHT','KEY_ENTER']
          };
          const seq = sequences[target] || sequences.apple_tv;

          // Open source menu
          setTimeout(() => sendKey('KEY_SOURCE'), 500);

          // Wait 2s for menu to fully render, then navigate with 400ms between keys
          seq.forEach((key, i) => {
            setTimeout(() => sendKey(key), 2500 + i * 400);
          });

          setTimeout(() => {
            L('  Navigation complete');
            ws.close();
            resolve('done');
          }, 2500 + seq.length * 400 + 1500);
        }
      } catch (e) {}
    });

    ws.on('error', (err) => { L(`  WS error: ${err.message}`); resolve('error'); });
    setTimeout(() => { try { ws.close(); } catch (e) {} resolve('timeout'); }, 15000);
  });
}

// === RUN ALL TESTS ===
async function main() {
  const target = process.argv[2] || 'apple_tv';
  L(`=== Samsung TV Input Switch Diagnostic ===`);
  L(`Target: ${target}`);
  L(`TV IP: ${tvIp}`);

  // Test ports
  L('\n--- Port scan ---');
  const ports = [7676, 7677, 8001, 8002, 9197];
  for (const p of ports) {
    const open = await testPort(p);
    L(`Port ${p}: ${open ? 'OPEN' : 'closed'}`);
  }

  // If 7676 is open, try UPnP
  const p7676 = await testPort(7676);
  if (p7676) {
    L('\n--- UPnP SOAP test (port 7676) ---');
    const hdmiIds = { apple_tv: ['HDMI1', '57'], ps5: ['HDMI2', '58'], xbox: ['HDMI3', '59'] };
    const [src, id] = hdmiIds[target] || ['HDMI1', '57'];
    L(`Trying SetMainTVSource: ${src} ID=${id}`);
    const result = await upnpSetSource(src, id);
    L(`Result: ${JSON.stringify(result)}`);
    // Also try with different IDs
    if (result.error || (result.status && result.status !== 200)) {
      L('Retrying with ID=13...');
      const r2 = await upnpSetSource(src, '13');
      L(`Result: ${JSON.stringify(r2)}`);
    }
  } else {
    L('\nPort 7676 closed - UPnP not available on this model');
  }

  // WebSocket source navigation
  L(`\n--- WebSocket source nav -> ${target} ---`);
  await wsSourceNav(target);

  L('\n=== DONE ===');
  save();
}

main().catch(e => { L(`Fatal: ${e.message}`); save(); });
