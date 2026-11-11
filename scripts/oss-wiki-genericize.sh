#!/usr/bin/env bash
# oss-wiki-genericize.sh — text-only identifier replacement for the wiki tree.
#
# Sibling of scripts/oss-genericize.sh, trimmed for a docs/wiki/-only tree.
# scripts/oss-genericize.sh's first step (oss-blank-slate.py) asserts specific
# PRODUCT-tree files exist (app/client/src/components/MeetingQueueDrawer.tsx,
# the agent seed files, etc.) and fails closed when they're absent — correct
# for the full OSS cut, wrong here: wiki pages are prose, not product source,
# so there's no hardcoded workspace-slug literal or agent roster to
# structurally de-seed. This script applies the SAME W3 string-replacement
# table (kept in sync by hand with scripts/oss-genericize.sh's `apply` calls —
# if that table gains a rule, add the matching line here) with none of the
# file-rename or structural-assertion steps that assume a full product tree.
#
# USAGE: scripts/oss-wiki-genericize.sh <TREE_DIR>
# EXIT: 0 on success; non-zero if TREE_DIR is missing.

set -euo pipefail

TREE_DIR="${1:-}"
if [ -z "$TREE_DIR" ] || [ ! -d "$TREE_DIR" ]; then
  echo "Usage: $0 <TREE_DIR>" >&2
  exit 1
fi

cd "$TREE_DIR"

FILELIST=$(mktemp)
find . -type f ! -path './.git/*' | while IFS= read -r f; do
  if file --mime "$f" 2>/dev/null | grep -q 'charset=binary'; then
    :
  else
    echo "$f"
  fi
done > "$FILELIST"
echo "  $(wc -l < "$FILELIST") text file(s) to process"

esc_pat()  { printf '%s' "$1" | sed -e 's/[\\.*^$[]/\\&/g' -e 's/|/\\|/g'; }
esc_repl() { printf '%s' "$1" | sed -e 's/[\\&]/\\&/g' -e 's/|/\\|/g'; }

apply_exact() {
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
  [ "$hits" -gt 0 ] && echo "    '$from' -> '$to' in $hits file(s)"
  return 0
}

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
  [ "$hits" -gt 0 ] && echo "    [residual/ci] '$from' -> '$to' in $hits file(s)"
  return 0
}

to_upper() { printf '%s' "$1" | tr '[:lower:]' '[:upper:]'; }
to_title() {
  printf '%s' "$1" | sed -e 's/\([^[:alnum:]]\)\([[:alpha:]]\)/\1\u\2/g' -e 's/^\([[:alpha:]]\)/\u\1/'
}

apply() {
  local from="$1" to="$2"
  local u_from u_to t_from t_to
  echo "  rule '$from' -> '$to'"
  if [ "$from" != "$(printf '%s' "$from" | tr '[:upper:]' '[:lower:]')" ]; then
    apply_exact "$from" "$to"
    return 0
  fi
  u_from="$(to_upper "$from")"; u_to="$(to_upper "$to")"
  t_from="$(to_title "$from")"; t_to="$(to_title "$to")"
  [ "$u_from" != "$from" ] && apply_exact "$u_from" "$u_to"
  [ "$t_from" != "$from" ] && [ "$t_from" != "$u_from" ] && apply_exact "$t_from" "$t_to"
  apply_exact "$from" "$to"
  apply_residual "$from" "$to"
  return 0
}

# Mirrors scripts/oss-genericize.sh's W3 table (most-specific -> least-specific).
apply "/home/operator/"        "/home/operator/"
apply "/home/operator"         "/home/operator"
apply "cc.example.com"  "cc.example.com"
apply "dev@example.com" "dev@example.com"
apply "dev@example.com"   "dev@example.com"
apply "@example.com"     "@example.com"
apply "example.com"      "example.com"
apply "your-org"         "your-org"
apply "example"          "example"
apply "example"                "example"
apply "example-project"       "example-project"
apply "Example Project"       "Example Project"
apply "Operator"           "Operator"
apply "operator"           "operator"
apply "Example Five"    "Example Dental Lab"
apply "Example Five"            "Example Five"
apply "example5"            "example5"
apply "example project"       "example project"
apply "example2"               "example2"
apply "example3"            "example3"
apply "example3"           "example3"
apply "example4"              "example4"
apply "rivera"               "rivera"
apply "EXAMPLE" "EXAMPLE"
apply "Example" "Example"
apply "operationkit"             "operationkit"
apply "OperationKit"             "OperationKit"
apply "your-org/operationkit" "your-org/operationkit"

rm -f "$FILELIST"
echo "=== oss-wiki-genericize: done ==="
