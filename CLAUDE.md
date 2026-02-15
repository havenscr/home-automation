# Home Automation — Claude Code Guidelines

## Target Hardware

Raspberry Pi 3B+ with 1GB RAM running Homebridge, Apple TV Enhanced, and custom services.
Available memory is ~400MB. Every byte counts.

## SSH Access

```bash
ssh claude@192.168.1.61
```

Key auth is configured. Use the `claude` user for all SSH operations.
Project files live at `/opt/sonos-commander/` on the Pi.
Homebridge config is at `/var/lib/homebridge/config.json`.

**CRITICAL: Never run more than 2 parallel SSH connections to the Pi.** The Pi 3B+ has limited SSH capacity. Use sequential commands or chain with `&&` in a single session.

## Code Constraints (Pi 3B+)

### Memory
- Total RAM: 922MB, available: ~400MB
- Homebridge uses ~212MB, Apple TV Enhanced uses ~190MB
- Keep each custom service under 50MB resident memory
- **No heavy frameworks** — no Next.js, no webpack, no React build tooling on the Pi
- Use vanilla JS for frontends; single-file HTML/CSS/JS is ideal
- Avoid loading large datasets into memory; stream or paginate instead

### CPU
- Quad-core ARM Cortex-A53 @ 1.4GHz — capable but not fast
- Avoid CPU-intensive operations (image processing, heavy JSON parsing of large files)
- Use async I/O everywhere; never block the event loop
- Keep startup time fast — lazy-load where possible

### Disk
- 29GB SD card, 19GB free
- SD cards have limited write cycles — minimize frequent file writes
- Use in-memory buffers for logs, flush periodically (not on every event)
- Keep `node_modules` lean: only install what you actually use

### Network
- UPnP/SSDP discovery is unreliable — cache speaker references after discovery
- Sonos speakers occasionally go offline; always handle connection errors gracefully
- Local network only — no need for HTTPS, but never expose credentials in API responses

## Architecture Principles

### Keep It Simple
- One `server.js` per service is fine until it hits ~800 lines, then consider splitting into modules
- Config files (JSON) should be the source of truth for user-facing settings
- No ORMs, no databases — flat JSON files are sufficient for this scale
- No build steps — code should run directly with `node server.js`

### Reliability Over Features
- Every speaker operation must handle the speaker being offline
- Always filter the Sonos Boost (192.168.1.15) from speaker operations — it's a WiFi extender, not a speaker
- Use `try/catch` around all UPnP calls; log errors but don't crash
- Services must auto-restart via systemd (`Restart=always`)

### API Design
- RESTful endpoints under `/api/`
- POST for actions, GET for state
- Return JSON with consistent structure: `{ success: true/false, data/error }`
- Keep response payloads small — the web UI runs on phones too

### Web UI Guidelines
- Single HTML file with inline CSS and JS (no build step, no external CDN dependencies)
- Must work on mobile Safari (primary access is via iPhone)
- Keep total page weight under 200KB
- Use CSS Grid/Flexbox for layout — no CSS frameworks
- Color palette: teal (#009999) primary, dark backgrounds for dashboards
- Test all UI changes at 375px width (iPhone SE) and 1024px (iPad)
- Avoid animations that trigger repaints on every frame

### HomeKit Integration
- Homebridge dummy switches are the bridge between HomeKit and custom services
- Each switch triggers a `curl` POST to the local API
- Stateless switches (`"stateful": false`) with a 1-second timer work best
- Name convention: `SC - Routine Name` for Sonos Commander switches
- Keep dummy switch count reasonable — too many clutters the Home app

## Testing Changes

```bash
# After editing code locally, deploy and test:
ssh claude@192.168.1.61 "sudo systemctl restart sonos-commander"
ssh claude@192.168.1.61 "sudo journalctl -u sonos-commander -n 20 --no-pager"

# Test a specific routine
ssh claude@192.168.1.61 "curl -s -X POST http://localhost:5005/api/trigger/Day_Music"

# Check speaker discovery
ssh claude@192.168.1.61 "curl -s http://localhost:5005/api/speakers"

# Check current playback
ssh claude@192.168.1.61 "curl -s http://localhost:5005/api/status"
```

## File Deployment

The source of truth is this git repo. To deploy changes to the Pi:

```bash
# Deploy a specific file
ssh claude@192.168.1.61 "cat > /opt/sonos-commander/server.js" < sonos-commander/server.js

# Deploy and restart
ssh claude@192.168.1.61 "cat > /opt/sonos-commander/server.js" < sonos-commander/server.js && ssh claude@192.168.1.61 "sudo systemctl restart sonos-commander"
```

## Common Pitfalls

1. **Boost speaker** — Always filter `Boost` from speaker iterations. It causes UPnP 500 errors.
2. **SD card writes** — Don't write logs on every request. Buffer and flush.
3. **SSH flooding** — Max 2 parallel SSH connections. Chain commands with `&&`.
4. **Sonos discovery** — SSDP can take 5-10 seconds. Cache results. Don't re-discover on every request.
5. **Memory leaks** — Clear timers and intervals when they're done. Watch for growing arrays/objects.
6. **Large responses** — The favorites list has 70+ items. Paginate or lazy-load in the UI.
