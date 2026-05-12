# Home Automation

Local-first apartment automation built around a Raspberry Pi 3B+, Homebridge, and a pair of small Node.js services. Replaces cloud routines (IFTTT, vendor schedules, LG ThinQ routines) with fast, deterministic local control that integrates with Apple HomeKit.

**Status:** Production. Running 24/7 on the Pi at `192.168.1.61`.

---

## Architecture at a glance

```
                   iPhone / iPad / Mac (Home app, Siri)
                                |
                          HomeKit (BLE/WiFi)
                                |
                +---------------+----------------+
                |  Homebridge (port 8581)        |
                |  /var/lib/homebridge/config.json
                |  Hosts ~85 dummy switches that  |
                |  fire curl commands on toggle   |
                +-------+----------------+-------+
                        |                |
              POST /api/...    POST /api/...
                        |                |
        +---------------v---+    +-------v---------------+
        | home-orchestrator |    | sonos-commander       |
        | port 5006         |    | port 5005             |
        | Hue + Caseta +    |    | Sonos speakers,       |
        | Nanoleaf +        |    | grouping, scenes,     |
        | SwitchBot +       |    | sleep timers, music   |
        | Samsung TV +      |    | routines              |
        | LG ThinQ ACs +    |    +-----------------------+
        | routines + cron   |
        +-------------------+
                  |
        +---------+----------+
        |  Devices on LAN    |
        |  Hue Bridge        |
        |  Caseta LEAP       |
        |  Nanoleaf panels   |
        |  Samsung S95F TV   |
        |  Sonos x6 + Boost  |
        |  LG portable ACs   |
        |  SwitchBot devices |
        +--------------------+
```

Both Node services are stateless restartable — config lives on disk, no databases, no cloud. Pairing scripts run once per device to capture credentials, after which everything works offline.

---

## Services

### [home-orchestrator/](home-orchestrator/) — port 5006

The "brain" service. Runs lighting routines, climate control, time-of-day color gradients, and TV input switching.

**What it controls:**
- **Philips Hue** lights via the Bridge at `192.168.1.2` (group commands to avoid rate limiting). Health probe at `GET /api/hue/health` returns last latency + 1h reachability % from a rolling 60-sample buffer (5-min poll). Logs once on reachable<->unreachable transitions, two consecutive failures required before flipping state to suppress single-probe noise.
- **Lutron Caseta** dimmers via the LEAP TLS protocol (Smart Bridge 2 at `192.168.1.14`)
- **Nanoleaf** panels at `192.168.1.149`
- **SwitchBot** scenes via cloud API (no local LAN protocol exists)
- **Samsung S95F TV** via WebSocket + WoL + SmartThings (input switching uses cloud because LG-style HDMI keys are broken on 2025 models)
- **LG portable ACs** (office + kitchen) via the LG ThinQ Connect REST API with Personal Access Token auth
- **Homebridge dummy switches** as triggers and HomeKit-side state read

**Key files:**
- [home-orchestrator/server.js](home-orchestrator/server.js) — Express app, route handlers, all integration logic (~3300 lines, single file by design)
- [home-orchestrator/climate.js](home-orchestrator/climate.js) — LG ThinQ AC controller (separate module)
- [home-orchestrator/config.json](home-orchestrator/config.json) — single source of truth for routines, schedules, device IDs, API keys
- [home-orchestrator/public/index.html](home-orchestrator/public/index.html) — main control UI
- [home-orchestrator/public/climate.html](home-orchestrator/public/climate.html) — climate dashboard
- [home-orchestrator/LEARNINGS.md](home-orchestrator/LEARNINGS.md) — protocol gotchas (Caseta LEAP, Hue rate limiting, brightnessOnly tracks, etc)
- [home-orchestrator/pair-caseta-leap.js](home-orchestrator/pair-caseta-leap.js) — one-shot Caseta pairing (press button on bridge)
- [home-orchestrator/pair-samsung-tv.js](home-orchestrator/pair-samsung-tv.js) — one-shot Samsung pairing (accept on TV)
- [home-orchestrator/pair-thinq.js](home-orchestrator/pair-thinq.js) — one-shot LG ThinQ device discovery

**UI:**
- Main: http://192.168.1.61:5006/ (lighting routines, scenes, daytime gradient)
- Climate: http://192.168.1.61:5006/climate.html

#### Lighting routines (12 total)

Triggered from HomeKit dummies or `/api/routines/{id}/start`.

| ID | What it does |
|---|---|
| `sunrise_default` | Sunrise wake-up fade (cool-to-warm CT, slow brightness ramp) |
| `sunset_transition` | 25-minute sunset fade across Hue + Caseta + Nanoleaf, multi-track waypoints |
| `evening_to_latenight` | Drops brightness and warms color across all evening lights |
| `storms_end` | Cleanup routine after `thunderstorm` (resets affected lights) |
| `romantic_mode` | Low-brightness warm tones, sets matching Sonos playlist |
| `movie_mode` | Dims living room, raises play bar volume, kills overheads |
| `party_mode` | High brightness, color cycling, party-volume Sonos |
| `disco_party` | Color-loop effect on dynamic groups |
| `aurora_borealis` | Slow green/teal/purple cycle on Nanoleaf + Hue |
| `fireplace_cozy` | Warm flicker effect, low overheads, fireplace audio on Sonos |
| `thunderstorm` | Random Hue flashes synced with Sonos thunder loop |
| `red_alert` | Bridge-pulsing red alert (full brightness flash cycle) |

#### Climate controller (LG ThinQ)

The newest addition. Replaces fragile LG-side routines with a polling control loop:

- **Day/night targets**: configurable via UI (defaults: day 72F at 8am-10pm, night 70F at 10pm-8am). Each room can optionally override the global day or night target (e.g. office=68F day, kitchen=74F day) — pressure is then measured per-room against each room's own effective target, so the worst-relative-to-its-own-target room drives the ladder.
- **Heat-pressure ladder**: max delta across rooms drives a 5-rung priority list. As pressure climbs, more aggressive rungs engage. Hysteresis prevents flapping.
- **Office quiet hours** (Mon-Fri 10am-6pm): office capped at MID fan; kitchen ramps to compensate when room is hot. Outside these hours, the default ladder lets office go HIGH and become the apt's primary cooler.
- **Manual override auto-detect**: if the LG app, the unit's buttons, or anyone else changes a setpoint or fan speed, the orchestrator pauses that AC for 30 minutes (configurable) before resuming control. Detection is automatic — no button press needed.
- **User-off detection**: if you turn an AC fully off (LG app, the unit, or our `/power` endpoint), the loop excludes it from pressure calculation and never tries to write to it or wake it back up. The other AC continues normal control. Banner in the UI makes it obvious. Turn it back on and control resumes immediately.
- **COOL ↔ FAN auto-switching with protection**: when room drops 2°F below target the loop switches that AC from COOL to FAN (compressor forced off). When room rises 2°F above target it switches back to COOL. A 10-minute mode-write dwell prevents flapping (we observed LG units sometimes keep the compressor running against stale internal sensors when the loop didn't force FAN explicitly). Earlier 1°F deadband + 5-min dwell caused 5-6 min COOL↔FAN cycles because the room walked the band in ~5 min, defeating the dwell; widened on 2026-05-12. AIR_DRY mode (and any non-COOL/non-FAN mode) is detected as user intent and left alone. Manual mode changes from LG app or unit still trigger the override detector + 60-min pause.
- **Fan dwell time**: after any fan-speed write, the loop holds that speed for at least `fanDwellMinutes` (default 5, configurable in the Settings UI). Smooths out micro-cycles where pressure oscillates across rung thresholds.
- **Power-outage recovery**: if both ACs go offline temporarily and come back, the loop resumes seamlessly on the next poll. Never auto-powers an AC ON — that's always a user action.
- **Per-AC and global pause** with explicit duration buttons in the UI.
- **Polling cadence**: 60 seconds. ~10-15MB RAM. Direct HTTPS calls to `api-aic.lgthinq.com`. Per-slot rate-limit backoff handles LG's HTTP 401 code 1314 ("Exceeded User API calls") with exponential delay up to 10 minutes.
- **Setpoint writes are skipped when AC is in FAN/AIR_DRY mode** (the unit ignores them anyway). Re-asserted automatically when the loop returns the unit to COOL.
- **Fan write debounce**: skips redundant fan writes if the same value was set within the last 5 minutes and the AC reflects it.
- **Pressure smoothing**: 3-sample moving average on each room's `currentF` before computing pressure, so the 0.5F-resolution temp sensor doesn't cause ladder rungs to flap at thresholds.
- **Runaway-write circuit breaker**: if any slot accumulates 30+ writes in a rolling 10-minute window, the breaker engages a 30-min global pause and logs loudly. Defense against a stuck loop hammering the LG API. Per-slot counter visible in the diagnostics tab. Clear via `POST /api/climate/global/resume` (or the "Clear pause now" button in the diagnostics tab when paused).
- **Ladder startup validator**: on boot, `climate.start()` runs a shape check on `config.climate.ladder` and logs warnings to `activity.log` under `ladder-validator:` for any drift (junk numeric keys, malformed `[room, speed]` tuples, unknown room references, invalid speed values, office-HIGH-in-officeQuiet violating the quiet-hours cap, missing `default` or `officeQuiet`). Warn-only — never mutates config. Tests in `home-orchestrator/test/climate.test.js` cover the known bug shapes.
- **UI** at `/climate.html` is fully editable: dashboard with per-AC manual control, settings tab for all schedule + override values, a ladder tab where you can add/remove rungs, reorder via up/down buttons, and edit room or fan speed inline, and a diagnostics tab showing rolling-window mode flips, fan changes, override pauses, the breaker state, and the last manual-override evidence (what the loop wrote vs what the AC reported, so genuine overrides can be told apart from spurious LG-side fan-resets). All edits saved via `PATCH /api/climate/config`. Diagnostics pulled from `GET /api/climate/stats?hours=N`.

#### Daytime gradient

Continuous color-temperature shift driven by sun position + OpenWeatherMap cloud cover. Sunny vs cloudy CT blend. Detects manual overrides via 3-strike threshold and auto-resumes after restart via the `gradientWasRunning` config flag.

---

### [sonos-commander/](sonos-commander/) — port 5005

Sonos audio control. Handles speaker discovery, grouping, volume scenes, music routines, sleep timers, and TV-volume awareness for the Playbase + Master Bedroom Beam.

**What it controls:**
- **6 Sonos speakers** + Boost (Boost is filtered from operations — it's a WiFi extender, not a speaker):
  - Playbase (TV input), Master Bedroom (TV input), Office Speaker (line-in), Kitchen, Bathroom, Guest Bathroom Speaker
- **Spotify playback** via the Sonos UPnP API (tracks/albums/playlists use queue + selectQueue + selectTrack + play; episodes/podcasts use a special `x-sonos-spotify` URI scheme)
- **TV volume scripts** that respect input-source state (won't bump a speaker that's playing line-in or TV)

**Key files:**
- [sonos-commander/server.js](sonos-commander/server.js) — main service
- [sonos-commander/config.json](sonos-commander/config.json) — routines, scenes, group presets, knownSpeakers persistence
- [sonos-commander/public/index.html](sonos-commander/public/index.html) — control UI

**UI:** http://192.168.1.61:5005/

#### Music & TV routines (~25 total)

Triggered from HomeKit dummies or `/api/trigger/{id}`.

**Time-of-day music:**
| ID | What it does |
|---|---|
| `Music_Morning` | Morning playlist on living-room speakers, gentle volume |
| `Day_Music` | Daytime playlist; respects TV-on conditions |
| `Day_Music_No_TV` | Day music variant when TV is on (skips Playbase) |
| `Evening_Music` | Evening volume drop, warmer playlist |
| `Late_Night_Music` | Quiet, ambient |
| `Music_Workday` | Office Speaker only (line-in or Spotify), low volume |

**Mood / activity:**
| ID | What it does |
|---|---|
| `Upbeat_Music` | Higher-energy playlist across most speakers |
| `Reading_Music` | Soft instrumental, lower volume |
| `Romantic_Playlist` | Used by `romantic_mode` lighting routine |
| `White_Noise_Sleep` | Master bedroom only, white noise loop |
| `Thunderstorm_Ambience` | Synced with `thunderstorm` lighting routine |
| `Red_Alert_Music` | Used by `red_alert` lighting routine |

**Control:**
| ID | What it does |
|---|---|
| `Sonos_Off` | Stops all speakers (with grace period for TV inputs) |
| `Sonos_Group` | Groups all speakers to Playbase |
| `Sonos_Non_LR_Pause` | Pauses everything except Living Room |
| `Sonos_Pause_Music_LR_and_Office` | Pauses Living Room + Office (when working / on a call) |

**TV-coordinated:**
| ID | What it does |
|---|---|
| `LR_TV_On` / `LR_TV_Off` | Living Room TV mode (Playbase TV input + appropriate volume) |
| `BR_TV_On` / `BR_TV_Off` | Bedroom TV mode |
| `PC_On` | PC desk audio (Office Speaker line-in @ vol 10) |
| `Fireplace_On` / `Fireplace_Off` | Fireplace audio routine |
| `bedroom_tv_up` / `bedroom_tv_down` | Bedroom TV vol nudge |

#### `tvVolume` action type

Custom routine action that handles per-speaker volume maps with autoSkip rules. If a speaker is currently playing line-in or TV input, the routine leaves it untouched. Consolidated 6 HomeKit automations into 3 by moving the input-check into the server.

#### Conditions system

Music routines have a `conditions` array (e.g. `[{speaker: "Playbase", source: "tv", is: false}]`) with `conditionLogic: "any"|"all"`. All music routines skip when Playbase TV or Master Bedroom TV is on.

---

## Homebridge — the HomeKit bridge

Homebridge runs at `homebridge.local:8581` and uses the `homebridge-dummy` plugin to expose ~85 virtual switches to HomeKit. Each switch carries a `commandOn` (and sometimes `commandOff`) curl command that fires when toggled in the Home app or via Siri or via a HomeKit automation.

**Pattern:**

```json
{
  "id": "ho-sunset-start",
  "name": "Dummy - Fade Start Sunset",
  "type": "Switch",
  "timer": { "delay": 1, "units": "SECONDS", "random": false },
  "commandOn": "/usr/bin/curl -s -X POST http://localhost:5006/api/routines/sunset_transition/start"
}
```

**Naming convention:**
- `Dummy - <name>` for home-orchestrator triggers and stateless triggers
- `SC - <name>` for sonos-commander triggers
- The `id` field uses prefixes `ho-`, `sc-`, or none for legacy switches

**Stateful vs stateless:**
- Most are stateless with `timer: 1 sec` — fires the curl, auto-resets to OFF after 1 second so HomeKit treats every tap as a fresh trigger.
- A few are stateful with both `commandOn` + `commandOff` and `resetOnRestart: false` (e.g. `Dummy - TV Evening Mode`, `Dummy - Climate Auto`). These survive reboots and reflect the actual on/off state of a feature.

**Two functional categories of dummy** (important for log analysis and audits):
- **Curl-based dummies**: have a `commandOn` curl. When toggled, Homebridge logs `executed command: ...`. Examples: `Dummy - Day Music`, `Dummy - Fade Start Sunset`, `Dummy - Other Lights (Day)`. The audit's `automationFires` count tracks these.
- **State-only dummies**: NO `commandOn`, just a switch HomeKit-side automations watch. When toggled, Homebridge logs `is on` but no `executed command` line. Used purely as HomeKit-internal triggers for chained automations. Example: `Dummy - Routine Start`. The audit's `stateToggles` count tracks these.

**The wake-up chain (NOT sunrise-based):**
1. HomeKit time-of-day automation fires at clock-based times (different on weekdays vs weekends — set in iOS Home app, not in any config file in this repo).
2. That automation toggles `Dummy - Routine Start` (state-only).
3. HomeKit automation chains watching `Dummy - Routine Start` then trigger the delay dummies (`Dummy - 30 Sec Delay` through `Dummy - 50 Min Delay`) and ultimately a curl-based dummy like `Dummy - Fade Start Sunset` (or its sunrise equivalent), which calls the orchestrator's `/api/routines/sunrise_default/start`.
4. End signal in the orchestrator's activity log: `type: "fade", message: "Routine \"Sunrise Wake-Up\" completed"`.

When auditing wake-up health, the right signal is `routineCompletions.sunrise_default` (count of completion log entries), NOT the fire count of `Dummy - Fade Start Sunrise`.

**Inventory by category:**
- **Routines (HO + SC)**: ~25 triggers
- **Volume / delays (SC)**: 13 timer dummies (`Dummy - 30 Sec Delay` through `Dummy - 50 Min Delay`) used by HomeKit automations to chain actions
- **TV inputs**: `Dummy - Input Apple TV` / PS5 / Xbox
- **Light scenes** (SwitchBot-driven for the "other lights"): `Dummy - Other Lights (Day/Evening/Late Night/Off)`
- **Nanoleaf brightness presets**: `Dummy - Nanoleaf 100%/70%/50%/30%/10%/Off`
- **Climate**: `Dummy - Climate Auto` (stateful — pause/resume the AC control loop)

**Dangerous edits to avoid:**
- The HomebridgeDummy platform expects `accessories` (not `devices`). A second platform entry with `devices` creates invisible switches.
- Always edit the existing platform's `accessories` array; don't create a new platform block.
- Config file is at `/var/lib/homebridge/config.json` and requires `sudo` to write.

---

## Hardware & infrastructure

| Component | Details |
|---|---|
| Hardware | Raspberry Pi 3B+, 1GB RAM, 29GB SD card |
| OS | Raspberry Pi OS (Debian-based) |
| Runtime | Node.js v22 |
| Pi IP | `192.168.1.61` (DHCP-reserved) |
| Hue Bridge | `192.168.1.2` |
| Caseta Bridge | `192.168.1.14` (LEAP TLS, port 8081) |
| Nanoleaf | `192.168.1.149` (DHCP-reserved) |
| Samsung TV | `192.168.1.193` (WS port 8002) |
| Sonos Boost | `192.168.1.15` (filtered from operations) |
| Available RAM | ~360MB free after Homebridge + Apple TV Enhanced + custom services |
| Homebridge UI | http://homebridge.local:8581 |

The Pi is at the absolute edge of its capacity. Avoid heavy frameworks (no React build, no webpack, no Next.js). Single-file vanilla HTML/CSS/JS for all UIs, and one `server.js` per service until it hits ~800 lines. Stream or paginate large responses; SD card writes should be buffered or rate-limited.

---

## Tests

`home-orchestrator/test/climate.test.js` exercises the ladder validator, `pressureToRungCount` hysteresis, and C/F unit conversions using Node's built-in test runner (no Jest dependency on the Pi). Run with:

```bash
cd home-orchestrator && npm test
```

Coverage is intentionally narrow — only the bug shapes we have actually hit (char-spread corruption, office-HIGH drift, off-by-one hysteresis). Add a test when you fix a bug that's worth not regressing on, not for completeness.

## Deployment

**SSH note:** use Windows native OpenSSH, never Git's bundled SSH (it silently eats stdout):

```bash
PI="/c/Windows/System32/OpenSSH/ssh.exe claude@192.168.1.61"
SCP="/c/Windows/System32/OpenSSH/scp.exe"
```

**Deploy home-orchestrator:**

```bash
$SCP home-orchestrator/server.js claude@192.168.1.61:/tmp/server.js
$PI "sudo cp /tmp/server.js /opt/home-orchestrator/server.js && sudo systemctl restart home-orchestrator" 2>/dev/null
$PI "sudo journalctl -u home-orchestrator -n 30 --no-pager" 2>/dev/null
```

**Deploy sonos-commander:**

```bash
$SCP sonos-commander/server.js claude@192.168.1.61:/tmp/server.js
$PI "sudo cp /tmp/server.js /opt/sonos-commander/server.js && sudo systemctl restart sonos-commander" 2>/dev/null
```

**Edit Homebridge config** (root-owned, requires sudo):

```bash
$PI "sudo cp /var/lib/homebridge/config.json /tmp/config.json && sudo chown claude /tmp/config.json"
$SCP claude@192.168.1.61:/tmp/config.json ./homebridge-config.json
# edit locally, then push back
$SCP ./homebridge-config.json claude@192.168.1.61:/tmp/config.json
$PI "sudo cp /tmp/config.json /var/lib/homebridge/config.json && sudo systemctl restart homebridge"
```

**Quick health check (everything at once):**

```bash
$PI "systemctl is-active home-orchestrator sonos-commander homebridge && curl -s http://localhost:5006/api/climate/state | head -c 200 && echo && curl -s http://localhost:5005/api/speakers | head -c 200"
```

**Homebridge systemd override** (`/etc/systemd/system/homebridge.service.d/override.conf`):
The override sets `KillMode=mixed` and `TimeoutStopSec=10` so child processes (Apple TV plugin's `atvscript`/`atvremote` workers) are killed cleanly when Homebridge stops. Without this, every restart leaves zombie processes behind and systemd warns about left-over processes. If you re-deploy Homebridge or its UI rewrites the override file, restore those two lines.

---

## Common pitfalls

1. **Sonos Boost** (`192.168.1.15`): always filter from speaker iteration. Sending UPnP commands to it returns 500 errors.
2. **SD-card writes**: don't `fs.writeFileSync` on every event. Buffer activity logs, flush every N seconds.
3. **SSH flooding**: max 2 parallel SSH sessions to the Pi. Chain commands with `&&` in a single session.
4. **Sonos discovery**: SSDP can take 5-10s. Cache `knownSpeakers` after discovery; don't re-discover on every request.
5. **Hue rate limit**: bridge handles ~10-15 concurrent connections. Use group commands (`PUT /api/{key}/groups/{id}/action`) instead of per-light loops.
6. **brightnessOnly tracks**: must guard against `color` access in 4 places — dynamic start, initial set, tick handler, completion handler. See [home-orchestrator/LEARNINGS.md](home-orchestrator/LEARNINGS.md).
7. **HomebridgeDummy `commandOff` only fires on stateful switches** (`resetOnRestart: false`, no `timer`). The 1-sec timer pattern is stateless and ignores `commandOff`.
8. **Samsung S95F (2025 model)**: `KEY_HDMI1/2/3` is broken. Input switching uses SmartThings cloud API with OAuth auto-refresh every 12h.
9. **LG ThinQ unit native**: ACs report in Celsius. `climate.js` converts at the API boundary so config and UI use Fahrenheit. Don't change unit on the units themselves — it complicates the conversion logic.
10. **S1 Playbar/Playbase 402 on join**: TV-capable speakers running S1 firmware (Master Bedroom Playbar `86.6-75110` is at the final S1 build; Sonos won't ship further updates) can refuse to become a slave with UPnP 402 "Invalid Args" when their TV input is or was recently active. `groupAllSpeakers` preflights `inputSource` and skips TV-mode speakers from the join list; remaining 402s on retry are logged as informational and the routine falls back via `findGroupCoordinator` to use that speaker as the group coordinator instead. Behavior is correct either way: music plays. The preflight just removes log noise that the bi-weekly audit was flagging.
11. **homebridge-zp must stay pinned at 1.4.55**: any newer version pulls in a homebridge-lib release that renamed `Bonjour.js` to `MdnsClient.js`, breaking the plugin load and removing all Sonos HomeKit accessories. This bit us on 2026-05-04 (audit caught it). The plugin lives in `/var/lib/homebridge/node_modules/homebridge-zp` with the version pinned exactly (not `^1.4.55`) in `/var/lib/homebridge/package.json`. Homebridge does not auto-update plugins, so the only ways to break this are: (a) clicking "Update" on homebridge-zp in the homebridge UI at `http://192.168.1.61:8581` -- **never do this for zp**; (b) running `sudo npm install --prefix /var/lib/homebridge homebridge-zp` without a version spec. If the pin ever drifts, restore with `sudo npm install --prefix /var/lib/homebridge homebridge-zp@1.4.55 && sudo systemctl restart homebridge`. The three UI auto-update flags (`nodeUpdatePolicy`, `homebridgeUpdatePolicy`, `homebridgeUiUpdatePolicy`) cover node/core/UI -- not plugins -- so they're not relevant here.

---

## Bi-weekly Health Audit

A self-monitoring loop that reviews the past 14 days of logs across every service every 2 weeks and posts findings as a GitHub issue. Zero per-run cost (uses Claude Max OAuth from Azure Key Vault).

**How it works:**
- Pi runs `/opt/home-orchestrator/scripts/snapshot-logs.sh` every 12 hours via `/etc/cron.d/home-audit-snapshot`
- The script bundles activity logs, systemd errors, Homebridge plugin errors, automation fire counts, and live climate state into a single JSON file
- File is pushed to the `audit-data` branch of this repo via a GitHub PAT stored at `/opt/home-orchestrator/.github-pat`
- GitHub Action `health-audit.yml` runs every other Monday at 02:00 UTC (Sunday 6-7pm Pacific)
- Workflow pulls `claude-code-oauth-token` from Azure Key Vault `ae-secrets-vault` via OIDC federation
- Claude reads the snapshot + previous audit's rolling summary, produces a 9-section report, posts as a GitHub issue with `home-audit` label
- Issue auto-closed if `SEVERITY: GOOD`, left open for `NEEDS_ATTENTION` or `PROBLEM`

**Files:**
- [scripts/snapshot-logs.sh](scripts/snapshot-logs.sh) — Pi-side log bundler
- [scripts/install-pi-snapshot.sh](scripts/install-pi-snapshot.sh) — one-time Pi setup (sets up cron, configures PAT, runs first snapshot)
- [.github/workflows/health-audit.yml](.github/workflows/health-audit.yml) — bi-weekly audit Action
- `audit-data` branch (orphan) — holds the latest snapshot, overwritten each push

**Required setup (one-time):**
1. Repo secrets in Settings → Secrets → Actions: `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`
2. Azure App Registration `gh-actions-keyvault-reader` has a federated credential for `repo:havenscr/home-automation:ref:refs/heads/main`
3. Azure App Registration's service principal has `secrets/get` and `secrets/list` on `ae-secrets-vault`
4. KV secret `claude-code-oauth-token` populated (shared with agents-and-automation)
5. On Pi: fine-grained PAT scoped to this repo, Contents: Read+Write, stored in `/opt/home-orchestrator/.github-pat` mode 600

**Manual trigger:**
```bash
# Force the audit to run regardless of bi-weekly week parity
gh workflow run health-audit.yml --repo havenscr/home-automation -f force_run=yes
```

**Manually run a snapshot from Pi:**
```bash
sudo -u claude /opt/home-orchestrator/scripts/snapshot-logs.sh
```

**View past audits:**
```bash
gh issue list --repo havenscr/home-automation --label home-audit
```

**Operational risks:**
- PAT expires (not currently, but if rotated): script will fail at `git push`. Rotation procedure: regenerate PAT, paste over `/opt/home-orchestrator/.github-pat`, snapshot resumes on next 12h cron.
- Snapshot file growing too large: capped at 500KB; truncates oldest activity-log entries first.
- If the Pi cron stops pushing for >36h, the workflow's `Fetch audit-data.json` step will warn but still run with stale data.

**Freshness self-check:** `GET http://192.168.1.61:5006/api/audit/health` returns `{state: fresh|stale|missing, ageHours}` for the snapshot file. Polled internally every hour; logs once on state transitions. Threshold is 14h (one missed 12h cron + buffer). Was added 2026-05-12 after the cron silently no-op'd for 7 days due to a `/var/log` permission denial on its redirect target. Reach it from HomeKit by adding a Homebridge dummy switch whose `commandOn` curl-pings this endpoint and toggles a HomeKit notification accessory when state != fresh.

**HomeKit chain self-check:** `GET http://192.168.1.61:5006/api/homekit/health?days=14` returns per-dummy fire counts (today, yesterday, last 7d streak) and a status field (`ok` / `missing-today` / `missing-yesterday` / `chronic` / `ok-while-away`). Expected dummies are declared in `home-orchestrator/config.json` under the top-level `homekitExpectations` key (array of `{name, minPerDay, presenceGated?}`); if absent, falls back to a default list including `Dummy - Routine Start` and `Dummy - Fade Start Sunset` — the two known-problematic ones the bi-weekly audit kept flagging. Polled internally every hour and logs transitions to `homekit-health` activity type. Catches a broken Home app automation within hours instead of the 14-day audit window. Constraint: depends on `/var/lib/homebridge/homebridge.log` which homebridge-config-ui-x truncates when it exceeds `log.maxSize` (raised on 2026-05-12 from the default 1MB / 200KB-retained to 10MB / 2MB-retained, giving ~20 days of history instead of ~2). Surfaced in the climate.html Diagnostics tab.

**Presence detection** (`GET /api/presence`) reads the stateful `Dummy - Anyone Home` HomeKit switch via homebridge-config-ui-x's API at port 8581. The switch is driven by iOS Home app automations that you must set up once: open Home app → Automations → "+" → use the built-in "When the first person arrives home" trigger → action `Dummy - Anyone Home` ON. Mirror with "When the last person leaves home" → OFF. iOS's built-in person-aware geofence already knows about every household member (Reid, Gabby, etc.) so a single dummy captures the union of all presence signals. home-orchestrator polls the dummy every 60s and applies asymmetric debounce: away→home is instant (welcome you home immediately), home→away requires 30 consecutive minutes of "off" state (absorbs single iOS geofence misfires that would otherwise wrongly suppress automations). Token auth against UIX is automatic via the `/api/auth/noauth` endpoint (the UI is in `auth: none` mode locally on the Pi). Mark a `homekitExpectations` entry with `presenceGated: true` to have its status downgraded from `chronic` to `ok-while-away` when nobody is home -- prevents the audit from flagging legitimately-skipped automations like `Dummy - Fade Start Sunset` while you're traveling.

---

## Where to look for what

| Question | Answer |
|---|---|
| What does routine X do? | Look in `home-orchestrator/config.json` `routines.X` or `sonos-commander/config.json` `routines.X` |
| Why isn't a HomeKit switch firing my routine? | `/var/lib/homebridge/config.json` — find the dummy by name, check `commandOn` |
| What devices does the orchestrator know about? | Top-level keys in `home-orchestrator/config.json`: `hue`, `caseta`, `nanoleaf`, `samsung`, `switchbot`, `climate` |
| Where's the climate setpoint logic? | `home-orchestrator/climate.js` — `tickOnce()` is the control loop |
| Why is a light doing something weird at sunset? | `daytimeGradient` block in config; also see `LEARNINGS.md` for override-detection rules |
| How do I add a new HomeKit dummy? | Append to the existing `HomebridgeDummy` platform's `accessories` array in `/var/lib/homebridge/config.json`. Use the naming convention. |
| What's the deploy flow? | This file's "Deployment" section above |
| Why's the Pi running out of memory? | Check `free -m`. Each service should stay <50MB resident. Watch for socket/handle leaks. |
| What's the latest audit say? | `gh issue list --repo havenscr/home-automation --label home-audit --limit 1` or check the [Issues tab](https://github.com/havenscr/home-automation/issues?q=label%3Ahome-audit) |

---

## Keeping this README current

**This README is the authoritative project doc.** When changes are made to:

- Service architecture (new service, new module, new external integration)
- Routines (added, removed, renamed, behavior changed materially)
- HomeKit dummy switches (added, removed, naming changed)
- Config schema (new top-level key, breaking change to an existing one)
- Deploy or hardware setup

…this README must be updated in the same change. Stale documentation here is worse than no documentation, because everything else (memory files, CLAUDE.md instructions) assumes this is correct.

The repo's [CLAUDE.md](CLAUDE.md) enforces this rule for AI-assisted work.
