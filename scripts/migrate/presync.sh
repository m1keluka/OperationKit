#!/usr/bin/env bash
# presync.sh — phase 1: copy the bulk of the data while the old host stays live.
#
# Run on the NEW host as mike (ssh -A mike@<ovh-ip>), as many times as you like
# in the days before cutover; each run only moves the delta:
#   bash scripts/migrate/presync.sh --src mike@<do-ip> [--dry-run] [--only NAME]
#
# NAME is one of: projects second-brain ai-workspace transcripts assistant
#                 data ssh gh secrets   (default: all, in that order)
#
# What is deliberately NOT copied here (cutover.sh owns it, with services down):
#   * the live SQLite DB (command-center.db, -wal, -shm) — a hot copy is torn
#   * Claude/Codex account homes — OAuth refresh tokens rotate; copying them
#     while the old host still refreshes would leave the new copy revoked
#   * the LiteLLM Postgres volume — moved as a pg_dump
# Never deletes anything on the source. Does not pass --delete on the
# destination either (cutover.sh's final delta does, after a confirmation).
set -euo pipefail
# shellcheck source=scripts/migrate/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  sed -n '2,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

parse_common_args "$@"
ONLY=
set -- "${REST_ARGS[@]+"${REST_ARGS[@]}"}"
while [ $# -gt 0 ]; do
  case "$1" in
    --only) shift; ONLY=${1:-} ;;
    --only=*) ONLY=${1#--only=} ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done
require_src
require_user_mike
[ -n "${SSH_AUTH_SOCK:-}" ] || die "no SSH agent — reconnect with 'ssh -A' so rsync can reach the source"
ensure_state_dir

# cutover.sh's final delta sets PRESYNC_DELETE=1 so source-side removals carry
# over. Presync runs never delete on the destination.
DELETE_ARGS=()
[ "${PRESYNC_DELETE:-0}" = 1 ] && DELETE_ARGS=(--delete)

want() { [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; }

# Shared rsync filters for project trees. Order matters: first match wins.
# Anything regenerable is skipped; stale card worktrees are the ENOSPC driver on
# the DO host (90-150 under example-platform alone) and are NOT carried over.
# app/client/dist is kept: compose bind-mounts it, an empty dir = blank board.
PROJECT_FILTERS=(
  # Secret files — copied by the 'secrets' step with 600 perms + checksum.
  --filter='- /.secrets-master-key'
  --filter='- /.test-cred-encryption-key'
  --filter='- /.doppler-admin-token'
  --filter='- /operationkit/.env'
  # Card / ad-hoc worktrees at the top level of projects/.
  --filter='- /*-wt-*'
  --filter='- /.cc-worktree-*'
  --filter='- /cc-wt-*'
  # Their admin dirs inside each repo (pruned by `git worktree prune` later).
  --filter='- /*/.git/worktrees/'
  # Preview spool: in-flight jobs belong to the old host.
  --filter='- /.preview-spool/'
  --filter='+ /operationkit/app/client/dist/'
  --filter='- node_modules/'
  --filter='- .next/'
  --filter='- .turbo/'
  --filter='- .vite/'
  --filter='- .cache/'
  --filter='- coverage/'
  --filter='- dist/'
  --filter='- build/'
  --filter='- out/'
  --filter='- *.tsbuildinfo'
)
CACHE_FILTERS=(
  --filter='- node_modules/'
  --filter='- .cache/'
)

# ── projects ────────────────────────────────────────────────────────────────
if want projects; then
  step "projects/ (minus worktrees, node_modules, build output, secret files)"
  pull "$PROJECTS_DIR/" "$PROJECTS_DIR/" "${DELETE_ARGS[@]+"${DELETE_ARGS[@]}"}" "${PROJECT_FILTERS[@]}"
  if [ "$DRY_RUN" -eq 0 ]; then
    # Worktree admin dirs were skipped; make each repo forget them now.
    for g in "$PROJECTS_DIR"/*/.git; do
      [ -d "$g" ] || continue
      sudo git --git-dir="$g" worktree prune 2>/dev/null || true
    done
    log "git worktree prune done for every repo under $PROJECTS_DIR"
  fi
fi

# ── vault, workspace, transcripts, assistant ────────────────────────────────
for name in second-brain ai-workspace transcripts assistant; do
  want "$name" || continue
  step "$name/"
  if src test -d "$OPERATOR_HOME/$name"; then
    pull "$OPERATOR_HOME/$name/" "$OPERATOR_HOME/$name/" --compress "${DELETE_ARGS[@]+"${DELETE_ARGS[@]}"}" "${CACHE_FILTERS[@]}"
  else
    warn "$OPERATOR_HOME/$name not on source — skipped"
  fi
done

# ── data dir, minus the live DB and the account slots ───────────────────────
if want data; then
  step "data/command-center/ (uploads etc.; NOT the live DB, NOT cc-accounts, NOT old backups)"
  pull "$CC_DATA/" "$CC_DATA/" \
    --filter='- /command-center.db' \
    --filter='- /command-center.db-wal' \
    --filter='- /command-center.db-shm' \
    --filter='- /cc-accounts/' \
    --filter='- /backups/'
fi

# ── ~/.ssh and gh config: credentials, so 600 + checksum ────────────────────
if want ssh; then
  step "$OPERATOR_HOME/.ssh (keeps this host's authorized_keys; source's is not copied)"
  pull_secret_dir "$OPERATOR_HOME/.ssh" --exclude=/authorized_keys
fi
if want gh; then
  step "$OPERATOR_HOME/.config/gh (GitHub CLI auth — mounted read-only into the container as /etc/gh)"
  pull_secret_dir "$OPERATOR_HOME/.config/gh"
fi

# ── secrets ─────────────────────────────────────────────────────────────────
if want secrets; then
  step "secrets (paths only are printed; contents never leave rsync)"
  log "files: ${SECRET_FILES[*]}"
  log "dirs:  ${SECRET_DIRS[*]}"
  confirm COPY-SECRETS "copy .env, encryption keys, Doppler token + config, cron.env to this host (600 perms)"
  for f in "${SECRET_FILES[@]}"; do pull_secret "$f"; done
  for d in "${SECRET_DIRS[@]}"; do pull_secret_dir "$d"; done
  # mike owns everything here; the container reads them as root.
  if [ "$DRY_RUN" -eq 0 ]; then
    for f in "${SECRET_FILES[@]}"; do [ -e "$f" ] && sudo chown mike:mike "$f"; done
    for d in "${SECRET_DIRS[@]}"; do [ -d "$d" ] && sudo chown -R mike:mike "$d"; done
  fi
fi

# ── reference copies of host config (for review; installed by cutover.sh) ───
if [ -z "$ONLY" ]; then
  step "host config snapshot -> $MIGRATE_STATE/src-etc/ (Caddyfile, preview sites, crontab markers)"
  run mkdir -p "$MIGRATE_STATE/src-etc"
  pull /etc/caddy/ "$MIGRATE_STATE/src-etc/caddy/"
  if [ "$DRY_RUN" -eq 0 ]; then
    src 'crontab -l 2>/dev/null' > "$MIGRATE_STATE/src-etc/crontab.mike.txt" || true
    chmod 600 "$MIGRATE_STATE/src-etc/crontab.mike.txt"
    src "systemctl list-unit-files 'cc-*' --no-legend" > "$MIGRATE_STATE/src-etc/systemd-units.txt" 2>/dev/null || true
    log "compare: diff $MIGRATE_STATE/src-etc/caddy/Caddyfile $CC_REPO/config/caddy/Caddyfile"
  fi
fi

if [ "$FAIL_COUNT" -gt 0 ]; then
  summary || true
  die "$FAIL_COUNT check(s) failed — re-run the failing step (--only NAME)"
fi
step "presync complete"
df -h / | sed 's/^/  /'
