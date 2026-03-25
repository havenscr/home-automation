# Home Orchestrator - Technical Learnings

## Caseta LEAP Protocol (lutron-leap)

### Pairing Flow
- Port 8083 (TLS) for pairing, port 8081 (TLS) for data
- HAP pairing (port 4548) is BLOCKED once bridge is paired to HomeKit -- Error 6 (Unavailable)
- LEAP pairing: connect with Lutron association certs -> user presses bridge button -> bridge sends PhysicalAccess permission -> send CSR -> receive signed certificate
- npm package: `lutron-leap` v3.6.1 (`PairingClient`, `LeapClient`, `SmartBridge`)

### LeapClient Constructor
```
new LeapClient(host, port, ca, key, cert)  // NOT cert, key, ca!
```
Parameter order is `rootCert, privateKey, cert` -- getting this wrong gives "bad certificate" TLS error.

### Device Control
- `GoToLevel` command: `client.request('CreateRequest', '/zone/{id}/commandprocessor', { Command: { CommandType: 'GoToLevel', Parameter: [{ Type: 'Level', Value: brightness }] } })`
- Zone status: `client.request('ReadRequest', '/zone/{id}/status')` returns `{ ZoneStatus: { Level: number } }`

### FullyQualifiedName Gotcha
- `device.FullyQualifiedName` can be a non-string (array or object). Always coerce: `typeof name === 'string' ? name : Array.isArray(name) ? name.join(',') : String(name)`

### Credentials File
- Saved to `caseta-leap-creds.json`: bridgeIp, leapPort (8081), cert, rootCert, privateKey, pairedAt
- Pairing script: `pair-caseta-leap.js`

---

## Hue Bridge Rate Limiting - CRITICAL

### Problem
- Sending HTTP requests to 34 lights simultaneously causes ECONNRESET errors
- Hue bridge can handle ~10-15 concurrent HTTP connections
- Over half the lights fail each tick when sending individual requests

### Solution: Group Commands
- `PUT /api/{key}/groups/{id}/action` sends ONE request for ALL lights in a group
- Bridge distributes via Zigbee internally -- no HTTP bottleneck
- Reduced 34 calls/tick to 6 (1 per group + 4 individual play bars)
- Zero ECONNRESET errors after fix

### Config Pattern
- Add `"groupId": 12` to track config alongside `"lights": [...]`
- Code checks `track.groupId` -- uses `hueGroupAction()` if set, falls back to per-light loop
- `lights` array still needed for dynamic start (reads state of `lights[0]`) and override detection

---

## brightnessOnly Tracks - 4 Guard Points

When a track has `brightnessOnly: true`, waypoints have NO `color` property. Must guard in ALL four places:

1. **Dynamic start injection** (startRoutine): Only inject `bri`, not `color`
2. **Initial state set**: Use `{ bri, transitiontime }` only, no color state
3. **Tick handler** (processFadeTrack): Do NOT call `interpolateColor()` -- moved into `else` branch
4. **Completion handler**: Send `{ bri, transitiontime }` only

Missing any one of these causes `TypeError: Cannot read properties of undefined (reading 'xy')`.

---

## Dynamic Start

- Reads current state of `track.lights[0]` at routine start
- Replaces `waypoints[0]` with actual current values
- For brightnessOnly tracks: only injects `bri`, not `color`
- Handles both sunny (ct:~230) and cloudy (ct:~343) starting states
- Falls back to hardcoded waypoint[0] if read fails

---

## Scene Transition

- Detects active Day scene on a group by checking all scenes with matching group ID
- Uses Hue v1 API: `GET /api/{key}/scenes`, filters by group, checks `lastupdated` timestamps
- Maps "Day X" -> "Evening X" by stripping prefix and reconstructing
- Handles both "Day " and "Day - " prefix variants
- Recalls Evening scene on a different group (Group 11 includes play bars)

---

## Homebridge Config Gotchas

### Duplicate Platform Entries
- `HomebridgeDummy` plugin uses `"accessories"` array (not `"devices"`)
- Adding a second `HomebridgeDummy` platform entry with `"devices"` creates invisible accessories
- Always append to existing platform's `"accessories"` array
- Homebridge config at `/var/lib/homebridge/config.json` requires `sudo` to write

### Dummy Switch Pattern
```json
{
  "id": "ho-sunset-start",
  "name": "Dummy - Fade Start Sunset",
  "type": "Switch",
  "timer": { "delay": 1, "units": "SECONDS", "random": false },
  "commandOn": "/usr/bin/curl -s -X POST http://localhost:5006/api/routines/sunset_transition/start",
  "disableLogging": false
}
```

---

## Device Mapping

- **Island Pendants**: Controlled via Hue (in Group 12 static lights), NOT Caseta -- Caseta switch just powers them
- **Under Cabinet**: Caseta LEAP zone 4
- **Neon Sign**: Caseta LEAP zone 5
- **Nanoleaf IP**: Was 192.168.1.65, changed to 192.168.1.149 -- reserve in router DHCP

## Key File Locations

| What | Path |
|------|------|
| Home Orchestrator source | `home-orchestrator/server.js` |
| Config | `home-orchestrator/config.json` |
| LEAP pairing script | `home-orchestrator/pair-caseta-leap.js` |
| LEAP credentials (Pi) | `/opt/home-orchestrator/caseta-leap-creds.json` |
| Homebridge config (Pi) | `/var/lib/homebridge/config.json` |
| Home Orchestrator UI | `home-orchestrator/public/index.html` |
| Sonos Commander UI | `sonos-commander/public/index.html` |

## Hue Group Reference

| Group | Name | Lights | Used For |
|-------|------|--------|----------|
| 8 | Day Static Colors | 26 | All daytime static lights |
| 10 | Day Color Lights | 8 | Dynamic scene lights (day) |
| 11 | Evening Color Lights | 12 | Dynamic scene lights + play bars (evening) |
| 12 | Evening Static Colors | 22 | Sunset fade Track 1 (groupId) |
