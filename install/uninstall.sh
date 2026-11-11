#!/usr/bin/env bash
# install/uninstall.sh — remove an Operation Kit install (e.g. to re-run a demo).
#
#   sudo bash install/uninstall.sh --config client.conf --yes [options]
#
# Removes: the app + connector containers, every session sandbox container,
# the nightly backup job, the built images, the Cloudflare tunnel / DNS record / Access app / verify
# token that install.sh created, and INSTALL_DIR (data, secrets, everything).
# Leaves alone: Docker, firewall, security updates, SSH settings (host prep is
# harmless and makes the next install faster), other DNS records, the Cloudflare
# login method and Zero Trust team.
#
# Options:
#   --yes               required: confirms you mean it (all client data is deleted)
#   --keep-data         keep INSTALL_DIR (secrets + database) — a "restart clean"
#   --keep-cloudflare   keep tunnel/DNS/Access, so a re-install skips that step
#   --keep-images       keep the built images (re-install is ~5 min faster)
#   --dry-run           show what would be removed
set -euo pipefail
# shellcheck source=install/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
CONFIG=; YES=0; KEEP_DATA=0; KEEP_CF=0; KEEP_IMAGES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --config) shift; CONFIG=${1:-} ;;
    --yes) YES=1 ;;
    --keep-data) KEEP_DATA=1 ;;
    --keep-cloudflare) KEEP_CF=1 ;;
    --keep-images) KEEP_IMAGES=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done
[ -n "$CONFIG" ] || die "--config <file> is required"
conf_load "$CONFIG"; conf_validate; ok_paths
require_root
[ "$YES" -eq 1 ] || [ "$DRY_RUN" -eq 1 ] || die "this deletes the install for $(site_label). Re-run with --yes to confirm."
export DRY_RUN

step "Session sandboxes"
ids=$(docker ps -aq --filter 'name=^ok-jail-' 2>/dev/null || true)
if [ -n "$ids" ]; then run docker rm -f $ids >/dev/null; log "removed $(wc -w <<<"$ids") sandbox container(s)"; else log "none"; fi

step "App + connector"
if [ -f "$OK_SETTINGS_ENV" ] && [ -f "$OK_SECRETS_ENV" ]; then
  if [ "$DRY_RUN" -eq 1 ]; then log "  [dry-run] docker compose down --remove-orphans"
  else COMPOSE_PROFILES=tunnel dc down --remove-orphans; fi
else
  run docker rm -f command-center >/dev/null 2>&1 || true
  run docker compose --project-name operationkit down --remove-orphans >/dev/null 2>&1 || true
fi

if [ "$KEEP_CF" -eq 0 ]; then
  if [ -s "$OK_SECRETS/cloudflare-api-token" ]; then
    cf_args=(down --config "$CONFIG"); [ "$DRY_RUN" -eq 1 ] && cf_args+=(--dry-run)
    bash "$OK_LIB_DIR/cloudflare.sh" "${cf_args[@]}"
  else
    warn "no Cloudflare token on this server — tunnel/DNS/Access (if any) left in place"
  fi
fi

if [ "$KEEP_IMAGES" -eq 0 ]; then
  step "Images"
  for img in operationkit-app:local ok-jail:local; do
    if docker image inspect "$img" >/dev/null 2>&1; then run docker rmi -f "$img" >/dev/null; log "removed $img"; fi
  done
fi

step "Nightly backup job"
if [ -f /etc/cron.d/operationkit-backup ]; then run rm -f /etc/cron.d/operationkit-backup; log "removed (re-install adds it back)"; else log "none"; fi

if [ "$KEEP_DATA" -eq 0 ]; then
  step "Install folder $OK_DIR"
  case "$OK_DIR" in /|/opt|/home|/root|/usr|/var|/etc) die "refusing to delete $OK_DIR" ;; esac
  if [ -d "$OK_DIR" ]; then run rm -rf --one-file-system "$OK_DIR"; log "deleted"; else log "not present"; fi
fi
log "Uninstall complete. Re-install: sudo ./install.sh --config $CONFIG"
