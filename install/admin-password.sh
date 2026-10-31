#!/usr/bin/env bash
# install/admin-password.sh — issue a NEW one-time setup password for the admin.
#
#   sudo bash install/admin-password.sh --config client.conf [--username NAME]
#
# Use when the first setup password expired (72 h) or was lost. The admin must
# choose a new password at the next sign-in. The new value is written to
# secrets/first-admin-setup-password (mode 600) and never printed; read it in
# your own terminal:  ssh -t <server> sudo cat <INSTALL_DIR>/secrets/first-admin-setup-password
set -euo pipefail
# shellcheck source=install/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
CONFIG=; USERNAME=
while [ $# -gt 0 ]; do
  case "$1" in
    --config) shift; CONFIG=${1:-} ;;
    --username) shift; USERNAME=${1:-} ;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done
[ -n "$CONFIG" ] || die "--config <file> is required"
conf_load "$CONFIG"; conf_validate; ok_paths
require_root
USERNAME=${USERNAME:-$(conf ADMIN_USERNAME admin)}
(umask 077; openssl rand -base64 18 | tr -d '/+=' | cut -c1-20 > "$OK_ADMIN_SETUP_FILE")
jq -nc --arg slug "$(conf CLIENT_SLUG)" --arg name "$(conf CLIENT_NAME)" --arg user "$USERNAME" \
    --rawfile pw "$OK_ADMIN_SETUP_FILE" \
    '{client_slug:$slug, client_name:$name, admin_username:$user, setup_password:($pw|rtrimstr("\n")), setup_hours:72, reset:true}' \
  | docker exec -i command-center tsx server/src/scripts/install-bootstrap.ts
log "New one-time setup password for '$USERNAME' is in $OK_ADMIN_SETUP_FILE (valid 72 hours)."
