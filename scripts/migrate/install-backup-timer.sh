#!/usr/bin/env bash
# install-backup-timer.sh — install + enable the nightly restic backup timer.
#
# Run as root on the new host:  sudo bash scripts/migrate/install-backup-timer.sh [--dry-run]
#
# Copies config/systemd/cc-backup.{service,timer} to /etc/systemd/system,
# initialises the restic repository if it does not exist yet (asks first), and
# enables the timer. If the root-only credentials are not in place yet it
# installs the units but leaves the timer disabled and says what is missing
# (runbook §I.2). Idempotent; never prints credential values.
set -euo pipefail
# shellcheck source=scripts/migrate/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  sed -n '2,11p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

parse_common_args "$@"
[ ${#REST_ARGS[@]} -eq 0 ] || die "unknown argument: ${REST_ARGS[0]}"
[ "$(id -u)" -eq 0 ] || die "run as root"

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
CONF_DIR=/root/.config/cc-backup
DST=/etc/systemd/system

step "install units"
for u in cc-backup.service cc-backup.timer; do
  if [ -f "$DST/$u" ] && cmp -s "$REPO_ROOT/config/systemd/$u" "$DST/$u"; then
    log "$u unchanged"
  else
    run install -m 644 "$REPO_ROOT/config/systemd/$u" "$DST/$u"
  fi
done
run systemctl daemon-reload
run install -d -m 700 "$CONF_DIR"

missing=()
for f in "$CONF_DIR/restic.env" "$CONF_DIR/restic-password"; do
  [ -s "$f" ] || missing+=("$f")
done
if [ ${#missing[@]} -gt 0 ]; then
  warn "credentials not in place: ${missing[*]}"
  warn "units installed, timer NOT enabled. Create them (runbook §I.2), then re-run this script."
  exit 0
fi
for f in "$CONF_DIR/restic.env" "$CONF_DIR/restic-password"; do
  run chmod 600 "$f"
done

step "restic repository"
set -a
# shellcheck disable=SC1091
. "$CONF_DIR/restic.env"
set +a
export RESTIC_PASSWORD_FILE=$CONF_DIR/restic-password
if restic cat config >/dev/null 2>&1; then
  log "repository already initialised"
else
  confirm INIT-REPO "initialise a NEW restic repository at the configured bucket (one-time)"
  run restic init
fi

step "enable timer"
run systemctl enable --now cc-backup.timer
[ "$DRY_RUN" -eq 1 ] || systemctl list-timers --no-pager cc-backup.timer
log "first backup: sudo systemctl start cc-backup.service && journalctl -u cc-backup -f"
