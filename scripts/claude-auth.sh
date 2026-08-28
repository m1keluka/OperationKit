#!/usr/bin/env bash
# claude-auth.sh — authenticate a Claude Code SUBSCRIPTION (Pro/Max) into an
# OperationKit account home so agent sessions can run without an API key.
#
# See docs/CLAUDE-CODE-AUTH.md for the full model. This is a thin, idempotent
# wrapper around the real (interactive) Claude Code auth flow — it does NOT
# fabricate a non-interactive path. It runs `claude auth login --claudeai`
# (or `claude setup-token`) with HOME pointed at the chosen account directory,
# then fixes ownership so the session user can read the credentials.
#
# Usage:
#   scripts/claude-auth.sh [ACCOUNT] [--setup-token] [--home DIR]
#
#   ACCOUNT         account slot letter (a..e). Default: a
#   --setup-token   use `claude setup-token` (headless) instead of `auth login`
#   --home DIR      override the account home dir (default: /opt/operationkit/.ccuser-<ACCOUNT>)
#
# Examples:
#   scripts/claude-auth.sh a                 # interactive subscription login into account a
#   scripts/claude-auth.sh b --setup-token   # long-lived token into account b (headless)
set -euo pipefail

ACCOUNT="a"
MODE="login"
HOME_OVERRIDE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --setup-token) MODE="setup-token"; shift ;;
    --home) HOME_OVERRIDE="${2:?--home needs a directory}"; shift 2 ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    [a-z]) ACCOUNT="$1"; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

ACCOUNT_HOME="${HOME_OVERRIDE:-/opt/operationkit/.ccuser-${ACCOUNT}}"
CRED="${ACCOUNT_HOME}/.claude/.credentials.json"

if ! command -v claude >/dev/null 2>&1; then
  echo "error: 'claude' CLI not found. Install with: npm install -g @anthropic-ai/claude-code" >&2
  exit 1
fi

echo "Account home : ${ACCOUNT_HOME}"
echo "Credential   : ${CRED}"
echo "CLI          : $(claude --version 2>/dev/null || echo unknown)"

if [ -f "${CRED}" ]; then
  echo "Credentials already present. Checking status (idempotent, no re-login)…"
  HOME="${ACCOUNT_HOME}" claude auth status --text || true
  echo "Already authenticated. Delete ${CRED} and re-run to re-authenticate."
  exit 0
fi

mkdir -p "${ACCOUNT_HOME}/.claude"

if [ "${MODE}" = "setup-token" ]; then
  echo "Running: HOME=${ACCOUNT_HOME} claude setup-token"
  HOME="${ACCOUNT_HOME}" claude setup-token
else
  echo "Running: HOME=${ACCOUNT_HOME} claude auth login --claudeai"
  echo "(approve the printed URL in a browser and paste the code back)"
  HOME="${ACCOUNT_HOME}" claude auth login --claudeai
fi

# Ownership: make the credentials readable by whoever runs sessions. When run as
# root against a bind-mounted host dir, hand it to the invoking (SUDO) user.
OWNER_UID="${SUDO_UID:-$(id -u)}"
OWNER_GID="${SUDO_GID:-$(id -g)}"
chown -R "${OWNER_UID}:${OWNER_GID}" "${ACCOUNT_HOME}/.claude" 2>/dev/null || true
chmod 600 "${CRED}" 2>/dev/null || true

if [ -f "${CRED}" ]; then
  echo "✓ Account '${ACCOUNT}' authenticated — ${CRED} exists. It is now available to the router."
else
  echo "✗ ${CRED} was not created. Auth did not complete; see docs/CLAUDE-CODE-AUTH.md." >&2
  exit 1
fi
