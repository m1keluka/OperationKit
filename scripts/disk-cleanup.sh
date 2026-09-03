#!/usr/bin/env bash
# Disk hygiene for the command-center VPS.
#
# Safe by design: regenerable caches, unused docker images / build cache,
# rotated journals, idle pushed worktrees. NEVER deletes:
#   - live session transcripts (/home/operator/transcripts)
#   - Claude/Codex account homes
#   - unpushed or dirty worktrees
#   - images used by a running or stopped container
#   - obj-snapshots (objectives safety net)
#
# Tiers from `df -Pk /`:
#   <80%   light      — journal + docker builder prune
#   80–89% normal     — + unused images, npm caches, idle worktrees
#   >=90%  aggressive — + pip/uv/huggingface/playwright-mcp, DB backups >7d
#
# Cron: every 6 hours (scripts/install-disk-cleanup-cron.sh).
# CC disk-watchdog also invokes this when used% >= 90 or free < 2 GiB.
set -uo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin

LOG=/home/operator/disk-cleanup.log
PROJECTS=/home/operator/projects
WORKTREE_MIN_AGE_DAYS=3
BACKUP_DIR=/home/operator/data/command-center/backups

if [ "$(id -u)" -eq 0 ]; then SUDO=""; else SUDO="sudo"; fi

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" | tee -a "$LOG"; }
used_bytes() { df -B1 / | awk 'NR==2{print $3}'; }

pct=$(df -Pk / | awk 'NR==2{gsub("%","",$5); print $5}')
pct=${pct:-0}
if [ "$pct" -ge 90 ]; then TIER=aggressive
elif [ "$pct" -ge 80 ]; then TIER=normal
else TIER=light
fi

log "=== disk-cleanup start tier=$TIER used=${pct}% reason=${DISK_CLEANUP_REASON:-cron} ==="
BEFORE=$(used_bytes)
df -h / | awk 'NR==2{print "  before: "$3" used, "$4" free ("$5")"}' | tee -a "$LOG"

# 1) journals — always. Cap at 200M / 14 days.
$SUDO journalctl --vacuum-size=200M >/dev/null 2>&1 || true
$SUDO journalctl --vacuum-time=14d  >/dev/null 2>&1 || true
log "journal vacuumed"

# 2) Docker build cache — the 2026-08-25 fill was mostly this (11G+ in a few days).
$SUDO docker builder prune -af >/dev/null 2>&1 && log "docker builder prune done" || log "docker builder prune skipped"

if [ "$TIER" != "light" ]; then
  $SUDO docker image prune -af >/dev/null 2>&1 && log "docker image prune done" || true
  $SUDO docker volume prune -f >/dev/null 2>&1 && log "docker volume prune done" || true
fi

# 3) Regenerable package caches. EXCLUDES yarn-berry / pnpm-store (can be
#    hardlink-linked into live node_modules) and ms-playwright browsers
#    (sessions need them until the next image rebuild).
cache_homes=(/home/operator /home/operator/.ccuser-* /home/operator/data/command-center/cc-accounts/*)
for h in "${cache_homes[@]}"; do
  [ -d "$h" ] || continue
  $SUDO rm -rf "$h"/.npm/_cacache "$h"/.npm/_npx "$h"/.cache/uv 2>/dev/null || true
done
log "package caches cleared (npm _cacache/_npx, uv)"

if [ "$TIER" = "aggressive" ]; then
  for h in "${cache_homes[@]}"; do
    [ -d "$h" ] || continue
    $SUDO rm -rf \
      "$h"/.cache/pip \
      "$h"/.cache/huggingface \
      "$h"/.cache/playwright-mcp \
      "$h"/.cache/puppeteer \
      "$h"/.cache/claude-cli-nodejs \
      2>/dev/null || true
  done
  log "aggressive caches cleared (pip, huggingface, playwright-mcp, puppeteer)"
  if [ -d "$BACKUP_DIR" ]; then
    find "$BACKUP_DIR" -name 'command-center-*.db' -mtime +7 -delete 2>/dev/null || true
    log "sqlite backups older than 7d pruned"
  fi
fi

# 4) Idle git worktrees that are fully reproducible from origin.
if [ -d "$PROJECTS" ]; then
  cd "$PROJECTS" || true
  for d in $(ls -d .cc-worktree-* *-wt-* 2>/dev/null | sort -u); do
    [ -e "$d/.git" ] || continue
    age_days=$(( ( $(date +%s) - $(stat -c %Y "$d") ) / 86400 ))
    if [ "$age_days" -lt "$WORKTREE_MIN_AGE_DAYS" ]; then log "keep $d (idle ${age_days}d < ${WORKTREE_MIN_AGE_DAYS}d)"; continue; fi
    if ! git -C "$d" rev-parse --abbrev-ref --symbolic-full-name @{u} >/dev/null 2>&1; then
      log "keep $d (no upstream — cannot prove pushed)"; continue
    fi
    dirty=$(git -C "$d" status --porcelain 2>/dev/null | wc -l)
    unpushed=$(git -C "$d" log --oneline @{u}.. 2>/dev/null | wc -l)
    if [ "$dirty" -eq 0 ] && [ "$unpushed" -eq 0 ]; then
      main=$(dirname "$(git -C "$d" rev-parse --git-common-dir 2>/dev/null)")
      if git -C "$main" worktree remove "$PROJECTS/$d" 2>/dev/null; then
        log "reaped worktree $d (clean, pushed, idle ${age_days}d)"
      else
        log "keep $d (worktree remove refused)"
      fi
    else
      log "keep $d (dirty=$dirty unpushed=$unpushed)"
    fi
  done
fi

AFTER=$(used_bytes)
FREED=$(( (BEFORE - AFTER) / 1024 / 1024 ))
df -h / | awk 'NR==2{print "  after:  "$3" used, "$4" free ("$5")"}' | tee -a "$LOG"
log "=== disk-cleanup done; freed ${FREED} MiB (tier=$TIER) ==="
