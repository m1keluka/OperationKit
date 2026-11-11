#!/usr/bin/env bash
# pyramid-create.sh — decompose a root objective into a tree of child objectives.
#
# Flow:
#   1. Fetch the root objective from the Command Center DB.
#   2. Invoke `claude -p` with the pyramid-decomposition skill to produce a JSON plan.
#   3. Walk the plan, creating each node via the API with the correct parent_id,
#      mapping skill-level refs to real IDs as we go.
#
# Usage:
#   bash pyramid-create.sh <root-objective-id>
#
# Required environment:
#   CC_USER, CC_PASS              Login credentials for the API (default: admin/admin)
#
# Optional environment:
#   CC_API_BASE                   Default: http://localhost:3002
#   CC_CONTAINER                  Default: command-center
#   CC_DB_PATH                    Default: /app/data/command-center.db
#   CLAUDE_BIN                    Default: /usr/local/bin/claude
#   PYRAMID_SKILL_PATH            Default: ~/ai-workspace/skills/pyramid-decomposition/SKILL.md
#   PYRAMID_DRY_RUN               If "1", print the plan and skip creating objectives
#   PYRAMID_PLAN_FILE             If set, read the plan JSON from this file instead of calling claude
#
# Exit codes:
#   0  success (plan printed / tree created)
#   1  usage error
#   2  API or DB access failed
#   3  claude invocation failed
#   4  plan JSON invalid or references unresolvable
#   5  objective creation failed mid-run

set -u
set -o pipefail

# ── Config ─────────────────────────────────────────────────────────────────────
ROOT_ID="${1:-}"
API_BASE="${CC_API_BASE:-http://localhost:3002}"
CONTAINER="${CC_CONTAINER:-command-center}"
DB_PATH="${CC_DB_PATH:-/app/data/command-center.db}"
CLAUDE_BIN="${CLAUDE_BIN:-/usr/local/bin/claude}"
SKILL_PATH="${PYRAMID_SKILL_PATH:-$HOME/ai-workspace/skills/pyramid-decomposition/SKILL.md}"
USER_NAME="${CC_USER:-admin}"
USER_PASS="${CC_PASS:-admin}"
DRY_RUN="${PYRAMID_DRY_RUN:-0}"
PLAN_FILE="${PYRAMID_PLAN_FILE:-}"

die() { echo "ERROR: $*" >&2; exit "${2:-1}"; }
log() { echo "[pyramid] $*" >&2; }

[ -n "$ROOT_ID" ] || die "usage: bash pyramid-create.sh <root-objective-id>" 1
[[ "$ROOT_ID" =~ ^[0-9]+$ ]] || die "root id must be numeric, got: $ROOT_ID" 1

for bin in curl jq; do
  command -v "$bin" >/dev/null 2>&1 || die "required binary not found: $bin" 1
done

WORK_DIR="$(mktemp -d -t pyramid-XXXXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT
COOKIE_JAR="$WORK_DIR/cookies.txt"

# ── Step 1: Fetch root objective from the DB ──────────────────────────────────
log "fetching root objective $ROOT_ID from DB"
ROOT_JSON="$(docker exec "$CONTAINER" sqlite3 -json "$DB_PATH" \
  "SELECT id, title, description, agent_context, category, depth, parent_id FROM objectives WHERE id=$ROOT_ID;" 2>/dev/null || true)"

[ -n "$ROOT_JSON" ] && [ "$ROOT_JSON" != "[]" ] || die "root objective $ROOT_ID not found in $DB_PATH" 2

ROOT_TITLE="$(echo "$ROOT_JSON" | jq -r '.[0].title')"
ROOT_DESC="$(echo "$ROOT_JSON" | jq -r '.[0].description')"
ROOT_AGENT="$(echo "$ROOT_JSON" | jq -r '.[0].agent_context')"
ROOT_CATEGORY="$(echo "$ROOT_JSON" | jq -r '.[0].category')"
ROOT_DEPTH="$(echo "$ROOT_JSON" | jq -r '.[0].depth')"

log "root: \"$ROOT_TITLE\" (agent=$ROOT_AGENT category=$ROOT_CATEGORY depth=$ROOT_DEPTH)"

# ── Step 2: Get the decomposition plan ────────────────────────────────────────
PLAN_JSON=""
if [ -n "$PLAN_FILE" ]; then
  log "reading plan from $PLAN_FILE (skipping claude)"
  [ -r "$PLAN_FILE" ] || die "plan file not readable: $PLAN_FILE" 1
  PLAN_JSON="$(cat "$PLAN_FILE")"
else
  [ -x "$CLAUDE_BIN" ] || die "claude binary not executable: $CLAUDE_BIN" 3
  [ -r "$SKILL_PATH" ] || die "skill file not readable: $SKILL_PATH" 3

  PROMPT_FILE="$WORK_DIR/prompt.md"
  {
    echo "# Task: Decompose objective $ROOT_ID into a pyramid tree"
    echo
    echo "Load and follow this skill before producing output:"
    echo
    echo "---"
    cat "$SKILL_PATH"
    echo
    echo "---"
    echo
    echo "## Root objective (from the Command Center DB)"
    echo
    echo '```json'
    echo "$ROOT_JSON" | jq '.[0]'
    echo '```'
    echo
    echo "## Instructions"
    echo
    echo "1. Apply Steps 1–4 of the pyramid-decomposition skill."
    echo "2. Emit the JSON plan described in the skill's Output Contract."
    echo "3. Set \"root_id\" to $ROOT_ID."
    echo "4. Print the JSON to stdout with no preamble, no trailing prose, no markdown fences."
  } > "$PROMPT_FILE"

  log "invoking claude (this can take a minute)"
  RAW_OUT="$WORK_DIR/claude-out.txt"
  if ! "$CLAUDE_BIN" -p --output-format text < "$PROMPT_FILE" > "$RAW_OUT" 2>"$WORK_DIR/claude-err.txt"; then
    cat "$WORK_DIR/claude-err.txt" >&2
    die "claude invocation failed" 3
  fi

  # Strip accidental ``` fencing / leading commentary and extract the first {...} block.
  PLAN_JSON="$(awk '
    /^```/ { in_fence = !in_fence; next }
    { print }
  ' "$RAW_OUT" | jq -c '.' 2>/dev/null || true)"

  if [ -z "$PLAN_JSON" ]; then
    # Fallback: pull from first "{" to end, letting jq parse what it can.
    PLAN_JSON="$(sed -n '/^{/,$p' "$RAW_OUT" | jq -c '.' 2>/dev/null || true)"
  fi

  [ -n "$PLAN_JSON" ] || { cat "$RAW_OUT" >&2; die "claude output was not valid JSON (see above)" 4; }
fi

# ── Step 3: Validate plan structure ────────────────────────────────────────────
jq -e '.nodes and .execution_order and (.depth | type == "number")' <<<"$PLAN_JSON" >/dev/null \
  || die "plan missing required fields (nodes/execution_order/depth)" 4

DEPTH="$(jq -r '.depth' <<<"$PLAN_JSON")"
ASSESSMENT="$(jq -r '.scope_assessment // ""' <<<"$PLAN_JSON")"
NODE_COUNT="$(jq '.nodes | length' <<<"$PLAN_JSON")"

echo
echo "=== Scope assessment ==="
echo "$ASSESSMENT"
echo
echo "Recommended depth: $DEPTH   Nodes to create: $NODE_COUNT"
echo

if [ "$DEPTH" = "1" ] || [ "$NODE_COUNT" = "0" ]; then
  log "depth 1 / no nodes — leaving root objective as-is"
  exit 0
fi

# Sanity: all parent_refs and depends_on refs must resolve inside nodes[].
BAD_REFS="$(jq -r '
  [.nodes[].ref] as $refs
  | .nodes[]
  | select(.parent_ref != null and (.parent_ref as $p | $refs | index($p) | not))
  | "unknown parent_ref: \(.parent_ref) (on node \(.ref))"
' <<<"$PLAN_JSON")"
[ -z "$BAD_REFS" ] || die "plan has unresolved parent_refs:\n$BAD_REFS" 4

BAD_DEPS="$(jq -r '
  [.nodes[].ref] as $refs
  | .nodes[]
  | select(.kind == "leaf")
  | . as $n
  | (.depends_on // [])[]
  | select(. as $d | $refs | index($d) | not)
  | "unknown depends_on: \(.) (on leaf \($n.ref))"
' <<<"$PLAN_JSON")"
[ -z "$BAD_DEPS" ] || die "plan has unresolved depends_on refs:\n$BAD_DEPS" 4

if [ "$DRY_RUN" = "1" ]; then
  echo "=== Plan (dry run — nothing will be created) ==="
  jq '.' <<<"$PLAN_JSON"
  exit 0
fi

# ── Step 4: Login and get auth cookie ──────────────────────────────────────────
log "logging in as $USER_NAME"
LOGIN_HTTP="$(curl -sS -o "$WORK_DIR/login.json" -w '%{http_code}' \
  -c "$COOKIE_JAR" \
  -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg u "$USER_NAME" --arg p "$USER_PASS" '{username:$u, password:$p}')" \
  "$API_BASE/api/auth/login" || echo 000)"

[ "$LOGIN_HTTP" = "200" ] || { cat "$WORK_DIR/login.json" >&2; die "login failed (HTTP $LOGIN_HTTP)" 2; }

# ── Step 5: Create nodes in order (parents before children) ───────────────────
# Order: sort nodes by level ascending so parents always exist before children.
declare -A REF_TO_ID
CREATED_COUNT=0

# Emit node refs in creation order (level asc, stable by input order within level).
NODE_REFS="$(jq -r '.nodes | sort_by(.level) | .[].ref' <<<"$PLAN_JSON")"

while IFS= read -r REF; do
  [ -n "$REF" ] || continue

  NODE="$(jq -c --arg r "$REF" '.nodes[] | select(.ref == $r)' <<<"$PLAN_JSON")"
  PARENT_REF="$(jq -r '.parent_ref // ""' <<<"$NODE")"

  if [ -z "$PARENT_REF" ]; then
    PARENT_ID="$ROOT_ID"
  else
    PARENT_ID="${REF_TO_ID[$PARENT_REF]:-}"
    [ -n "$PARENT_ID" ] || die "internal: parent ref '$PARENT_REF' has no resolved id yet (check level ordering)" 5
  fi

  # Build the request body. For domain/group nodes we already have the REVIEW NODE: description.
  BODY="$(jq -nc \
    --arg title       "$(jq -r '.title'         <<<"$NODE")" \
    --arg description "$(jq -r '.description'   <<<"$NODE")" \
    --arg agent       "$(jq -r '.agent_context' <<<"$NODE")" \
    --arg category    "$(jq -r '.category'      <<<"$NODE")" \
    --argjson parent_id "$PARENT_ID" \
    '{title:$title, description:$description, agent_context:$agent, category:$category, parent_id:$parent_id}')"

  HTTP="$(curl -sS -o "$WORK_DIR/resp.json" -w '%{http_code}' \
    -b "$COOKIE_JAR" \
    -H 'Content-Type: application/json' \
    -d "$BODY" \
    "$API_BASE/api/objectives" || echo 000)"

  if [ "$HTTP" != "201" ] && [ "$HTTP" != "200" ]; then
    cat "$WORK_DIR/resp.json" >&2
    die "failed to create node ref=$REF (HTTP $HTTP)" 5
  fi

  NEW_ID="$(jq -r '.id' <"$WORK_DIR/resp.json")"
  [[ "$NEW_ID" =~ ^[0-9]+$ ]] || die "creation response missing numeric id for ref=$REF" 5

  REF_TO_ID[$REF]="$NEW_ID"
  KIND="$(jq -r '.kind' <<<"$NODE")"
  TITLE="$(jq -r '.title' <<<"$NODE")"
  log "  created id=$NEW_ID kind=$KIND parent=$PARENT_ID ref=$REF \"$TITLE\""
  CREATED_COUNT=$((CREATED_COUNT + 1))
done <<<"$NODE_REFS"

# ── Step 6: Print execution order summary ─────────────────────────────────────
echo
echo "=== Created $CREATED_COUNT objectives under root $ROOT_ID ==="
echo

echo "Immediate (no dependencies, can start in parallel):"
jq -r '.execution_order.immediate[]?' <<<"$PLAN_JSON" | while IFS= read -r REF; do
  [ -n "$REF" ] || continue
  ID="${REF_TO_ID[$REF]:-?}"
  TITLE="$(jq -r --arg r "$REF" '.nodes[] | select(.ref == $r) | .title' <<<"$PLAN_JSON")"
  echo "  - id=$ID  $TITLE"
done

echo
echo "Sequential chains (each depends on the previous):"
CHAIN_COUNT="$(jq '.execution_order.sequential_chains | length' <<<"$PLAN_JSON")"
if [ "$CHAIN_COUNT" = "0" ]; then
  echo "  (none)"
else
  for ((i=0; i<CHAIN_COUNT; i++)); do
    echo "  Chain $((i+1)):"
    jq -r --argjson i "$i" '.execution_order.sequential_chains[$i][]' <<<"$PLAN_JSON" \
      | while IFS= read -r REF; do
          ID="${REF_TO_ID[$REF]:-?}"
          TITLE="$(jq -r --arg r "$REF" '.nodes[] | select(.ref == $r) | .title' <<<"$PLAN_JSON")"
          echo "    → id=$ID  $TITLE"
        done
  done
fi

echo
log "done."
