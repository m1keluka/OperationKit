#!/usr/bin/env bash
# Seat-management E2E (obj 720330): boots a throwaway Command Center (scratch
# guard on, temp DB / seat homes / secrets key), a stub Claude token endpoint and
# a fake `claude` probe, then runs the Playwright spec against it.
#
#   bash tests/e2e/seat-management/run.sh [playwright args, e.g. --project=dark]
#
# Needs app/client/dist built, and @playwright/test + Chromium on this machine
# (not a repo dependency, by design: this is not part of CI). PW_NODE_PATH may
# point at a node_modules dir that has @playwright/test.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
PORT="${E2E_PORT:-3912}"
STUB_PORT="${STUB_PORT:-4555}"
WORK="$(mktemp -d)"
export E2E_BASE_URL="http://127.0.0.1:$PORT" E2E_STUB_URL="http://127.0.0.1:$STUB_PORT"
export E2E_ADMIN_USER=e2e-admin E2E_ADMIN_PASS="e2e-$(date +%s)-pass"

for p in "$PORT" "$STUB_PORT"; do
  if curl -s -o /dev/null "http://127.0.0.1:$p/" 2>/dev/null; then echo "port $p is already in use — stop that process first"; exit 1; fi
done

# Our own children only: the server runs in its own process group (setsid), so
# cleanup stops tsx AND its node child without touching any other server.
SRV=; STUB=
cleanup() {
  [ -n "$SRV" ] && kill -- "-$SRV" 2>/dev/null || true
  [ -n "$STUB" ] && kill "$STUB" 2>/dev/null || true
}
trap cleanup EXIT

STUB_PORT=$STUB_PORT node "$HERE/stub-claude-token.mjs" > "$WORK/stub.log" 2>&1 &
STUB=$!

export CC_SCRATCH_SERVER=1 PORT DB_PATH="$WORK/cc.db" JWT_SECRET=scratch-only-e2e
export SECRETS_KEK_PROVIDER=env SECRETS_MASTER_KEY="$(head -c 32 /dev/urandom | base64)"
export CC_ACCOUNT_ROUTER_STATE_FILE="$WORK/account-router-state.json" CC_RATE_LIMIT_LOG="$WORK/rate-limit.jsonl"
export CC_SEAT_HOME_ROOT="$WORK/seats" CC_LEGACY_CODEX_HOME="$WORK/no-codex" GROK_HOME_DIR="$WORK/no-grok"
export CC_CLAUDE_OAUTH_TOKEN_URL="$E2E_STUB_URL/v1/oauth/token"
SERVER_PATH="$HERE/fake-bin:$PATH"
setsid env PATH="$SERVER_PATH" bash -c 'cd "$0/app/server" && exec npx tsx src/index.ts' "$REPO" > "$WORK/server.log" 2>&1 &
SRV=$!
unset SECRETS_MASTER_KEY JWT_SECRET

for _ in $(seq 1 120); do curl -sf "$E2E_BASE_URL/api/health" >/dev/null 2>&1 && break; sleep 1; done
if ! grep -q 'SCRATCH instance' "$WORK/server.log"; then
  echo "scratch guard line missing — refusing to run"; tail -30 "$WORK/server.log"; exit 1
fi
node "$HERE/seed-admin.mjs" "$WORK/cc.db" "$E2E_ADMIN_USER" "$E2E_ADMIN_PASS"
PW=$(command -v playwright || echo "npx playwright")
NODE_PATH="${PW_NODE_PATH:-}" $PW test -c "$HERE/playwright.config.ts" "$@"
