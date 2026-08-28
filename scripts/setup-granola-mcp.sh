#!/usr/bin/env bash
# Register the Granola MCP server in each ccuser-* account's Claude Code config
# so spawned sessions get meeting intelligence tools without per-session setup.
#
# Granola MCP is a remote HTTP server at https://mcp.granola.ai/mcp.
# Auth uses OAuth 2.0 Dynamic Client Registration — no API key or env var is
# needed in the registration command. Each account must complete a one-time
# browser OAuth flow on first use inside a session.
#
# Idempotent: re-runs converge to the same registration state by removing any
# existing granola entry before re-adding. Safe to re-run anytime.
#
# Available tools after registration:
#   - Query meeting content conversationally
#   - List accessible folders (paid plan)
#   - Browse meetings (with date/keyword filters)
#   - Search meetings (detailed)
#   - Access full transcripts (paid plan)
#
# NOTE: This is for interactive in-session use. The nightly cron ingest
# (scripts/run-granola-ingest.sh) uses the REST API directly and does NOT
# depend on this MCP registration.

set -euo pipefail

CONTAINER="${CONTAINER:-command-center}"
SERVER_NAME="granola"
MCP_URL="https://mcp.granola.ai/mcp"

# Check the container is running before attempting docker exec calls
if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "ERROR: container '$CONTAINER' is not running" >&2
  exit 1
fi

success_count=0
fail_count=0
skip_count=0

# Loop ccuser-a through ccuser-z, skipping accounts that don't exist on the host
for letter in {a..z}; do
  account="ccuser-${letter}"
  home="/home/${account}"

  # Skip if the home directory doesn't exist (account not provisioned)
  if ! docker exec "$CONTAINER" test -d "$home" 2>/dev/null; then
    skip_count=$((skip_count + 1))
    continue
  fi

  echo "==> ${account} (HOME=${home})"

  # Remove existing registration (suppress error if not present)
  docker exec -u ccuser -e "HOME=${home}" "$CONTAINER" \
    claude mcp remove "$SERVER_NAME" --scope user >/dev/null 2>&1 || true

  # Register Granola MCP as an HTTP (remote) transport
  if docker exec -u ccuser -e "HOME=${home}" "$CONTAINER" \
    claude mcp add "$SERVER_NAME" \
      --transport http \
      --scope user \
      "$MCP_URL" 2>&1; then
    echo "    OK — registered (url=${MCP_URL})"
    success_count=$((success_count + 1))
  else
    echo "    FAIL — see error above" >&2
    fail_count=$((fail_count + 1))
  fi
done

echo
echo "Done. Registered: ${success_count}  Failed: ${fail_count}  Skipped (no home): ${skip_count}"
echo
echo "First use per account requires a one-time OAuth browser flow inside the session."
echo "Run 'claude mcp list' inside a session to confirm 'granola' appears."
