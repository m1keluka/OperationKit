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

# conf_validate — fail early with plain-language messages.
conf_validate() {
  local slug domain zone
  slug=$(conf CLIENT_SLUG); domain=$(conf DOMAIN); zone=$(conf ZONE)
  [ -n "$(conf CLIENT_NAME)" ] || die "CLIENT_NAME is empty in the config file"
  [[ "$slug" =~ ^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$ ]] || die "CLIENT_SLUG must be 3-40 lowercase letters, digits or dashes (got '$slug')"
  [[ "$domain" =~ ^[a-z0-9.-]+\.[a-z]{2,}$ ]] || die "DOMAIN does not look like a web address (got '$domain')"
  [[ "$zone" =~ ^[a-z0-9.-]+\.[a-z]{2,}$ ]] || die "ZONE does not look like a domain (got '$zone')"
  case "$domain" in *."$zone"|"$zone") ;; *) die "DOMAIN ($domain) must sit under ZONE ($zone)" ;; esac
  [[ "$(conf ADMIN_USERNAME admin)" =~ ^[a-z][a-z0-9._-]{1,31}$ ]] || die "ADMIN_USERNAME must be lowercase, 2-32 chars"
  case "$(conf ACCESS_LOGIN_METHOD otp)" in otp|google|microsoft) ;; *) die "ACCESS_LOGIN_METHOD must be otp, google or microsoft" ;; esac
  [ -n "$(conf ACCESS_ALLOWED_EMAILS)$(conf ACCESS_ALLOWED_EMAIL_DOMAIN)" ] \
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
}

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

# docker compose for this install (project name pinned so uninstall finds it).
dc() {
  docker compose --project-name operationkit \
    --env-file "$OK_SETTINGS_ENV" --env-file "$OK_SECRETS_ENV" \
    -f "$OK_COMPOSE_FILE" "$@"
}
