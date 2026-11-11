#!/usr/bin/env bash
# Granola meeting ingest — runs inside the command-center container every 15 min.
# Fetches new Granola transcripts, classifies via Claude, writes vault notes,
# and inserts action items into the pre-objective review queue.
set -euo pipefail

GRANOLA_KEY="$(docker exec command-center tsx /app/server/src/scripts/secrets-get.ts GRANOLA_API_KEY 2>/dev/null || true)"

if [ -z "$GRANOLA_KEY" ]; then
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] GRANOLA_API_KEY not available — skipping run"
  exit 0
fi

docker exec \
  -e "GRANOLA_API_KEY=$GRANOLA_KEY" \
  command-center \
  /usr/local/bin/tsx /app/server/src/scripts/granola-ingest.ts
