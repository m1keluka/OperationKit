#!/usr/bin/env bash
# Ensure the Playwright MCP server is NOT registered globally (user scope) in any
# ccuser-* account's Claude Code config.
#
# WHY (reversal of the old "register globally" behavior — 2026-06-22):
#   A global user-scope registration loaded Playwright — and spawned a headless
#   Chromium — in EVERY spawned session, including plain worker sessions that
#   never touch a browser. On a busy box that meant dozens of idle Chrome +
#   playwright-mcp node processes competing for CPU/RAM, which starved the web
#   server and ultimately wedged the host.
#
#   Browser testing belongs to REVIEWER / design-arena sessions, which already
#   register Playwright per-session via an explicit `--mcp-config`
#   (writeReviewerPlaywrightMcpConfig in session-manager.ts). So the global
#   registration is pure overhead — this script removes it everywhere.
#
# Idempotent: removes the registration where present, no-op otherwise. Safe to
# re-run after image rebuilds (which may reset host ~/.ccuser-*/.claude.json).
set -euo pipefail

CONTAINER="${CONTAINER:-command-center}"
SERVER_NAME="playwright"

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "ERROR: container '$CONTAINER' is not running" >&2
  exit 1
fi

# Discover account homes dynamically (covers a-g and any future slots). Skip the
# codex home (no Claude MCP config) and any home without a config file.
homes=$(docker exec "$CONTAINER" sh -lc 'ls -d /home/ccuser-* 2>/dev/null || true')
for home in $homes; do
  account="$(basename "$home")"
  [ "$account" = "ccuser-codex" ] && continue
  docker exec "$CONTAINER" sh -lc "[ -f '${home}/.claude.json' ]" || continue

  if docker exec -u ccuser -e "HOME=${home}" "$CONTAINER" \
       claude mcp remove "$SERVER_NAME" --scope user >/dev/null 2>&1; then
    echo "==> ${account}: removed stale global '${SERVER_NAME}' registration"
  else
    echo "==> ${account}: no global '${SERVER_NAME}' registration (ok)"
  fi
done

echo
echo "Done. Worker sessions no longer spawn Playwright/Chrome at startup."
echo "Reviewer + design-arena sessions still get browser tools per-session via"
echo "their explicit --mcp-config (writeReviewerPlaywrightMcpConfig)."
