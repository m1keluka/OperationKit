#!/usr/bin/env bash
# oss-wiki-gate.sh — FAIL-CLOSED safety gate for the wiki publish.
#
# Sibling of scripts/oss-sync-gate.sh, trimmed for a docs/wiki/-only tree.
# Reuses the SAME denylist file (scripts/oss-denylist.txt) and the same
# gitleaks invocation, so a business-identity string or a secret that would
# block the main OSS cut also blocks the wiki publish — one list, two
# consumers, no drift. It drops the agent-roster allow-list and
# seed.agents.example.json presence checks from oss-sync-gate.sh: those assert
# properties of the PRODUCT tree (a seeded agent registry) that a prose-only
# wiki tree never has, so running them here would fail-closed on an
# irrelevant absence instead of a real leak.
#
# Checks (all must pass):
#   0. PRE-genericize denylist — same denylist, run against the tree BEFORE
#      oss-wiki-genericize.sh rewrites it (see oss-sync-gate.sh's header for
#      why this has to run before genericization, not just after).
#   1. gitleaks detect --no-git — secret scan.
#   2. POST-genericize business-identity denylist.
#   3. real-content absence — no ai-workspace/ or second-brain/ path, no .env,
#      no real seed.*.json.
#
# Usage: GATE_DIR=<tree> PREGEN_DIR=<pre-genericize tree> scripts/oss-wiki-gate.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GITLEAKS_BIN="${GITLEAKS_BIN:-gitleaks}"
GATE_DIR="${GATE_DIR:?set GATE_DIR to the assembled+genericized wiki tree}"
DENYLIST_FILE="$SCRIPT_DIR/oss-denylist.txt"

FAIL=0
note_fail() { echo "  ✗ $*"; FAIL=1; }
note_ok()   { echo "  ✓ $*"; }

echo "=============================================="
echo " Wiki publish gate (fail-closed) — scanning: $GATE_DIR"
echo "=============================================="

list_files_in() {
  find "$1" -type f ! -path '*/.git/*' | sed "s|^$1/||"
}

PRE_PATTERNS=(); POST_PATTERNS=(); BOTH_PATTERNS=()
if [ -f "$DENYLIST_FILE" ]; then
  SCOPE="BOTH"
  while IFS= read -r line; do
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [ -z "$line" ] && continue
    if [[ "$line" =~ ^#.*BEGIN:\ *PRE-ONLY ]]; then SCOPE="PRE"; continue
    elif [[ "$line" =~ ^#.*END:\ *PRE-ONLY ]]; then SCOPE="BOTH"; continue
    elif [[ "$line" =~ ^#.*BEGIN:\ *POST-ONLY ]]; then SCOPE="POST"; continue
    elif [[ "$line" =~ ^#.*END:\ *POST-ONLY ]]; then SCOPE="BOTH"; continue
    elif [[ "$line" =~ ^# ]]; then continue
    fi
    case "$SCOPE" in
      PRE)  PRE_PATTERNS+=("$line") ;;
      POST) POST_PATTERNS+=("$line") ;;
      BOTH) BOTH_PATTERNS+=("$line") ;;
    esac
  done < "$DENYLIST_FILE"
fi

scan_denylist_in() {
  local dir="$1"; shift
  local -a pats=("$@")
  local hits=0 f pat
  while IFS= read -r f; do
    if file --mime "$dir/$f" 2>/dev/null | grep -q 'charset=binary'; then continue; fi
    for pat in "${pats[@]}"; do
      [ -z "$pat" ] && continue
      if grep -niF -- "$pat" "$dir/$f" >/dev/null 2>&1; then
        grep -niF -- "$pat" "$dir/$f" | while IFS= read -r ln; do
          echo "  ✗ DENYLIST '$pat' -> $f: $ln"
        done
        hits=$((hits + 1))
      fi
    done
  done < <(list_files_in "$dir")
  echo "$hits"
}

echo
echo "[0/3] PRE-genericize denylist"
if [ -z "${PREGEN_DIR:-}" ] || [ ! -d "$PREGEN_DIR" ]; then
  note_fail "PREGEN_DIR not set or missing — fail-closed"
else
  HITS=$(scan_denylist_in "$PREGEN_DIR" "${PRE_PATTERNS[@]}" "${BOTH_PATTERNS[@]}")
  [ "$HITS" -eq 0 ] && note_ok "pre-genericize denylist clean" || note_fail "$HITS pre-genericize hit(s)"
fi

echo
echo "[1/3] gitleaks secret scan"
if ! command -v "$GITLEAKS_BIN" >/dev/null 2>&1; then
  note_fail "gitleaks binary not found"
else
  if "$GITLEAKS_BIN" detect --no-git --source "$GATE_DIR" --redact --exit-code 1 >/tmp/wiki-gitleaks.log 2>&1; then
    note_ok "gitleaks: no secrets detected"
  else
    note_fail "gitleaks: secrets detected"
    sed 's/^/      /' /tmp/wiki-gitleaks.log | tail -30
  fi
fi

echo
echo "[2/3] POST-genericize business-identity denylist"
HITS=$(scan_denylist_in "$GATE_DIR" "${POST_PATTERNS[@]}" "${BOTH_PATTERNS[@]}")
[ "$HITS" -eq 0 ] && note_ok "post-genericize denylist clean" || note_fail "$HITS post-genericize hit(s)"

echo
echo "[3/3] real-content absence"
for d in ai-workspace second-brain; do
  if list_files_in "$GATE_DIR" | grep -qE "(^|/)${d}/"; then
    note_fail "tracked path(s) under ${d}/"
  else
    note_ok "no tracked ${d}/ content"
  fi
done
if list_files_in "$GATE_DIR" | grep -E '(^|/)\.env$' >/dev/null; then
  note_fail ".env present"
else
  note_ok "no .env present"
fi
if list_files_in "$GATE_DIR" | grep -E '(^|/)seed\.(workspaces|agents)\.json$' >/dev/null; then
  note_fail "real seed json present"
else
  note_ok "no real seed json present"
fi

echo
echo "=============================================="
if [ "$FAIL" -eq 0 ]; then
  echo " WIKI GATE RESULT: PASS"
  echo "=============================================="
  exit 0
else
  echo " WIKI GATE RESULT: FAIL — publish BLOCKED"
  echo "=============================================="
  exit 1
fi
