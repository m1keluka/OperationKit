#!/usr/bin/env bash
# notify-failure.sh — report a cron job failure into the Command Center alerts feed.
#
# Usage: notify-failure.sh JOB_NAME EXIT_CODE [LOG_PATH]
#
# Reads ALERTS_API_TOKEN (and optionally ALERTS_API_URL) from the environment
# (sourced from ~/.config/command-center/cron.env in cron context). Hits the
# /api/alerts ingest endpoint, which writes to the in-app feed and — for
# severity=high+ — emails via Resend.
#
# If ALERTS_API_TOKEN is missing, logs a warning to stderr and exits 0 —
# alerting must never mask the underlying job failure (the cron's stdout/
# stderr still goes to the per-job log file).
#
# Honors ALERTS_ENABLED=false as a kill switch (matches notifier.ts).

set -u

job="${1:?job name required}"
exit_code="${2:?exit code required}"
log_path="${3:-}"

if [ "${ALERTS_ENABLED:-}" = "false" ]; then
  exit 0
fi

if [ -z "${ALERTS_API_TOKEN:-}" ]; then
  echo "[notify-failure] ALERTS_API_TOKEN missing — alert dropped for '$job' (exit=$exit_code)" >&2
  exit 0
fi

api_url="${ALERTS_API_URL:-http://127.0.0.1:3002/api/alerts}"

# Tail the last 800 chars of the log so the alert message stays compact.
tail_text=""
if [ -n "$log_path" ] && [ -f "$log_path" ]; then
  tail_text="$(tail -c 800 "$log_path" 2>/dev/null || true)"
fi

host="$(hostname -s 2>/dev/null || echo unknown)"
title="cron failed: $job"
message="$(printf 'host=%s exit=%s\n\n%s' "$host" "$exit_code" "$tail_text")"

# Build JSON safely via jq if available, else hand-escape.
if command -v jq >/dev/null 2>&1; then
  payload="$(jq -n \
    --arg severity "high" \
    --arg source "cron:$job" \
    --arg title "$title" \
    --arg message "$message" \
    --arg dedup_key "cron:$job:$exit_code" \
    '{severity:$severity, source:$source, title:$title, message:$message, dedup_key:$dedup_key}')"
else
  esc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e ':a;N;$!ba;s/\n/\\n/g'; }
  payload="$(printf '{"severity":"high","source":"cron:%s","title":"%s","message":"%s","dedup_key":"cron:%s:%s"}' \
    "$(esc "$job")" "$(esc "$title")" "$(esc "$message")" "$(esc "$job")" "$exit_code")"
fi

curl -sS --max-time 10 \
  -H "Authorization: Bearer $ALERTS_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -X POST "$api_url" \
  --data "$payload" >/dev/null \
  || echo "[notify-failure] alerts POST failed for '$job'" >&2

exit 0
