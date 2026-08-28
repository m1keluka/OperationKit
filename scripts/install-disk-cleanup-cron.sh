#!/usr/bin/env bash
# Idempotent: replace the weekly Sunday disk-cleanup cron with a 6-hourly run.
# The script itself no-ops into a cheap light pass when the disk is under 80%.
set -euo pipefail

SCRIPT_PATH="/home/operator/projects/command-center-infra/scripts/disk-cleanup.sh"
MARKER="# command-center: disk-cleanup"
HOST_BOOT_SRC="/home/operator/projects/command-center-infra/scripts/host-boot.d/40-disk-hygiene.sh"
HOST_BOOT_DST="/home/operator/ai-workspace/host-boot.d/40-disk-hygiene.sh"

chmod +x "$SCRIPT_PATH"
if [ -f "$HOST_BOOT_SRC" ] && [ -d "$(dirname "$HOST_BOOT_DST")" ]; then
  cp "$HOST_BOOT_SRC" "$HOST_BOOT_DST"
  chmod +x "$HOST_BOOT_DST"
  echo "Installed host-boot.d wrapper: $HOST_BOOT_DST"
fi

CURRENT="$(crontab -l 2>/dev/null || true)"
FILTERED="$(printf '%s\n' "$CURRENT" \
  | grep -v "$MARKER" \
  | grep -v 'scripts/disk-cleanup.sh' \
  || true)"

NEW_ENTRIES=$(cat <<EOF
# Every 6 hours. Script chooses light/normal/aggressive from df. $MARKER
25 */6 * * * /usr/bin/bash $SCRIPT_PATH >> /home/operator/disk-cleanup-cron.log 2>&1
EOF
)

printf '%s\n%s\n' "$FILTERED" "$NEW_ENTRIES" | sed '/^$/d' | crontab -

echo "Installed cron entry:"
crontab -l | grep -A1 "$MARKER" || crontab -l | grep disk-cleanup
