#!/usr/bin/env bash
# run-claude-scheduled.sh — invoked by cron/at lines installed by vps-schedule.sh.
#
# Usage: run-claude-scheduled.sh <name> [--once]
#
# Loads the prompt for <name> from /home/operator/.config/command-center/schedule/<name>.prompt,
# picks a logged-in Claude account via pick-claude-account.sh, then exec's
# run-claude-host.sh which runs `claude -p` with the chosen HOME.
#
# When called with --once, also asks vps-schedule.sh to clean up the
# self-removing crontab line and metadata after the prompt completes.

set -u -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR=/home/operator/.config/command-center/schedule

NAME="${1:-}"
ONCE=""
[ "${2:-}" = "--once" ] && ONCE=1

if [ -z "$NAME" ]; then
  echo "ERROR: missing <name>" >&2
  exit 64
fi

PROMPT="$CONFIG_DIR/$NAME.prompt"
if [ ! -f "$PROMPT" ]; then
  echo "ERROR: prompt file not found for '$NAME': $PROMPT" >&2
  exit 65
fi

# Pick an account; export HOME for the helper.
PICK="$SCRIPT_DIR/pick-claude-account.sh"
RUN="$SCRIPT_DIR/run-claude-host.sh"
[ -x "$PICK" ] || { echo "ERROR: $PICK not found or not executable" >&2; exit 70; }
[ -x "$RUN" ]  || { echo "ERROR: $RUN not found or not executable" >&2; exit 70; }

ACCOUNT_HOME="$("$PICK")"
if [ -z "$ACCOUNT_HOME" ] || [ ! -d "$ACCOUNT_HOME/.claude" ]; then
  echo "ERROR: pick-claude-account.sh returned no usable account (got '$ACCOUNT_HOME')" >&2
  exit 71
fi

START_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo "[$START_TS] schedule-vps run name=$NAME account=$ACCOUNT_HOME once=${ONCE:-0}"

EXIT=0
HOME="$ACCOUNT_HOME" "$RUN" "$PROMPT" || EXIT=$?

END_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo "[$END_TS] schedule-vps done name=$NAME exit=$EXIT"

if [ -n "$ONCE" ]; then
  "$SCRIPT_DIR/vps-schedule.sh" run-once-cleanup "$NAME" || true
fi

exit "$EXIT"
