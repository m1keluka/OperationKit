#!/usr/bin/env bash
# Start OpenHands container
# Runs standalone (not in docker-compose) because it needs host Docker socket
# and spawns sibling sandbox containers

set -euo pipefail

# Load env vars from /opt/stack/.env
if [ -f /opt/stack/.env ]; then
  set -a
  source /opt/stack/.env
  set +a
fi

OPENHANDS_IMAGE="docker.openhands.dev/openhands/openhands:1.6"
AGENT_SERVER_REPO="ghcr.io/openhands/agent-server"
AGENT_SERVER_TAG="1.15.0-python"
LITELLM_PROXY_URL="http://localhost:4000"
WORKSPACE_DIR="/opt/openhands-workspace"
CONFIG_DIR="/opt/openhands-state"

mkdir -p "${WORKSPACE_DIR}" "${CONFIG_DIR}"

# Stop existing container if running
docker rm -f openhands-app 2>/dev/null || true

docker run -d --pull=always \
  --name openhands-app \
  --restart unless-stopped \
  -e AGENT_SERVER_IMAGE_REPOSITORY="${AGENT_SERVER_REPO}" \
  -e AGENT_SERVER_IMAGE_TAG="${AGENT_SERVER_TAG}" \
  -e LLM_MODEL="litellm_proxy/orchestrator" \
  -e LLM_API_KEY="${LITELLM_MASTER_KEY}" \
  -e LLM_BASE_URL="${LITELLM_PROXY_URL}" \
  -e SANDBOX_VOLUMES="${WORKSPACE_DIR}:/workspace:rw" \
  -e LOG_ALL_EVENTS=true \
  -e MAX_ITERATIONS=200 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "${CONFIG_DIR}:/.openhands" \
  -p 127.0.0.1:3000:3000 \
  --add-host host.docker.internal:host-gateway \
  "${OPENHANDS_IMAGE}"

echo "OpenHands started on localhost:3000"
echo "Access via: https://oh.mikeluka.com (after Caddy is configured)"
echo ""
echo "Container logs: docker logs -f openhands-app"
