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

## LG ThinQ Connect API

Notes from running two LG portable ACs (Office + Kitchen) against the **new** LG ThinQ Connect REST API (PAT-auth, 2024+). Each claim below is tagged with confidence: **[VERIFIED]** = confirmed against LG's own SDK source or developer docs; **[OBSERVED]** = we've seen this behavior in our system but cannot point to a primary source; **[UNVERIFIED]** = the doc previously asserted this without checking, and post-research we still cannot confirm.

References:
- [thinq-connect/pythinqconnect](https://github.com/thinq-connect/pythinqconnect) — LG's official Python SDK, Apache-2.0, our authoritative source for headers/error codes/endpoints
- [wideq](https://github.com/sampsyo/wideq) — community reverse-engineering of the **legacy** ThinQ v1/v2 API. Useful for device-level behavior carryover but payload shapes differ.
- [smartthinq-sensors (HA integration)](https://github.com/ollo69/ha-smartthinq-sensors) — best source for portable-AC quirks the community has documented.

### Authentication & headers — [VERIFIED]
- Auth: Personal Access Token, `Authorization: Bearer <pat>`. Get one from the LG ThinQ developer portal. No refresh flow — PAT is long-lived until manually revoked. Error 1103 INVALID_TOKEN / 1218 INVALID_TOKEN_AGAIN signal revocation.
- Required headers on every request (per [thinq_api.py `_generate_headers`](https://github.com/thinq-connect/pythinqconnect/blob/main/thinqconnect/thinq_api.py)):
  - `Authorization: Bearer <pat>`
  - `x-country: US`
  - `x-message-id`: 22-char urlsafe-base64, unique per request (16 random bytes, padding stripped). Our `crypto.randomBytes(16).toString('base64url').slice(0, 22)` matches the SDK exactly.
  - `x-client-id`: stable UUID4 per integration. Persisted in `config.climate.thinq.clientId`. LG explicitly warns against generating new client IDs frequently — it can get your API calls blocked.
  - `x-api-key: v6GFvkweNo7DK7yD3ylIZ9w52aKBU0eJ7wLXkSR3` — hardcoded constant in LG's SDK (`const.py` `API_KEY`). Identical value baked into our climate.js.
  - `x-service-phase: OP` — operational/production. "QA" exists for staging but the public SDK only ships OP.
- Region-specific hostname: `api-{region}.lgthinq.com` where region is `aic` (Americas including US), `eic` (Europe/MEA), `kic` (Asia-Pacific). Full mapping in our `COUNTRY_TO_REGION` matches LG's [country.py](https://github.com/thinq-connect/pythinqconnect/blob/main/thinqconnect/country.py).

### Temperature units — [VERIFIED, contradicts our earlier claim]
**Previously asserted "Celsius is the native unit, F is a UI conversion." That's wrong.** Per [air_conditioner.py](https://github.com/thinq-connect/pythinqconnect/blob/main/thinqconnect/devices/air_conditioner.py), the AC profile exposes BOTH simultaneously: `currentTemperatureC`, `currentTemperatureF`, `targetTemperatureC`, `targetTemperatureF`, plus min/max/cool/heat/auto variants in both units. A separate `temperature.unit` field reports the user's account-level display preference ("C" or "F") — that's a UI hint, not a data format.
- **Implication for our climate.js**: we currently call `cToF(temperature.currentTemperature)` and treat C as primary. We could read `temperature.currentTemperatureF` directly and skip the conversion. Functionally identical today, but cleaner. **Follow-up item.**
- Per wideq source (legacy API), C-to-F was a per-device lookup table, not arithmetic. The Connect API exposing both fields side-steps that.

### Sensor resolution — [PARTIALLY VERIFIED]
- Native granularity is 0.5°C per [wideq/ac.py](https://github.com/sampsyo/wideq/blob/master/wideq/ac.py) parsing logic (whole numbers parsed as int, non-whole as float).
- The 0.5°F observed flapping at threshold boundaries is **[OBSERVED]** — pressure calc oscillates when room walks between two adjacent 0.5°F values.
- Our 3-sample median smoother on `currentF` (`tempHistory[slot]`, `TEMP_HISTORY_LEN = 3`) addresses this in our code. Median over mean so a single outlier reading from the LG API doesn't propagate. Display value stays raw; only pressure calc uses the smoothed value.

### Job modes (jobMode enum) — [PARTIALLY VERIFIED]
- LG ThinQ Connect developer portal documents `currentJobMode` for AC as: `AIR_CLEAN`, `COOL`, `AIR_DRY`. (HEAT and AUTO target-temp fields exist on heat-pump-capable units; our portables don't have these.)
- The legacy [wideq ACMode enum](https://github.com/sampsyo/wideq/blob/master/wideq/ac.py) is broader: `COOL, DRY, FAN, AI, HEAT, AIRCLEAN, ACO, AROMA, ENERGY_SAVING, ENERGY_SAVER`. Note `DRY` (legacy) vs `AIR_DRY` (Connect). Our code uses Connect spelling.
- **[OBSERVED / unconfirmed]**: We see `FAN` reported by our portable ACs. The Connect docs don't list it explicitly for AC. Per [smartthinq-sensors #734](https://github.com/ollo69/ha-smartthinq-sensors/issues/734), **portable/window units sometimes expose `AIRCLEAN` as the actual fan-only mode** rather than a true `FAN` mode. Worth confirming what our ACs actually return when set to fan-only via the LG app vs. via our API write. If we're writing `FAN` and they're interpreting it as `AIRCLEAN`, fine — but the naming inconsistency is a footgun for anyone reading the code.

### COOL / FAN auto-switching — [OBSERVED, mostly unconfirmed]
**Our current code makes several behavioral assumptions about LG portables that we have NOT been able to verify in LG's docs or in community reverse-engineering. Treat these as "this is what we built; here's why" rather than "this is documented LG behavior."**
- **Setpoint writes ignored in FAN/AIR_DRY** — [UNVERIFIED]. Our `setpointEnforceable` check skips setpoint writes when `jobMode !== 'COOL'` on the assumption the AC silently drops them. LG has a documented error code `2305 COMMAND_NOT_SUPPORTED_IN_MODE` that would explain this — but it's an *error*, not silent success. **It's possible the API returns 2305 and our code is swallowing it as a generic error.** Worth instrumenting next time we touch this.
- **Compressor running against stale sensor reads** — [UNVERIFIED, possibly hardware-side]. We force-write `jobMode: FAN` when room is cool rather than trusting the AC's own temperature comparison. No community evidence of this; thermistor-placement issues are widely discussed for portables generally but that's hardware, not API.
- **Mode transitions auto-reset fan speed** — [UNVERIFIED]. Our `MODE_GRACE_MS = 75s` window and `didModeSwitch` dwell-bypass exist on the assumption that switching COOL↔FAN drops `windStrength` to a default. Nobody has documented this; we observed it once and hardcoded a workaround.
- **MODE_DEADBAND_F = 2.0, MODE_DWELL_MS = 10min** — [OBSERVED, our tuning]. Set 2026-05-12 after watching the loop cycle COOL↔FAN every 5-6 min overnight. Earlier 1°F/5min defeated itself because the room walked the band in the same time as the dwell.
- **AIR_DRY left alone** — our policy. Loop never auto-switches to or from AIR_DRY. User-set mode is treated as intent and preserved. Override detector still fires on direct mode changes via the LG app, pausing the slot 60 min.

### Override detection — [our design, no LG-side equivalent]
- Each `cfg.lastState[slot].lastWritten.<field>At` stores when we last wrote that field. The override detector only compares if write age is between `SETTLE_MS = 15s` (give the AC time to reflect) and `STALE_MS = 5 min` (forget old writes).
- The `targetC` comparison only fires when both writer and reader were in COOL mode. In FAN/AIR_DRY the AC's reported "target" can drift independently of what we wrote — would false-positive every poll otherwise.
- After detection, `lastWritten` is deleted so the same change doesn't re-trigger.

### Error codes — [partially VERIFIED, partially CONTRADICTED]
LG's SDK ([thinq_api.py error class](https://github.com/thinq-connect/pythinqconnect/blob/main/thinqconnect/thinq_api.py)) enumerates these. Codes we've definitely seen vs codes we *thought* we saw:

| LG code | Meaning | Status |
|---|---|---|
| **1314** | "Exceeded User API calls" — rate limit (the actual code LG's live API returns) | **VERIFIED in production.** Pi journal entries from 2026-05-04 09:55-09:58 show LG returning HTTP 401 with `code:"1314"` and `message:"Exceeded User API calls"` during a tuning-burst rate-limit event. Our regex matches both this and the SDK-documented 1306 for forward-compat. |
| 1306 | EXCEEDED_API_CALLS — listed by LG's SDK error table, but the live API does not actually return this code today | **DOCS-ONLY**. LG's own published SDK ([thinq_api.py](https://github.com/thinq-connect/pythinqconnect/blob/main/thinqconnect/thinq_api.py)) lists 1306 as the rate-limit code, but the running service returns 1314 instead. Their docs are out of sync with the API. Our code matches both. |
| 1222 | NOT_CONNECTED_DEVICE — AC's WiFi is offline | VERIFIED. Per [HA core #139022](https://github.com/home-assistant/core/issues/139022), persists until the device's WiFi reassociates. No auto-recovery interval. |
| 2214 | FAIL_REQUEST — generic catch-all | VERIFIED. No actionable detail. Often transient. |
| 1103 / 1218 | INVALID_TOKEN — PAT revoked | VERIFIED. Rotate via developer portal. |
| 2305 | COMMAND_NOT_SUPPORTED_IN_MODE | VERIFIED (existence). May be the *real* signal we attribute to "silent failure in FAN mode." |
| 2209 / 2210 / 2212 | DEVICE_RESPONSE_DELAY / RETRY_REQUEST / SYNCING | VERIFIED. **Our code doesn't distinguish these.** They suggest retry-with-backoff is appropriate rather than bubbling as errors. |
| 2301 / 2304 | COMMAND_NOT_SUPPORTED_IN_REMOTE_OFF / _IN_POWER_OFF | VERIFIED. Useful for diagnosing failed writes after a power cycle. |

**Action items from this audit:**
- ✅ Verified rate-limit code via production logs. LG returns 1314 (not 1306 as the SDK claims). Regex now matches both codes plus the message text. Tests anchored on real production error strings.
- Add explicit handling for 2209/2210/2212 (transient, retry) vs 2305 (mode-incompatible, give up).
- Surface 1103/1218 (revoked PAT) loudly — currently they bubble as generic errors and the loop just keeps failing.

### Rate-limit observations — [our system, no LG-published numbers]
- LG does not publish a rate-limit threshold. Community reports ([smartthinq-sensors #903](https://github.com/ollo69/ha-smartthinq-sensors/issues/903)) ask for it; LG never answered.
- Our exponential backoff per slot (60s base, 10min cap) is a guess that has held up empirically.
- Rate-limit backoff is **per-slot**, not global. Office getting rate-limited doesn't pause Kitchen.

### Runaway-write breaker — [our design]
- Added 2026-05-12. If a slot crosses 30 writes in a rolling 10-min window, the breaker engages a 30-min global pause and logs loudly. Clear via `POST /api/climate/global/resume` or the diagnostics tab button.
- Threshold (30 in 10 min = 3 writes/min) is well above normal traffic (peak ~12-25 writes/hour during the 2026-05-12 oscillation incident).

### Recovery semantics — [VERIFIED behavior, our handling]
- After power outages or LG cloud blips, expect code 1222 episodes lasting until WiFi reassociates. No special handling needed — next successful read repopulates cache and the loop resumes.
- We never auto-power an AC on. If both ACs report POWER_OFF, the loop excludes them (`userOff`) and waits.

### Discovery and device IDs — [VERIFIED]
- Run `pair-thinq.js` once to enumerate devices. Each AC's `deviceId` (64-char hex per our observation, but LG treats it as opaque string — don't depend on format) and `displayName` get printed.
- Stick the IDs in `config.climate.devices.<slot>.deviceId`. Slot name (`office`, `kitchen`) is arbitrary local-to-us.

### Architecture options we're NOT using — [VERIFIED, worth knowing]
LG offers a documented push-event subscription via AWS IoT Core MQTT (`POST /event/{device_id}/subscribe`, 186-day lease per subscription; also `POST /push/{device_id}/subscribe` for device-level notifications). Client cert flow via `POST /client/certificate`. **This would eliminate polling and the rate-limit pressure entirely.** Not pursued today because polling-and-control works, but if rate limits become a real problem this is the LG-blessed path forward.

LG also exposes an energy-usage endpoint (`GET /devices/energy/{id}/usage?property=&period=&startDate=&endDate=`) that could feed the bi-weekly audit pipeline.

The SDK auto-adds `x-conditional-control: true` header on control writes. We don't. Worth checking whether some of our writes are failing state-consistency checks that this header would bypass.

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
