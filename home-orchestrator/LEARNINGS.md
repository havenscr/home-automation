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

## LG ThinQ Connect API - CRITICAL

Captured from production trial and error against two LG portable ACs (Office + Kitchen, both LP1419IVSM-style 8000-BTU units). The official LG ThinQ Connect REST API has thin public documentation and several quirks that are not obvious until you've burned a few hours on each.

### Authentication & headers
- Auth: Personal Access Token (PAT), passed as `Authorization: Bearer <pat>`. Get one from the LG ThinQ developer portal. No OAuth refresh dance, the PAT is long-lived until revoked.
- Required headers on every request:
  - `Authorization: Bearer <pat>`
  - `x-country: US` (or whatever your account is registered to)
  - `x-message-id`: a 22-char base64url string, must be unique per request. We generate with `crypto.randomBytes(16).toString('base64url').slice(0, 22)`.
  - `x-client-id`: a stable UUID per integration, persisted in `config.climate.thinq.clientId`. Get from `pair-thinq.js` run once.
  - `x-api-key: v6GFvkweNo7DK7yD3ylIZ9w52aKBU0eJ7wLXkSR3` (this is the public API key for the developer-portal flow, baked into climate.js)
  - `x-service-phase: OP` (means production, not staging)
- Region matters in the hostname: US accounts hit `api-aic.lgthinq.com`. The full `COUNTRY_TO_REGION` map is in climate.js -- if you move countries, update the mapping. Sending a US request to the EU host returns generic auth failures with no helpful detail.

### Native unit is Celsius
- AC reports current and target temperature in `temperature.unit: "C"`. Even if your unit's physical display shows Fahrenheit, the API returns Celsius.
- climate.js converts at the API boundary so config.json and the UI work in Fahrenheit. Do NOT change the unit on the physical AC -- it complicates conversion logic without benefit.
- Rounding: `roundC(c)` rounds to the nearest 0.5°C, matching what the AC accepts as setpoint resolution.

### Sensor resolution and smoothing
- The AC reports current temperature at 0.5°F resolution (e.g. 74.0, 74.5, 75.0 -- nothing in between).
- This causes pressure-calculation flapping at threshold boundaries: room reads 74.5F, computes pressure 0.5F, engages a fan rung; next poll reads 74.0F, computes pressure 0.0F, disengages -- and the loop oscillates every 60 seconds.
- Fix: a 3-sample median smoother on `currentF` per slot (`tempHistory[slot]`, `TEMP_HISTORY_LEN = 3`). Median (not mean) so a single outlier reading doesn't propagate. Display value stays raw; only pressure calc uses the smoothed value.

### COOL <-> FAN mode quirks
- Setpoint writes are silently ignored when the AC is in FAN or AIR_DRY mode. The unit accepts the request and returns 200, but the setpoint doesn't change. climate.js skips setpoint writes when `jobMode !== 'COOL'` and re-asserts the setpoint automatically when the loop returns the unit to COOL (`setpointEnforceable` check).
- **Compressor stays running against stale sensor**: we observed LG units keeping the compressor active for several minutes after the room dropped below target, presumably because internal sensor readings lagged. To guarantee the compressor cannot run when the room is cool, climate.js force-writes `jobMode: FAN` rather than trusting target temp alone.
- **Mode transitions auto-reset fan speed**: when the AC switches between COOL and FAN, it resets `windStrength` to a default (usually LOW). climate.js handles this with a `MODE_GRACE_MS = 75s` grace period in the override detector AND by force-rewriting fan speed on the same tick as the mode switch (`didModeSwitch` bypass of the fan-dwell check).
- **Mode-switch dwell + deadband**: at default settings the room walks the deadband faster than the dwell timer, defeating it. After observing 5-6 min COOL↔FAN cycles overnight, we widened to `MODE_DEADBAND_F = 2.0` and `MODE_DWELL_MS = 10 min` on 2026-05-12. Tune these if oscillation returns.
- **AIR_DRY (and any non-COOL/non-FAN) is user intent**: the loop never auto-switches to or from AIR_DRY. If you set it manually, the loop leaves it alone. The override detector still fires on direct mode changes from the LG app though, pausing the slot for 60 min.

### Override detection field timestamps
- Each `cfg.lastState[slot].lastWritten.<field>At` stores when we last wrote that field. The override detector only compares a field if its write age is between `SETTLE_MS = 15s` (give the AC time to reflect it) and `STALE_MS = 5 min` (forget old writes so they can't trigger spurious overrides).
- The `targetC` comparison only fires when both writer and reader were in COOL mode. In FAN/AIR_DRY the AC's "target" field drifts independently and would false-positive every poll otherwise.
- After detection, `lastWritten` is deleted so the same change doesn't re-detect on the next poll.

### Rate limits and observed error codes

| HTTP | LG code | Meaning | Handled? |
|---|---|---|---|
| 401 | 1314 | "Exceeded User API calls" -- you hit the per-account rate limit | YES - exponential backoff per slot, 60s -> 10min cap (`trackRateLimit`) |
| 416 | 1222 | "Not connected device" -- AC is offline, sleeping, or LG cloud lost it | NO - bubbles as generic error, next tick retries. Self-recovers when AC reconnects. |
| 400 | 2214 | "Fail Request" -- generic catch-all, no actionable detail | NO - same as above. Often transient, often clusters around config patches. |

- Rate-limit backoff is **per-slot**, not global. Office getting rate-limited doesn't pause Kitchen.
- Rate-limit events log to activity.log as `<slot> rate-limited by LG; backing off Xs`.
- The bi-weekly audit reads activity.log and flags rate-limit clusters. Don't chase a one-time burst (usually a config-tuning artifact); investigate sustained clusters.

### Runaway-write breaker
- Added 2026-05-12 as defense against a stuck control loop. If a slot crosses 30 writes in a rolling 10-min window, the breaker engages a 30-min global pause and logs loudly. Clear via `POST /api/climate/global/resume` or the diagnostics tab button.
- Threshold (30 in 10 min = 3 writes/min) is intentionally well above normal traffic (we observed ~12-25 writes/hour at peak during the 2026-05-12 oscillation incident, comfortably below the cap). If you see legitimate writes tripping it, the loop has a real bug.

### "Not connected" recovery and HTTP 416 handling
- After power outages or LG cloud blips, ACs sometimes report HTTP 416 / code 1222 for a few minutes before reconnecting. climate.js does not require special handling -- the next successful read repopulates cache and the loop resumes.
- We never auto-power an AC on. If both ACs report POWER_OFF, the loop excludes them from pressure calculation entirely (`userOff`) and waits. Reid turns them back on manually.

### Discovery and device IDs
- Run `pair-thinq.js` once to enumerate your account's devices. It prints each AC's `deviceId` (a 64-char hex string) and `displayName`.
- Stick the IDs in `config.climate.devices.<slot>.deviceId`. Slot name (`office`, `kitchen`) is arbitrary local-to-us, used in logs, UI, and ladder rungs.
- IDs are stable across firmware updates and account moves. Replace only if you swap the physical AC.

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
