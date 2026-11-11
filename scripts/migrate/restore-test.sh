#!/usr/bin/env bash
# restore-test.sh — prove the off-site backup can actually be restored.
#
# Run as root on the new host (monthly, and once right after the first backup):
#   sudo bash scripts/migrate/restore-test.sh [--snapshot ID] [--keep] [--dry-run]
#
# Restores a snapshot (default: latest) into a fresh scratch dir under
# /var/tmp, then checks it WITHOUT touching anything live:
#   1. SQLite: PRAGMA integrity_check = ok, objectives row count > 0
#   2. LiteLLM: pg_restore into a throwaway postgres:16 container (no ports
#      published, removed afterwards), count tables in the public schema
#   3. Vault: restored second-brain file count within 5% of the live one
#   4. Configs: each secret path present in the snapshot (existence only)
# The scratch dir is removed at the end unless --keep. Nothing outside it and
# the temporary container is created or changed.
set -euo pipefail
# shellcheck source=scripts/migrate/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

SNAPSHOT=latest
KEEP=0
parse_common_args "$@"
set -- "${REST_ARGS[@]+"${REST_ARGS[@]}"}"
while [ $# -gt 0 ]; do
  case "$1" in
    --snapshot) shift; SNAPSHOT=${1:-} ;;
    --snapshot=*) SNAPSHOT=${1#--snapshot=} ;;
    --keep) KEEP=1 ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done
[ "$(id -u)" -eq 0 ] || die "run as root"
CONF_DIR=/root/.config/cc-backup
[ -s "$CONF_DIR/restic.env" ] || die "missing $CONF_DIR/restic.env"
[ -s "$CONF_DIR/restic-password" ] || die "missing $CONF_DIR/restic-password"
set -a
# shellcheck disable=SC1091
. "$CONF_DIR/restic.env"
set +a
export RESTIC_PASSWORD_FILE=$CONF_DIR/restic-password

SCRATCH=/var/tmp/cc-restore-test-$(date -u +%Y%m%dT%H%M%SZ)
PG_CTR=cc-restore-test-pg-$$
cleanup() {
  docker rm -f "$PG_CTR" >/dev/null 2>&1 || true
  if [ "$KEEP" -eq 0 ] && [ -d "$SCRATCH" ]; then rm -rf -- "$SCRATCH"; fi
}
[ "$DRY_RUN" -eq 1 ] || trap cleanup EXIT

step "restore snapshot '$SNAPSHOT' -> $SCRATCH"
run install -d -m 700 "$SCRATCH"
run restic restore "$SNAPSHOT" --target "$SCRATCH"
if [ "$DRY_RUN" -eq 1 ]; then
  log "[dry-run] would check SQLite integrity + row count, pg_restore into a throwaway postgres:16 ($PG_CTR), compare vault file counts, and check config paths"
  exit 0
fi

R=$SCRATCH$CC_DATA/backups/nightly

step "1. SQLite"
ic=$(sqlite3 "$R/command-center.db" 'PRAGMA integrity_check;' 2>&1 || true)
if [ "$ic" = ok ]; then pass "integrity_check ok"; else fail "integrity_check: $ic"; fi
n=$(sqlite3 "$R/command-center.db" 'SELECT COUNT(*) FROM objectives;' 2>/dev/null || echo 0)
if [ "${n:-0}" -gt 0 ]; then pass "objectives rows: $n"; else fail "objectives table empty/unreadable"; fi

step "2. LiteLLM pg_dump -> throwaway postgres:16"
# A random throwaway password: lives only in this shell and the temp container.
pgpw=$(openssl rand -hex 16)
docker run -d --name "$PG_CTR" -e POSTGRES_PASSWORD="$pgpw" -e POSTGRES_DB=litellm postgres:16 >/dev/null
for _ in $(seq 1 30); do docker exec "$PG_CTR" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 2; done
if docker exec -i "$PG_CTR" pg_restore -U postgres -d litellm --no-owner < "$R/litellm.pgdump" 2> "$SCRATCH/pg_restore.err"; then
  pass "pg_restore clean"
else
  note "pg_restore reported warnings ($(wc -l < "$SCRATCH/pg_restore.err") lines; role/extension notices are expected)"
fi
t=$(docker exec "$PG_CTR" psql -U postgres -d litellm -tAc "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public'")
if [ "${t:-0}" -gt 0 ]; then pass "LiteLLM tables restored: $t"; else fail "no LiteLLM tables restored"; fi

step "3. vault"
live=$(find "$OPERATOR_HOME/second-brain" -type f -not -path '*/node_modules/*' | wc -l)
got=$(find "$SCRATCH$OPERATOR_HOME/second-brain" -type f | wc -l)
log "files: live $live, restored $got (the live vault keeps growing after the snapshot)"
if [ "$got" -gt 0 ] && [ $((got * 100)) -ge $((live * 95)) ]; then pass "vault restored (>=95% of live file count)"; else fail "vault restore looks short"; fi

step "4. configs (existence only)"
for p in "${SECRET_FILES[@]}" "${SECRET_DIRS[@]}" /etc/caddy/Caddyfile; do
  if [ -e "$SCRATCH$p" ]; then pass "in snapshot: $p"; else note "not in snapshot: $p"; fi
done

[ "$KEEP" -eq 1 ] && log "kept $SCRATCH (delete it yourself when done)"
summary
