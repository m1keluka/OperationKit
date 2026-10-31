#!/usr/bin/env bash
# Switch a starter pack on or off, or list them (obj 719936).
#
#   scripts/starter-pack.sh status
#   scripts/starter-pack.sh enable  <pack-id> --workspace <ws> [--no-sample-data] [--dry-run]
#   scripts/starter-pack.sh disable <pack-id> --workspace <ws>
#
# Works from the server host (talks to the app container) or from inside the
# container. Sample data is ON by default; --no-sample-data skips it.
# The internal API secret is read inside the container and never printed.
set -euo pipefail

usage() { sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

ACTION="${1:-}"; [ -n "$ACTION" ] || usage 1; shift
PACK=""; WS=""; SAMPLES=true; DRY=false
case "$ACTION" in
  status|list) ;;
  enable|disable) PACK="${1:-}"; [ -n "$PACK" ] || usage 1; shift ;;
  -h|--help) usage 0 ;;
  *) echo "Unknown action: $ACTION" >&2; usage 1 ;;
esac
while [ $# -gt 0 ]; do
  case "$1" in
    --workspace) WS="${2:-}"; shift 2 ;;
    --workspace=*) WS="${1#*=}"; shift ;;
    --no-sample-data) SAMPLES=false; shift ;;
    --dry-run) DRY=true; shift ;;
    -h|--help) usage 0 ;;
    *) echo "Unknown option: $1" >&2; usage 1 ;;
  esac
done
if [[ "$ACTION" == enable || "$ACTION" == disable ]]; then
  [ -n "$WS" ] || { echo "--workspace <slug> is required" >&2; exit 1; }
  [[ "$PACK" =~ ^[a-z0-9][a-z0-9-]+$ ]] || { echo "Bad pack id: $PACK" >&2; exit 1; }
  [[ "$WS" =~ ^[A-Za-z0-9][A-Za-z0-9_-]*$ ]] || { echo "Bad workspace: $WS" >&2; exit 1; }
fi

PORT="${PORT:-3002}"
if [[ "$ACTION" == status || "$ACTION" == list ]]; then
  METHOD=GET; URLPATH="/api/internal/starter-packs"; BODY=""
else
  METHOD=POST; URLPATH="/api/internal/starter-packs/$PACK/$ACTION"
  BODY="{\"workspace\":\"$WS\",\"with_samples\":$SAMPLES,\"dry_run\":$DRY}"
fi

# Runs where the server is: reads the secret, sends it as a header via stdin
# (so it never appears in a process list), prints the JSON reply.
INNER='
set -e
S="${INTERNAL_API_SECRET:-}"
if [ -z "$S" ]; then S="$(tsx /app/server/src/scripts/secrets-get.ts INTERNAL_API_SECRET 2>/dev/null || true)"; fi
[ -n "$S" ] || { echo "INTERNAL_API_SECRET is not available" >&2; exit 1; }
if [ "$1" = GET ]; then
  printf "X-Internal-Secret: %s\n" "$S" | curl -sS --fail-with-body -X GET -H @- "http://127.0.0.1:$2$3"
else
  printf "X-Internal-Secret: %s\n" "$S" | curl -sS --fail-with-body -X POST -H @- -H "Content-Type: application/json" --data "$4" "http://127.0.0.1:$2$3"
fi
'

if [ -d /app/server/src ]; then
  OUT=$(bash -c "$INNER" _ "$METHOD" "$PORT" "$URLPATH" "$BODY") || { echo "$OUT" >&2; echo "starter-pack $ACTION failed" >&2; exit 1; }
else
  CONTAINER="${CC_CONTAINER:-command-center}"
  OUT=$(docker exec -e PORT="$PORT" "$CONTAINER" bash -c "$INNER" _ "$METHOD" "$PORT" "$URLPATH" "$BODY") || { echo "$OUT" >&2; echo "starter-pack $ACTION failed" >&2; exit 1; }
fi

# Plain-language output: one line per step / pack.
if command -v node >/dev/null 2>&1; then
  printf '%s' "$OUT" | node -e '
    let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
      const r = JSON.parse(s)
      if (r.packs) for (const p of r.packs) console.log(`${p.enabled ? "ON " : "off"}  ${p.id}  — ${p.name}`)
      else { for (const st of r.steps || []) console.log(`  - ${st}`); console.log(`${r.id}: done (${r.workspace})`) }
    })' 2>/dev/null || printf '%s\n' "$OUT"
else
  printf '%s\n' "$OUT"
fi
