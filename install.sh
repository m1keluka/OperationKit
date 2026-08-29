#!/usr/bin/env bash
# ==============================================================================
# OperationKit installer
# ------------------------------------------------------------------------------
# Idempotent, safe to re-run. On a fresh Ubuntu 24.04 droplet it:
#   1. verifies OS + that Docker (with the compose plugin) is present, installing
#      Docker from the official repo if it is missing;
#   2. creates .env from .env.example if absent;
#   3. GENERATES strong random secrets for every secret var that is still empty
#      or a placeholder (LiteLLM keys, Postgres password, JWT, internal API
#      secret, 32-byte base64 encryption keys) — existing values are preserved;
#   4. PROMPTS only for the minimal provider key (ANTHROPIC_API_KEY) and the
#      public domain, or accepts them non-interactively via flags/env;
#   5. generates a single-site Caddyfile from your domain (auto-TLS), and creates
#      every host directory the default compose service bind-mounts;
#   6. brings up the docker compose stack (app + LiteLLM bound to loopback;
#      only Caddy is public);
#   7. runs a health-check loop against LiteLLM /health and the app port and
#      prints the URL + next steps.
#
# Usage:
#   sudo ./install.sh                      # interactive
#   sudo ./install.sh --non-interactive \
#        --domain cc.example.com --acme-email you@example.com \
#        --anthropic-key sk-ant-xxx        # hands-off
#   ANTHROPIC_API_KEY=sk-ant-xxx CC_DOMAIN=cc.example.com ./install.sh --non-interactive
#
# Flags:
#   --domain <d>          public domain for Caddy auto-TLS (or CC_DOMAIN env)
#   --acme-email <e>      Let's Encrypt contact email (or CADDY_ACME_EMAIL env)
#   --anthropic-key <k>   Anthropic API key (or ANTHROPIC_API_KEY env)
#   --openai-key <k>      optional OpenAI key   (or OPENAI_API_KEY env)
#   --gemini-key <k>      optional Gemini key   (or GEMINI_API_KEY env)
#   --core-only           bring up just LiteLLM + its DB (skip the app service)
#   --no-up               generate .env + Caddyfile but do not start containers
#   --non-interactive     never prompt; fail if a required value is missing
#   -h | --help           show this help
# ==============================================================================

set -euo pipefail

# ──────────────────────────────────────────────────────────────────────────────
# Locate the repo (this script lives at the repo root)
# ──────────────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
ENV_FILE="$SCRIPT_DIR/.env"
ENV_EXAMPLE="$SCRIPT_DIR/.env.example"

# ──────────────────────────────────────────────────────────────────────────────
# Defaults + flag parsing
# ──────────────────────────────────────────────────────────────────────────────
INTERACTIVE=1
DO_UP=1
CORE_ONLY=0
DOMAIN="${CC_DOMAIN:-}"
ACME_EMAIL="${CADDY_ACME_EMAIL:-}"
ANTHROPIC_KEY="${ANTHROPIC_API_KEY:-}"
OPENAI_KEY="${OPENAI_API_KEY:-}"
GEMINI_KEY="${GEMINI_API_KEY:-}"

usage() { sed -n '2,36p' "$0" | sed 's/^# \{0,1\}//'; exit 0; }

while [ $# -gt 0 ]; do
  case "$1" in
    --domain)         DOMAIN="$2"; shift 2 ;;
    --acme-email)     ACME_EMAIL="$2"; shift 2 ;;
    --anthropic-key)  ANTHROPIC_KEY="$2"; shift 2 ;;
    --openai-key)     OPENAI_KEY="$2"; shift 2 ;;
    --gemini-key)     GEMINI_KEY="$2"; shift 2 ;;
    --core-only)      CORE_ONLY=1; shift ;;
    --no-up)          DO_UP=0; shift ;;
    --non-interactive) INTERACTIVE=0; shift ;;
    -h|--help)        usage ;;
    *) echo "Unknown option: $1" >&2; echo "Run with --help." >&2; exit 2 ;;
  esac
done

log()  { printf '\033[1;36m[install]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

# ──────────────────────────────────────────────────────────────────────────────
# .env helpers — position-preserving upsert (safe for base64/slash/+ values)
# ──────────────────────────────────────────────────────────────────────────────
get_env() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true; }

set_env() {
  # set_env KEY VALUE — replaces the first "KEY=" line in place, or appends.
  local key="$1" val="$2" tmp
  tmp="$(mktemp)"
  awk -v k="$key" -v v="$val" '
    BEGIN { done = 0 }
    (!done && index($0, k "=") == 1) { print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }
  ' "$ENV_FILE" > "$tmp"
  mv "$tmp" "$ENV_FILE"
}

is_placeholder() {
  local v="$1"
  [ -z "$v" ] || case "$v" in *REPLACE_ME*|*change-me*) return 0 ;; esac
  return 1
}

# Generators (openssl is present on Ubuntu; installed by ensure_docker deps too)
rand_hex()  { openssl rand -hex 32; }
rand_b64()  { openssl rand -base64 32; }       # decodes to exactly 32 bytes
rand_sk()   { printf 'sk-%s' "$(openssl rand -hex 24)"; }

# ──────────────────────────────────────────────────────────────────────────────
# 0. Sanity: OS + privileges
# ──────────────────────────────────────────────────────────────────────────────
log "OperationKit installer starting in $SCRIPT_DIR"

# Root is only needed to INSTALL packages / write /etc/caddy. If we're already
# root, no prefix; if sudo exists, use it; otherwise leave empty and only fail
# later inside a step that genuinely needs privilege.
if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
elif command -v sudo >/dev/null 2>&1; then
  SUDO="sudo"
else
  SUDO=""
  warn "Not root and sudo not found — steps needing privilege (installing Docker/Caddy) will fail if reached."
fi

need_root() {
  # need_root "action" — die only when a privileged step is actually required
  if [ "$(id -u)" -ne 0 ] && [ -z "$SUDO" ]; then
    die "Need root (or sudo) to $1. Re-run as root."
  fi
}

if ! grep -q "24.04" /etc/os-release 2>/dev/null; then
  warn "Expected Ubuntu 24.04. Found: $(. /etc/os-release 2>/dev/null; echo "${PRETTY_NAME:-unknown}"). Continuing."
fi

# ──────────────────────────────────────────────────────────────────────────────
# 1. Ensure Docker + compose plugin
# ──────────────────────────────────────────────────────────────────────────────
ensure_docker() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    log "Docker present: $(docker --version)"
    return
  fi
  need_root "install Docker"
  log "Installing Docker Engine + compose plugin (official repo)..."
  $SUDO apt-get update -qq
  $SUDO apt-get install -y -qq ca-certificates curl gnupg openssl
  $SUDO install -m 0755 -d /etc/apt/keyrings
  if [ ! -f /etc/apt/keyrings/docker.gpg ]; then
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
      | $SUDO gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    $SUDO chmod a+r /etc/apt/keyrings/docker.gpg
  fi
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    | $SUDO tee /etc/apt/sources.list.d/docker.list >/dev/null
  $SUDO apt-get update -qq
  $SUDO apt-get install -y -qq docker-ce docker-ce-cli containerd.io \
    docker-buildx-plugin docker-compose-plugin
  $SUDO systemctl enable --now docker
  log "Docker installed: $(docker --version)"
}
ensure_docker

# openssl is required for secret generation
command -v openssl >/dev/null 2>&1 || die "openssl not found (needed to generate secrets)."

# docker compose wrapper (respects sudo when the invoking user isn't in docker group)
DC() {
  if docker info >/dev/null 2>&1; then docker compose "$@"; else $SUDO docker compose "$@"; fi
}

# ──────────────────────────────────────────────────────────────────────────────
# 2. Create .env from .env.example (idempotent)
# ──────────────────────────────────────────────────────────────────────────────
[ -f "$ENV_EXAMPLE" ] || die ".env.example not found at $ENV_EXAMPLE"
if [ ! -f "$ENV_FILE" ]; then
  cp "$ENV_EXAMPLE" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  log "Created .env from .env.example"
else
  log ".env already exists — preserving existing values"
fi

# ──────────────────────────────────────────────────────────────────────────────
# 3. Generate secrets when absent/placeholder
# ──────────────────────────────────────────────────────────────────────────────
gen_if_needed() {
  # gen_if_needed KEY GENERATOR_FN
  local key="$1" genfn="$2" cur
  cur="$(get_env "$key")"
  if is_placeholder "$cur"; then
    set_env "$key" "$($genfn)"
    log "  generated $key"
  else
    log "  kept existing $key"
  fi
}

log "Ensuring secrets..."
gen_if_needed LITELLM_MASTER_KEY       rand_sk
gen_if_needed LITELLM_SALT_KEY         rand_sk
gen_if_needed POSTGRES_PASSWORD        rand_hex
gen_if_needed CC_JWT_SECRET            rand_hex
gen_if_needed INTERNAL_API_SECRET      rand_hex
gen_if_needed SECRETS_MASTER_KEY       rand_b64
gen_if_needed TEST_CRED_ENCRYPTION_KEY rand_b64

# ──────────────────────────────────────────────────────────────────────────────
# 4. Provider key + domain (prompt only when needed)
# ──────────────────────────────────────────────────────────────────────────────
prompt_or_fail() {
  # prompt_or_fail VARNAME "Prompt text" [allow_empty]
  local __var="$1" __msg="$2" __allow="${3:-0}" __val
  eval "__val=\${$__var}"
  if [ -n "$__val" ]; then return; fi
  if [ "$INTERACTIVE" -eq 1 ]; then
    read -r -p "$__msg" __val
    eval "$__var=\$__val"
  fi
  eval "__val=\${$__var}"
  if [ -z "$__val" ] && [ "$__allow" -ne 1 ]; then
    die "Missing required value ($__var). Provide it via flag/env or run interactively."
  fi
}

# Anthropic key: required unless already present in .env
CUR_ANTHROPIC="$(get_env ANTHROPIC_API_KEY)"
if [ -z "$ANTHROPIC_KEY" ] && ! is_placeholder "$CUR_ANTHROPIC"; then
  ANTHROPIC_KEY="$CUR_ANTHROPIC"
fi
prompt_or_fail ANTHROPIC_KEY "Anthropic API key (sk-ant-...): "
set_env ANTHROPIC_API_KEY "$ANTHROPIC_KEY"
[ -n "$OPENAI_KEY" ] && set_env OPENAI_API_KEY "$OPENAI_KEY"
[ -n "$GEMINI_KEY" ] && set_env GEMINI_API_KEY "$GEMINI_KEY"

# Domain + ACME email for Caddy
CUR_DOMAIN="$(get_env CC_DOMAIN)"
if [ -z "$DOMAIN" ] && ! is_placeholder "$CUR_DOMAIN" && [ "$CUR_DOMAIN" != "cc.example.com" ]; then
  DOMAIN="$CUR_DOMAIN"
fi
prompt_or_fail DOMAIN "Public domain (DNS A record already pointing here, e.g. cc.example.com): "
set_env CC_DOMAIN "$DOMAIN"

CUR_ACME="$(get_env CADDY_ACME_EMAIL)"
if [ -z "$ACME_EMAIL" ] && ! is_placeholder "$CUR_ACME" && [ "$CUR_ACME" != "admin@example.com" ]; then
  ACME_EMAIL="$CUR_ACME"
fi
prompt_or_fail ACME_EMAIL "Email for Let's Encrypt notices: " 1
[ -n "$ACME_EMAIL" ] && set_env CADDY_ACME_EMAIL "$ACME_EMAIL"

# ──────────────────────────────────────────────────────────────────────────────
# 5. Generate a single-site Caddyfile from the domain (auto-TLS, loopback proxy)
# ──────────────────────────────────────────────────────────────────────────────
CADDY_OUT="$SCRIPT_DIR/config/caddy/Caddyfile.generated"
mkdir -p "$SCRIPT_DIR/config/caddy"
{
  [ -n "$ACME_EMAIL" ] && printf '{\n\temail %s\n}\n\n' "$ACME_EMAIL"
  cat <<CADDY
# Generated by install.sh — single public site with auto-TLS.
# Only this vhost is exposed; the app + LiteLLM stay bound to 127.0.0.1.
${DOMAIN} {
	encode zstd gzip
	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		X-Content-Type-Options "nosniff"
		X-Frame-Options "DENY"
		Referrer-Policy "strict-origin-when-cross-origin"
	}
	reverse_proxy 127.0.0.1:3002 {
		flush_interval -1
	}
}
CADDY
} > "$CADDY_OUT"
log "Wrote $CADDY_OUT"

if command -v caddy >/dev/null 2>&1 && { [ "$(id -u)" -eq 0 ] || [ -n "$SUDO" ]; }; then
  $SUDO install -D -m 0644 "$CADDY_OUT" /etc/caddy/Caddyfile
  $SUDO systemctl reload caddy 2>/dev/null || $SUDO systemctl restart caddy 2>/dev/null || \
    warn "Could not reload caddy — reload it manually after verifying /etc/caddy/Caddyfile."
  log "Installed Caddyfile to /etc/caddy/Caddyfile and reloaded Caddy"
else
  warn "Caddy not installed on host. Install it (see docs/DIGITALOCEAN.md) then copy $CADDY_OUT to /etc/caddy/Caddyfile."
fi

# ──────────────────────────────────────────────────────────────────────────────
# 5b. Create every host directory the default compose service bind-mounts
# ──────────────────────────────────────────────────────────────────────────────
# Docker REFUSES to start a service whose bind-mount source directory is missing
# (and silently creates a *directory* where a file was meant), so a fresh droplet
# must have these before the first `docker compose up`. This list mirrors the
# `command-center` service `volumes:` block in docker-compose.yml exactly, minus
# /var/run/docker.sock (provided by the Docker daemon itself).
#
# The paths are literal /home/operator/... because docker-compose.yml hardcodes
# that prefix; keep the two lists in sync when you change either.
OPERATOR_HOME=/home/operator

log "Creating host directories for compose bind-mounts under $OPERATOR_HOME ..."
$SUDO mkdir -p \
  "$OPERATOR_HOME/data/command-center" \
  "$OPERATOR_HOME/ai-workspace" \
  "$OPERATOR_HOME/second-brain" \
  "$OPERATOR_HOME/projects" \
  "$OPERATOR_HOME/transcripts" \
  "$OPERATOR_HOME/assistant" \
  "$OPERATOR_HOME/.claude-auth" \
  "$OPERATOR_HOME/.ccuser-a" \
  "$OPERATOR_HOME/.ccuser-b" \
  "$OPERATOR_HOME/.ccuser-c" \
  "$OPERATOR_HOME/.ccuser-d" \
  "$OPERATOR_HOME/.ccuser-e" \
  "$OPERATOR_HOME/.ccuser-codex" \
  "$OPERATOR_HOME/.ssh" \
  "$OPERATOR_HOME/.config/gh" \
  "$OPERATOR_HOME/.doppler"

# .ssh holds the deploy key used for git push from sessions; OpenSSH refuses to
# use a world-readable key directory.
$SUDO chmod 700 "$OPERATOR_HOME/.ssh"
log "Host bind-mount directories ready"

# ──────────────────────────────────────────────────────────────────────────────
# 6. Validate compose + bring up the stack
# ──────────────────────────────────────────────────────────────────────────────
log "Validating docker compose config..."
DC config >/dev/null || die "docker compose config failed — check .env values above."

if [ "$DO_UP" -eq 0 ]; then
  log "--no-up set: .env and Caddyfile generated; not starting containers."
  exit 0
fi

if [ "$CORE_ONLY" -eq 1 ]; then
  log "Starting core services (litellm-db, litellm)..."
  DC up -d litellm-db litellm
else
  log "Starting full stack (docker compose up -d)..."
  DC up -d
fi

# ──────────────────────────────────────────────────────────────────────────────
# 7. Health-check loop
# ──────────────────────────────────────────────────────────────────────────────
wait_health() {
  # wait_health "label" "url" max_seconds
  local label="$1" url="$2" max="$3" waited=0
  log "Waiting for $label ($url)..."
  while [ "$waited" -lt "$max" ]; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      log "  $label healthy after ${waited}s"
      return 0
    fi
    sleep 5; waited=$((waited + 5))
  done
  warn "  $label did not become healthy within ${max}s (check: DC logs)"
  return 1
}

RC=0
wait_health "LiteLLM" "http://127.0.0.1:4000/health/liveliness" 120 || RC=1
if [ "$CORE_ONLY" -ne 1 ]; then
  wait_health "Command Center app" "http://127.0.0.1:3002/api/health" 180 || RC=1
fi

echo
log "========================================"
if [ "$RC" -eq 0 ]; then
  log " OperationKit is up."
else
  warn " OperationKit started with health warnings — inspect 'docker compose logs'."
fi
log "========================================"
echo "  App URL:     https://${DOMAIN}   (via Caddy, once DNS + TLS resolve)"
echo "  App (local): http://127.0.0.1:3002/api/health"
echo "  LiteLLM:     http://127.0.0.1:4000/health/liveliness  (loopback only)"
echo
echo "  Secrets live in .env (mode 600, gitignored). Re-running this installer is safe."
echo "  Next: create your admin user / review docs/DIGITALOCEAN.md for DNS + firewall."
exit "$RC"
