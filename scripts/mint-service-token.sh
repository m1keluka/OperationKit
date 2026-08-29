#!/usr/bin/env bash
# mint-service-token.sh — produce a long-lived admin JWT for service clients
# (e.g. the campaign-audit cron). The token is signed with the same JWT_SECRET
# the running server uses, so requireAuth accepts it via either cookie or
# `Authorization: Bearer <jwt>` header.
#
# Usage:
#   bash scripts/mint-service-token.sh               # 1 year expiry, mike admin
#   bash scripts/mint-service-token.sh 30d           # custom expiry
#   bash scripts/mint-service-token.sh 1y service-bot 0
#
# Prints the JWT to stdout. Store it in Doppler as CC_SERVICE_TOKEN and feed it
# to the cron via the env var of the same name.

set -euo pipefail

CONTAINER="${CC_CONTAINER:-command-center}"
EXPIRY="${1:-365d}"
USERNAME="${2:-operator}"
USER_ID="${3:-1}"

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "container '$CONTAINER' not running" >&2
  exit 1
fi

docker exec "$CONTAINER" node --input-type=module -e "
  import jwt from 'jsonwebtoken'
  const secret = process.env.JWT_SECRET
  if (!secret) { console.error('JWT_SECRET not set in container'); process.exit(1) }
  const token = jwt.sign(
    { id: Number('${USER_ID}'), username: '${USERNAME}', role: 'admin' },
    secret,
    { expiresIn: '${EXPIRY}' }
  )
  process.stdout.write(token + '\n')
"
