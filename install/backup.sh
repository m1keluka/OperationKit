#!/usr/bin/env bash
# install/backup.sh — back up an Operation Kit install, and put a backup back.
#
#   sudo bash install/backup.sh run          --config client.conf [--label nightly|pre-update|manual] [--no-offsite]
#   sudo bash install/backup.sh list         --config client.conf
#   sudo bash install/backup.sh fetch        --config client.conf [--snapshot latest|<id>]
#   sudo bash install/backup.sh restore DIR  --config client.conf --yes
#   sudo bash install/backup.sh install-cron --config client.conf
#   (every action takes --dry-run)
#
# `run` writes one folder, INSTALL_DIR/backups/<label>-<UTC time>/ (mode 700):
#   command-center.db  the database, copied with SQLite's online backup while the
#                      app runs, then checked with PRAGMA integrity_check
#   data.tar.gz        the rest of state/data: Claude/Codex seat logins
#                      (cc-accounts), uploads, branding
#   home.tar.gz        state/home: projects, notes, agent memory (not for
#                      --label pre-update, which only needs what an update can break)
#   secrets.tar.gz     secrets/ (stack.env holds the key that decrypts the
#                      secrets stored in the database — a restore needs both)
#   client.conf, install.env, MANIFEST (commit, image, sizes, sha256)
# Only the newest BACKUP_KEEP_LOCAL (default 7) nightly folders are kept, and 5
# pre-update ones. When BACKUP_TARGET is set, a nightly folder is also sent OFF
# the server with restic (encrypted with OK_BACKUP_PASSWORD from stack.env)
# to any S3-compatible bucket (Backblaze B2, AWS S3, Wasabi…), keeping 14 daily,
# 8 weekly and 12 monthly copies.
#
# `fetch` downloads an off-server backup into INSTALL_DIR/backups/restored-…/ and
# prints the folder; `restore DIR` stops the app, puts that folder's database,
# data, home and secrets back (the current ones are first moved aside to
# INSTALL_DIR/backups/pre-restore-<time>/), and starts the app again.
# INSTALL.md "Backups and restore" walks through recovering onto a new server.
set -euo pipefail
# shellcheck source=install/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

ACTION=${1:-}; shift || true
RESTORE_DIR=
if [ "$ACTION" = restore ]; then RESTORE_DIR=${1:-}; shift || true; fi
CONFIG=; LABEL=manual; OFFSITE=1; YES=0; SNAPSHOT=latest
while [ $# -gt 0 ]; do
  case "$1" in
    --config) shift; CONFIG=${1:-} ;;
    --label) shift; LABEL=${1:-} ;;
    --no-offsite) OFFSITE=0 ;;
    --snapshot) shift; SNAPSHOT=${1:-latest} ;;
    --yes) YES=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,33p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
  shift
done
case "$ACTION" in run|list|fetch|restore|install-cron) ;; *) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;; esac
[ -n "$CONFIG" ] || die "--config <file> is required"
[ -f "$CONFIG" ] || die "config file not found: $CONFIG"
CONFIG=$(cd "$(dirname "$CONFIG")" && pwd)/$(basename "$CONFIG")
[[ "$LABEL" =~ ^[a-z][a-z-]{1,20}$ ]] || die "--label must be lowercase letters and dashes"
export DRY_RUN
conf_load "$CONFIG"; conf_validate; ok_paths
require_root

BACKUPS=$OK_DIR/backups
DB=$OK_STATE/data/command-center.db
TARGET=$(conf BACKUP_TARGET)

# ── restic (off-server copies) ────────────────────────────────────────────────
# The repository password and bucket keys go through the environment and a
# mode-600 file, never argv, and are never printed.
RESTIC_PW_FILE=
restic_env() {
  [ -n "$TARGET" ] || die "BACKUP_TARGET is empty in $CONFIG — there is no off-server backup to talk to"
  command -v restic >/dev/null 2>&1 || die "restic is not installed (sudo apt-get install restic), needed for BACKUP_TARGET"
  local pw kid key
  pw=$(env_get "$OK_SECRETS_ENV" OK_BACKUP_PASSWORD)
  [ -n "$pw" ] || die "OK_BACKUP_PASSWORD is missing from $OK_SECRETS_ENV — re-run install.sh (it generates one), or hand the saved one over as BACKUP_PASSWORD"
  kid=$(env_get "$OK_SECRETS_ENV" OK_BACKUP_ACCESS_KEY_ID); key=$(env_get "$OK_SECRETS_ENV" OK_BACKUP_SECRET_ACCESS_KEY)
  [ -n "$kid" ] && [ -n "$key" ] || die "BACKUP_TARGET is set but the bucket keys are not: hand over BACKUP_ACCESS_KEY_ID and BACKUP_SECRET_ACCESS_KEY (INSTALL.md, Backups)"
  RESTIC_PW_FILE=$(mktemp); chmod 600 "$RESTIC_PW_FILE"
  trap 'rm -f "$RESTIC_PW_FILE"' EXIT
  printf '%s\n' "$pw" > "$RESTIC_PW_FILE"
  export RESTIC_REPOSITORY=$TARGET RESTIC_PASSWORD_FILE=$RESTIC_PW_FILE
  case "$TARGET" in
    b2:*) export B2_ACCOUNT_ID=$kid B2_ACCOUNT_KEY=$key ;;
    *)    export AWS_ACCESS_KEY_ID=$kid AWS_SECRET_ACCESS_KEY=$key ;;
  esac
  unset pw key
}

# ── run ───────────────────────────────────────────────────────────────────────
snapshot_db() { # DEST — consistent copy of the live database, integrity-checked
  local dest=$1 out script=server/src/scripts/db-backup.ts
  if [ "$(docker inspect -f '{{.State.Running}}' command-center 2>/dev/null)" = true ]; then
    # An image built before this script existed (the first update.sh run) does
    # not have it: copy it in from this checkout.
    docker exec command-center test -f "/app/$script" \
      || docker cp "$OK_REPO_DIR/app/$script" "command-center:/app/$script" >/dev/null
    out=$(docker exec command-center tsx "$script" /app/data/.backup-tmp/command-center.db 2>&1) \
      || die "database backup failed: $out"
    mv "$OK_STATE/data/.backup-tmp/command-center.db" "$dest"
    rmdir "$OK_STATE/data/.backup-tmp" 2>/dev/null || true
    log "  database: $(jq -r '"\(.bytes) bytes, integrity \(.integrity)"' <<<"$out" 2>/dev/null || echo ok)"
  elif command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$DB" ".backup '$dest'"
    [ "$(sqlite3 "$dest" 'PRAGMA integrity_check')" = ok ] || die "the database copy failed its integrity check"
    log "  database: copied with sqlite3 (app not running), integrity ok"
  else
    # App stopped: the files are at rest, so a plain copy (with the WAL) is consistent.
    cp -p "$DB" "$dest"; for x in -wal -shm; do [ -f "$DB$x" ] && cp -p "$DB$x" "$dest$x"; done
    log "  database: copied as files (app not running; no integrity check without sqlite3)"
  fi
}

tar_dir() { # SRC_DIR OUT.tar.gz [tar options…] — a live folder: files changing
  local src=$1 out=$2 rc=0; shift 2  # mid-read (exit 1) are fine, real errors (2) are not
  tar -C "$src" --warning=no-file-changed --warning=no-file-removed "$@" -czf "$out" . || rc=$?
  [ "$rc" -le 1 ] || die "could not archive $src (tar exit $rc)"
}

prune_local() { # LABEL KEEP
  local label=$1 keep=$2
  # Folder names sort by time (UTC stamp), newest last.
  find "$BACKUPS" -mindepth 1 -maxdepth 1 -type d -name "$label-*" | sort | head -n "-$keep" | while read -r old; do
    rm -rf --one-file-system "$old"; log "  removed old backup $(basename "$old")"
  done
}

do_run() {
  local ts dir commit image
  ts=$(date -u +%Y%m%dT%H%M%SZ)
  dir=$BACKUPS/$LABEL-$ts
  step "Backup $LABEL → $dir"
  if [ ! -f "$DB" ]; then
    [ "$DRY_RUN" -eq 1 ] || die "no database at $DB — is Operation Kit installed under $OK_DIR?"
    warn "no database at $DB yet (fine for a dry run)"
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    log "  [dry-run] would write database, data$([ "$LABEL" = pre-update ] || echo ', home'), secrets and config into $dir"
    [ -z "$TARGET" ] || [ "$OFFSITE" -eq 0 ] || [ "$LABEL" != nightly ] || log "  [dry-run] would send it to $TARGET with restic"
    return 0
  fi
  install -d -m 700 "$BACKUPS"; install -d -m 700 "$dir"
  snapshot_db "$dir/command-center.db"
  tar_dir "$OK_STATE/data" "$dir/data.tar.gz" --exclude='./command-center.db' --exclude='./command-center.db-*' --exclude='./.backup-tmp'
  log "  data (seat logins, uploads, branding): $(du -h "$dir/data.tar.gz" | cut -f1)"
  if [ "$LABEL" != pre-update ]; then
    tar_dir "$OK_STATE/home" "$dir/home.tar.gz"
    log "  home (projects, notes, memory): $(du -h "$dir/home.tar.gz" | cut -f1)"
  fi
  tar_dir "$OK_SECRETS" "$dir/secrets.tar.gz"
  cp "$CONFIG" "$dir/client.conf"
  [ -f "$OK_SETTINGS_ENV" ] && cp "$OK_SETTINGS_ENV" "$dir/install.env"
  commit=$(repo_sha); image=$(docker image inspect -f '{{.Id}}' operationkit-app:local 2>/dev/null || echo none)
  { echo "label=$LABEL"; echo "created=$ts"; echo "commit=$commit"; echo "image=$image"
    (cd "$dir" && sha256sum -- *.db *.tar.gz client.conf); } > "$dir/MANIFEST"
  chmod -R go-rwx "$dir"
  log "  done: $(du -sh "$dir" | cut -f1) in $dir"

  case "$LABEL" in
    nightly) prune_local nightly "$(conf BACKUP_KEEP_LOCAL 7)" ;;
    pre-update) prune_local pre-update 5 ;;
  esac

  if [ -n "$TARGET" ] && [ "$OFFSITE" -eq 1 ] && [ "$LABEL" = nightly ]; then
    step "Off-server copy → $TARGET"
    restic_env
    restic cat config >/dev/null 2>&1 || { restic init >/dev/null; log "  new encrypted backup repository created"; }
    restic backup --quiet --host "ok-$(conf CLIENT_SLUG)" --tag operationkit --tag "$LABEL" "$dir"
    local prune=(); [ "$(date +%u)" = 7 ] && prune=(--prune)   # the slow repack only on Sundays
    restic forget --quiet --host "ok-$(conf CLIENT_SLUG)" --tag operationkit \
      --keep-daily 14 --keep-weekly 8 --keep-monthly 12 "${prune[@]+"${prune[@]}"}"
    log "  sent (restic snapshot $(restic snapshots --json --latest 1 --host "ok-$(conf CLIENT_SLUG)" | jq -r '.[-1].short_id // "?"'))"
  elif [ -z "$TARGET" ] && [ "$LABEL" = nightly ]; then
    warn "BACKUP_TARGET is empty: this backup is on the SAME server as the data. Set an off-server target (INSTALL.md, Backups)."
  fi
}

# ── restore ───────────────────────────────────────────────────────────────────
do_restore() {
  local src=$1 ts aside
  [ -n "$src" ] || die "restore needs the backup folder: install/backup.sh restore <folder> --config … --yes"
  src=$(cd "$src" 2>/dev/null && pwd) || die "no such folder: $1"
  [ -f "$src/command-center.db" ] && [ -f "$src/data.tar.gz" ] && [ -f "$src/secrets.tar.gz" ] \
    || die "$src is not a backup folder (needs command-center.db, data.tar.gz, secrets.tar.gz)"
  if [ -f "$src/MANIFEST" ] && command -v sha256sum >/dev/null; then
    (cd "$src" && grep -E '^[0-9a-f]{64}  ' MANIFEST | sha256sum -c --quiet -) || die "$src does not match its MANIFEST checksums — damaged or incomplete"
  fi
  step "Restore from $src"
  sed -n 's/^\(label\|created\|commit\)=/  \1: /p' "$src/MANIFEST" 2>/dev/null || true
  if [ "$DRY_RUN" -eq 1 ]; then log "  [dry-run] would stop the app, move the current data aside, restore, start the app"; return 0; fi
  [ "$YES" -eq 1 ] || die "this replaces the database, data, home and secrets of $(site_label). Re-run with --yes to confirm."

  ts=$(date -u +%Y%m%dT%H%M%SZ); aside=$BACKUPS/pre-restore-$ts
  install -d -m 700 "$BACKUPS" "$aside"
  log "  stopping the app"
  docker stop command-center >/dev/null 2>&1 || true
  docker ps -aq --filter 'name=^ok-jail-' | xargs -r docker rm -f >/dev/null

  log "  moving the current data aside to $aside"
  mv "$OK_STATE/data" "$aside/data"; mv "$OK_SECRETS" "$aside/secrets"
  [ -f "$src/home.tar.gz" ] && mv "$OK_STATE/home" "$aside/home"

  install -d -m 755 "$OK_STATE/data"; install -d -m 700 "$OK_SECRETS"
  tar -C "$OK_STATE/data" -xzf "$src/data.tar.gz"
  install -m 644 "$src/command-center.db" "$DB"
  tar -C "$OK_SECRETS" -xzf "$src/secrets.tar.gz"; chmod 700 "$OK_SECRETS"; chmod 600 "$OK_SECRETS"/* 2>/dev/null || true
  if [ -f "$src/home.tar.gz" ]; then install -d -m 777 "$OK_STATE/home"; tar -C "$OK_STATE/home" -xzf "$src/home.tar.gz"
  else log "  home: not in this backup (pre-update backups skip it) — kept as it was"; fi
  log "  restored database, data$([ -f "$src/home.tar.gz" ] && echo ', home'), secrets"

  log "  starting the app"
  dc up -d command-center >/dev/null
  local waited; waited=$(wait_healthy 240) || die "the app did not become healthy after the restore — docker logs --tail 100 command-center. The previous data is in $aside"
  log "  app healthy after ${waited}s. Previous data kept in $aside (delete it when you are happy)."
}

# ── fetch ─────────────────────────────────────────────────────────────────────
do_fetch() {
  restic_env
  local into found
  into=$BACKUPS/restored-$(date -u +%Y%m%dT%H%M%SZ)
  step "Downloading off-server backup '$SNAPSHOT' from $TARGET"
  if [ "$DRY_RUN" -eq 1 ]; then log "  [dry-run] would restic restore $SNAPSHOT into $into"; return 0; fi
  install -d -m 700 "$into"
  restic restore "$SNAPSHOT" --host "ok-$(conf CLIENT_SLUG)" --tag operationkit --target "$into" >/dev/null
  found=$(find "$into" -name command-center.db -printf '%h\n' | head -1)
  [ -n "$found" ] || die "the downloaded snapshot holds no backup folder"
  log "  downloaded. Put it back with:"
  log "    sudo bash $OK_LIB_DIR/backup.sh restore $found --config $CONFIG --yes"
}

# ── list ──────────────────────────────────────────────────────────────────────
do_list() {
  step "Backups on this server ($BACKUPS)"
  if [ -d "$BACKUPS" ]; then
    find "$BACKUPS" -mindepth 1 -maxdepth 1 -type d | sort | while read -r d; do printf '  %-40s %s\n' "$(basename "$d")" "$(du -sh "$d" | cut -f1)"; done
  else log "  none yet"; fi
  if [ -n "$TARGET" ]; then
    step "Off-server backups ($TARGET)"
    restic_env
    restic snapshots --host "ok-$(conf CLIENT_SLUG)" --tag operationkit --compact
  fi
}

# ── install-cron ──────────────────────────────────────────────────────────────
do_install_cron() {
  local at hh mm cron_file=/etc/cron.d/operationkit-backup line
  at=$(conf BACKUP_TIME 03:30)
  [[ "$at" =~ ^([01]?[0-9]|2[0-3]):([0-5][0-9])$ ]] || die "BACKUP_TIME must be HH:MM (got '$at')"
  hh=$((10#${BASH_REMATCH[1]})); mm=$((10#${BASH_REMATCH[2]}))
  line="$mm $hh * * * root flock -n /run/operationkit-backup.lock bash $OK_LIB_DIR/backup.sh run --label nightly --config $CONFIG >> $OK_DIR/logs/backup.log 2>&1"
  if [ "$DRY_RUN" -eq 1 ]; then log "  [dry-run] would write $cron_file: daily at $at"; return 0; fi
  command -v cron >/dev/null 2>&1 || warn "cron is not installed — the nightly backup will not run (sudo apt-get install cron)"
  install -d -m 755 "$OK_DIR/logs"
  { echo "# Operation Kit nightly backup — written by install.sh / install/backup.sh install-cron. Re-run to change."
    echo "SHELL=/bin/bash"; echo "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
    echo "$line"; } > "$cron_file.tmp"
  chmod 644 "$cron_file.tmp"; mv "$cron_file.tmp" "$cron_file"
  log "  nightly at $at ($(timedatectl show -p Timezone --value 2>/dev/null || echo 'server time')), log: $OK_DIR/logs/backup.log"
  if [ -n "$TARGET" ]; then log "  off-server: $TARGET (encrypted with restic)"
  else warn "BACKUP_TARGET is empty — backups stay on this server only. Set it for an off-server copy (INSTALL.md, Backups)."; fi
}

case "$ACTION" in
  run) do_run ;;
  restore) do_restore "$RESTORE_DIR" ;;
  fetch) do_fetch ;;
  list) do_list ;;
  install-cron) do_install_cron ;;
esac
