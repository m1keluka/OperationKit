#!/usr/bin/env bash
# Agent files: list, install starter templates, import, export, validate (obj 719986).
#
#   scripts/agent-template.sh list
#   scripts/agent-template.sh install <template-slug>|all [--overwrite] [--workspace <ws>]
#   scripts/agent-template.sh import <file.yaml|file.md|folder> [--overwrite] [--workspace <ws>]
#   scripts/agent-template.sh export <agent-slug> [-o <file>]
#   scripts/agent-template.sh validate <file.yaml|file.md>
#
# Works from the server host (talks to the app container) or from inside the
# container. Files are read where you run the script, so any path works.
# The internal API secret is read inside the container and never printed.
# Installer: `install all` switches on the three starter agents; it skips any
# that already exist (add --overwrite to replace them).
set -euo pipefail

usage() { sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

ACTION="${1:-}"; [ -n "$ACTION" ] || usage 1; shift
ARG=""; OVERWRITE=false; WS=""; OUTFILE=""
case "$ACTION" in
  list|status) ;;
  install|import|export|validate) ARG="${1:-}"; [ -n "$ARG" ] || usage 1; shift ;;
  -h|--help) usage 0 ;;
  *) echo "Unknown action: $ACTION" >&2; usage 1 ;;
esac
while [ $# -gt 0 ]; do
  case "$1" in
    --overwrite) OVERWRITE=true; shift ;;
    --workspace) WS="${2:-}"; shift 2 ;;
    --workspace=*) WS="${1#*=}"; shift ;;
    -o|--out) OUTFILE="${2:-}"; shift 2 ;;
    -h|--help) usage 0 ;;
    *) echo "Unknown option: $1" >&2; usage 1 ;;
  esac
done
[ -z "$WS" ] || [[ "$WS" =~ ^[A-Za-z0-9][A-Za-z0-9_-]*$ ]] || { echo "Bad workspace: $WS" >&2; exit 1; }

PORT="${PORT:-3002}"
WS_JSON="null"; [ -z "$WS" ] || WS_JSON="\"$WS\""
CONTENT_FILE=""; FILENAME=""
case "$ACTION" in
  list|status) METHOD=GET; URLPATH="/api/internal/agent-templates"; BODY="" ;;
  install)
    METHOD=POST
    if [ "$ARG" = all ]; then
      URLPATH="/api/internal/agent-templates/install-starters"
      BODY="{\"templates\":\"all\",\"overwrite\":$OVERWRITE,\"workspace\":$WS_JSON}"
    else
      [[ "$ARG" =~ ^[a-z0-9][a-z0-9-]+$ ]] || { echo "Bad template slug: $ARG" >&2; exit 1; }
      URLPATH="/api/internal/agent-templates/templates/$ARG/install"
      BODY="{\"overwrite\":$OVERWRITE,\"workspace\":$WS_JSON}"
    fi ;;
  export)
    [[ "$ARG" =~ ^[a-z0-9][a-z0-9-]+$ ]] || { echo "Bad agent slug: $ARG" >&2; exit 1; }
    METHOD=GET; URLPATH="/api/internal/agent-templates/agents/$ARG/export"; BODY="" ;;
  import|validate)
    SRC="$ARG"
    if [ -d "$SRC" ]; then
      for n in agent.yaml agent.yml agent.md; do [ -f "$SRC/$n" ] && { SRC="$SRC/$n"; break; }; done
    fi
    [ -f "$SRC" ] || { echo "No agent file at: $ARG" >&2; exit 1; }
    CONTENT_FILE="$SRC"
    # Folder + file name, so "agents/<slug>/agent.yaml" can be checked against the slug.
    FILENAME="$(basename "$(dirname "$SRC")")/$(basename "$SRC")"
    METHOD=POST
    if [ "$ACTION" = import ]; then URLPATH="/api/internal/agent-templates/import"; else URLPATH="/api/internal/agent-templates/validate"; fi
    BODY="" ;;
esac

# Runs where the server is. File text arrives on stdin; the JSON body is built
# with node (always present in the container) and sent from a temp file, so
# neither the secret nor a large file ever lands on a command line.
INNER='
set -e
S="${INTERNAL_API_SECRET:-}"
if [ -z "$S" ]; then S="$(tsx /app/server/src/scripts/secrets-get.ts INTERNAL_API_SECRET 2>/dev/null || true)"; fi
[ -n "$S" ] || { echo "INTERNAL_API_SECRET is not available" >&2; exit 1; }
TMP="$(mktemp)"; trap "rm -f \"$TMP\"" EXIT
if [ -n "$5" ]; then
  node -e "let s=\"\";process.stdin.setEncoding(\"utf8\").on(\"data\",d=>s+=d).on(\"end\",()=>process.stdout.write(JSON.stringify({content:s,filename:process.argv[1],overwrite:process.argv[2]===\"true\",workspace:process.argv[3]||null})))" "$5" "$6" "$7" > "$TMP"
else
  printf "%s" "$4" > "$TMP"
fi
if [ "$1" = GET ]; then
  printf "X-Internal-Secret: %s\n" "$S" | curl -s --fail-with-body -X GET -H @- "http://127.0.0.1:$2$3"
else
  printf "X-Internal-Secret: %s\n" "$S" | curl -s --fail-with-body -X POST -H @- -H "Content-Type: application/json" --data-binary "@$TMP" "http://127.0.0.1:$2$3"
fi
'

run() {
  if [ -d /app/server/src ]; then
    bash -c "$INNER" _ "$METHOD" "$PORT" "$URLPATH" "$BODY" "$FILENAME" "$OVERWRITE" "$WS"
  else
    docker exec -i -e PORT="$PORT" "${CC_CONTAINER:-command-center}" bash -c "$INNER" _ "$METHOD" "$PORT" "$URLPATH" "$BODY" "$FILENAME" "$OVERWRITE" "$WS"
  fi
}

FAILED=0
if [ -n "$CONTENT_FILE" ]; then
  OUT=$(run < "$CONTENT_FILE") || FAILED=1
else
  OUT=$(run < /dev/null) || FAILED=1
fi
if [ "$FAILED" = 1 ] && [ "${OUT:0:1}" != "{" ]; then
  echo "$OUT" >&2; echo "agent-template $ACTION failed" >&2; exit 1
fi

if [ "$ACTION" = export ] && [ "$FAILED" = 0 ]; then
  if [ -n "$OUTFILE" ]; then printf '%s' "$OUT" > "$OUTFILE"; echo "Saved $ARG to $OUTFILE"; else printf '%s' "$OUT"; fi
  exit 0
fi

# Plain-language output.
if command -v node >/dev/null 2>&1; then
  printf '%s' "$OUT" | node -e '
let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
  let r; try { r = JSON.parse(s) } catch { console.log(s); return }
  const probs = (l, label) => (l || []).forEach(p => console.log(`  ${label} ${p.field}: ${p.message}`))
  if (r.templates) {
    console.log("Templates:")
    for (const t of r.templates) console.log(`  ${t.installed ? "[installed]" : "[available]"} ${t.slug}  v${t.version}  by ${t.author}${t.update_available ? "  (update available)" : ""}`)
    console.log("Agents on this install:")
    for (const a of r.installed) console.log(`  ${a.slug}${a.version ? "  v" + a.version : ""}${a.archived ? "  (archived)" : ""}`)
    for (const p of r.problems || []) { console.log(`Invalid template ${p.path}:`); probs(p.errors, "x") }
  } else if (r.results) {
    for (const x of r.results) console.log(`  ${x.slug}: ${x.status}${x.error ? " — " + x.error : ""}`)
  } else if ("ok" in r) {
    console.log(r.ok ? `Valid: ${r.agent.name} (${r.agent.slug}) v${r.agent.version}` : "Not valid:")
    probs(r.errors, "x"); probs(r.warnings, "!")
    if (!r.ok) process.exitCode = 1
  } else if (r.slug) {
    console.log(`${r.action === "created" ? "Added" : "Updated"} agent ${r.slug} (${r.file_path})`)
    if (r.routines && r.routines.length) console.log(`  Schedules added switched OFF: ${r.routines.join(", ")}`)
    probs(r.warnings, "!")
  } else if (r.error) {
    console.log(`Error: ${r.error}`); probs(r.errors, "x"); probs(r.warnings, "!")
  } else console.log(s)
})' || FAILED=1
else
  printf '%s\n' "$OUT"
fi
exit "$FAILED"
