#!/bin/bash
# snapshot-logs.sh -- Pi-side cron job that bundles 14 days of home-automation
# logs into a single JSON file and pushes it to the audit-data branch of the
# home-automation repo. The bi-weekly health-audit.yml GitHub Action reads
# this file rather than reaching into the Pi over the network.
#
# Run via /etc/cron.d/home-audit-snapshot every 12 hours.
# Or run manually:  sudo -u claude /opt/home-orchestrator/scripts/snapshot-logs.sh
#
# Requires:
#   - jq, curl, git, node, journalctl (all already on the Pi)
#   - /opt/home-orchestrator/.github-pat (mode 600, owned by claude)
#   - REPO_URL configured below to point at your home-automation repo
#
# Output format documented in /opt/home-orchestrator/scripts/README.md
# (also lives in the repo at scripts/README.md if present).

set -euo pipefail

# ---- Configuration ----
LOOKBACK_DAYS=14
MAX_BYTES=500000   # 500 KB cap to keep prompt under token budget
ACTIVITY_LOG_HO="/opt/home-orchestrator/activity.log"
ACTIVITY_LOG_SC="/opt/sonos-commander/activity.log"
HOMEBRIDGE_LOG="/var/lib/homebridge/homebridge.log"
WORK_DIR="/var/tmp/home-audit-snapshot"
REPO_DIR="$WORK_DIR/repo"
PAT_FILE="/opt/home-orchestrator/.github-pat"
# Override these via /opt/home-orchestrator/.audit-config if customizing per-host
REPO_URL="${REPO_URL:-}"
REPO_OWNER="${REPO_OWNER:-}"
REPO_NAME="${REPO_NAME:-home-automation}"

# Pull config overrides if file exists (lets you set REPO_URL etc without editing this script)
if [ -f /opt/home-orchestrator/.audit-config ]; then
  # shellcheck disable=SC1091
  . /opt/home-orchestrator/.audit-config
fi

if [ -z "$REPO_URL" ]; then
  echo "REPO_URL not set; aborting" >&2
  exit 1
fi

# ---- Helpers ----

log() { echo "[snapshot] $*" >&2; }

# Tail a JSON-lines activity log keeping only entries within lookback window,
# capping at N entries (newest wins). Outputs a JSON array.
tail_activity_log() {
  local file="$1"
  local max_entries="$2"
  if [ ! -f "$file" ]; then
    echo '[]'
    return
  fi
  local cutoff_iso
  cutoff_iso=$(date -u -d "$LOOKBACK_DAYS days ago" +%Y-%m-%dT%H:%M:%SZ)
  # Each line is JSON with a "ts" field. Filter, then keep last N.
  jq -c --arg cutoff "$cutoff_iso" 'select(.ts >= $cutoff)' "$file" 2>/dev/null \
    | tail -n "$max_entries" \
    | jq -s '.'
}

# Pull recent error/warn lines from a non-JSON log (homebridge.log).
# Strip ANSI codes, keep last N matching lines.
tail_text_log_errors() {
  local file="$1"
  local max_lines="$2"
  if [ ! -f "$file" ]; then
    echo '[]'
    return
  fi
  # Last 14 days worth of lines. Homebridge log doesn't have stable timestamps for date -d
  # parsing, so we just take the last large chunk and grep within it.
  tail -n 50000 "$file" 2>/dev/null \
    | sed -E 's/\x1b\[[0-9;]*m//g' \
    | grep -iE 'error|warn|crash|fatal|denied|refused|ECONNRESET|TLS|exception' \
    | grep -v -iE 'warn.*deprecat' \
    | tail -n "$max_lines" \
    | jq -R -s 'split("\n") | map(select(length > 0))'
}

# Count occurrences of "DummyName executed command" patterns in homebridge.log
# over the lookback window. Returns a JSON object {dummyName: count}.
count_automation_fires() {
  local file="$1"
  if [ ! -f "$file" ]; then
    echo '{}'
    return
  fi
  tail -n 100000 "$file" 2>/dev/null \
    | sed -E 's/\x1b\[[0-9;]*m//g' \
    | grep -oE '\[Homebridge Dummy\] [A-Za-z0-9 ()_-]+ executed command' \
    | sed -E 's/.*Dummy\] (.+) executed command/\1/' \
    | sort \
    | uniq -c \
    | awk '{count=$1; $1=""; sub(/^ /,""); printf "%s\t%d\n", $0, count}' \
    | jq -R -s 'split("\n") | map(select(length > 0) | split("\t") | {(.[0]): (.[1]|tonumber)}) | add // {}'
}

# systemd journal errors for a service over the lookback window
journal_errors() {
  local svc="$1"
  local max_lines="$2"
  journalctl -u "$svc" --since "$LOOKBACK_DAYS days ago" --no-pager 2>/dev/null \
    | grep -iE 'error|warn|fatal|denied|crash|unhandled|left-over|ECONNREFUSED' \
    | tail -n "$max_lines" \
    | jq -R -s 'split("\n") | map(select(length > 0))'
}

# Count restarts of a service in the lookback window
journal_restart_count() {
  local svc="$1"
  journalctl -u "$svc" --since "$LOOKBACK_DAYS days ago" --no-pager 2>/dev/null \
    | grep -c "Started ${svc}.service" || true
}

# Resident memory of a service in MB (rough)
service_mem_mb() {
  local svc="$1"
  local pid
  pid=$(systemctl show -p MainPID --value "$svc" 2>/dev/null || echo 0)
  if [ "$pid" = "0" ] || [ -z "$pid" ]; then
    echo 0
    return
  fi
  ps -o rss= -p "$pid" 2>/dev/null | awk '{printf "%d", $1/1024}' || echo 0
}

service_active() {
  systemctl is-active "$1" 2>/dev/null | grep -q '^active$' && echo true || echo false
}

# ---- Build the snapshot JSON ----

mkdir -p "$WORK_DIR"
SNAPSHOT_FILE="$WORK_DIR/audit-data.json"
TMP_FILE="$WORK_DIR/audit-data.tmp.json"

log "building snapshot..."

UPTIME_STR=$(uptime -p 2>/dev/null || uptime)
MEM_TOTAL=$(free -m | awk '/^Mem:/{print $2}')
MEM_AVAIL=$(free -m | awk '/^Mem:/{print $7}')
DISK_FREE_GB=$(df -BG / | awk 'NR==2{gsub("G","",$4); print $4}')

# Live climate state (best-effort; if it fails, just include error string)
CLIMATE_STATE=$(curl -s --max-time 5 http://localhost:5006/api/climate/state || echo '{"error":"unreachable"}')

jq -n \
  --arg snapshotAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --argjson lookbackDays "$LOOKBACK_DAYS" \
  --arg uptime "$UPTIME_STR" \
  --argjson memTotal "$MEM_TOTAL" \
  --argjson memAvail "$MEM_AVAIL" \
  --argjson diskFreeGB "$DISK_FREE_GB" \
  --arg ho_active "$(service_active home-orchestrator)" \
  --argjson ho_restarts "$(journal_restart_count home-orchestrator)" \
  --argjson ho_mem "$(service_mem_mb home-orchestrator)" \
  --arg sc_active "$(service_active sonos-commander)" \
  --argjson sc_restarts "$(journal_restart_count sonos-commander)" \
  --argjson sc_mem "$(service_mem_mb sonos-commander)" \
  --arg hb_active "$(service_active homebridge)" \
  --argjson hb_restarts "$(journal_restart_count homebridge)" \
  --argjson hb_mem "$(service_mem_mb homebridge)" \
  --argjson activityHO "$(tail_activity_log "$ACTIVITY_LOG_HO" 1500)" \
  --argjson activitySC "$(tail_activity_log "$ACTIVITY_LOG_SC" 1500)" \
  --argjson hbErrors "$(tail_text_log_errors "$HOMEBRIDGE_LOG" 200)" \
  --argjson hbFires "$(count_automation_fires "$HOMEBRIDGE_LOG")" \
  --argjson sysHO "$(journal_errors home-orchestrator 50)" \
  --argjson sysSC "$(journal_errors sonos-commander 50)" \
  --argjson sysHB "$(journal_errors homebridge 50)" \
  --argjson climate "$CLIMATE_STATE" \
  '{
    snapshotAt: $snapshotAt,
    lookbackDays: $lookbackDays,
    host: { uptime: $uptime, memMB: { total: $memTotal, available: $memAvail }, diskFreeGB: $diskFreeGB },
    services: {
      "home-orchestrator": { active: ($ho_active=="true"), restarts: $ho_restarts, memResidentMB: $ho_mem },
      "sonos-commander":   { active: ($sc_active=="true"), restarts: $sc_restarts, memResidentMB: $sc_mem },
      "homebridge":        { active: ($hb_active=="true"), restarts: $hb_restarts, memResidentMB: $hb_mem }
    },
    activityLog: {
      "home-orchestrator": $activityHO,
      "sonos-commander":   $activitySC
    },
    homebridgeLog: {
      errors: $hbErrors,
      automationFires: $hbFires
    },
    systemd: {
      errors: {
        "home-orchestrator": $sysHO,
        "sonos-commander":   $sysSC,
        "homebridge":        $sysHB
      }
    },
    climateState: $climate
  }' > "$TMP_FILE"

# Truncate per-section if total size exceeds cap. Crude but effective:
# drop oldest activity log entries first.
SIZE=$(stat -c%s "$TMP_FILE")
if [ "$SIZE" -gt "$MAX_BYTES" ]; then
  log "snapshot is ${SIZE} bytes, exceeds ${MAX_BYTES}. Trimming activity logs..."
  jq '.activityLog["home-orchestrator"] = (.activityLog["home-orchestrator"] | .[-500:])
      | .activityLog["sonos-commander"]   = (.activityLog["sonos-commander"]   | .[-500:])
      | .homebridgeLog.errors             = (.homebridgeLog.errors             | .[-100:])' \
      "$TMP_FILE" > "$TMP_FILE.trimmed"
  mv "$TMP_FILE.trimmed" "$TMP_FILE"
  SIZE=$(stat -c%s "$TMP_FILE")
  log "after trim: ${SIZE} bytes"
fi

mv "$TMP_FILE" "$SNAPSHOT_FILE"
log "snapshot written: $SNAPSHOT_FILE (${SIZE} bytes)"

# ---- Push to audit-data branch ----

if [ ! -f "$PAT_FILE" ]; then
  log "ERROR: PAT file missing at $PAT_FILE -- cannot push. Snapshot was built but not delivered."
  exit 2
fi
PAT=$(cat "$PAT_FILE")

# Construct the auth URL. REPO_URL is expected to be https://github.com/<owner>/<name>.git
AUTH_URL=$(echo "$REPO_URL" | sed -E "s#https://#https://x-access-token:${PAT}@#")

if [ ! -d "$REPO_DIR/.git" ]; then
  log "first-run clone of audit-data branch into $REPO_DIR"
  rm -rf "$REPO_DIR"
  # Clone only the audit-data branch with depth 1; if the branch doesn't exist yet
  # create it as an orphan branch in a fresh clone.
  if git ls-remote --heads "$AUTH_URL" audit-data | grep -q audit-data; then
    git clone --branch audit-data --depth 1 --single-branch "$AUTH_URL" "$REPO_DIR"
  else
    log "audit-data branch does not exist remotely; creating as orphan"
    git clone --depth 1 "$AUTH_URL" "$REPO_DIR"
    cd "$REPO_DIR"
    git checkout --orphan audit-data
    git rm -rf . 2>/dev/null || true
    cd - > /dev/null
  fi
fi

cd "$REPO_DIR"
git config user.name "home-audit-bot"
git config user.email "home-audit-bot@$(hostname).local"
git remote set-url origin "$AUTH_URL"

# Ensure on audit-data branch (in case the branch was created but checkout didn't stick)
git fetch origin audit-data 2>/dev/null || true
git checkout audit-data 2>/dev/null || git checkout -b audit-data

cp "$SNAPSHOT_FILE" ./audit-data.json
git add audit-data.json
if git diff --cached --quiet; then
  log "no change in snapshot since last push"
else
  git commit -m "audit snapshot $(date -u +%Y-%m-%dT%H:%MZ)" >/dev/null
  git push origin audit-data
  log "pushed audit-data.json (${SIZE} bytes) to audit-data branch"
fi
