#!/usr/bin/env bash
# run-claude-host.sh — invoke `claude -p` for host-side cron jobs.
#
# Usage: run-claude-host.sh <prompt-file>
#
# Expects HOME to already be set to a logged-in Claude account directory
# (e.g. /home/ccuser-a) by the caller. Use scripts/pick-claude-account.sh
# on the host to choose a slot, then forward HOME via `docker exec -e`.
#
# Replaces the older /home/operator/transcripts/run-claude-audit.sh which
# hardcoded HOME=/home/ccuser (an account that has never been logged in
# and therefore always returns "Not logged in" for -p invocations).

set -u -o pipefail

PROMPT_FILE="${1:-}"
if [ -z "$PROMPT_FILE" ] || [ ! -f "$PROMPT_FILE" ]; then
  echo "ERROR: prompt file not found: ${PROMPT_FILE:-<missing>}" >&2
  exit 1
fi

if [ -z "${HOME:-}" ] || [ ! -d "$HOME/.claude" ]; then
  echo "ERROR: HOME (${HOME:-<unset>}) is not a logged-in Claude account dir" >&2
  exit 1
fi

PROMPT="$(cat "$PROMPT_FILE")"
exec claude -p "$PROMPT" --dangerously-skip-permissions --output-format json
