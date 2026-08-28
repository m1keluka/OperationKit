#!/usr/bin/env bash
# Live-checkout drift check (obj-1150) — standalone, no server dependency.
#
# Detects when the live (bind-mounted, served) Command Center checkout is
# "unbacked production":
#   (a) DIRTY in a SERVED path (app/server/src, app/client/src, app/shared,
#       app/client/dist), or
#   (b) HEAD != origin/main (ahead OR behind).
# Harmless untracked files OUTSIDE served paths (e.g. scripts/*.mjs scratch
# files) are IGNORED and do not trip the check.
#
# Exit codes: 0 = clean, 1 = DRIFT detected, 2 = git could not be queried.
# Mirrors services/drift-guard.ts analyzeDrift(); the server runs the same logic
# every 60s and alerts. Use this from cron/ops or when the server is down.
#
# Usage: bash scripts/drift-check.sh [repo_dir]
set -u

REPO_DIR="${1:-/home/operator/projects/command-center-infra}"
SERVED_PATHS=(app/server/src app/client/src app/shared app/client/dist)

if ! git -C "$REPO_DIR" rev-parse --git-dir >/dev/null 2>&1; then
  echo "[drift-check] ERROR: $REPO_DIR is not a git checkout — inconclusive."
  exit 2
fi

git -C "$REPO_DIR" fetch origin main --quiet 2>/dev/null \
  || echo "[drift-check] WARN: git fetch failed — comparing against possibly-stale origin/main"

DRIFT=0

# (a) Dirty served paths
DIRTY=""
for p in "${SERVED_PATHS[@]}"; do
  hits=$(git -C "$REPO_DIR" status --porcelain -- "$p" 2>/dev/null || true)
  [[ -n "$hits" ]] && DIRTY+="$hits"$'\n'
done
if [[ -n "$DIRTY" ]]; then
  echo "[drift-check] DRIFT: uncommitted changes in SERVED paths (live-but-unbacked):"
  echo "$DIRTY" | sed '/^$/d; s/^/    /'
  DRIFT=1
fi

# (b) Ahead/behind origin/main — "<behind>\t<ahead>"
COUNTS=$(git -C "$REPO_DIR" rev-list --left-right --count origin/main...HEAD 2>/dev/null || echo "0	0")
BEHIND=$(echo "$COUNTS" | awk '{print $1}')
AHEAD=$(echo "$COUNTS" | awk '{print $2}')
if [[ "${AHEAD:-0}" -gt 0 ]]; then
  echo "[drift-check] DRIFT: HEAD is $AHEAD commit(s) AHEAD of origin/main (unpushed — would be lost on reset)."
  DRIFT=1
fi
if [[ "${BEHIND:-0}" -gt 0 ]]; then
  echo "[drift-check] DRIFT: HEAD is $BEHIND commit(s) BEHIND origin/main (serving stale code)."
  DRIFT=1
fi

if [[ "$DRIFT" -eq 1 ]]; then
  echo "[drift-check] ⚠️  UNBACKED PRODUCTION. Commit -> PR -> merge -> deploy from main."
  exit 1
fi

echo "[drift-check] OK: live checkout clean in served paths and in sync with origin/main."
exit 0
