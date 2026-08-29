#!/usr/bin/env bash
# Tear down a preview environment for a Command Center PR
# Usage: bash preview-teardown.sh <pr_number>
set -euo pipefail

PR_NUM="${1:?Usage: preview-teardown.sh <pr_number>}"
CONTAINER_NAME="cc-preview-${PR_NUM}"
REPO_DIR="${CC_REPO_DIR:-/home/operator/projects/operationkit}"
WORKTREE_DIR="/tmp/cc-preview-${PR_NUM}"
PREVIEW_DATA_DIR="/tmp/cc-preview-${PR_NUM}-data"
CADDY_SITE="/etc/caddy/sites-enabled/pr-${PR_NUM}.caddy"

echo "[preview] Tearing down PR #${PR_NUM} preview..."

# Stop and remove container
docker rm -f "${CONTAINER_NAME}" 2>/dev/null && echo "[preview] Container removed" || echo "[preview] No container found"

# Remove docker image
docker rmi "cc-preview-${PR_NUM}" 2>/dev/null || true

# Remove git worktree
if [ -d "${WORKTREE_DIR}" ]; then
  cd "${REPO_DIR}" && git worktree remove "${WORKTREE_DIR}" --force 2>/dev/null || true
  rm -rf "${WORKTREE_DIR}"
  echo "[preview] Worktree removed"
fi

# Remove the per-PR writable database dir (prod-isolated; safe to delete)
if [ -d "${PREVIEW_DATA_DIR}" ]; then
  rm -rf "${PREVIEW_DATA_DIR}"
  echo "[preview] Preview database dir removed"
fi

# Remove Caddy config
if [ -f "${CADDY_SITE}" ]; then
  sudo rm "${CADDY_SITE}"
  sudo caddy reload --config /etc/caddy/Caddyfile 2>/dev/null || sudo systemctl reload caddy
  echo "[preview] Caddy config removed and reloaded"
fi

echo "[preview] PR #${PR_NUM} preview torn down"
