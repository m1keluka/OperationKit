#!/usr/bin/env bash
# Setup a Claude Code account slot for the account rotation system.
#
# Usage (run from INSIDE the command-center container):
#   bash ${CC_REPO_DIR:-/home/operator/projects/operationkit}/scripts/setup-claude-account.sh <slot>
#
# Slots: a, b, c, d, e
# Each slot gets its own home directory at /home/ccuser-<slot>/
# with persistent .claude.json and .claude/ for OAuth tokens.
#
# After running, you'll get an interactive Claude session to complete OAuth login.

set -e

SLOT="${1:-}"

if [[ -z "$SLOT" || ! "$SLOT" =~ ^[abcde]$ ]]; then
  echo "Usage: $0 <slot>"
  echo "  slot: a, b, c, d, or e"
  echo ""
  echo "Account slots:"
  echo "  a - Primary account (personal)"
  echo "  b - Secondary account"
  echo "  c - Tertiary account"
  echo "  d - Quaternary account"
  echo "  e - Quinary account (Pro Max)"
  exit 1
fi

HOME_DIR="/home/ccuser-${SLOT}"
echo "=== Setting up Claude Code account slot: ${SLOT} ==="
echo "Home directory: ${HOME_DIR}"

# Create home directory structure
mkdir -p "${HOME_DIR}/.claude"

# Create or ensure ccuser exists
id ccuser &>/dev/null || useradd -m -s /bin/bash ccuser

# Set ownership
chown -R ccuser:ccuser "${HOME_DIR}"

# Check if already authenticated
if [[ -f "${HOME_DIR}/.claude.json" ]]; then
  echo ""
  echo "Account slot ${SLOT} already has credentials at ${HOME_DIR}/.claude.json"
  echo "To re-authenticate, delete the file first:"
  echo "  rm ${HOME_DIR}/.claude.json"
  echo ""
  read -p "Re-authenticate anyway? (y/N) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Keeping existing credentials."
    exit 0
  fi
fi

echo ""
echo "Starting interactive Claude session for OAuth login..."
echo "Complete the login flow in your browser, then exit Claude (Ctrl+C or /exit)."
echo ""

# Launch Claude interactively as ccuser with the slot's HOME
su -s /bin/bash ccuser -c "HOME=${HOME_DIR} claude"

# Verify auth succeeded
if [[ -f "${HOME_DIR}/.claude.json" ]]; then
  echo ""
  echo "=== Success! ==="
  echo "Account slot ${SLOT} is authenticated."
  echo "Credentials stored at: ${HOME_DIR}/.claude.json"
  echo "Config directory: ${HOME_DIR}/.claude/"
  echo ""
  echo "This account will be available for the rotation system on next server start."
else
  echo ""
  echo "=== Warning ==="
  echo "No .claude.json found after login attempt."
  echo "The OAuth login may not have completed. Try again."
  exit 1
fi
