#!/usr/bin/env bash
# setup-hermes.sh — Install and configure Hermes agent on the VPS
# Run this as user 'mike' on the VPS host (not inside Docker).
#
# Usage:
#   bash /home/operator/projects/command-center-infra/scripts/setup-hermes.sh [install|gateway|status|uninstall]
#
# Phases:
#   install  — Create virtualenv, pip install, write config (Phase 0)
#   gateway  — Create systemd service, enable + start (Phase 1)
#   status   — Check if Hermes is running and healthy
#   uninstall — Stop service, remove virtualenv (reversible)

set -euo pipefail

HERMES_HOME="/home/operator/.hermes"
VENV_DIR="/home/operator/.hermes-venv"
SERVICE_FILE="/etc/systemd/system/hermes-gateway.service"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[hermes]${NC} $*"; }
warn() { echo -e "${YELLOW}[hermes]${NC} $*"; }
err()  { echo -e "${RED}[hermes]${NC} $*" >&2; }

# ─── Phase 0: Install ──────────────────────────────────────────────────────

do_install() {
  log "Phase 0: Installing Hermes agent..."

  # Check Python
  if ! command -v python3 &>/dev/null; then
    err "Python 3 not found. Install with: sudo apt install python3 python3-venv python3-pip"
    exit 1
  fi

  PYTHON_VERSION=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
  log "Python version: $PYTHON_VERSION"

  # Create virtualenv
  if [ -d "$VENV_DIR" ]; then
    warn "Virtualenv already exists at $VENV_DIR — reusing"
  else
    log "Creating virtualenv at $VENV_DIR..."
    python3 -m venv "$VENV_DIR"
  fi

  # Activate and install
  source "$VENV_DIR/bin/activate"
  log "Installing hermes-agent..."
  pip install --upgrade pip
  pip install hermes-agent

  # Post-install
  log "Running hermes postinstall..."
  hermes postinstall || true

  # Create HERMES_HOME if it doesn't exist
  mkdir -p "$HERMES_HOME"

  # LiteLLM master key: native store, then env-master.
  LITELLM_KEY=""
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx command-center; then
    LITELLM_KEY=$(docker exec command-center tsx /app/server/src/scripts/secrets-get.ts LITELLM_MASTER_KEY 2>/dev/null || true)
  fi
  if [ -z "$LITELLM_KEY" ] && [ -f /home/operator/env-master/litellm.env ]; then
    LITELLM_KEY=$(grep LITELLM_MASTER_KEY /home/operator/env-master/litellm.env | cut -d= -f2)
  fi

  if [ -z "$LITELLM_KEY" ]; then
    warn "Could not find LITELLM_MASTER_KEY — you'll need to set it manually in $HERMES_HOME/.env"
  fi

  # Write .env if it doesn't exist
  if [ ! -f "$HERMES_HOME/.env" ]; then
    log "Writing $HERMES_HOME/.env..."
    cat > "$HERMES_HOME/.env" <<ENVEOF
# Hermes environment — LiteLLM proxy as backend
OPENAI_API_BASE=http://localhost:4000
OPENAI_API_KEY=${LITELLM_KEY:-REPLACE_WITH_LITELLM_MASTER_KEY}

# Telegram gateway — set this to enable Telegram messaging
# Create a bot via @BotFather and paste the token here
TELEGRAM_BOT_TOKEN=REPLACE_WITH_TELEGRAM_BOT_TOKEN
ENVEOF
  else
    warn ".env already exists — skipping (edit manually if needed)"
  fi

  # Write config.yaml if it doesn't exist
  if [ ! -f "$HERMES_HOME/config.yaml" ]; then
    log "Writing $HERMES_HOME/config.yaml..."
    cat > "$HERMES_HOME/config.yaml" <<'CFGEOF'
# Hermes Agent Configuration
# Model backend: LiteLLM proxy on localhost:4000
# Available model groups: orchestrator, research, code, writing, reasoning, hermes

model: hermes
api_base: http://localhost:4000

# Terminal: local execution (Hermes runs on the VPS host)
terminal:
  type: local
  persistent_shell: true

# Memory
memory:
  provider: default

# MCP servers — command-center integration (Phase 6)
# mcp_servers:
#   command-center:
#     type: stdio
#     command: node
#     args: [/home/operator/projects/command-center-infra/scripts/hermes-mcp-server.js]
CFGEOF
  else
    warn "config.yaml already exists — skipping"
  fi

  # Seed memory files
  mkdir -p "$HERMES_HOME/memories"
  if [ -f /home/operator/projects/command-center-infra/scripts/hermes-seeds/MEMORY.md ]; then
    if [ ! -f "$HERMES_HOME/memories/MEMORY.md" ]; then
      cp /home/operator/projects/command-center-infra/scripts/hermes-seeds/MEMORY.md "$HERMES_HOME/memories/MEMORY.md"
      log "Seeded MEMORY.md"
    fi
  fi
  if [ -f /home/operator/projects/command-center-infra/scripts/hermes-seeds/USER.md ]; then
    if [ ! -f "$HERMES_HOME/memories/USER.md" ]; then
      cp /home/operator/projects/command-center-infra/scripts/hermes-seeds/USER.md "$HERMES_HOME/memories/USER.md"
      log "Seeded USER.md"
    fi
  fi

  log "Phase 0 complete! Test with: source $VENV_DIR/bin/activate && hermes chat"
  log ""
  log "Next steps:"
  log "  1. Set TELEGRAM_BOT_TOKEN in $HERMES_HOME/.env"
  log "  2. Run: bash $0 gateway"
}

# ─── Phase 1: Gateway systemd service ──────────────────────────────────────

do_gateway() {
  log "Phase 1: Setting up Hermes gateway service..."

  if [ ! -d "$VENV_DIR" ]; then
    err "Virtualenv not found at $VENV_DIR — run 'install' first"
    exit 1
  fi

  # Check Telegram token is set
  if grep -q "REPLACE_WITH_TELEGRAM_BOT_TOKEN" "$HERMES_HOME/.env" 2>/dev/null; then
    warn "TELEGRAM_BOT_TOKEN not set in $HERMES_HOME/.env"
    warn "The gateway will start but Telegram messaging won't work until you set it."
  fi

  # Write systemd service
  log "Writing systemd service to $SERVICE_FILE..."
  sudo tee "$SERVICE_FILE" > /dev/null <<SVCEOF
[Unit]
Description=Hermes Agent Gateway
After=network.target docker.service
Wants=network.target

[Service]
Type=simple
User=mike
Group=mike
Environment=HERMES_HOME=$HERMES_HOME
Environment=PATH=$VENV_DIR/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=$VENV_DIR/bin/hermes gateway run
WorkingDirectory=/home/mike
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=hermes

[Install]
WantedBy=multi-user.target
SVCEOF

  sudo systemctl daemon-reload
  sudo systemctl enable hermes-gateway
  sudo systemctl start hermes-gateway

  log "Gateway service started!"
  log "Check status: sudo systemctl status hermes-gateway"
  log "View logs:    journalctl -u hermes-gateway -f"
}

# ─── Status check ──────────────────────────────────────────────────────────

do_status() {
  echo "=== Hermes Agent Status ==="
  echo ""

  # Virtualenv
  if [ -d "$VENV_DIR" ]; then
    log "Virtualenv: $VENV_DIR (exists)"
    HERMES_VERSION=$("$VENV_DIR/bin/hermes" --version 2>/dev/null || echo "unknown")
    log "Version: $HERMES_VERSION"
  else
    warn "Virtualenv: not installed"
  fi

  # Config
  if [ -f "$HERMES_HOME/config.yaml" ]; then
    log "Config: $HERMES_HOME/config.yaml (exists)"
  else
    warn "Config: not found"
  fi

  # Memory
  if [ -f "$HERMES_HOME/memories/MEMORY.md" ]; then
    LINES=$(wc -l < "$HERMES_HOME/memories/MEMORY.md")
    log "MEMORY.md: $LINES lines"
  else
    warn "MEMORY.md: not seeded"
  fi

  # Gateway service
  if systemctl is-active --quiet hermes-gateway 2>/dev/null; then
    log "Gateway: running"
  else
    warn "Gateway: not running"
  fi

  # LiteLLM connectivity
  if curl -sf http://localhost:4000/health/liveliness > /dev/null 2>&1; then
    log "LiteLLM: healthy (localhost:4000)"
  else
    warn "LiteLLM: not reachable"
  fi

  # Command Center connectivity
  if curl -sf http://localhost:3002/api/health > /dev/null 2>&1; then
    log "Command Center: healthy (localhost:3002)"
  else
    warn "Command Center: not reachable"
  fi
}

# ─── Uninstall ─────────────────────────────────────────────────────────────

do_uninstall() {
  warn "Stopping and removing Hermes gateway..."

  if systemctl is-active --quiet hermes-gateway 2>/dev/null; then
    sudo systemctl stop hermes-gateway
  fi
  if [ -f "$SERVICE_FILE" ]; then
    sudo systemctl disable hermes-gateway 2>/dev/null || true
    sudo rm "$SERVICE_FILE"
    sudo systemctl daemon-reload
  fi

  warn "Removing virtualenv at $VENV_DIR..."
  rm -rf "$VENV_DIR"

  log "Uninstalled. Config and memory preserved at $HERMES_HOME"
  log "To fully remove: rm -rf $HERMES_HOME"
}

# ─── Main ──────────────────────────────────────────────────────────────────

case "${1:-install}" in
  install)   do_install ;;
  gateway)   do_gateway ;;
  status)    do_status ;;
  uninstall) do_uninstall ;;
  *)
    echo "Usage: $0 [install|gateway|status|uninstall]"
    exit 1
    ;;
esac
