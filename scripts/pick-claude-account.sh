#!/usr/bin/env bash
# pick-claude-account.sh — choose a logged-in Claude account HOME dir for
# host-side cron jobs that need to invoke `claude -p`.
#
# Mirrors server/src/services/account-router.ts:pickAccount() — picks the slot
# with the lowest priority number first (so a deprioritized personal account is
# used last), then fewest active sessions, breaking ties by sessionsToday then
# tokensToday, and skips slots whose rateLimitResetsAt is still in the future.
#
# Reads /home/operator/transcripts/account-router-state.json. Falls back to
# /home/ccuser-a if the state file is missing or unreadable, since a is the
# Primary slot and is always provisioned.
#
# Optional env: EXCLUDE_HOMES is a colon-separated list of homeDir paths to
# skip. Used by retry paths (e.g. generate-daily-digest.sh) to pick a
# different account after a previous one failed. Exits non-zero with empty
# stdout if every candidate is excluded.
#
# Prints the absolute HOME path on stdout. Exits non-zero only on truly
# unexpected errors (the fallback covers the common "state file not yet
# written" case).

set -u -o pipefail

STATE_FILE="${ACCOUNT_ROUTER_STATE:-/home/operator/transcripts/account-router-state.json}"
FALLBACK_HOME="/home/ccuser-a"
EXCLUDE_HOMES="${EXCLUDE_HOMES:-}"

is_excluded() {
  case ":$EXCLUDE_HOMES:" in
    *":$1:"*) return 0 ;;
    *)        return 1 ;;
  esac
}

if [ ! -r "$STATE_FILE" ]; then
  if is_excluded "$FALLBACK_HOME"; then
    exit 1
  fi
  echo "$FALLBACK_HOME"
  exit 0
fi

EXCLUDE_HOMES="$EXCLUDE_HOMES" python3 - "$STATE_FILE" "$FALLBACK_HOME" <<'PY'
import json, os, sys, time
state_file, fallback = sys.argv[1], sys.argv[2]
exclude = {p for p in os.environ.get("EXCLUDE_HOMES", "").split(":") if p}

try:
    with open(state_file) as f:
        state = json.load(f)
except Exception:
    if fallback in exclude:
        sys.exit(1)
    print(fallback); sys.exit(0)

accounts = state.get("accounts") or []
now_ms = int(time.time() * 1000)

def available(a):
    reset = a.get("rateLimitResetsAt")
    if not reset:
        return True
    try:
        # Accept either ISO-8601 string or epoch-ms number
        if isinstance(reset, (int, float)):
            return reset <= now_ms
        from datetime import datetime
        # 'Z' suffix
        s = reset.rstrip("Z")
        try:
            t = datetime.fromisoformat(s)
        except ValueError:
            return True
        return t.timestamp() * 1000 <= now_ms
    except Exception:
        return True

def usable(a):
    home = a.get("homeDir")
    return bool(home) and home not in exclude

candidates = [a for a in accounts if usable(a) and available(a)]
if not candidates:
    candidates = [a for a in accounts if usable(a)]
if not candidates:
    if fallback in exclude:
        sys.exit(1)
    print(fallback); sys.exit(0)

candidates.sort(key=lambda a: (
    a.get("priority", 0),
    len(a.get("activeSessions") or []),
    a.get("sessionsToday", 0),
    a.get("tokensToday", 0),
))
print(candidates[0]["homeDir"])
PY
