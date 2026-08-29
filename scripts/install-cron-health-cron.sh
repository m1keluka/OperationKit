#!/usr/bin/env bash
# install-cron-health-cron.sh — register the daily cron-health-check entry
# for the current user. Idempotent: re-running replaces the existing entry.
#
# Runs at 09:30 America/New_York, after the prior night's digest (23:00 ET),
# the morning campaign-audit (08:00 ET), and a fresh hourly update-active-state
# tick (09:00 ET).
#
# The check itself doesn't need any cron.env vars — it inspects host paths
# directly — but we still source the env file when present, so the script
# can use $TRANSCRIPT_DIR / $SECOND_BRAIN_ROOT overrides if anyone sets them.

set -euo pipefail

SCRIPT_PATH="${CC_REPO_DIR:-/home/operator/projects/operationkit}/scripts/cron-health-check.sh"
ENV_FILE="$HOME/.config/command-center/cron.env"
MARKER="# command-center: cron-health-check"

if [ ! -x "$SCRIPT_PATH" ]; then
  chmod +x "$SCRIPT_PATH"
fi

mkdir -p "$(dirname "$ENV_FILE")"

SOURCE_LINE=""
if [ -f "$ENV_FILE" ]; then
  SOURCE_LINE=". $ENV_FILE && "
fi

CURRENT="$(crontab -l 2>/dev/null || true)"
FILTERED="$(echo "$CURRENT" | grep -v "$MARKER" || true)"

NEW_ENTRIES=$(cat <<EOF
CRON_TZ=America/New_York
30 9 * * * ${SOURCE_LINE}bash $SCRIPT_PATH >> /home/operator/transcripts/cron-health-check.cron.log 2>&1 $MARKER
EOF
)

printf '%s\n%s\n' "$FILTERED" "$NEW_ENTRIES" | sed '/^$/d' | crontab -

echo "Installed cron entry:"
crontab -l | grep -A1 "$MARKER" || true
