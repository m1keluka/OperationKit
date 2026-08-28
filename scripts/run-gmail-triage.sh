#!/usr/bin/env bash
# Hourly Gmail inbox triage — triggered by cron, calls the internal API.
# The server must be running and Gmail OAuth credentials must be in Doppler.
set -euo pipefail

RESULT=$(curl -s -X POST http://localhost:3002/api/internal/gmail-triage/run \
  -H 'Content-Type: application/json' \
  --max-time 120)

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $RESULT"
