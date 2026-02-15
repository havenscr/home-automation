# Home Automation

Local-first home automation services running on a Raspberry Pi 3B+ alongside Homebridge. Designed to replace cloud dependencies (IFTTT, etc.) with fast, reliable local control integrated with Apple HomeKit.

## Projects

### [Sonos Commander](sonos-commander/)

Node.js/Express application for local Sonos speaker automation.

- **REST API** for triggering music routines, speaker grouping, volume control
- **Web UI** at port 5005 for managing routines, scenes, and group presets
- **HomeKit integration** via Homebridge dummy switches
- **Sleep timers** with configurable fade-out
- **Activity logging** and now-playing dashboard

**Speakers:** Kitchen, Office Speaker, Bathroom, Master Bedroom, Guest Bathroom Speaker, Playbase (+ Boost, filtered from all operations)

**Quick start:**
```bash
# On the Pi
cd /opt/sonos-commander
sudo systemctl restart sonos-commander
sudo journalctl -u sonos-commander -f

# Test a routine
curl -s -X POST http://localhost:5005/api/trigger/Day_Music
```

## Infrastructure

| Component | Details |
|---|---|
| Hardware | Raspberry Pi 3B+ (1GB RAM, 29GB SD) |
| OS | Raspbian/Debian |
| Runtime | Node.js v22 |
| Homebridge | http://homebridge.local:8581 |
| Network | 192.168.1.61 (static) |

## Deployment

Services are managed via systemd. After editing code:

```bash
# Copy updated files to the Pi
scp sonos-commander/server.js claude@192.168.1.61:/opt/sonos-commander/

# Restart the service
ssh claude@192.168.1.61 "sudo systemctl restart sonos-commander"

# Check logs
ssh claude@192.168.1.61 "sudo journalctl -u sonos-commander -n 50"
```
