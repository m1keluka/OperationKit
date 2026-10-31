# shellcheck shell=bash disable=SC2034  # constants are used by the scripts that source this
# scripts/migrate/lib.sh — shared helpers for the DO -> OVH Rise-4 migration.
#
# Sourced by preflight.sh, presync.sh, cutover.sh, verify.sh, restore-test.sh
# and bootstrap-host.sh. Runbook: docs/migration/ovh-rise4.md.
#
# Execution model: every script runs ON THE NEW (OVH) HOST as user `mike`,
# PULLING from the old DigitalOcean droplet over SSH. "local" = destination,
# SRC_HOST = source. Reach the source with agent forwarding from your laptop
# (`ssh -A mike@<ovh-ip>`), so no private key has to live on either server.
#
# Contract for every script that sources this file:
#   * set -euo pipefail (set here, re-set by callers).
#   * --dry-run prints every mutating command and changes nothing. Read-only
#     probes (df, test -e, systemctl is-active) still run so the plan is real.
#   * Destructive / cutover steps go through confirm(): type-to-confirm on the
#     controlling TTY. No --yes flag exists on purpose.
#   * NEVER echo secret values. Secret files are moved with rsync/scp and
#     compared by checksum; only MATCH / MISMATCH is printed, never contents
#     or hashes. Do not add `set -x` anywhere in these scripts.
set -euo pipefail

# ── Paths (match the repo: docker-compose.yml, app/server/src/config.ts) ──
MIGRATE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
readonly MIGRATE_DIR
readonly OPERATOR_HOME=/home/operator
readonly PROJECTS_DIR=$OPERATOR_HOME/projects
readonly CC_REPO=$PROJECTS_DIR/operationkit
readonly CC_DATA=$OPERATOR_HOME/data/command-center
readonly CC_DB=$CC_DATA/command-center.db
readonly MIGRATE_STATE=$OPERATOR_HOME/.cc-migrate
readonly MIGRATE_LOG_DIR=$MIGRATE_STATE/logs

# Secret files, by path only. Contents are never read by these scripts.
# What breaks without each one is documented in docs/migration/ovh-rise4.md §C.
readonly SECRET_FILES=(
  "$CC_REPO/.env"
  "$PROJECTS_DIR/.secrets-master-key"
  "$PROJECTS_DIR/.test-cred-encryption-key"
  "$PROJECTS_DIR/.doppler-admin-token"
  "$OPERATOR_HOME/.config/command-center/cron.env"
)
readonly SECRET_DIRS=(
  "$OPERATOR_HOME/.doppler"
)
# Claude / Codex OAuth homes (account slots a-e + codex + root auth). Slots f, g
# and grok live under $CC_DATA/cc-accounts and travel with the data dir.
readonly ACCOUNT_DIRS=(
  "$OPERATOR_HOME/.ccuser-a"
  "$OPERATOR_HOME/.ccuser-b"
  "$OPERATOR_HOME/.ccuser-c"
  "$OPERATOR_HOME/.ccuser-d"
  "$OPERATOR_HOME/.ccuser-e"
  "$OPERATOR_HOME/.ccuser-codex"
  "$OPERATOR_HOME/.claude-auth"
)

DRY_RUN=0
SRC_HOST=${SRC_HOST:-}
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=30)

# ── Output ──
_ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log()  { printf '[%s] %s\n' "$(_ts)" "$*"; }
warn() { printf '[%s] WARN: %s\n' "$(_ts)" "$*" >&2; }
die()  { printf '[%s] FATAL: %s\n' "$(_ts)" "$*" >&2; exit 1; }
step() { printf '\n[%s] ━━ %s\n' "$(_ts)" "$*"; }

# Tally for check-style scripts (preflight / verify).
PASS_COUNT=0
FAIL_COUNT=0
WARN_COUNT=0
pass()  { PASS_COUNT=$((PASS_COUNT + 1)); printf '  PASS  %s\n' "$*"; }
fail()  { FAIL_COUNT=$((FAIL_COUNT + 1)); printf '  FAIL  %s\n' "$*"; }
note()  { WARN_COUNT=$((WARN_COUNT + 1)); printf '  WARN  %s\n' "$*"; }
summary() {
  printf '\n%d pass, %d warn, %d fail\n' "$PASS_COUNT" "$WARN_COUNT" "$FAIL_COUNT"
  [ "$FAIL_COUNT" -eq 0 ]
}

# ── Arg parsing ──
# Consumes the flags every script shares; leaves the rest in REST_ARGS.
REST_ARGS=()
parse_common_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) DRY_RUN=1 ;;
      --src) shift; SRC_HOST=${1:-} ;;
      --src=*) SRC_HOST=${1#--src=} ;;
      -h|--help) usage; exit 0 ;;
      *) REST_ARGS+=("$1") ;;
    esac
    shift
  done
  if [ "$DRY_RUN" -eq 1 ]; then
    log "DRY RUN — no changes will be made"
  fi
}

require_src() {
  [ -n "$SRC_HOST" ] || die "source host required: --src mike@<do-droplet-ip> (or SRC_HOST=...)"
}

require_user_mike() {
  [ "$(id -un)" = mike ] || die "run as user 'mike' on the new host (got '$(id -un)')"
}

# ── Execution ──
# run CMD...   — execute, or print it under --dry-run. Arguments are quoted with
# printf %q so the log is copy-pasteable. Never pass a secret VALUE as an arg.
run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '  [dry-run] would run:'
    printf ' %q' "$@"
    printf '\n'
    return 0
  fi
  "$@"
}

# ssh joins argv with spaces and the remote shell re-splits it, so a
# multi-word argument would be torn apart. _remote_cmd quotes each argument
# with %q when there are several; a single argument is passed through as a
# shell snippet on purpose (pipes, redirects: src 'crontab -l | wc -l').
_remote_cmd() {
  if [ $# -eq 1 ]; then printf '%s' "$1"; return; fi
  printf '%q ' "$@"
}

# src CMD...   — run a command on the source host. Read-only callers only; use
# src_run for anything that changes state there.
src() {
  require_src
  # shellcheck disable=SC2029  # client-side expansion is the point (see above)
  ssh "${SSH_OPTS[@]}" "$SRC_HOST" "$(_remote_cmd "$@")"
}

# src_run CMD... — mutating command on the source host (dry-run aware).
src_run() {
  require_src
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '  [dry-run] would run on %s: %s\n' "$SRC_HOST" "$(_remote_cmd "$@")"
    return 0
  fi
  # shellcheck disable=SC2029  # client-side expansion is the point (see above)
  ssh "${SSH_OPTS[@]}" "$SRC_HOST" "$(_remote_cmd "$@")"
}

# have_tty — a controlling terminal is actually openable ([ -r /dev/tty ] is
# true even under cron/systemd, where opening it fails).
have_tty() { { : < /dev/tty; } 2>/dev/null; }

# confirm PHRASE WHAT — type-to-confirm on the controlling TTY. Under --dry-run
# it only prints what it would ask. Aborts the script on any mismatch.
confirm() {
  local phrase=$1 what=$2 answer
  if [ "$DRY_RUN" -eq 1 ]; then
    log "[dry-run] would ask you to type '$phrase' to: $what"
    return 0
  fi
  have_tty || die "confirmation needs an interactive terminal (step: $what)"
  printf '\n  >>> %s\n  >>> Type %s to continue (anything else aborts): ' "$what" "$phrase" > /dev/tty
  IFS= read -r answer < /dev/tty || answer=
  [ "$answer" = "$phrase" ] || die "not confirmed — aborted before: $what"
  log "confirmed: $what"
}

# ── Copy helpers ──
# Ownership matters: account homes and worktrees are chowned to the container's
# ccuser, the SQLite DB to root. So both ends run rsync under sudo (mike has
# passwordless sudo on both hosts) and --numeric-ids keeps the UIDs. Local sudo
# keeps SSH_AUTH_SOCK so the forwarded agent still reaches the source, and uses
# mike's known_hosts so the source host key is pinned once.
readonly RSYNC_SSH="ssh ${SSH_OPTS[*]} -o UserKnownHostsFile=$OPERATOR_HOME/.ssh/known_hosts"
readonly RSYNC_BASE=(sudo --preserve-env=SSH_AUTH_SOCK rsync -aHAX --numeric-ids --partial
  --rsync-path="sudo -n rsync" -e "$RSYNC_SSH")

# pull SRC_PATH DST_PATH [rsync-args...] — rsync from the source host. A
# trailing slash on SRC_PATH copies contents (rsync semantics).
pull() {
  require_src
  local from=$1 to=$2
  shift 2
  run sudo mkdir -p "$to"
  run "${RSYNC_BASE[@]}" --info=stats1 "$@" "$SRC_HOST:$from" "$to"
}

# pull_secret PATH — copy one secret file, same path on both hosts, 600 perms,
# then compare checksums. Prints only the path and MATCH/MISMATCH/ABSENT.
pull_secret() {
  require_src
  local path=$1
  if ! src sudo -n test -e "$path"; then
    note "absent on source (skipped): $path"
    return 0
  fi
  run sudo mkdir -p "$(dirname "$path")"
  run "${RSYNC_BASE[@]}" --chmod=F600 "$SRC_HOST:$path" "$path"
  [ "$DRY_RUN" -eq 1 ] && return 0
  checksum_match "$path"
}

# pull_secret_dir DIR [rsync-args...] — like pull_secret for a directory
# (dirs 700, files 600). Extra args (e.g. --exclude) pass through to rsync;
# excluded destination files survive --delete.
pull_secret_dir() {
  require_src
  local dir=$1
  shift
  if ! src sudo -n test -d "$dir"; then
    note "absent on source (skipped): $dir/"
    return 0
  fi
  run sudo mkdir -p "$dir"
  run "${RSYNC_BASE[@]}" --delete --chmod=D700,F600 "$@" "$SRC_HOST:$dir/" "$dir/"
  [ "$DRY_RUN" -eq 1 ] && return 0
  checksum_match "$dir"
}

# Script that prints ONE digest for a file, or for a directory tree (sorted
# per-file sums, hashed again). Runs identically on both hosts via stdin.
_digest_script() {
  printf 'p=%q\n' "$1"
  cat <<'SH'
if [ -d "$p" ]; then
  cd "$p" && find . -type f -print0 | sort -z | xargs -0r sha256sum | sha256sum
else
  sha256sum "$p"
fi | cut -d' ' -f1
SH
}

# checksum_match PATH — compare digests across hosts. The digests stay in
# shell variables and are never printed.
checksum_match() {
  local path=$1 here there
  here=$(_digest_script "$path" | sudo bash -s 2>/dev/null || true)
  there=$(_digest_script "$path" | src sudo -n bash -s 2>/dev/null || true)
  if [ -n "$here" ] && [ "$here" = "$there" ]; then
    pass "checksum MATCH: $path"
  else
    fail "checksum MISMATCH: $path"
  fi
}

ensure_state_dir() {
  run mkdir -p "$MIGRATE_LOG_DIR"
}
