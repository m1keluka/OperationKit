#!/usr/bin/env bash
# install-dream-cycle-cron.sh — register the nightly Dream Cycle cron entry
# for the current user. Idempotent: re-running replaces the existing entry.
#
# Schedule: 02:30 America/New_York. By then:
#   - reconcile-clients ran at 00:05 ET (well done)
#   - generate-daily-digest ran at 23:00 ET prior night (~3.5h earlier)
#   - update-active-state's morning tick at 09:00 ET is still ~6.5h away
#
# dream-cycle.sh needs CC_SERVICE_TOKEN at runtime. We source it from
# ~/.config/command-center/cron.env if present so cron (which starts with a
# minimal environment) can see the token. Provision via:
#   bash scripts/fix-vps-cron.sh

set -euo pipefail

SCRIPT_PATH="/home/operator/projects/command-center-infra/scripts/dream-cycle.sh"
ENV_FILE="$HOME/.config/command-center/cron.env"
MARKER="# command-center: dream-cycle"

if [ ! -x "$SCRIPT_PATH" ]; then
  chmod +x "$SCRIPT_PATH"
fi

mkdir -p "$(dirname "$ENV_FILE")"

SOURCE_LINE=""
if [ -f "$ENV_FILE" ]; then
  SOURCE_LINE=". $ENV_FILE && "
else
  echo "WARNING: $ENV_FILE not found. dream-cycle will fail without CC_SERVICE_TOKEN." >&2
  echo "  Create with: bash scripts/fix-vps-cron.sh" >&2
fi

CURRENT="$(crontab -l 2>/dev/null || true)"
FILTERED="$(printf '%s\n' "$CURRENT" \
  | grep -v "$MARKER" \
  | grep -v '^CRON_TZ=America/New_York$' \
  || true)"

NEW_ENTRIES=$(cat <<EOF
CRON_TZ=America/New_York
30 2 * * * ${SOURCE_LINE}bash $SCRIPT_PATH >> /home/operator/transcripts/dream-cycle.cron.log 2>&1 $MARKER
EOF
)

printf '%s\n%s\n' "$FILTERED" "$NEW_ENTRIES" | sed '/^[[:space:]]*$/d' | crontab -

echo "Installed cron entry:"
crontab -l | grep -A1 "$MARKER" || true
