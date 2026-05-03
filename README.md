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
- **Philips Hue** lights via the Bridge at `192.168.1.2` (group commands to avoid rate limiting)
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

- **Day/night targets**: configurable via UI (defaults: day 72F at 8am-10pm, night 70F at 10pm-8am)
- **Heat-pressure ladder**: max delta across rooms drives a 5-rung priority list. As pressure climbs, more aggressive rungs engage. Hysteresis prevents flapping.
- **Office quiet hours** (Mon-Fri 10am-6pm): office capped at MID fan; kitchen ramps to compensate when room is hot. Outside these hours, the default ladder lets office go HIGH and become the apt's primary cooler.
- **Manual override auto-detect**: if the LG app, the unit's buttons, or anyone else changes a setpoint or fan speed, the orchestrator pauses that AC for 30 minutes (configurable) before resuming control. Detection is automatic — no button press needed.
- **Per-AC and global pause** with explicit duration buttons in the UI.
- **Polling cadence**: 60 seconds. ~10-15MB RAM. Direct HTTPS calls to `api-aic.lgthinq.com`.
- **UI** at `/climate.html` is fully editable: dashboard with per-AC manual control, settings tab for all schedule + override values, and a ladder tab where you can add/remove rungs, reorder via up/down buttons, and edit room or fan speed inline. All edits saved via `PATCH /api/climate/config`.

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
