# HomeKit Automation Audit

**Date:** 2026-02-15
**Source:** My Home 2026-02-14 14.04.hbk + /var/lib/homebridge/config.json

## Apple TV Enhanced Plugin

**Plugin:** homebridge-appletv-enhanced v1.13.0
**Memory cost:** ~190MB (4 Python processes, 2 per Apple TV)
**Apple TVs:** Bedroom (4K gen 2) + Living Room (4K gen 3)

### Features Exposed Per Apple TV
- Television service with 40+ Input Source services (Netflix, Hulu, Disney, etc.)
- Occupancy sensors: Playing, Paused, Idle
- Switches: Play, Pause, Play Pause, Screensaver

### Automations That DEPEND on Apple TV Enhanced (7 total)

#### Play/Pause Light System (Living Room)
A sophisticated 4-part automation that dims/brightens lights when you pause/play the LR Apple TV at night:

| # | Automation | Trigger | Action |
|---|-----------|---------|--------|
| 20 | LR TV - Pause Lights | ATV LR "Paused" occupancy sensor | Nanoleafs 30%, Late Night Relax scene |
| 37 | LR TV - Play Lights | ATV LR "Playing" occupancy sensor | Movie scene, Nanoleafs 10%, under-cabinet 1% |
| 55 | Candles Off - For TV Pause | Candles Off switch | Disables pause/play system (gate) |
| 77 | Candles On - For TV Pause | Candles On switch | Enables pause/play system (gate) |

**Conditions:** Only fires when candles are on AND main lights are off (late night movie watching).

#### Alexa Play/Pause Control
| # | Automation | Trigger | Action |
|---|-----------|---------|--------|
| 31 | Alexa - LR TV Play | Dummy - LR TV Play switch | ATV LR "Play" switch ON |
| 57 | Alexa - LR TV Pause | Dummy - LR TV Pause switch | ATV LR "Pause" switch ON |

#### Bedroom TV Detection (Sonos Integration)
| # | Automation | Trigger | Action |
|---|-----------|---------|--------|
| 24 | Sonos - BR TV Off | ATV BR Active Identifier == 0 | All speakers vol 10, bedroom TV down |
| 63 | Sonos - BR TV On | ATV BR Active Identifier == 1 | Master Bedroom vol 32, bedroom TV up |
| 73 | Sonos - BR TV On - Office | ATV BR Active == 1 + office active | Same as 63, adjusted for office |

### Automations That Do NOT Need Apple TV Enhanced (4 related)
| # | Automation | Notes |
|---|-----------|-------|
| 2 | LR - TV Input (Apple TV) | Uses dummy switch + Samsung TV plugin |
| 22 | LR - TV Input (PS5) | Uses dummy switch + Samsung TV plugin |
| 55 | Candles Off - For TV Pause | Just a dummy switch toggle |
| 77 | Candles On - For TV Pause | Just a dummy switch toggle |

## All 78 Automations Summary

### By Category
- **Light alarm (wake-up sequence):** 7 automations (#1, 3, 5, 29, 39, 61, 74)
- **Time-of-day lighting:** 12 automations (sunset dims, evening/late night/day scenes)
- **Weather-based lighting:** 4 automations (sunny/cloudy switching)
- **Arrive/Leave home:** 4 automations (2 leave-home off, evening/late night arrival)
- **Dimmer button scenes:** 12 automations (bathroom B1/B3/B4, office B1/B2/B3/B4)
- **Sonos/TV integration:** 8 automations (LR TV on/off, BR TV on/off, PC audio)
- **Apple TV play/pause:** 4 automations (pause lights, play lights, candle gates)
- **Alexa bridge:** 9 automations (Nanoleaf levels, volume, TV play/pause, shuffle)
- **Morning routine chain:** 6 automations (routine start, delay chain, condo-on variants)
- **IFTTT bridges:** 4 dummy switches still calling IFTTT webhooks (Other Lights)
- **TV input switching:** 2 automations (Apple TV, PS5)
- **Scheduled tasks:** 3 automations (Hue reset, TV reboot, Friday livestream)
- **Misc:** 3 automations

### Homebridge Platforms Running
| Platform | Purpose | Memory Impact |
|----------|---------|---------------|
| Apple TV Enhanced | ATV control + sensors | ~190MB (4 Python processes) |
| HomebridgeDummy | 47 virtual switches | Minimal (Node.js) |
| IFTTT | 15 Sonos + smart plug triggers | Minimal |
| SwitchBot | Smart home devices | Minimal |
| WeatherPlus | Weather conditions for automations | Minimal |
| PlayStation | PS5 detection | Minimal |
| Alexa | Voice bridge | Moderate |
| HomebridgeAlexaSmartHome | Alexa device sync | Moderate |
| ElgatoKeyLights | Key light control | Minimal |
| NetworkPresence | Occupancy detection | Minimal |
| SamsungTizen | Samsung TV control | Minimal |

### IFTTT Remnants Still Active
These Homebridge dummy switches still call IFTTT webhooks:
- Dummy - Other Lights (Late Night) -> IFTTT Late_Night_Other_Lights
- Dummy - Other Lights (Evening) -> IFTTT Evening_Other_Lights
- Dummy - Other Lights (Day) -> IFTTT Day_Other_Lights
- Dummy - Other Lights (Off) -> IFTTT Off_Other_Lights

These should be migrated to Sonos Commander or direct local control.

### IFTTT Platform (Legacy Sonos Controls)
15 IFTTT accessories still exist for old Sonos control. These are now handled by Sonos Commander dummy switches. The IFTTT platform should be cleaned to keep only the 6 smart plug accessories:
- Fireplace On/Off
- Candles On/Off
- Office Candles On
- Common Area Candles Off
