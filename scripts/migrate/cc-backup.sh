#!/usr/bin/env bash
# cc-backup.sh — nightly off-site backup of Command Center to S3-compatible
# object storage with restic (client-side encrypted, deduplicated).
#
# Runs as root from cc-backup.service (config/systemd/cc-backup.{service,timer}).
# Manual run:   sudo bash scripts/migrate/cc-backup.sh [--dry-run]
#
# What goes in one snapshot:
#   * SQLite .backup of /home/operator/data/command-center/command-center.db
#   * pg_dump -Fc of the LiteLLM Postgres (litellm-db container)
#   * the vault (/home/operator/second-brain) and ai-workspace (minus node_modules)
#   * configs + secrets needed to rebuild: compose .env, encryption key files,
#     Doppler config/token, cron.env, /etc/caddy, crontab export
#   Not included: account OAuth homes (recovery = re-login, see runbook §D.3),
#   projects/ (lives on GitHub), transcripts (regenerable logs).
#
# Credentials (root-only, never committed, never printed):
#   /root/.config/cc-backup/restic.env       RESTIC_REPOSITORY, AWS_ACCESS_KEY_ID,
#                                            AWS_SECRET_ACCESS_KEY (600)
#   /root/.config/cc-backup/restic-password  repository password (600)
#
# Retention: 14 daily, 8 weekly, 12 monthly. `forget --prune` deletes old
# snapshots, so an interactive run asks first; the systemd unit passes
# --scheduled, which is the standing approval for the nightly prune.
set -euo pipefail
# shellcheck source=scripts/migrate/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

CONF_DIR=/root/.config/cc-backup
ENV_FILE=$CONF_DIR/restic.env
STAGE=$CC_DATA/backups/nightly
KEEP=(--keep-daily 14 --keep-weekly 8 --keep-monthly 12)
SCHEDULED=0

parse_common_args "$@"
for a in "${REST_ARGS[@]+"${REST_ARGS[@]}"}"; do
  case "$a" in
    --scheduled) SCHEDULED=1 ;;
    *) die "unknown argument: $a" ;;
  esac
done
[ "$(id -u)" -eq 0 ] || die "run as root"
[ -s "$ENV_FILE" ] || die "missing $ENV_FILE (runbook §I.2)"
[ -s "$CONF_DIR/restic-password" ] || die "missing $CONF_DIR/restic-password (runbook §I.2)"
[ "$(stat -c %a "$ENV_FILE")" = 600 ] || die "$ENV_FILE must be mode 600"
[ "$(stat -c %a "$CONF_DIR/restic-password")" = 600 ] || die "$CONF_DIR/restic-password must be mode 600"

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
export RESTIC_PASSWORD_FILE=$CONF_DIR/restic-password

step "stage consistent dumps -> $STAGE"
run install -d -m 700 "$STAGE"
run sqlite3 "$CC_DB" ".backup '$STAGE/command-center.db.tmp'"
if [ "$DRY_RUN" -eq 0 ]; then
  ic=$(sqlite3 "$STAGE/command-center.db.tmp" 'PRAGMA integrity_check;')
  [ "$ic" = ok ] || die "sqlite integrity_check failed on the fresh backup: $ic"
  mv -f "$STAGE/command-center.db.tmp" "$STAGE/command-center.db"
  docker exec litellm-db pg_dump -U llmproxy -d litellm -Fc > "$STAGE/litellm.pgdump.tmp"
  [ -s "$STAGE/litellm.pgdump.tmp" ] || die "pg_dump produced an empty file"
  mv -f "$STAGE/litellm.pgdump.tmp" "$STAGE/litellm.pgdump"
  crontab -u mike -l > "$STAGE/crontab.mike.txt" 2>/dev/null || true
  chmod 600 "$STAGE"/*
else
  log "[dry-run] would pg_dump litellm-db -> $STAGE/litellm.pgdump and export mike's crontab"
fi

PATHS=("$STAGE" "$OPERATOR_HOME/second-brain" "$OPERATOR_HOME/ai-workspace" /etc/caddy)
for p in "${SECRET_FILES[@]}" "${SECRET_DIRS[@]}"; do
  [ -e "$p" ] && PATHS+=("$p")
done

step "restic backup (${#PATHS[@]} paths)"
run restic backup --one-file-system --tag nightly \
  --exclude node_modules --exclude .cache --exclude .next \
  "${PATHS[@]}"

step "retention: ${KEEP[*]}"
if [ "$SCHEDULED" -eq 0 ]; then
  confirm PRUNE "delete snapshots outside the retention policy (${KEEP[*]})"
fi
run restic forget --tag nightly "${KEEP[@]}" --prune

# Weekly integrity read of 5% of the pack data (Sunday).
if [ "$(date +%u)" = 7 ]; then
  step "weekly restic check (5% data sample)"
  run restic check --read-data-subset=5%
fi

step "done"
[ "$DRY_RUN" -eq 1 ] || restic snapshots --tag nightly --latest 1 --compact
