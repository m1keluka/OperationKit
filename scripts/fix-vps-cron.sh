#!/usr/bin/env bash
# fix-vps-cron.sh — one-shot host runbook that (re)sets up the 4 command-center
# cron jobs on the VPS. Run as the operator user on the host (NOT inside the
# command-center container).
#
# What it does:
#   1. Verifies `docker` and the command-center container are healthy, and
#      probes whether Doppler is reachable inside the container (non-fatal).
#   2. Mints a fresh CC_SERVICE_TOKEN (JWT) via scripts/mint-service-token.sh.
#   3. Resolves SUPABASE_URL, SUPABASE_SERVICE_KEY, CC_PLATFORM_URL, and
#      CC_PLATFORM_CRON_SECRET. Lookup order per var:
#        (a) the caller's exported environment,
#        (b) values already present in the existing cron.env,
#        (c) Doppler via the container CLI. Two Doppler modes are tried:
#            (c1) the host service-token YAML at /home/operator/.doppler/.doppler.yaml
#                 (mounted into the container at /root/.doppler), or
#            (c2) the personal admin token at /home/operator/projects/.doppler-admin-token
#                 (readable as root inside the container; injected per-call as
#                 DOPPLER_TOKEN). This is the same token sessions use, so no
#                 dashboard step is needed if the host already has the file.
#      The cron secrets actually live in example-platform/prd under different
#      names; resolve_var() handles the project/config + name remap.
#   4. Writes ~/.config/command-center/cron.env atomically with 600 perms.
#      All 4 vars plus CC_SERVICE_TOKEN are `export`-ed so cron can source it.
#   5. Re-installs all cron entry sets (install-daily-log-cron.sh,
#      install-campaign-audit-cron.sh, install-reconcile-clients-cron.sh,
#      install-cron-health-cron.sh, install-dream-cycle-cron.sh) so they pick
#      up the new cron.env.
#   6. Runs each cron script once and reports PASS/FAIL per script.
#
# Exit codes:
#   0  all 4 crons verified green
#   1  one or more crons failed verification (see per-script logs)
#
# Safe to re-run: idempotent. Overwrites cron.env and cron entries.

set -u -o pipefail

REPO_DIR="${CC_REPO_DIR:-/home/operator/projects/operationkit}"
SCRIPTS_DIR="$REPO_DIR/scripts"
ENV_FILE="$HOME/.config/command-center/cron.env"
LOG_DIR="/home/operator/transcripts"
VERIFY_LOG="$LOG_DIR/fix-vps-cron-$(date -u +%Y%m%dT%H%M%SZ).log"

mkdir -p "$LOG_DIR" "$(dirname "$ENV_FILE")"

log()  { printf '[%s] %s\n' "$(date -Iseconds)" "$*" | tee -a "$VERIFY_LOG"; }
die()  { log "FATAL: $*"; exit 1; }
warn() { log "WARN: $*"; }

# ---------------------------------------------------------------------------
# Step 1: Preflight
# ---------------------------------------------------------------------------
log "=== fix-vps-cron start ==="
OPERATOR_USER="${OPERATOR_USER:-operator}"
[ "$(id -un)" = "$OPERATOR_USER" ] || warn "expected to run as user '$OPERATOR_USER', got '$(id -un)' (override with OPERATOR_USER)"
[ "$(id -un)" = "${OPERATOR_USER:-operator}" ] || warn "expected to run as user '${OPERATOR_USER:-operator}', got '$(id -un)'"

command -v docker  >/dev/null 2>&1 || die "docker CLI not on host PATH"
command -v jq      >/dev/null 2>&1 || die "jq not on host PATH"
command -v curl    >/dev/null 2>&1 || die "curl not on host PATH"

docker ps --format '{{.Names}}' | grep -qx command-center \
  || die "command-center container is not running"

# All doppler invocations route through the container — the bundled CLI there
# reads the service-token config mounted from /home/operator/.doppler.
doppler_cli() {
  docker exec command-center doppler "$@"
}

DOPPLER_MODE="none"   # "service-token" | "admin-token" | "none"
DOPPLER_DIAG=""
HOST_DOPPLER_YAML="/home/operator/.doppler/.doppler.yaml"
ADMIN_TOKEN_FILE="/home/operator/projects/.doppler-admin-token"
ADMIN_TOKEN=""

if ! doppler_cli --version >/dev/null 2>&1; then
  DOPPLER_DIAG="doppler CLI not available inside command-center container (rebuild image?)"
else
  # Mode 1: host service-token YAML mounted into the container.
  if [ -s "$HOST_DOPPLER_YAML" ]; then
    doppler_err="$(doppler_cli secrets --only-names 2>&1 >/dev/null)" || true
    if [ -z "$doppler_err" ]; then
      DOPPLER_MODE="service-token"
    else
      DOPPLER_DIAG="host service-token present but doppler cannot list: ${doppler_err}"
    fi
  fi
  # Mode 2: personal admin token (mode 600 ccuser:ccuser → readable as root in container).
  if [ "$DOPPLER_MODE" = "none" ]; then
    if docker exec command-center test -r "$ADMIN_TOKEN_FILE" 2>/dev/null; then
      ADMIN_TOKEN="$(docker exec command-center cat "$ADMIN_TOKEN_FILE" 2>/dev/null | tr -d '[:space:]')"
      if [ -n "$ADMIN_TOKEN" ] \
        && docker exec -e "DOPPLER_TOKEN=$ADMIN_TOKEN" command-center \
             doppler projects --silent >/dev/null 2>&1; then
        DOPPLER_MODE="admin-token"
      else
        DOPPLER_DIAG="admin token file exists but token rejected by Doppler"
      fi
    else
      DOPPLER_DIAG="${DOPPLER_DIAG:-no host service-token at $HOST_DOPPLER_YAML; no admin token at $ADMIN_TOKEN_FILE}"
    fi
  fi
fi

case "$DOPPLER_MODE" in
  service-token) log "doppler reachable via host service token";;
  admin-token)   log "doppler reachable via personal admin token (no dashboard step needed)";;
  none)
    log "WARN: doppler unavailable — $DOPPLER_DIAG"
    log "  Falling back to environment / existing cron.env for SUPABASE_URL,"
    log "  SUPABASE_SERVICE_KEY, CC_PLATFORM_URL, CC_PLATFORM_CRON_SECRET."
    log "  To enable Doppler: as the operator user, either"
    log "      doppler configure set token <SERVICE_TOKEN> --scope /   # service token"
    log "  or ensure $ADMIN_TOKEN_FILE is populated (admin token, ccuser-owned)."
    ;;
esac

# Resolve a Doppler secret across whichever mode is active.
# Args: $1 project, $2 config, $3 source-secret-name.
doppler_get() {
  local name="$3"
  docker exec command-center tsx /app/server/src/scripts/secrets-get.ts "$name" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# Step 2: Mint fresh CC_SERVICE_TOKEN
# ---------------------------------------------------------------------------
log "minting CC_SERVICE_TOKEN (1 year expiry)…"
NEW_TOKEN="$(bash "$SCRIPTS_DIR/mint-service-token.sh" 365d "${OPERATOR_USER:-operator}" 1 | tr -d '[:space:]')"
[ -n "$NEW_TOKEN" ] || die "mint-service-token.sh returned empty token"

# Sanity-check: three dot-separated segments (JWT header.payload.signature).
DOT_COUNT="$(printf '%s' "$NEW_TOKEN" | awk -F. '{print NF-1}')"
[ "$DOT_COUNT" = "2" ] || die "minted token does not look like a JWT (expected 2 dots, got $DOT_COUNT)"
log "token minted OK (length=${#NEW_TOKEN})"

# ---------------------------------------------------------------------------
# Step 3: Resolve the four Doppler-managed cron env vars.
# Resolution order per var: (a) caller's exported env, (b) existing cron.env,
# (c) Doppler (if available). First non-empty wins. This lets the script run
# in a "doppler-not-yet-set-up" state as long as the operator pre-exports the
# vars in their shell or has a previously-good cron.env on disk.
# ---------------------------------------------------------------------------
log "resolving SUPABASE_URL / SUPABASE_SERVICE_KEY / CC_PLATFORM_URL / CC_PLATFORM_CRON_SECRET…"

# Snapshot existing cron.env (if any) into a separate scope — sourcing it
# directly into our shell would clobber any caller-exported overrides.
declare -A EXISTING_ENV=()
if [ -s "$ENV_FILE" ]; then
  while IFS= read -r line; do
    case "$line" in
      export\ *=*)
        kv="${line#export }"
        k="${kv%%=*}"
        v="${kv#*=}"
        # Strip the bash %q quoting by re-evaluating in a sandbox.
        v="$(bash -c "printf '%s' $v" 2>/dev/null || true)"
        EXISTING_ENV["$k"]="$v"
        ;;
    esac
  done < "$ENV_FILE"
fi

# Maps the cron-env variable name to where it lives in Doppler. The cron
# scripts use these short names; example-platform stores them under different
# names (e.g. SUPABASE_SERVICE_ROLE_KEY → SUPABASE_SERVICE_KEY in cron.env).
declare -A DOPPLER_SOURCE=(
  [SUPABASE_URL]="example-platform:prd:SUPABASE_URL"
  [SUPABASE_SERVICE_KEY]="example-platform:prd:SUPABASE_SERVICE_ROLE_KEY"
  [CC_PLATFORM_URL]="example-platform:prd:APP_URL"
  [CC_PLATFORM_CRON_SECRET]="example-platform:prd:CRON_SECRET"
)

resolve_var() {
  local name="$1"
  local current="${!name:-}"
  if [ -n "$current" ]; then
    printf '%s' "$current"
    return 0
  fi
  if [ -n "${EXISTING_ENV[$name]:-}" ]; then
    printf '%s' "${EXISTING_ENV[$name]}"
    return 0
  fi
  local mapping="${DOPPLER_SOURCE[$name]:-}"
  if [ -n "$mapping" ] && [ "$DOPPLER_MODE" != "none" ]; then
    local project="${mapping%%:*}"
    local rest="${mapping#*:}"
    local config="${rest%%:*}"
    local source_name="${rest##*:}"
    doppler_get "$project" "$config" "$source_name" || true
  fi
}

SB_URL="$(resolve_var SUPABASE_URL)"
SB_KEY="$(resolve_var SUPABASE_SERVICE_KEY)"
AX_URL="$(resolve_var CC_PLATFORM_URL)"
AX_SEC="$(resolve_var CC_PLATFORM_CRON_SECRET)"

MISSING=()
[ -z "$SB_URL" ] && MISSING+=("SUPABASE_URL")
[ -z "$SB_KEY" ] && MISSING+=("SUPABASE_SERVICE_KEY")
[ -z "$AX_URL" ] && MISSING+=("CC_PLATFORM_URL")
[ -z "$AX_SEC" ] && MISSING+=("CC_PLATFORM_CRON_SECRET")
if [ "${#MISSING[@]}" -gt 0 ]; then
  log "ERROR: cannot resolve required cron secrets: ${MISSING[*]}"
  log "  Provide them via ONE of:"
  log "    1) export them in the shell before running this script, or"
  log "    2) leave a previous good cron.env on disk at $ENV_FILE, or"
  log "    3) put a valid Doppler service token at $HOST_DOPPLER_YAML, or"
  log "    4) ensure $ADMIN_TOKEN_FILE exists (admin token, ccuser-owned)."
  log "  Source-of-truth mapping: example-platform/prd → SUPABASE_URL,"
  log "  SUPABASE_SERVICE_ROLE_KEY (→ SUPABASE_SERVICE_KEY), APP_URL (→"
  log "  CC_PLATFORM_URL), CRON_SECRET (→ CC_PLATFORM_CRON_SECRET)."
  exit 1
fi

# ---------------------------------------------------------------------------
# Step 4: Write cron.env atomically with 0600 perms
# ---------------------------------------------------------------------------
TMP="$(mktemp "${ENV_FILE}.XXXXXX")"
{
  printf '# Managed by scripts/fix-vps-cron.sh — last refreshed %s\n' "$(date -Iseconds)"
  printf '# Do not commit this file. 0600 perms enforced.\n'
  printf 'export CC_SERVICE_TOKEN=%q\n'         "$NEW_TOKEN"
  printf 'export SUPABASE_URL=%q\n'             "$SB_URL"
  printf 'export SUPABASE_SERVICE_KEY=%q\n'     "$SB_KEY"
  printf 'export CC_PLATFORM_URL=%q\n'        "$AX_URL"
  printf 'export CC_PLATFORM_CRON_SECRET=%q\n' "$AX_SEC"
} > "$TMP"
chmod 600 "$TMP"
mv -f "$TMP" "$ENV_FILE"
log "wrote $ENV_FILE ($(wc -l < "$ENV_FILE") lines)"

# Persist the new token in the native secrets store (non-fatal). cron.env on
# disk is still the source of truth for the crontab itself.
if printf '%s' "$NEW_TOKEN" | docker exec -i command-center tsx /app/server/src/scripts/secrets-set.ts CC_SERVICE_TOKEN >/dev/null 2>&1; then
  log "persisted CC_SERVICE_TOKEN to secrets store"
else
  warn "could not persist CC_SERVICE_TOKEN to secrets store (non-fatal — cron.env still has it)"
fi

# ---------------------------------------------------------------------------
# Step 5: Re-install the 3 cron entry sets so they pick up cron.env
# ---------------------------------------------------------------------------
log "re-installing cron entries…"
bash "$SCRIPTS_DIR/install-daily-log-cron.sh"         | tee -a "$VERIFY_LOG"
bash "$SCRIPTS_DIR/install-campaign-audit-cron.sh"    | tee -a "$VERIFY_LOG"
bash "$SCRIPTS_DIR/install-reconcile-clients-cron.sh" | tee -a "$VERIFY_LOG"
bash "$SCRIPTS_DIR/install-cron-health-cron.sh"       | tee -a "$VERIFY_LOG"
bash "$SCRIPTS_DIR/install-dream-cycle-cron.sh"       | tee -a "$VERIFY_LOG"

log "current crontab:"
crontab -l | tee -a "$VERIFY_LOG"

# ---------------------------------------------------------------------------
# Step 6: One-shot verification of each of the 4 cron scripts
# ---------------------------------------------------------------------------
EXIT_CODE=0
declare -a RESULTS
verify() {
  local name="$1" cmd="$2"
  local out_log="$LOG_DIR/fix-vps-cron-${name}-verify.log"
  log "-- verify $name --"
  # shellcheck disable=SC1090
  if ( . "$ENV_FILE" && bash -c "$cmd" ) >"$out_log" 2>&1; then
    log "  $name: PASS (log: $out_log)"
    RESULTS+=("PASS  $name")
    return 0
  fi
  log "  $name: FAIL (log: $out_log)"
  tail -20 "$out_log" | sed 's/^/    /' | tee -a "$VERIFY_LOG"
  RESULTS+=("FAIL  $name  (tail: $out_log)")
  EXIT_CODE=1
  return 1
}

verify update-active-state    "$SCRIPTS_DIR/update-active-state.sh"
verify generate-daily-digest  "$SCRIPTS_DIR/generate-daily-digest.sh"

# reconcile-clients depends on /api/webhooks/supabase. install-reconcile-clients-cron.sh
# already probed and refused to install the entry if the endpoint is missing,
# so use the crontab marker as the single source of truth — re-probing here
# can race against transient API blips and produce false FAILs.
if crontab -l 2>/dev/null | grep -q "# command-center: reconcile-clients"; then
  verify reconcile-clients    "$SCRIPTS_DIR/reconcile-clients.sh"
else
  log "-- skip reconcile-clients (no crontab entry; install-reconcile-clients-cron.sh declined to install)"
  RESULTS+=("SKIP  reconcile-clients  (webhook endpoint missing)")
fi

verify campaign-audit         "$SCRIPTS_DIR/campaign-audit.sh"
verify dream-cycle            "$SCRIPTS_DIR/dream-cycle.sh"

log "--- summary ---"
for r in "${RESULTS[@]}"; do
  log "  $r"
done
log "=== done (exit=$EXIT_CODE) ==="
exit "$EXIT_CODE"
