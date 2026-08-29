#!/usr/bin/env bash
# preview-spool-runner.sh — the HOST-SIDE half of PR preview auto-deploy
# (obj 1452). Drains the preview spool and runs preview-deploy.sh /
# preview-teardown.sh with the host privilege the in-container Node server lacks
# (sudo Caddy reload, host-daemon docker build, git worktree add on the host
# checkout).
#
# RUNS AS THE OPERATOR USER, not root: preview-deploy.sh fetches the PR branch
# over the repo's SSH remote (git@github.com), whose key belongs to that user — a
# root context fails with "Could not read from remote repository". The operator
# user needs passwordless sudo for the Caddy steps and membership in the docker
# group. The cc-preview-spool.service unit sets User to the operator account; the
# in-container kick (preview-spool.ts kickHostDrain) nsenters the host then
# `su - "$OPERATOR_USER"` (default: operator).
# RUNS AS THE OPERATOR USER (`operator` by default), not root: preview-deploy.sh
# fetches the PR branch over the repo's SSH remote (git@github.com) using that
# user's key — a root context fails with "Could not read from remote
# repository". The operator user needs passwordless sudo for the Caddy steps and
# membership in the docker group. The cc-preview-spool.service unit sets
# User=<operator>; the in-container kick (preview-spool.ts kickHostDrain)
# nsenters the host then `su - <operator>`.
#
# Triggered by the cc-preview-spool.path systemd unit on every change to the
# spool dir; also safe to run from cron or by hand. Drains ALL pending jobs on
# each run, so jobs that land between path-unit triggers are never stranded.
#
# A job is a JSON file written atomically by app/server/src/services/preview-spool.ts:
#   { "action": "deploy"|"teardown", "pr_number": N, "branch_name": "...", ... }
#
# Each processed job is moved to .processed/ (success) or .failed/ (non-zero
# exit), with a per-run log, so failures are inspectable and never silently lost
# or retried in a tight loop.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SPOOL_DIR="${PREVIEW_SPOOL_DIR:-/home/operator/projects/.preview-spool}"
LOG_DIR="${PREVIEW_SPOOL_LOG_DIR:-/home/operator/transcripts}"
LOG_FILE="${LOG_DIR}/preview-spool.log"
LOCK_FILE="/tmp/cc-preview-spool.lock"

DEPLOY_SCRIPT="${SCRIPT_DIR}/preview-deploy.sh"
TEARDOWN_SCRIPT="${SCRIPT_DIR}/preview-teardown.sh"

mkdir -p "${SPOOL_DIR}/.processed" "${SPOOL_DIR}/.failed" "${LOG_DIR}"

log() { printf '%s [preview-spool-runner] %s\n' "$(date -Is)" "$*" | tee -a "${LOG_FILE}" >&2; }

# Single-flight: a path-unit trigger can fire while a prior drain is still
# building. flock makes concurrent runs wait rather than race the same job.
exec 9>"${LOCK_FILE}"
if ! flock -w 600 9; then
  log "could not acquire lock within 600s — another drain is running; exiting"
  exit 0
fi

shopt -s nullglob
jobs=( "${SPOOL_DIR}"/deploy-*.json "${SPOOL_DIR}"/teardown-*.json )
if [ ${#jobs[@]} -eq 0 ]; then
  exit 0
fi

# jq is the parser; fall back to a tolerant grep if jq is unavailable.
get_field() {
  local file="$1" field="$2"
  if command -v jq >/dev/null 2>&1; then
    jq -r --arg f "$field" '.[$f] // empty' "$file" 2>/dev/null
  else
    grep -oE "\"${field}\"[[:space:]]*:[[:space:]]*\"?[^,\"}]*\"?" "$file" 2>/dev/null \
      | head -1 | sed -E "s/.*:[[:space:]]*\"?([^,\"}]*)\"?.*/\1/"
  fi
}

for job in "${jobs[@]}"; do
  [ -f "$job" ] || continue
  action="$(get_field "$job" action)"
  pr_number="$(get_field "$job" pr_number)"
  branch_name="$(get_field "$job" branch_name)"

  if ! [[ "$pr_number" =~ ^[0-9]+$ ]]; then
    log "SKIP malformed job (bad pr_number) $job"
    mv -f "$job" "${SPOOL_DIR}/.failed/$(basename "$job").$(date +%s)" 2>/dev/null || rm -f "$job"
    continue
  fi

  rc=0
  case "$action" in
    deploy)
      if [ -z "$branch_name" ]; then
        log "SKIP deploy PR #$pr_number — missing branch_name"
        rc=1
      else
        log "DEPLOY PR #$pr_number (branch $branch_name)"
        bash "$DEPLOY_SCRIPT" "$pr_number" "$branch_name" >>"${LOG_FILE}" 2>&1
        rc=$?
      fi
      ;;
    teardown)
      log "TEARDOWN PR #$pr_number"
      bash "$TEARDOWN_SCRIPT" "$pr_number" >>"${LOG_FILE}" 2>&1
      rc=$?
      ;;
    *)
      log "SKIP unknown action '$action' in $job"
      rc=1
      ;;
  esac

  ts="$(date +%s)"
  if [ "$rc" -eq 0 ]; then
    log "OK ${action} PR #$pr_number"
    mv -f "$job" "${SPOOL_DIR}/.processed/$(basename "$job").${ts}" 2>/dev/null || rm -f "$job"
  else
    log "FAIL ${action} PR #$pr_number (exit $rc) — see ${LOG_FILE}"
    mv -f "$job" "${SPOOL_DIR}/.failed/$(basename "$job").${ts}" 2>/dev/null || rm -f "$job"
  fi
done
