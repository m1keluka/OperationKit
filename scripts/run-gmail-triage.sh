#!/usr/bin/env bash
# Hourly Gmail inbox triage — triggered by cron, calls the internal API.
# The server must be running and Gmail OAuth credentials must be in Doppler.
set -euo pipefail

# obj 900027: loopback origin is still accepted, but send the shared secret so
# this cron keeps working under INTERNAL_API_REQUIRE_SECRET=1.
if [[ -z "${INTERNAL_API_SECRET:-}" ]]; then
  INTERNAL_API_SECRET="$(tsx /app/server/src/scripts/secrets-get.ts INTERNAL_API_SECRET 2>/dev/null || true)"
fi

RESULT=$(curl -s -X POST http://localhost:3002/api/internal/gmail-triage/run \
  -H 'Content-Type: application/json' \
  -H "X-Internal-Secret: ${INTERNAL_API_SECRET:-}" \
  --max-time 120)

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $RESULT"
