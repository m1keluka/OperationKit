#!/usr/bin/env bash
# install-preview-spool.sh — wire up the host-side PR-preview auto-deploy runner
# (obj 1452). Run ONCE on the VPS host as root (or via sudo):
#
#   sudo bash /home/operator/projects/command-center-infra/scripts/install-preview-spool.sh
#
# Idempotent: re-running re-copies the units, recreates the spool dir, and
# reloads systemd. This is the privileged step that lets the container's
# pr-created / github-webhook handlers deploy previews with no human in the loop:
# they enqueue a job into the spool; the cc-preview-spool.path unit installed
# here wakes cc-preview-spool.service (root), which runs preview-deploy.sh /
# preview-teardown.sh with the privilege the container lacks.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: run as root (sudo bash $0)" >&2
  exit 1
fi

REPO_DIR="/home/operator/projects/command-center-infra"
SYSTEMD_SRC="${REPO_DIR}/config/systemd"
SYSTEMD_DST="/etc/systemd/system"
SPOOL_DIR="${PREVIEW_SPOOL_DIR:-/home/operator/projects/.preview-spool}"

echo "[install-preview-spool] Creating spool dir ${SPOOL_DIR}"
mkdir -p "${SPOOL_DIR}/.processed" "${SPOOL_DIR}/.failed"
# The in-container Node server (root, UID 0 == host root via the bind mount)
# and host sessions both write here; 0777 keeps it writable regardless of which
# UID the writer runs as. Files themselves carry no secrets (PR number + branch).
chmod 0777 "${SPOOL_DIR}" "${SPOOL_DIR}/.processed" "${SPOOL_DIR}/.failed"

echo "[install-preview-spool] Ensuring runner is executable"
chmod +x "${REPO_DIR}/scripts/preview-spool-runner.sh"

echo "[install-preview-spool] Installing systemd units"
cp -f "${SYSTEMD_SRC}/cc-preview-spool.service" "${SYSTEMD_DST}/cc-preview-spool.service"
cp -f "${SYSTEMD_SRC}/cc-preview-spool.path" "${SYSTEMD_DST}/cc-preview-spool.path"

echo "[install-preview-spool] Reloading systemd + enabling path unit"
systemctl daemon-reload
systemctl enable --now cc-preview-spool.path

echo "[install-preview-spool] Done. Status:"
systemctl status --no-pager cc-preview-spool.path || true
echo
echo "Spool dir:   ${SPOOL_DIR}"
echo "Runner log:  /home/operator/transcripts/preview-spool.log"
echo "Manual drain: bash ${REPO_DIR}/scripts/preview-spool-runner.sh"
