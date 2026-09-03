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
#   examplegrowth (bare slug) → example
#   example-project     → example-project
#   Example Project     → Example Project
#   personal         → personal
#   example2             → example2
#   example3          → example3
#   example4            → example4
#
#
# W10 additions (obj 709220 — vault decision 2026-08-30-oss-w10-genericize-persist):
#   @operationkit   → @operationkit         (npm workspace scope; 3 packages)
#   can_use_assistant    → can_use_assistant     (permission flag)
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
# NOTE: "example" alone IS now replaced (obj 709964). The more-specific forms (examplegrowth,
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

apply() {
  local from="$1" to="$2"
  local from_re to_re hits=0
  from_re="$(esc_pat "$from")"
  to_re="$(esc_repl "$to")"
  while IFS= read -r f; do
    if grep -qF "$from" "$f" 2>/dev/null; then
      sed -i "s|${from_re}|${to_re}|g" "$f"
      hits=$((hits + 1))
    fi
  done < "$FILELIST"
  echo "  replaced '$from' → '$to' in $hits file(s)"
}

# Ordered: most-specific first to avoid partial-match cascades
apply "/home/operator/"        "/home/operator/"
apply "cc.example.com"  "cc.example.com"
apply "dev@example.com" "dev@example.com"
apply "dev@example.com"   "dev@example.com"
apply "@example.com"     "@example.com"
apply "example.com"      "example.com"
apply "your-org"         "your-org"
# Bare `example` and case variants come AFTER all more-specific examplegrowth forms.
# All cases are needed because denylist grep is case-insensitive (grep -iF).
# False positives are minimal: `example` is not a common English word.
apply "EXAMPLE"                "EXAMPLE"
apply "Example"                "Example"
apply "example"                "example"
# Example Project variants
apply "EXAMPLE-PROJECT"       "EXAMPLE-PROJECT"
apply "Example-Project"       "Example-Project"
apply "example-project"       "example-project"
apply "Example Project"       "Example Project"
apply "personal"           "personal"
# Case variants for workspace slugs — denylist grep is case-insensitive (grep -iF).
# Full coverage: lowercase (slug), capitalized (prose), UPPERCASE (display labels).
apply "EXAMPLE2"               "EXAMPLE2"
apply "Example2"               "Example2"
apply "example2"               "example2"
apply "EXAMPLE3"            "EXAMPLE3"
apply "Example3"            "Example3"
apply "example3"            "example3"
apply "EXAMPLE4"              "EXAMPLE4"
apply "Example4"              "Example4"
apply "example4"              "example4"
# Client/counterparty names
apply "Jane Doe"          "Jane Doe"

# --- W10 (obj 709220): OSS-audit identity recs, persisted into the pipeline ------
# Ordered most-specific → least-specific, exactly like the block above.

# R02: npm workspace scope. Covers @operationkit/{shared,server,client}.
apply "@operationkit" "@operationkit"

# R03: assistant identity. can_use_assistant first (it embeds the bare slug), then the
# route form, then the capitalised prose/identifier form, then the bare slug.
apply "can_use_assistant" "can_use_assistant"
apply "/assistant"        "/assistant"
apply "Assistant"         "Assistant"
apply "assistant"         "assistant"

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
  "app/server/src/routes/assistant.ts:app/server/src/routes/assistant.ts" \
  "app/server/src/services/assistant-nudge.ts:app/server/src/services/assistant-nudge.ts"
do
  src="${pair%%:*}"; dst="${pair##*:}"
  if [ -f "$src" ]; then
    mv "$src" "$dst"
    echo "  renamed '$src' → '$dst'"
  fi
done

echo "=== oss-genericize: done ==="
