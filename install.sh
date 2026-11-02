#!/usr/bin/env bash
# ==============================================================================
# Operation Kit — one-command installer for a fresh Ubuntu 24.04 server
# ------------------------------------------------------------------------------
#   sudo ./install.sh --config client.conf [options]
#
# Reads ONE client config file (see install/client.conf.example) and:
#   1. prepares the server: Docker, firewall (SSH only), automatic security
#      updates, fail2ban, swap                      (install/bootstrap-host.sh)
#   2. creates the install folder (INSTALL_DIR, default /opt/operationkit)
#   3. generates every secret ON THIS SERVER into secrets/stack.env (mode 600);
#      values are never printed
#   4. builds the app image and the per-session sandbox image
#   5. sets up Cloudflare: tunnel, DNS for DOMAIN, Access sign-in
#                                                    (install/cloudflare.sh)
#   6. starts the app and waits until it is healthy
#   7. creates the client workspace and the first admin with a ONE-TIME setup
#      password (forced change at first sign-in), linked to ADMIN_EMAIL so the
#      Cloudflare Access sign-in is the only one they need (one login)
#   8. switches on the STARTER_PACKS (a failure stops the install)
#   9. schedules the nightly backup (install/backup.sh; off the server when
#      BACKUP_TARGET is set) and runs install/verify.sh
# Re-running is safe: every step checks what is already there. To move an
# install to newer code, use install/update.sh (backs up first, then re-runs this).
#
# Options:
#   --config FILE          client config (required)
#   --secrets-file FILE    hand-over file with API tokens (KEY=value lines; see
#                          INSTALL.md). Its values are moved into secrets/ and
#                          the file is deleted.
#   --dry-run              print what would happen, change nothing
#   --skip-cloudflare      local-only install (no tunnel/DNS/Access): DOMAIN, ZONE
#                          and ACCESS_* may be empty. Reach it over an SSH tunnel
#                          (INSTALL.md, "Test install without a domain")
#   --skip-firewall        leave the firewall alone
#   --skip-ssh-hardening   leave SSH password logins as they are
#   --skip-verify          do not run install/verify.sh at the end
#   --swap-gb N            swap file size (default 4, 0 = none)
#   -h | --help
# ==============================================================================
set -euo pipefail
# shellcheck source=install/lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/install/lib.sh"

CONFIG=
SECRETS_HANDOVER=
SKIP_CF=0
SKIP_VERIFY=0
BOOT_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --config) shift; CONFIG=${1:-} ;;
    --secrets-file) shift; SECRETS_HANDOVER=${1:-} ;;
    --dry-run) DRY_RUN=1; BOOT_ARGS+=(--dry-run) ;;
    --skip-cloudflare) SKIP_CF=1 ;;
    --skip-firewall) BOOT_ARGS+=(--skip-firewall) ;;
    --skip-ssh-hardening) BOOT_ARGS+=(--skip-ssh-hardening) ;;
    --skip-verify) SKIP_VERIFY=1 ;;
    --swap-gb) shift; BOOT_ARGS+=(--swap-gb "${1:-}") ;;
    -h|--help) sed -n '2,39p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
  shift
done
[ -n "$CONFIG" ] || die "--config <file> is required (start from install/client.conf.example)"
[ -f "$CONFIG" ] || die "config file not found: $CONFIG"
CONFIG=$(cd "$(dirname "$CONFIG")" && pwd)/$(basename "$CONFIG")   # absolute: the backup cron job re-reads it
# Local-only installs: DOMAIN/ZONE/Access settings become optional (lib.sh conf_validate).
OK_LOCAL_ONLY=$SKIP_CF
export DRY_RUN OK_LOCAL_ONLY

T0=$(date +%s)
declare -a TIMINGS=()
mark() { TIMINGS+=("$(printf '%-34s %4ss' "$1" "$(( $(date +%s) - T_STEP ))")"); T_STEP=$(date +%s); }
T_STEP=$T0

conf_load "$CONFIG"
conf_validate
ok_paths
require_root
SLUG=$(conf CLIENT_SLUG)
DOMAIN=$(conf DOMAIN)
APP_HOME=$(app_home)
log "Installing Operation Kit for '$(conf CLIENT_NAME)' at $(site_label) into $OK_DIR"
[ "$DRY_RUN" -eq 1 ] && log "DRY RUN — nothing will be changed"

# ── 1. Host ───────────────────────────────────────────────────────────────────
bash "$OK_LIB_DIR/bootstrap-host.sh" --timezone "$(conf TIMEZONE UTC)" "${BOOT_ARGS[@]+"${BOOT_ARGS[@]}"}"
mark "1 host prepared"

# ── 2. Folders ────────────────────────────────────────────────────────────────
step "2. Install folder $OK_DIR"
run install -d -m 755 "$OK_DIR" "$OK_STATE" "$OK_STATE/data" "$OK_STATE/home" "$OK_STATE/data/branding"
run install -d -m 1777 "$OK_STATE/tmp"
run install -d -m 700 "$OK_SECRETS"
# Sandboxes run as uid 1000 and write into session folders under these roots.
for d in projects ai-workspace second-brain transcripts assistant; do run install -d -m 777 "$OK_STATE/home/$d"; done
# Project registry the server resolves session workdirs from. Repos registered in
# the app are added to it; never overwrite one that already exists.
WS_JSON="$OK_STATE/home/ai-workspace/workspaces.json"
if [ ! -e "$WS_JSON" ]; then
  if [ "$DRY_RUN" -eq 1 ]; then printf '  [dry-run] create %s\n' "$WS_JSON"
  else printf '{"workspaces":{}}\n' > "$WS_JSON" && chmod 664 "$WS_JSON"; fi
fi
mark "2 folders"

# ── 3. Secrets (generated here, never printed) ────────────────────────────────
step "3. Secrets (stored in $OK_SECRETS_ENV, mode 600 — values are never shown)"
if [ -n "$SECRETS_HANDOVER" ]; then
  [ -f "$SECRETS_HANDOVER" ] || die "--secrets-file not found: $SECRETS_HANDOVER"
  while IFS= read -r line || [ -n "$line" ]; do
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    [[ "$line" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]] || die "secrets file: a line is not KEY=value (line content not shown)"
    key=${BASH_REMATCH[1]}; val=${BASH_REMATCH[2]}
    val=${val#\"}; val=${val%\"}
    case "$key" in
      CLOUDFLARE_API_TOKEN)
        if [ "$DRY_RUN" -eq 0 ]; then (umask 077; printf '%s\n' "$val" > "$OK_SECRETS/cloudflare-api-token"); fi
        log "  CLOUDFLARE_API_TOKEN: stored in secrets/cloudflare-api-token" ;;
      ANTHROPIC_API_KEY)
        env_set "$OK_SECRETS_ENV" SESSION_JAIL_ANTHROPIC_API_KEY "$val"; log "  ANTHROPIC_API_KEY: stored for sandboxed sessions" ;;
      CLAUDE_CODE_OAUTH_TOKEN)
        env_set "$OK_SECRETS_ENV" SESSION_JAIL_CLAUDE_OAUTH_TOKEN "$val"; log "  CLAUDE_CODE_OAUTH_TOKEN: stored for sandboxed sessions" ;;
      OPENAI_API_KEY|GEMINI_API_KEY|GOOGLE_CLIENT_ID|GOOGLE_CLIENT_SECRET|AZURE_CLIENT_ID|AZURE_CLIENT_SECRET|AZURE_DIRECTORY_ID)
        env_set "$OK_SECRETS_ENV" "$key" "$val"; log "  $key: stored" ;;
      BACKUP_ACCESS_KEY_ID|BACKUP_SECRET_ACCESS_KEY)
        env_set "$OK_SECRETS_ENV" "OK_$key" "$val"; log "  $key: stored for off-server backups" ;;
      BACKUP_PASSWORD)  # recovering onto a new server: the saved backup password
        env_set "$OK_SECRETS_ENV" OK_BACKUP_PASSWORD "$val"; log "  BACKUP_PASSWORD: stored (opens the existing off-server backups)" ;;
      *) warn "  $key: not used by the installer — ignored" ;;
    esac
  done < "$SECRETS_HANDOVER"
  unset val
  if [ "$DRY_RUN" -eq 0 ]; then shred -u "$SECRETS_HANDOVER" 2>/dev/null || rm -f "$SECRETS_HANDOVER"; log "  hand-over file deleted"; fi
fi
secret_ensure CC_JWT_SECRET rand_hex
secret_ensure INTERNAL_API_SECRET rand_hex
secret_ensure SECRETS_MASTER_KEY rand_b64
secret_ensure TEST_CRED_ENCRYPTION_KEY rand_b64
# Encrypts the off-server backups (install/backup.sh). Without it a backup
# cannot be read: INSTALL.md "Backups" says where to keep a copy.
secret_ensure OK_BACKUP_PASSWORD rand_hex
[ "$DRY_RUN" -eq 1 ] || chmod 600 "$OK_SECRETS_ENV"

# Non-secret settings compose reads (install/docker-compose.yml).
write_settings() {
  local profiles=""
  [ "$SKIP_CF" -eq 1 ] || profiles="tunnel"
  cat <<EOF
# Written by install.sh from $(basename "$CONFIG") — not secret. Re-run install.sh to change.
OK_STATE=$OK_STATE
OK_APP_HOME=$APP_HOME
OK_DOMAIN=${DOMAIN:-localhost}
OK_LOCAL_ONLY=$SKIP_CF
OK_GIT_SHA=$(repo_sha)
OK_BRAND_NAME=$(conf BRAND_NAME OperationKit)
OK_TIMEZONE=$(conf TIMEZONE UTC)
OK_SESSION_ISOLATION=$(conf SESSION_ISOLATION docker)
COMPOSE_PROFILES=$profiles
EOF
}
if [ "$DRY_RUN" -eq 1 ]; then log "  [dry-run] would write $OK_SETTINGS_ENV:"; write_settings | sed 's/^/    /'
else write_settings > "$OK_SETTINGS_ENV"; chmod 644 "$OK_SETTINGS_ENV"; fi

logo=$(conf BRAND_LOGO)
if [ -n "$logo" ]; then
  [ -f "$logo" ] || die "BRAND_LOGO file not found on the server: $logo"
  [ "$(stat -c %s "$logo")" -le 524288 ] || die "BRAND_LOGO is larger than 512 KB"
  case "${logo,,}" in *.svg) ext=svg ;; *.png) ext=png ;; *) die "BRAND_LOGO must be .png or .svg" ;; esac
  run rm -f "$OK_STATE/data/branding/logo.svg" "$OK_STATE/data/branding/logo.png"
  run install -m 644 "$logo" "$OK_STATE/data/branding/logo.$ext"
fi
mark "3 secrets + settings"

# ── 4. Images ─────────────────────────────────────────────────────────────────
step "4. Building the app image and the session sandbox image (the slow step: ~5-10 min)"
if [ "$DRY_RUN" -eq 1 ]; then
  log "  [dry-run] docker compose build command-center"
  log "  [dry-run] docker build -t ok-jail:local app/jail"
else
  # Full build output goes to a log file; only its tail is shown (the whole
  # thing is too long to read in a terminal).
  install -d -m 755 "$OK_DIR/logs"
  BUILD_LOG=$OK_DIR/logs/build-$(date -u +%Y%m%dT%H%M%SZ).log
  log "  commit $(repo_sha | cut -c1-12); full build log: $BUILD_LOG"
  if ! { BUILDKIT_PROGRESS=plain dc build command-center \
         && BUILDKIT_PROGRESS=plain docker build -t ok-jail:local -f "$OK_REPO_DIR/app/jail/Dockerfile" "$OK_REPO_DIR/app/jail"; } >"$BUILD_LOG" 2>&1; then
    tail -n 40 "$BUILD_LOG" | sed 's/^/    | /' >&2
    die "the image build failed — last 40 lines above, everything in $BUILD_LOG"
  fi
  tail -n 3 "$BUILD_LOG" | sed 's/^/    | /'
  log "  images built"
fi
mark "4 images built"

# ── 5. Cloudflare ─────────────────────────────────────────────────────────────
if [ "$SKIP_CF" -eq 1 ]; then
  step "5. Cloudflare — skipped (--skip-cloudflare): the site is only reachable on the server itself (or over an SSH tunnel)"
  # No Access in front: the app must not look for Cloudflare's identity header.
  if [ -n "$(env_get "$OK_SECRETS_ENV" OK_CF_ACCESS_AUD)" ]; then
    env_set "$OK_SECRETS_ENV" OK_CF_ACCESS_TEAM ""; env_set "$OK_SECRETS_ENV" OK_CF_ACCESS_AUD ""
  fi
  log "  sign-in: the app's own username + password (one login needs Cloudflare Access)"
else
  cf_args=(up --config "$CONFIG"); [ "$DRY_RUN" -eq 1 ] && cf_args+=(--dry-run)
  if [ "$DRY_RUN" -eq 1 ] && [ ! -s "$OK_SECRETS/cloudflare-api-token" ]; then
    step "5. Cloudflare"; log "  [dry-run] would run install/cloudflare.sh up (no token on this machine to plan against)"
  else
    bash "$OK_LIB_DIR/cloudflare.sh" "${cf_args[@]}"
  fi
fi
mark "5 cloudflare"

# ── 6. Start ──────────────────────────────────────────────────────────────────
step "6. Starting the app"
if [ "$DRY_RUN" -eq 1 ]; then log "  [dry-run] docker compose up -d"; else
  dc up -d --remove-orphans
  waited=$(wait_healthy 240) || die "the app did not become healthy in 4 minutes — see: docker logs --tail 100 command-center"
  log "  app healthy after ${waited}s"
fi
mark "6 app started"

# ── 7. Workspace + first admin ────────────────────────────────────────────────
step "7. Client workspace '$SLUG' and first admin '$(conf ADMIN_USERNAME admin)'"
agents_json=$(conf AGENTS_ENABLED general | tr -d ' ' | jq -Rc 'split(",") | map(select(length > 0))')
if [ "$DRY_RUN" -eq 1 ]; then
  log "  [dry-run] would create workspace + admin with a one-time setup password in $OK_ADMIN_SETUP_FILE"
else
  [ -s "$OK_ADMIN_SETUP_FILE" ] || (umask 077; openssl rand -base64 18 | tr -d '/+=' | cut -c1-20 > "$OK_ADMIN_SETUP_FILE")
  # The password reaches the container on stdin (inside JSON), never on argv.
  if ! jq -nc --arg slug "$SLUG" --arg name "$(conf CLIENT_NAME)" --arg user "$(conf ADMIN_USERNAME admin)" \
      --rawfile pw "$OK_ADMIN_SETUP_FILE" --argjson agents "$agents_json" --arg email "$(admin_email)" \
      '{client_slug:$slug, client_name:$name, admin_username:$user, setup_password:($pw|rtrimstr("\n")), setup_hours:72, agents:$agents}
       + (if $email == "" then {} else {admin_email:$email} end)' \
    | docker exec -i command-center tsx server/src/scripts/install-bootstrap.ts 2>&1 | sed 's/^/  /'; then
    die "creating the workspace and first admin failed (message above)"
  fi
  # The bootstrap wrote the database from its own process; the running app still
  # holds its old workspace/agent lists in memory. Make it re-read them, or
  # restart it when that hook is not there.
  if app_internal POST /api/internal/install/reload-caches >/dev/null 2>&1; then
    log "  app re-read the workspace and agent lists"
  else
    log "  restarting the app so it sees the new workspace"
    dc restart command-center >/dev/null
    wait_healthy 240 >/dev/null || die "the app did not come back after the restart — see: docker logs --tail 100 command-center"
  fi
fi
mark "7 workspace + admin"

# ── 8. Starter packs ──────────────────────────────────────────────────────────
packs=$(conf STARTER_PACKS)
if [ -n "$packs" ]; then
  step "8. Starter packs: $packs"
  [ -x "$OK_REPO_DIR/scripts/starter-pack.sh" ] || die "STARTER_PACKS is set, but this copy of the code has no scripts/starter-pack.sh — empty STARTER_PACKS or update the code"
  IFS=',' read -r -a _packs <<< "${packs// /}"
  for p in "${_packs[@]}"; do
    [ -n "$p" ] || continue
    if [ "$DRY_RUN" -eq 1 ]; then log "  [dry-run] would enable starter pack '$p' for $SLUG"; continue; fi
    "$OK_REPO_DIR/scripts/starter-pack.sh" enable "$p" --workspace "$SLUG" 2>&1 | sed 's/^/  /' \
      || die "starter pack '$p' could not be switched on (message above). Fix it, then re-run the installer — it is safe to re-run."
  done
  mark "8 starter packs"
fi

# ── 9. Backups + verify ───────────────────────────────────────────────────────
step "9. Nightly backup"
b_args=(install-cron --config "$CONFIG"); [ "$DRY_RUN" -eq 1 ] && b_args+=(--dry-run)
bash "$OK_LIB_DIR/backup.sh" "${b_args[@]}"

# ── 8. Verify ─────────────────────────────────────────────────────────────────
claude_ready=0
[ -n "$(env_get "$OK_SECRETS_ENV" SESSION_JAIL_CLAUDE_OAUTH_TOKEN)$(env_get "$OK_SECRETS_ENV" SESSION_JAIL_ANTHROPIC_API_KEY)" ] && claude_ready=1
if [ "$DRY_RUN" -eq 0 ] && [ "$SKIP_VERIFY" -eq 0 ]; then
  v_args=(--config "$CONFIG"); [ "$SKIP_CF" -eq 1 ] && v_args+=(--local-only)
  [ "$claude_ready" -eq 1 ] || v_args+=(--skip-card)
  bash "$OK_LIB_DIR/verify.sh" "${v_args[@]}" || warn "verify found problems — see the FAIL lines above"
fi
mark "9 backup + verify"

TOTAL=$(( $(date +%s) - T0 ))
step "Done in $((TOTAL / 60))m $((TOTAL % 60))s"
printf '  %s\n' "${TIMINGS[@]}"
if [ "$DRY_RUN" -eq 0 ]; then
  { date -u +%FT%TZ; printf '  %s\n' "${TIMINGS[@]}"; echo "  total ${TOTAL}s"; } >> "$OK_DIR/install-timing.log"
fi
if [ "$SKIP_CF" -eq 1 ]; then
  cat <<EOF

  Site:        local only (--skip-cloudflare) — nothing is open to the internet.
               From your laptop, open an SSH tunnel and keep it running:
                 ssh -N -L 3002:127.0.0.1:3002 <user>@<server address>
               then browse to http://localhost:3002
  Sign-in:     username + password (one login needs Cloudflare Access)
EOF
else
  cat <<EOF

  Site:        https://$DOMAIN   (Cloudflare Access asks for the person's email first)
  One login:   $(admin_email) passes Cloudflare Access and lands in the app as $(conf ADMIN_USERNAME admin)
EOF
fi
cat <<EOF
  Build:       $(repo_sha | cut -c1-12)
  Backups:     nightly into $OK_DIR/backups$([ -n "$(conf BACKUP_TARGET)" ] && echo " and off the server ($(conf BACKUP_TARGET))" || echo " — on THIS server only: set BACKUP_TARGET for an off-server copy (INSTALL.md, Backups)")
  First admin: $(conf ADMIN_USERNAME admin) — break-glass one-time setup password is in
               $OK_ADMIN_SETUP_FILE (read it in YOUR terminal:
               ssh -t <server> sudo cat $OK_ADMIN_SETUP_FILE). It expires in 72 hours and
               must be changed at first sign-in.
EOF
if [ "$claude_ready" -eq 0 ]; then
  cat <<EOF
  Next:        connect Claude for the AI workers (INSTALL.md step 7):
               ssh -t <server> sudo bash $OK_REPO_DIR/install/claude-login.sh --config <config>
               then: sudo bash $OK_REPO_DIR/install/verify.sh --config <config>
EOF
fi
