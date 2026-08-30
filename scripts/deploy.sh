#!/usr/bin/env bash
# Deploy the full stack after the host prerequisites are in place (install.sh)
# Deploy the full stack after ./install.sh has provisioned the host
# Usage: bash deploy.sh
# Run from /opt/stack (the infra repo root)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STACK_DIR="$(dirname "$SCRIPT_DIR")"
cd "$STACK_DIR"

echo "========================================"
echo "  Deploying OperationKit"
echo "========================================"

# ──────────────────────────────────────────────
# 0. Check prerequisites
# ──────────────────────────────────────────────
command -v docker >/dev/null || { echo "ERROR: docker not found. Run ./install.sh first." >&2; exit 1; }
command -v caddy >/dev/null || { echo "ERROR: caddy not found. Run ./install.sh first." >&2; exit 1; }
[ -f .env ] || { echo "ERROR: .env not found. Copy .env.example and fill in real values." >&2; exit 1; }

echo "[1/5] Loading env..."
set -a
source .env
set +a

# Verify required keys exist
for KEY in LITELLM_MASTER_KEY LITELLM_SALT_KEY POSTGRES_PASSWORD ANTHROPIC_API_KEY OPENAI_API_KEY GEMINI_API_KEY; do
  [ -n "${!KEY:-}" ] || { echo "ERROR: $KEY is empty in .env" >&2; exit 1; }
done
echo "  All required keys present."

# ──────────────────────────────────────────────
# 1. Pre-pull images (parallel)
# ──────────────────────────────────────────────
echo "[2/5] Pulling images..."
docker pull docker.litellm.ai/berriai/litellm-database:v1.83.3-stable &
docker pull postgres:16 &
docker pull docker.openhands.dev/openhands/openhands:1.6 &
docker pull ghcr.io/openhands/agent-server:1.15.0-python &
wait
echo "  All images pulled."

# ──────────────────────────────────────────────
# 2. Start LiteLLM + Postgres
# ──────────────────────────────────────────────
echo "[3/5] Starting LiteLLM stack..."
docker compose up -d
echo "  Waiting for LiteLLM health..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:4000/health/liveliness >/dev/null 2>&1; then
    echo "  LiteLLM healthy after ${i}s"
    break
  fi
  [ "$i" -eq 30 ] && { echo "ERROR: LiteLLM failed to become healthy in 30s"; docker compose logs litellm | tail -20; exit 1; }
  sleep 1
done

# ──────────────────────────────────────────────
# 3. Start OpenHands
# ──────────────────────────────────────────────
echo "[4/5] Starting OpenHands..."
bash scripts/start-openhands.sh
echo "  Waiting for OpenHands..."
for i in $(seq 1 60); do
  if curl -sf http://localhost:3000 >/dev/null 2>&1; then
    echo "  OpenHands responding after ${i}s"
    break
  fi
  [ "$i" -eq 60 ] && echo "  WARNING: OpenHands not responding yet (may still be starting)"
  sleep 1
done

# ──────────────────────────────────────────────
# 4. Configure Caddy
# ──────────────────────────────────────────────
echo "[5/5] Reloading Caddy..."
cp config/caddy/Caddyfile /etc/caddy/Caddyfile
caddy reload --config /etc/caddy/Caddyfile 2>/dev/null || systemctl reload caddy

echo ""
echo "========================================"
echo "  Stack deployed!"
echo "========================================"
echo ""
echo "Services:"
echo "  OpenHands UI:   https://${OPENHANDS_DOMAIN:-oh.${CC_DOMAIN:-cc.example.com}}"
echo "  LiteLLM Proxy:  https://${LITELLM_DOMAIN:-llm.${CC_DOMAIN:-cc.example.com}}"
echo "  OpenHands UI:   https://oh.${CC_DOMAIN:-cc.example.com}"
echo "  LiteLLM Proxy:  https://llm.${CC_DOMAIN:-cc.example.com}"
echo "  LiteLLM API:    http://localhost:4000"
echo ""
echo "Verify:"
echo "  curl -s http://localhost:4000/health/liveliness"
echo "  curl -s http://localhost:3000"
echo "  docker ps"
echo ""
echo "Logs:"
echo "  docker compose logs -f litellm"
echo "  docker logs -f openhands-app"
