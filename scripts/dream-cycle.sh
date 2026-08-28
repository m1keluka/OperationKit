#!/usr/bin/env bash
# dream-cycle.sh — nightly Dream Cycle runner.
#
# POSTs to the command-center /api/admin/dream-cycle endpoint to run the
# 4 consolidation phases (blockers, rollup, cleanup, index). The rollup phase
# is what populates `usage_count` / `failure_count` / `eval_score` in
# ~/ai-workspace/skills/registry.json from session_intel — the whole point of
# scheduling this on cron.
#
# Runs on the HOST (not inside the container). Auth uses the same long-lived
# admin JWT (CC_SERVICE_TOKEN) as the other crons; `requireAuth` accepts it
# via Authorization: Bearer.
#
# Env:
#   CC_SERVICE_TOKEN   required (Bearer token; provisioned via fix-vps-cron.sh)
#   CC_API_BASE        default http://localhost:3002
#   DREAM_PHASE        default 'all' — pass a single phase name to scope it
#   DREAM_LOG_DIR      default /home/operator/transcripts
#   DREAM_TIMEOUT      default 180   (seconds; index-rebuild can be slow)
#
# Exit codes:
#   0  all required phases succeeded (index phase failure is WARN-only)
#   1  HTTP error, malformed response, or any non-index phase failed
#
# The `index` phase depends on `~/ai-workspace/scripts/minions/index-rebuild.sh`
# finding a populated `Sources` directory under $SECOND_BRAIN. Until that's
# wired up that phase always fails — we surface it as WARN so the rest of the
# cycle is still considered healthy.

set -u -o pipefail

CC_API_BASE="${CC_API_BASE:-http://localhost:3002}"
SERVICE_TOKEN="${CC_SERVICE_TOKEN:-}"
PHASE="${DREAM_PHASE:-all}"
LOG_DIR="${DREAM_LOG_DIR:-/home/operator/transcripts}"
TIMEOUT="${DREAM_TIMEOUT:-180}"

mkdir -p "$LOG_DIR"
RUN_LOG="$LOG_DIR/dream-cycle.log"

log() { printf '[%s] %s\n' "$(date -Iseconds)" "$*" | tee -a "$RUN_LOG"; }
die() { log "FATAL: $*"; exit 1; }

command -v curl >/dev/null 2>&1 || die "curl not found on host"
command -v jq   >/dev/null 2>&1 || die "jq not found on host"
[ -n "$SERVICE_TOKEN" ] || die "CC_SERVICE_TOKEN not set (source ~/.config/command-center/cron.env)"

log "=== dream-cycle start (phase=$PHASE) ==="

RESP_FILE="$(mktemp)"
trap 'rm -f "$RESP_FILE"' EXIT

HTTP_CODE="$(curl -sS --max-time "$TIMEOUT" \
  -o "$RESP_FILE" -w '%{http_code}' \
  -X POST \
  -H "Authorization: Bearer $SERVICE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"phase\":\"$PHASE\"}" \
  "$CC_API_BASE/api/admin/dream-cycle" 2>>"$RUN_LOG")" || {
  die "curl failed talking to $CC_API_BASE/api/admin/dream-cycle"
}

if [ "$HTTP_CODE" != "200" ]; then
  log "HTTP $HTTP_CODE response body:"
  sed 's/^/  /' "$RESP_FILE" >>"$RUN_LOG"
  die "endpoint returned HTTP $HTTP_CODE"
fi

if ! jq -e 'type == "array"' "$RESP_FILE" >/dev/null 2>&1; then
  log "non-array response body:"
  sed 's/^/  /' "$RESP_FILE" >>"$RUN_LOG"
  die "malformed response (expected JSON array)"
fi

EXIT_CODE=0

# Per-phase status. A phase has failed if its results contain `error` or
# `status == "failed"`. The `index` phase is WARN-only (known-broken until
# index-rebuild.sh has its Sources dir).
while IFS= read -r row; do
  phase_name="$(echo "$row" | jq -r '.phase')"
  duration="$(echo "$row" | jq -r '.duration_ms')"
  failed="$(echo "$row" | jq -r '
    if (.results | type) != "object" then "false"
    elif (.results.error // null) != null then "true"
    elif (.results.status // null) == "failed" then "true"
    else "false" end
  ')"
  summary="$(echo "$row" | jq -c '.results')"

  if [ "$failed" = "true" ]; then
    if [ "$phase_name" = "index" ]; then
      log "  WARN  $phase_name (${duration}ms): $summary"
    else
      log "  FAIL  $phase_name (${duration}ms): $summary"
      EXIT_CODE=1
    fi
  else
    log "  PASS  $phase_name (${duration}ms): $summary"
  fi
done < <(jq -c '.[]' "$RESP_FILE")

log "=== dream-cycle done (exit=$EXIT_CODE) ==="
exit "$EXIT_CODE"
