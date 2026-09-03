#!/usr/bin/env bash
# oss-genericize.sh — inline identifier replacement for the assembled OSS tree.
#
# PURPOSE
#   Raw command-center-infra source carries business-specific identifiers that must
#   be replaced before publication. This script applies W3's replacement table in-place
#   to a COPY of the assembled tree (never to the private source). It runs AFTER
#   strip (oss-strip-paths.txt removes whole overlay files) and BEFORE the gate
#   (oss-sync-gate.sh verifies no identifiers remain).
#
# USAGE
#   scripts/oss-genericize.sh <TREE_DIR>
#   <TREE_DIR> — the assembled (already-stripped) tree to genericize in-place.
#
# EXIT
#   0 on success; non-zero if TREE_DIR is missing or sed substitutions cannot run.
#
# WHAT IT REPLACES (W3 replacement table — do not expand without a vault decision)
#   /home/operator/       → /home/operator/
#   cc.example.com → cc.example.com
#   dev@example.com → dev@example.com
#   dev@example.com   → dev@example.com
#   @example.com   → @example.com
#   example.com    → example.com
#   your-org       → your-org
#   example (bare slug) → example
#   example-project     → example-project
#   Example Project     → Example Project
#   operator         → operator  (NOT `personal` — that slug already exists)
#   example2             → example2
#   example3          → example3
#   example4            → example4
#
#
# W10 additions (obj 709220 — vault decision 2026-08-30-oss-w10-genericize-persist):
#   @operationkit   → @operationkit         (npm workspace scope; 3 packages)
#   can_use_assistant    → can_use_assistant     (permission flag)
#   briefingRouter      → briefingRouter        (obj 709963: `assistant` is taken)
#   routes/briefing     → routes/briefing       (        "                      )
#   /api/briefing       → /api/briefing         (        "                      )
#   /assistant           → /assistant            (HTTP route + slash command)
#   Assistant            → Assistant             (prose + identifiers, e.g. AssistantRouter)
#   assistant            → assistant             (bare slug; see JARVIS FILE RENAMES below)
#   https://github.com/m1keluka/OperationKit.git / m1keluka/OperationKit URL forms
#                     → https://github.com/m1keluka/OperationKit.git
#   OperationKit is a self-hosted → OperationKit is a self-hosted (SECURITY.md line 3)
#   operator brain dump / the operator DMs / Action items reach the operator → operator wording
#
# WHY "Command Center" IS *NOT* BROADLY REPLACED
#   The bare product name appears 188× across 116 tracked files, including inside
#   href targets that point at real filenames — e.g.
#     design/guidelines/design-guidelines.html:41
#       <a href="Command Center — Board.html">
#   A blanket "Command Center" → "OperationKit" would rewrite the href but not the
#   file it targets, producing dead links. Only the SECURITY.md product-definition
#   sentence is replaced. Broadening this requires renaming the referenced assets
#   in the same change.
#
# NOTE: "example" alone IS now replaced (obj 709964). The more-specific forms (example,
# @example.com, etc.) run first to prevent partial-match cascades, then bare `example`
# catches what's left. Tested against the full tree; false-positive rate is zero.

set -euo pipefail

TREE_DIR="${1:-}"
if [ -z "$TREE_DIR" ] || [ ! -d "$TREE_DIR" ]; then
  echo "Usage: $0 <TREE_DIR>" >&2
  exit 1
fi

cd "$TREE_DIR"

echo "=== oss-genericize: applying W3 replacement table to $TREE_DIR ==="

# Build a list of text files to process (skip binary, skip .git)
FILELIST=$(mktemp)
find . -type f ! -path './.git/*' | while IFS= read -r f; do
  if file --mime "$f" 2>/dev/null | grep -q 'charset=binary'; then
    :  # skip binary
  else
    echo "$f"
  fi
done > "$FILELIST"

count=$(wc -l < "$FILELIST")
echo "  $count text files to process"

# Apply replacements in dependency order (more-specific → less-specific)
# Using a temp file to avoid in-place sed portability issues.
# Escape regex/replacement metacharacters so `apply` is a LITERAL string
# substitution, matching the grep -F membership test above it. Without this a
# pattern containing '*' (e.g. the bold-markdown SECURITY.md sentence) is an
# invalid BRE and sed aborts the whole run under `set -e`.
esc_pat()  { printf '%s' "$1" | sed -e 's/[\\.*^$[]/\\&/g' -e 's/|/\\|/g'; }
esc_repl() { printf '%s' "$1" | sed -e 's/[\\&]/\\&/g' -e 's/|/\\|/g'; }

# apply_exact: literal, CASE-SENSITIVE substitution of one from→to pair.
apply_exact() {
  local from="$1" to="$2" label="${3:-}"
  local from_re to_re hits=0
  from_re="$(esc_pat "$from")"
  to_re="$(esc_repl "$to")"
  while IFS= read -r f; do
    if grep -qF "$from" "$f" 2>/dev/null; then
      sed -i "s|${from_re}|${to_re}|g" "$f"
      hits=$((hits + 1))
    fi
  done < "$FILELIST"
  [ "$hits" -gt 0 ] && echo "    ${label}'$from' → '$to' in $hits file(s)"
  return 0
}

# apply_residual: CASE-INSENSITIVE sweep for any casing the explicit variants below
# did not produce (e.g. 'example2'). Emits the replacement verbatim, so this is the
# coverage BACKSTOP rather than the pretty path — but it guarantees that no casing
# of a rule token can survive into the published tree.
apply_residual() {
  local from="$1" to="$2"
  local from_re to_re hits=0
  from_re="$(esc_pat "$from")"
  to_re="$(esc_repl "$to")"
  while IFS= read -r f; do
    if grep -qiF "$from" "$f" 2>/dev/null; then
      sed -i "s|${from_re}|${to_re}|gI" "$f"
      hits=$((hits + 1))
    fi
  done < "$FILELIST"
  [ "$hits" -gt 0 ] && echo "    [residual/ci] '$from' → '$to' in $hits file(s)"
  return 0
}

# Case transforms used to derive a rule token's variants.
#   upper : EXAMPLE2, EXAMPLE-PROJECT
#   title : Example2, Example-Project  (first letter of every alnum run capitalised)
to_upper() { printf '%s' "$1" | tr '[:lower:]' '[:upper:]'; }
to_title() {
  printf '%s' "$1" | sed -e 's/\([^[:alnum:]]\)\([[:alpha:]]\)/\1\u\2/g' -e 's/^\([[:alpha:]]\)/\u\1/'
}

# apply_literal — case-SENSITIVE rule, NO case expansion. For COSMETIC renames of
# tokens the gate does not scan case-insensitively (the assistant→assistant family).
# Expanding those is not needed for coverage and is actively harmful: the tree
# carries NEGATIVE assertions about the legacy brand — `expect(d).not.toContain(
# 'JARVIS')` in services/assistant-config.test.ts — which a case-insensitive
# rewrite turns into a self-contradiction. Denylist-backed rules use apply();
# cosmetic ones use this.
apply_literal() {
  local from="$1" to="$2"
  echo "  rule (literal) '$from' → '$to'"
  apply_exact "$from" "$to" "[exact] "
  return 0
}

# ---------------------------------------------------------------------------
# apply — THE rule entry point for denylist-backed tokens. Replaces `from` in
# EVERY casing.
#
# WHY (obj 709963): the gate's denylist scan is case-INSENSITIVE (`grep -niF` in
# scripts/oss-sync-gate.sh) while this script was case-SENSITIVE, so the rules
# genuinely removed every LOWERCASE occurrence and 1028 case variants sailed
# through (136 EXAMPLE2, 21 Example-Project, 10 Example3, 9 EXAMPLE3, 5 EXAMPLE4,
# 2 Example4 — and zero lowercase survivors). #456 closed that by hand-enumerating
# UPPER/Title/lower for the four slugs it knew about. Deriving the variants makes
# the property structural instead of a list someone has to remember to extend:
# every current AND future rule gets full case coverage, plus a case-insensitive
# residual sweep for casings neither variant produces.
#
# Replacements carry the matching case, so the published tree stays readable and
# internally consistent (`EXAMPLE2_TOKEN` → `EXAMPLE2_TOKEN`, not `example2_TOKEN`).
# Because this is a WHOLE-TREE substitution, a fixture and the assertion that
# reads it are rewritten together and stay consistent.
# ---------------------------------------------------------------------------
apply() {
  local from="$1" to="$2"
  local u_from u_to t_from t_to
  echo "  rule '$from' → '$to'"
  # Case expansion applies ONLY to all-lowercase rule tokens. A rule whose `from`
  # already carries capitals is a DELIBERATE cased form and is substituted
  # literally — the table holds case-distinguished PAIRS, and expanding the
  # capitalised member would let its residual clobber the lowercase one.
  if [ "$from" != "$(printf '%s' "$from" | tr '[:upper:]' '[:lower:]')" ]; then
    apply_exact "$from" "$to" "[literal] "
    return 0
  fi
  u_from="$(to_upper "$from")"; u_to="$(to_upper "$to")"
  t_from="$(to_title "$from")"; t_to="$(to_title "$to")"
  [ "$u_from" != "$from" ] && apply_exact "$u_from" "$u_to" "[upper] "
  [ "$t_from" != "$from" ] && [ "$t_from" != "$u_from" ] && apply_exact "$t_from" "$t_to" "[title] "
  apply_exact "$from" "$to" "[exact] "
  apply_residual "$from" "$to"
  return 0
}

# Ordered: most-specific first to avoid partial-match cascades
apply "/home/operator/"        "/home/operator/"
# obj 709963: the trailing-slash rule above misses the bare constant
# (`HOME_DIR = process.env.USER_HOME || '/home/operator'` in server/src/config.ts), so
# the published tree built '/home/operator/second-brain' at runtime while its own
# services/design-context.test.ts asserted '/home/operator/…'. Must follow the
# trailing-slash rule.
apply "/home/operator"         "/home/operator"
apply "OPERATOR_HOME"          "OPERATOR_HOME"
apply "cc.example.com"  "cc.example.com"
apply "dev@example.com" "dev@example.com"
apply "dev@example.com"   "dev@example.com"
apply "@example.com"     "@example.com"
apply "example.com"      "example.com"
apply "your-org"         "your-org"
# Bare `example`/`example` come AFTER all more-specific example forms.
# apply() derives UPPER/Title/lower + a case-insensitive residual for every
# all-lowercase rule, so the hand-written variant triplets #456 added are no
# longer needed (and future rules get the same coverage for free).
apply "example"          "example"
apply "example"                "example"
apply "example-project"       "example-project"
apply "Example Project"       "Example Project"
apply "example project"       "example project"
# obj 709963: the replacement is `operator`, NOT `personal`. `operator` and
# `personal` are two DISTINCT workspaces that both appear as keys in the same
# object literals, so mapping one onto the other produced duplicate keys and the
# published client did not compile:
#     client/src/components/MeetingQueueDrawer.tsx(26,3): error TS1117:
#       An object literal cannot have multiple properties with the same name.
# Same class of bug as the assistant→assistant clobber below: a rename whose target
# is already taken. A replacement token must be checked against the tree before
# it is added.
apply "operator"           "operator"
apply "Operator"           "Operator"
# ws/parseConnectScope.test.ts feeds the PERCENT-ENCODED form ('oper%61tor') and
# asserts the decoded slug, so the rule above rewrote the assertion but not the
# input: the published test decoded 'operator' while expecting the new name. The
# replacement keeps an encoded octet (%61 = 'a') so the test still exercises
# percent-decoding instead of becoming a tautology.
apply "oper%61tor"         "oper%61tor"
apply "example2"               "example2"
apply "example3"            "example3"
apply "example3"           "example3"
apply "example4"              "example4"
# Client/counterparty names.
# `rivera` rather than the full "Alex Rivera": routes/contacts.ts also carries the
# vault filename `alex-rivera.md`, which the full-name rule cannot see. Rewriting
# the surname alone keeps the leading letter of the display name, so the contacts
# fixtures' alphabetical ordering assertions ("Alex …" < "Bea Lee" < "Zane Smith")
# still hold.
apply "rivera"               "rivera"
# obj 709963: `Example Dental Lab` / `example5` is a real client of the operator that
# was on no list at all — 21 occurrences across the workspaces seed, the loops
# project enum and the meeting-queue drawer. Added to scripts/oss-denylist.txt in
# the same change so its return is a gate failure, not a silent leak.
apply "Example Dental Lab"    "Example Dental Lab"
apply "example5"            "example5"
apply "example5"               "example5"

# --- W10 (obj 709220): OSS-audit identity recs, persisted into the pipeline ------
# Ordered most-specific → least-specific, exactly like the block above.

# R02: npm workspace scope. Covers @operationkit/{shared,server,client}.
apply "@operationkit" "@operationkit"

# R03: assistant identity. can_use_assistant first (it embeds the bare slug), then the
# route form, then the capitalised prose/identifier form, then the bare slug.
#
# COLLISION (obj 709963): the private tree ALREADY has an `assistant` namespace —
# routes/assistant.ts (the Personal Assistant config API, obj 701700),
# services/assistant-config.ts, services/assistant-persona.ts. The blanket
# assistant→assistant rename therefore produced TWO identical
# `import assistantRouter from './routes/assistant.js'` lines in server/src/index.ts,
# and the unguarded `mv` in the rename loop below LANDED ON TOP OF the real
# routes/assistant.ts and deleted it. The tree currently published to
# m1keluka/OperationKit does not compile:
#     server/src/index.ts(19,8): error TS2300: Duplicate identifier 'assistantRouter'.
#     server/src/index.ts(20,8): error TS2300: Duplicate identifier 'assistantRouter'.
# The assistant router IS the daily-briefing API (`GET /api/briefing/briefing`), so it
# genericizes to `briefing` — a name that describes what it does and collides with
# nothing. These three rules must precede the `/assistant` and bare-`assistant` rules.
apply_literal "briefingRouter"    "briefingRouter"
apply_literal "routes/briefing"   "routes/briefing"
apply_literal "/api/briefing"     "/api/briefing"

# The only upper-case assistant form that must travel: an env-var name. Handled
# explicitly so the family below can stay literal (see apply_literal's header).
apply_literal "ASSISTANT_NUDGE_ENABLED" "ASSISTANT_NUDGE_ENABLED"

apply_literal "can_use_assistant" "can_use_assistant"
apply_literal "/assistant"        "/assistant"
apply_literal "Assistant"         "Assistant"
apply_literal "assistant"         "assistant"

# R04: public clone URL. The full-URL forms are consumed FIRST so the bare-slug rule
# can never produce "…/OperationKit.git.git".
apply "https://github.com/m1keluka/OperationKit.git" "https://github.com/m1keluka/OperationKit.git"
apply "https://github.com/m1keluka/OperationKit.git"     "https://github.com/m1keluka/OperationKit.git"
apply "https://github.com/m1keluka/OperationKit.git"                 "https://github.com/m1keluka/OperationKit.git"
apply "https://github.com/m1keluka/OperationKit.git"                   "https://github.com/m1keluka/OperationKit.git"
# Bare owner/repo slug (not a URL) → real owner/repo, which yields the clone URL
# above whenever it is prefixed by https://github.com/.
apply "m1keluka/OperationKit" "m1keluka/OperationKit"

# R05: product-definition sentence only (see header note on why this is narrow).
# Two forms: the bold-markdown one as it is actually written in SECURITY.md, and
# the plain one in case the emphasis is ever dropped.
apply "OperationKit is a **self-hosted" "OperationKit is a **self-hosted"
apply "OperationKit is a self-hosted"   "OperationKit is a self-hosted"

# obj 709963: `general` is one of the operator's PRIVATE persona slugs. It
# cannot go on the PRE-ONLY denylist section (it is legitimately present in tracked
# SOURCE — the assistant-nudge prompt, the mentor-session overlay path, the
# docs/api bot index — and check 0 scans the raw tree), so it is neutralised here.
# Check 4 keeps it out of the shipped roster regardless.
apply "Mike'"'"'s general"              "the operator'"'"'s chief of staff"
apply "agent-profiles/general.md" "agent-profiles/general.md"
apply "general"                   "general"
apply "General"                   "General"

# R18: operator-neutral wording in the architecture docs.
apply "operator brain dump"        "operator brain dump"
apply "the operator DMs"               "the operator DMs"
apply "Action items reach the operator" "Action items reach the operator"

rm -f "$FILELIST"

# --- JARVIS FILE RENAMES (W10, obj 709220) ------------------------------------
# The content rules above rewrite bare `assistant` → `assistant`, which includes the
# module specifiers in app/server/src/index.ts:
#     import assistantRouter from './routes/assistant.js'
#     import { startAssistantNudgeScheduler } from './services/assistant-nudge.js'
# If the files keep their private names the published tree fails to resolve those
# imports. Renaming here (in the assembled COPY only — CCI source is untouched)
# keeps the transform self-consistent. Guarded so a missing/renamed source is a
# no-op rather than an error.
for pair in \
  "app/server/src/routes/briefing.ts:app/server/src/routes/briefing.ts" \
  "app/server/src/services/assistant-nudge.ts:app/server/src/services/assistant-nudge.ts"
do
  src="${pair%%:*}"; dst="${pair##*:}"
  if [ -f "$src" ]; then
    # FAIL-CLOSED collision guard (obj 709963). `mv` onto an existing path silently
    # DELETES it: routes/briefing.ts was landing on the real routes/assistant.ts, so
    # the Personal Assistant config API vanished from the published tree and the
    # duplicated import left it uncompilable. A rename target that already exists
    # means the replacement table has grown a collision — stop, do not publish.
    if [ -e "$dst" ]; then
      echo "  ERROR: rename '$src' → '$dst' would clobber an existing file." >&2
      echo "         Pick a non-colliding target in the R03 block above." >&2
      exit 1
    fi
    mv "$src" "$dst"
    echo "  renamed '$src' → '$dst'"
  fi
done

echo "=== oss-genericize: done ==="
