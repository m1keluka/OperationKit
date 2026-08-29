#!/usr/bin/env bash
# install-daily-log-cron.sh — register the hourly active-state refresher and
# the 23:00 ET daily-digest job for the current user.
#
# Idempotent: re-running replaces the existing entries (matched by marker
# comments). Preserves any unrelated cron entries the user has configured.
#
# Both jobs require CC_SERVICE_TOKEN at runtime. We source it from
# ~/.config/command-center/cron.env if present so cron (which starts with a
# minimal environment) can see the token. Create that file as:
#   echo 'export CC_SERVICE_TOKEN=<token>' > ~/.config/command-center/cron.env
#   chmod 600 ~/.config/command-center/cron.env

set -euo pipefail

SCRIPTS_DIR="${CC_REPO_DIR:-/home/operator/projects/operationkit}/scripts"
ACTIVE_SCRIPT="$SCRIPTS_DIR/update-active-state.sh"
DIGEST_SCRIPT="$SCRIPTS_DIR/generate-daily-digest.sh"
ENV_FILE="$HOME/.config/command-center/cron.env"
LOG_DIR="/home/operator/transcripts"

ACTIVE_MARKER="# command-center: update-active-state"
DIGEST_MARKER="# command-center: generate-daily-digest"

for f in "$ACTIVE_SCRIPT" "$DIGEST_SCRIPT"; do
  [ -f "$f" ] || { echo "ERROR: missing $f" >&2; exit 1; }
  [ -x "$f" ] || chmod +x "$f"
done

mkdir -p "$LOG_DIR" "$(dirname "$ENV_FILE")"

# Preserve non-matching entries, drop any of ours so we can re-install cleanly.
CURRENT="$(crontab -l 2>/dev/null || true)"
FILTERED="$(printf '%s\n' "$CURRENT" \
  | grep -v "$ACTIVE_MARKER" \
  | grep -v "$DIGEST_MARKER" \
  | grep -v '^CRON_TZ=America/New_York$' \
  || true)"

SOURCE_LINE=""
if [ -f "$ENV_FILE" ]; then
  SOURCE_LINE=". $ENV_FILE && "
else
  echo "WARNING: $ENV_FILE not found. Cron jobs will fail without CC_SERVICE_TOKEN." >&2
  echo "  Create with: echo 'export CC_SERVICE_TOKEN=<token>' > $ENV_FILE && chmod 600 $ENV_FILE" >&2
fi

NEW_ENTRIES="$(cat <<EOF
CRON_TZ=America/New_York
0 * * * * ${SOURCE_LINE}bash $ACTIVE_SCRIPT >> $LOG_DIR/update-active-state.cron.log 2>&1 $ACTIVE_MARKER
0 23 * * * ${SOURCE_LINE}bash $DIGEST_SCRIPT >> $LOG_DIR/generate-daily-digest.cron.log 2>&1 $DIGEST_MARKER
EOF
)"

# Write merged crontab (filtered + new), strip blank lines.
printf '%s\n%s\n' "$FILTERED" "$NEW_ENTRIES" | sed '/^[[:space:]]*$/d' | crontab -

echo "Installed cron entries:"
crontab -l | grep -E "($ACTIVE_MARKER|$DIGEST_MARKER|^CRON_TZ=)" || true
