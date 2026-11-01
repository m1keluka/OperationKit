#!/usr/bin/env bash
# install/update.sh — move an Operation Kit install to newer code, safely.
#
#   sudo bash install/update.sh --config client.conf [--ref main|<branch>|<tag>|<sha>]
#        [--remote origin] [--skip-backup] [--dry-run] [-- <extra install.sh options>]
#
# In order:
#   1. backs up the database (SQLite online backup, integrity-checked), the seat
#      logins (cc-accounts), secrets/stack.env and client.conf into
#      INSTALL_DIR/backups/pre-update-<UTC time>/   (install/backup.sh)
#   2. tags the running images operationkit-app:pre-update-<time> and
#      ok-jail:pre-update-<time>, so the old version can be started again
#   3. fetches --ref (default: main) and checks it out. When the code folder
#      belongs to a normal user (e.g. cloned as `ubuntu`) git runs as that user,
#      so the folder never ends up owned by root; safe.directory is set either way
#   4. re-runs ./install.sh --config client.conf (it lives at the REPO ROOT) —
#      with --skip-cloudflare again if the install was made that way
#   5. prints the exact rollback steps (also on failure)
# Nothing in INSTALL_DIR is deleted. Re-running is safe.
set -euo pipefail
# shellcheck source=install/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

CONFIG=; REF=main; REMOTE=origin; SKIP_BACKUP=0
INSTALL_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --config) shift; CONFIG=${1:-} ;;
    --ref) shift; REF=${1:-} ;;
    --remote) shift; REMOTE=${1:-} ;;
    --skip-backup) SKIP_BACKUP=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --) shift; INSTALL_ARGS=("$@"); break ;;
    -h|--help) sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
  shift
done
[ -n "$CONFIG" ] || die "--config <file> is required"
[ -f "$CONFIG" ] || die "config file not found: $CONFIG"
CONFIG=$(cd "$(dirname "$CONFIG")" && pwd)/$(basename "$CONFIG")
[[ "$REF" =~ ^[A-Za-z0-9._/-]+$ ]] || die "--ref looks wrong: '$REF'"
export DRY_RUN
conf_load "$CONFIG"; conf_validate; ok_paths
require_root

# git as the owner of the code folder (root-owned objects in a user's clone
# would break that user's next `git pull`); safe.directory covers the rest.
REPO_OWNER=$(stat -c %U "$OK_REPO_DIR")
g() {
  if [ "$REPO_OWNER" != root ] && [ "$(id -u)" -eq 0 ] && command -v sudo >/dev/null 2>&1; then
    sudo -u "$REPO_OWNER" -H git -c safe.directory='*' -C "$OK_REPO_DIR" "$@"
  else
    git -c safe.directory='*' -C "$OK_REPO_DIR" "$@"
  fi
}

TS=$(date -u +%Y%m%dT%H%M%SZ)
OLD_SHA=$(g rev-parse HEAD)
BACKUP_DIR=$OK_DIR/backups/pre-update-$TS
GIT_AS=""; [ "$REPO_OWNER" = root ] || GIT_AS="sudo -u $REPO_OWNER "

rollback_help() {
  cat <<EOF

  To go back to the version that ran before this update ($(cut -c1-12 <<<"$OLD_SHA")):
    1. old code:      ${GIT_AS}git -c safe.directory='*' -C $OK_REPO_DIR checkout --detach $OLD_SHA
    2. old images:    sudo docker tag operationkit-app:pre-update-$TS operationkit-app:local
                      sudo docker tag ok-jail:pre-update-$TS ok-jail:local
    3. old database (only if the new version changed data you want undone —
       this replaces everything written since the update):
                      $([ -n "$BACKUP_DIR" ] && echo "sudo bash $OK_LIB_DIR/backup.sh restore $BACKUP_DIR --config $CONFIG --yes" || echo "(no pre-update backup: --skip-backup was used)")
    4. start it:      cd $OK_REPO_DIR && sudo docker compose --project-name operationkit \\
                        --env-file $OK_SETTINGS_ENV --env-file $OK_SECRETS_ENV -f install/docker-compose.yml up -d
EOF
}

step "Update $(site_label): $(cut -c1-12 <<<"$OLD_SHA") → $REF (from $REMOTE)"

# ── 1. Backup ─────────────────────────────────────────────────────────────────
if [ "$SKIP_BACKUP" -eq 1 ]; then
  BACKUP_DIR=
  warn "--skip-backup: no pre-update backup taken"
else
  b_args=(run --label pre-update --config "$CONFIG"); [ "$DRY_RUN" -eq 1 ] && b_args+=(--dry-run)
  bash "$OK_LIB_DIR/backup.sh" "${b_args[@]}"
  if [ "$DRY_RUN" -eq 0 ]; then
    # backup.sh names the folder with its own timestamp: pick the newest.
    BACKUP_DIR=$(find "$OK_DIR/backups" -mindepth 1 -maxdepth 1 -type d -name 'pre-update-*' | sort | tail -1)
  fi
fi

# ── 2. Images ─────────────────────────────────────────────────────────────────
step "Keep the current images for rollback"
for img in operationkit-app ok-jail; do
  if docker image inspect "$img:local" >/dev/null 2>&1; then
    run docker tag "$img:local" "$img:pre-update-$TS"; log "  $img:local → $img:pre-update-$TS"
    # Keep the 3 newest rollback tags of each image.
    { docker image ls "$img" --format '{{.Tag}}' | grep '^pre-update-' || true; } | sort | head -n -3 \
      | while read -r old; do run docker rmi "$img:$old" >/dev/null 2>&1 || true; done
  else
    log "  $img:local not found — nothing to keep"
  fi
done

# ── 3. Code ───────────────────────────────────────────────────────────────────
step "Fetch $REF from $REMOTE"
[ -z "$(g status --porcelain --untracked-files=no)" ] \
  || die "the code folder $OK_REPO_DIR has local edits to tracked files — commit or discard them first (git status)"
if [ "$DRY_RUN" -eq 1 ]; then
  log "  [dry-run] git fetch $REMOTE $REF && git checkout --detach FETCH_HEAD"
  NEW_SHA=$OLD_SHA
else
  g fetch --quiet --tags "$REMOTE" "$REF" || die "could not fetch '$REF' from $REMOTE ($(g remote get-url "$REMOTE" 2>/dev/null || echo 'no such remote'))"
  NEW_SHA=$(g rev-parse 'FETCH_HEAD^{commit}')
  g checkout --quiet --detach "$NEW_SHA"
  log "  now at $(cut -c1-12 <<<"$NEW_SHA")$([ "$NEW_SHA" = "$OLD_SHA" ] && echo ' (no change — re-installing anyway)')"
fi

# ── 4. Install ────────────────────────────────────────────────────────────────
step "Re-run the installer (./install.sh at the repo root)"
i_args=(--config "$CONFIG")
local_mode && i_args+=(--skip-cloudflare)
[ "$DRY_RUN" -eq 1 ] && i_args+=(--dry-run)
if ! bash "$OK_REPO_DIR/install.sh" "${i_args[@]}" "${INSTALL_ARGS[@]+"${INSTALL_ARGS[@]}"}"; then
  warn "the installer failed on the new code — the site may be down"
  rollback_help
  exit 1
fi

step "Updated: $(cut -c1-12 <<<"$OLD_SHA") → $(cut -c1-12 <<<"$NEW_SHA")"
log "  pre-update backup: ${BACKUP_DIR:-none (--skip-backup)}"
rollback_help
