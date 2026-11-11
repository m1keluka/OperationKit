# shellcheck shell=bash disable=SC2034
# install/lib.sh — shared helpers for the Operation Kit client installer.
#
# Sourced by install.sh, install/*.sh. Contract (same as scripts/migrate/lib.sh,
# which this is ported from, minus the operator-specific paths):
#   * set -euo pipefail.
#   * --dry-run prints every mutating command and changes nothing. Read-only
#     probes still run so the plan is real.
#   * NEVER print a secret value. Secrets are generated straight into files with
#     mode 600 and are referred to by NAME only. Do not add `set -x` anywhere.
set -euo pipefail

OK_LIB_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
OK_REPO_DIR=$(cd "$OK_LIB_DIR/.." && pwd)
DRY_RUN=${DRY_RUN:-0}

# ── Output ────────────────────────────────────────────────────────────────────
_ts()  { date -u +%H:%M:%S; }
log()  { printf '[%s] %s\n' "$(_ts)" "$*"; }
warn() { printf '[%s] WARN: %s\n' "$(_ts)" "$*" >&2; }
die()  { printf '[%s] STOP: %s\n' "$(_ts)" "$*" >&2; exit 1; }
step() { printf '\n[%s] ━━ %s\n' "$(_ts)" "$*"; }

PASS_COUNT=0
FAIL_COUNT=0
pass() { PASS_COUNT=$((PASS_COUNT + 1)); printf '  PASS  %s\n' "$*"; }
fail() { FAIL_COUNT=$((FAIL_COUNT + 1)); printf '  FAIL  %s\n' "$*"; }

# run CMD... — execute, or print it under --dry-run.
run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '  [dry-run] %s\n' "$*"
    return 0
  fi
  "$@"
}

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    if [ "$DRY_RUN" -eq 1 ]; then warn "not root — fine for --dry-run, required for a real install"; return 0; fi
    die "run as root (sudo ./install.sh ...)"
  fi
}

# ── Client config (KEY="value" file — parsed, never sourced/executed) ─────────
declare -A CONF=()

# conf_load FILE — read KEY=value / KEY="value" lines into CONF.
conf_load() {
  local file=$1 line key val n=0
  [ -f "$file" ] || die "config file not found: $file"
  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n + 1))
    line=${line%$'\r'}
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    if [[ "$line" =~ ^[[:space:]]*([A-Z][A-Z0-9_]*)=(.*)$ ]]; then
      key=${BASH_REMATCH[1]}
      val=${BASH_REMATCH[2]}
      val=${val%"${val##*[![:space:]]}"}          # trim trailing space
      if [[ "$val" =~ ^\"(.*)\"$ ]] || [[ "$val" =~ ^\'(.*)\'$ ]]; then val=${BASH_REMATCH[1]}; fi
      CONF[$key]=$val
    else
      die "$file line $n is not KEY=\"value\": fix or comment it out"
    fi
  done < "$file"
}

# conf KEY [DEFAULT]
conf() { local v=${CONF[$1]-}; printf '%s' "${v:-${2-}}"; }

# admin_email — ADMIN_EMAIL, else the first ACCESS_ALLOWED_EMAILS entry, lower-cased.
# The installer links the first admin to it so the Cloudflare sign-in is the only one.
admin_email() {
  local e
  e=$(conf ADMIN_EMAIL)
  [ -n "$e" ] || e=$(conf ACCESS_ALLOWED_EMAILS | cut -d, -f1)
  printf '%s' "$e" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]'
}

# one_login_on — does this install sign people in at the Cloudflare Access door?
# True only when Access is actually configured (the app has a team + AUD to
# verify against) AND there is an admin email for Access to match on. The first
# admin is then not forced to change a password they never had (obj 900108).
one_login_on() {
  [ -n "$(env_get "$OK_SECRETS_ENV" OK_CF_ACCESS_AUD)" ] || return 1
  [ -n "$(env_get "$OK_SECRETS_ENV" OK_CF_ACCESS_TEAM)" ] || return 1
  [ -n "$(admin_email)" ] || return 1
  return 0
}

# local_mode — is this a local-only install (--skip-cloudflare)? Set by the
# caller (OK_LOCAL_ONLY=1), or remembered in install.env by install.sh so the
# other scripts (verify, admin-password, claude-login, update) agree with it.
local_mode() {
  case "${OK_LOCAL_ONLY-}" in 1) return 0 ;; 0) return 1 ;; esac
  # Installs from before OK_LOCAL_ONLY existed: no tunnel profile = local only.
  grep -qsE '^(OK_LOCAL_ONLY=1|COMPOSE_PROFILES=)$' "$(conf INSTALL_DIR /opt/operationkit)/install.env"
}

# conf_validate — fail early with plain-language messages. In local mode
# (--skip-cloudflare) DOMAIN, ZONE and the Access settings are optional: there is
# no tunnel, no DNS and no Cloudflare door, so nothing reads them.
conf_validate() {
  local slug domain zone local_only=0
  local_mode && local_only=1
  slug=$(conf CLIENT_SLUG); domain=$(conf DOMAIN); zone=$(conf ZONE)
  [ -n "$(conf CLIENT_NAME)" ] || die "CLIENT_NAME is empty in the config file"
  [[ "$slug" =~ ^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$ ]] || die "CLIENT_SLUG must be 3-40 lowercase letters, digits or dashes (got '$slug')"
  if [ "$local_only" -eq 0 ] || [ -n "$domain$zone" ]; then
    local hint=""; [ "$local_only" -eq 1 ] || hint=" (or install with --skip-cloudflare for a local-only test install)"
    [[ "$domain" =~ ^[a-z0-9.-]+\.[a-z]{2,}$ ]] || die "DOMAIN does not look like a web address (got '$domain')$hint"
    [[ "$zone" =~ ^[a-z0-9.-]+\.[a-z]{2,}$ ]] || die "ZONE does not look like a domain (got '$zone')$hint"
    case "$domain" in *."$zone"|"$zone") ;; *) die "DOMAIN ($domain) must sit under ZONE ($zone)" ;; esac
  fi
  [[ "$(conf ADMIN_USERNAME admin)" =~ ^[a-z][a-z0-9._-]{1,31}$ ]] || die "ADMIN_USERNAME must be lowercase, 2-32 chars"
  [ -z "$(conf ADMIN_EMAIL)" ] || [[ "$(conf ADMIN_EMAIL)" =~ ^[^[:space:]@,]+@[^[:space:]@,]+\.[^[:space:]@,]+$ ]] \
    || die "ADMIN_EMAIL does not look like an email address (got '$(conf ADMIN_EMAIL)')"
  case "$(conf ACCESS_LOGIN_METHOD otp)" in otp|google|microsoft) ;; *) die "ACCESS_LOGIN_METHOD must be otp, google or microsoft" ;; esac
  case "$(conf API_KEY_AUTH_BYPASS on)" in on|yes|1|true|off|no|0|false) ;; *) die "API_KEY_AUTH_BYPASS must be on or off (got '$(conf API_KEY_AUTH_BYPASS)')" ;; esac
  case "$(conf API_BROWSER_INTEGRITY_EXCEPTION on)" in on|yes|1|true|off|no|0|false) ;; *) die "API_BROWSER_INTEGRITY_EXCEPTION must be on or off (got '$(conf API_BROWSER_INTEGRITY_EXCEPTION)')" ;; esac
  [ "$local_only" -eq 1 ] || [ -n "$(conf ACCESS_ALLOWED_EMAILS)$(conf ACCESS_ALLOWED_EMAIL_DOMAIN)" ] \
    || die "set ACCESS_ALLOWED_EMAILS or ACCESS_ALLOWED_EMAIL_DOMAIN — otherwise nobody could open the site"
  case "$(conf CLAUDE_AUTH login)" in login|api-key) ;; *) die "CLAUDE_AUTH must be login or api-key" ;; esac
  case "$(conf SESSION_ISOLATION docker)" in docker|tmux) ;; *) die "SESSION_ISOLATION must be docker or tmux" ;; esac
  local a
  IFS=',' read -r -a _agents <<< "$(conf AGENTS_ENABLED general)"
  for a in "${_agents[@]}"; do
    a=${a// /}
    case "$a" in general|cto|cmo|coo|cfo) ;; *) die "AGENTS_ENABLED: unknown agent '$a' (allowed: general, cto, cmo, coo, cfo)" ;; esac
  done
  [[ "$(conf INSTALL_DIR /opt/operationkit)" == /* ]] || die "INSTALL_DIR must be an absolute path"
  [ -z "$(conf DOCKER_BRIDGE_IP)" ] || private_ipv4 "$(conf DOCKER_BRIDGE_IP)" \
    || die "DOCKER_BRIDGE_IP must be a private (RFC 1918) IPv4 address — the app must never be published on a public address"
  local k
  for k in BACKUP_KEEP_LOCAL BACKUP_KEEP_DAILY BACKUP_KEEP_WEEKLY BACKUP_KEEP_MONTHLY; do
    [ -z "$(conf "$k")" ] || [[ "$(conf "$k")" =~ ^[0-9]{1,3}$ ]] || die "$k must be a whole number (got '$(conf "$k")')"
  done
  local bt; bt=$(conf BACKUP_TARGET)
  [ -z "$bt" ] || [[ "$bt" =~ ^(s3|b2):[^[:space:]]+$ ]] \
    || die "BACKUP_TARGET must look like s3:https://<endpoint>/<bucket>/<folder> or b2:<bucket>:<folder> (got '$bt')"
}

# conf_set FILE KEY VALUE — position-preserving upsert of KEY="VALUE" in a
# client.conf. Only for NON-secret settings (client.conf never holds a secret).
# Keeps the file's mode and owner, and updates CONF too.
conf_set() {
  local file=$1 key=$2 val=$3 tmp
  [[ "$val" != *'"'* && "$val" != *$'\n'* ]] || die "conf_set: the $key value must not contain quotes or newlines"
  if [ "$DRY_RUN" -eq 1 ]; then printf '  [dry-run] would set %s in %s\n' "$key" "$file"; return 0; fi
  tmp=$(mktemp "$file.XXXXXX")
  OK_K=$key OK_V=$val awk '
    BEGIN { k = ENVIRON["OK_K"]; v = ENVIRON["OK_V"]; done = 0 }
    (!done && $0 ~ ("^[[:space:]]*" k "=")) { print k "=\"" v "\""; done = 1; next }
    { print }
    END { if (!done) print k "=\"" v "\"" }
  ' "$file" > "$tmp"
  chmod --reference="$file" "$tmp" 2>/dev/null || true
  chown --reference="$file" "$tmp" 2>/dev/null || true
  mv "$tmp" "$file"
  CONF[$key]=$val
}

# db_inspect DB — integrity-check a SQLite file and count the rows of the main
# tables with whatever the host has: sqlite3, else python3 (on every Ubuntu
# server image), else node. Prints "integrity=<result>" and then one
# "<table>=<rows>" line per table ("<table>=missing" when it does not exist).
# Returns 2 when none of the three tools is available.
db_inspect() {
  local db=$1 t
  if command -v sqlite3 >/dev/null 2>&1; then
    printf 'integrity=%s\n' "$(sqlite3 "file:$db?mode=ro" 'PRAGMA integrity_check' 2>&1 | head -1)"
    for t in workspaces users objectives projects; do
      printf '%s=%s\n' "$t" "$(sqlite3 "file:$db?mode=ro" "SELECT count(*) FROM $t" 2>/dev/null || echo missing)"
    done
  elif command -v python3 >/dev/null 2>&1; then
    python3 -I -c '
import sqlite3, sys
c = sqlite3.connect("file:" + sys.argv[1] + "?mode=ro", uri=True)
try:
    print("integrity=" + str(c.execute("PRAGMA integrity_check").fetchone()[0]))
except Exception as e:
    print("integrity=" + str(e).replace("\n", " "))
for t in ("workspaces", "users", "objectives", "projects"):
    try:
        print(t + "=" + str(c.execute("SELECT count(*) FROM " + t).fetchone()[0]))
    except Exception:
        print(t + "=missing")
' "$db"
  elif command -v node >/dev/null 2>&1 && node --no-warnings -e 'require("node:sqlite")' >/dev/null 2>&1; then
    node --no-warnings -e '
const { DatabaseSync } = require("node:sqlite");
let d;
try {
  d = new DatabaseSync(process.argv[1], { readOnly: true });
  console.log("integrity=" + Object.values(d.prepare("PRAGMA integrity_check").get())[0]);
} catch (e) { console.log("integrity=" + String(e.message).replace(/\n/g, " ")); process.exit(0); }
for (const t of ["workspaces", "users", "objectives", "projects"]) {
  try { console.log(t + "=" + d.prepare("SELECT count(*) AS n FROM " + t).get().n); } catch { console.log(t + "=missing"); }
}' "$db"
  else
    return 2
  fi
}

# site_label — how scripts name the install in messages.
site_label() { if [ -n "$(conf DOMAIN)" ] && ! local_mode; then printf 'https://%s' "$(conf DOMAIN)"; else printf '%s (local only)' "$(conf CLIENT_SLUG)"; fi; }

# ── Install layout (everything below INSTALL_DIR; nothing operator-specific) ──
#   $OK_DIR/state/   data, the app user's home, Claude accounts  (backed up)
#   $OK_DIR/secrets/ generated secrets, mode 700/600             (never printed)
#   $OK_DIR/install.env  non-secret settings compose reads
ok_paths() {
  OK_DIR=$(conf INSTALL_DIR /opt/operationkit)
  OK_STATE=$OK_DIR/state
  OK_SECRETS=$OK_DIR/secrets
  OK_SECRETS_ENV=$OK_SECRETS/stack.env
  OK_SETTINGS_ENV=$OK_DIR/install.env
  OK_ADMIN_SETUP_FILE=$OK_SECRETS/first-admin-setup-password
  OK_COMPOSE_FILE=$OK_REPO_DIR/install/docker-compose.yml
}

# The app's in-container home directory is defined by the app source (config.ts
# USER_HOME default), not by the installer. Read it from the source so this
# installer never hard-codes a person's username.
app_home() {
  local h
  h=$(sed -n "s/.*process\.env\.USER_HOME || '\([^']*\)'.*/\1/p" "$OK_REPO_DIR/app/server/src/config.ts" | head -1)
  [ -n "$h" ] || die "could not read the app home path from app/server/src/config.ts"
  printf '%s' "$h"
}

# ── Secrets: generated on this server, written straight to a 600 file ────────
rand_hex() { openssl rand -hex 32; }
rand_b64() { openssl rand -base64 32; }
rand_sk()  { printf 'sk-%s' "$(openssl rand -hex 24)"; }

# env_get FILE KEY — prints the value (callers must not print it further).
env_get() { [ -f "$1" ] && grep -E "^$2=" "$1" | head -1 | cut -d= -f2- || true; }

# env_set FILE KEY VALUE — position-preserving upsert, file stays mode 600.
env_set() {
  local file=$1 key=$2 val=$3 tmp
  if [ "$DRY_RUN" -eq 1 ]; then printf '  [dry-run] would set %s in %s\n' "$key" "$file"; return 0; fi
  [ -f "$file" ] || install -m 600 /dev/null "$file"
  tmp=$(mktemp "$file.XXXXXX")
  chmod 600 "$tmp"
  # Value travels via the environment, not argv, so it never shows up in `ps`.
  OK_K=$key OK_V=$val awk '
    BEGIN { k = ENVIRON["OK_K"]; v = ENVIRON["OK_V"]; done = 0 }
    (!done && index($0, k "=") == 1) { print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }
  ' "$file" > "$tmp"
  mv "$tmp" "$file"
}

# secret_ensure KEY GENERATOR — generate once, keep forever (re-runs are no-ops).
secret_ensure() {
  local key=$1 gen=$2
  if [ -n "$(env_get "$OK_SECRETS_ENV" "$key")" ]; then
    log "  $key: kept (already set)"
  else
    env_set "$OK_SECRETS_ENV" "$key" "$($gen)"
    log "  $key: generated"
  fi
}

# app_internal METHOD PATH [JSON] — call the running app's internal API from
# inside its container (loopback + X-Internal-Secret, read there and never
# printed). Prints the JSON reply; non-zero exit when the call fails.
app_internal() {
  local m=$1 p=$2 b=${3-}
  # shellcheck disable=SC2016  # expanded inside the container, on purpose
  docker exec command-center bash -c '
    S="${INTERNAL_API_SECRET:-}"; [ -n "$S" ] || { echo "INTERNAL_API_SECRET is not set in the app" >&2; exit 1; }
    if [ -n "$3" ]; then
      printf "X-Internal-Secret: %s\n" "$S" | curl -sS --fail-with-body -X "$1" -H @- -H "Content-Type: application/json" --data "$3" "http://127.0.0.1:3002$2"
    else
      printf "X-Internal-Secret: %s\n" "$S" | curl -sS --fail-with-body -X "$1" -H @- "http://127.0.0.1:3002$2"
    fi' _ "$m" "$p" "$b"
}

# wait_healthy [SECONDS] — wait for the app to answer /api/health.
wait_healthy() {
  local limit=${1:-240} waited=0
  until curl -fsS http://127.0.0.1:3002/api/health >/dev/null 2>&1; do
    [ "$waited" -lt "$limit" ] || return 1
    sleep 3; waited=$((waited + 3))
  done
  printf '%s' "$waited"
}

# repo_sha — the commit of this copy of the code. safe.directory: the repo is
# often cloned by one user and the installer run as root (git refuses otherwise).
repo_sha() { git -c safe.directory='*' -C "$OK_REPO_DIR" rev-parse HEAD 2>/dev/null || echo unknown; }

# docker_bridge_ip — IPv4 gateway of the default Docker bridge (docker0): where
# containers on that bridge (card sandboxes) reach the host, so the app is also
# published there (obj 900185). DOCKER_BRIDGE_IP in client.conf wins. Prints
# nothing when no private IPv4 is found.
docker_bridge_ip() {
  local ip
  ip=$(conf DOCKER_BRIDGE_IP)
  [ -n "$ip" ] || ip=$(docker network inspect bridge -f '{{range .IPAM.Config}}{{.Gateway}} {{end}}' 2>/dev/null \
    | tr ' ' '\n' | grep -m1 -E '^[0-9]+(\.[0-9]+){3}$' || true)
  [ -n "$ip" ] || ip=$(ip -4 -o addr show dev docker0 2>/dev/null | awk '{split($4,a,"/"); print a[1]; exit}')
  if private_ipv4 "$ip"; then printf '%s' "$ip"; fi
}

# private_ipv4 IP — true only for an RFC 1918 address (never the public NIC).
private_ipv4() {
  [[ "${1-}" =~ ^(10|172|192)\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
  case "${BASH_REMATCH[1]}" in
    10) return 0 ;;
    172) [ "${BASH_REMATCH[2]}" -ge 16 ] && [ "${BASH_REMATCH[2]}" -le 31 ] ;;
    192) [ "${BASH_REMATCH[2]}" = 168 ] ;;
  esac
}

# bridge_firewall_open IP — let containers on docker0 (and only docker0) reach
# the app's bridge publish IP:3002. A container -> host-gateway connection is
# INPUT traffic on the host, which `ufw default deny incoming` drops otherwise.
# The public NIC stays closed. Idempotent (ufw skips an existing rule).
bridge_firewall_open() {
  local ip=$1
  if ufw status 2>/dev/null | grep -q 'Status: active'; then
    run ufw allow in on docker0 to "$ip" port 3002 proto tcp comment 'OperationKit: sandboxes on docker0 -> app' | sed 's/^/    /'
    log "  firewall: 3002 allowed only in on docker0 to $ip (public NIC stays closed)"
  else
    log "  firewall (ufw) not active — nothing to open for the Docker bridge"
  fi
}

# bridge_health IP — HTTP code a container on the default bridge gets from
# http://IP:3002/api/health (000 = unreachable). Uses the sandbox image, which
# is always built by install.sh and has curl.
bridge_health() {
  docker run --rm --network bridge --entrypoint curl ok-jail:local \
    -s -o /dev/null -m 10 -w '%{http_code}' "http://$1:3002/api/health" 2>/dev/null || true
}

# docker compose for this install (project name pinned so uninstall finds it).
dc() {
  docker compose --project-name operationkit \
    --env-file "$OK_SETTINGS_ENV" --env-file "$OK_SECRETS_ENV" \
    -f "$OK_COMPOSE_FILE" "$@"
}
