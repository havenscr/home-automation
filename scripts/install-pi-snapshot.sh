#!/bin/bash
# install-pi-snapshot.sh -- one-time setup that wires up the audit log snapshot
# cron on the Pi. Run as root from the home-automation repo root after cloning.
#
# Steps:
#   1. Copies snapshot-logs.sh to /opt/home-orchestrator/scripts/ (owned by claude)
#   2. Prompts for GitHub PAT, repo URL/owner; writes them to /opt/home-orchestrator/.audit-config
#      and /opt/home-orchestrator/.github-pat (mode 600, owned by claude)
#   3. Installs /etc/cron.d/home-audit-snapshot to run every 12h
#   4. Triggers an immediate test run to verify everything works
#
# Usage:
#   sudo bash scripts/install-pi-snapshot.sh

set -euo pipefail

if [ "${EUID}" -ne 0 ]; then
  echo "Run as root: sudo bash $0" >&2
  exit 1
fi

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
SCRIPT_SRC="$REPO_ROOT/scripts/snapshot-logs.sh"
SCRIPT_DEST_DIR="/opt/home-orchestrator/scripts"
SCRIPT_DEST="$SCRIPT_DEST_DIR/snapshot-logs.sh"
PAT_FILE="/opt/home-orchestrator/.github-pat"
CONFIG_FILE="/opt/home-orchestrator/.audit-config"
CRON_FILE="/etc/cron.d/home-audit-snapshot"

if [ ! -f "$SCRIPT_SRC" ]; then
  echo "Cannot find $SCRIPT_SRC. Run from the home-automation repo root." >&2
  exit 1
fi

# 1. Deploy the snapshot script
mkdir -p "$SCRIPT_DEST_DIR"
cp "$SCRIPT_SRC" "$SCRIPT_DEST"
chmod 755 "$SCRIPT_DEST"
chown claude:claude "$SCRIPT_DEST_DIR" "$SCRIPT_DEST"
echo "[1/4] Deployed: $SCRIPT_DEST"

# Add claude user to systemd-journal group so journalctl works without sudo
if ! id -nG claude | grep -qw systemd-journal; then
  usermod -a -G systemd-journal claude
  echo "      Added claude user to systemd-journal group (login session needed for it to take effect; cron will use new groups on next run)"
fi

# 2. Capture PAT + repo info
if [ ! -f "$PAT_FILE" ]; then
  echo
  echo "Need a fine-grained GitHub PAT scoped to this repo only with permission:"
  echo "    Contents: Read and write   (no other permissions needed)"
  echo "Generate at: https://github.com/settings/personal-access-tokens/new"
  echo
  read -r -s -p "Paste PAT (input hidden): " PAT
  echo
  printf '%s' "$PAT" > "$PAT_FILE"
  chmod 600 "$PAT_FILE"
  chown claude:claude "$PAT_FILE"
  echo "[2/4] Saved PAT to $PAT_FILE"
else
  echo "[2/4] PAT already exists at $PAT_FILE (leaving as-is; delete + rerun to update)"
fi

if [ ! -f "$CONFIG_FILE" ]; then
  echo
  read -r -p "Repo URL (e.g. https://github.com/youruser/home-automation.git): " REPO_URL
  REPO_OWNER=$(echo "$REPO_URL" | sed -E 's#https://github.com/([^/]+)/.*#\1#')
  REPO_NAME=$(echo "$REPO_URL" | sed -E 's#.*/([^/]+)\.git#\1#')
  cat > "$CONFIG_FILE" <<EOF
REPO_URL="$REPO_URL"
REPO_OWNER="$REPO_OWNER"
REPO_NAME="$REPO_NAME"
EOF
  chmod 644 "$CONFIG_FILE"
  chown claude:claude "$CONFIG_FILE"
  echo "[3/4] Wrote $CONFIG_FILE"
else
  echo "[3/4] Config already exists at $CONFIG_FILE (leaving as-is)"
fi

# 4. Install cron
cat > "$CRON_FILE" <<EOF
# Home automation audit snapshot - runs every 12 hours.
# Bundles 14 days of logs into a JSON file and pushes to the audit-data branch.
# Bi-weekly GitHub Action reads from there.
SHELL=/bin/bash
PATH=/usr/local/bin:/usr/bin:/bin
0 */12 * * *  claude  $SCRIPT_DEST > /var/log/home-audit-snapshot.log 2>&1
EOF
chmod 644 "$CRON_FILE"
echo "[4/4] Installed cron: $CRON_FILE"

# Trigger an immediate test run
echo
echo "Running snapshot now to verify setup..."
if sudo -u claude "$SCRIPT_DEST"; then
  echo
  echo "SUCCESS. Snapshot pushed to audit-data branch."
  echo "Next steps:"
  echo "  1. Verify the file landed: gh api repos/<owner>/<name>/contents/audit-data.json?ref=audit-data | jq -r .size"
  echo "  2. Add CLAUDE_CODE_OAUTH_TOKEN and NTFY_TOPIC secrets to the repo"
  echo "  3. Trigger the health-audit workflow manually"
else
  echo
  echo "FAILED. Check /var/log/home-audit-snapshot.log and /var/tmp/home-audit-snapshot/ for clues." >&2
  exit 2
fi
