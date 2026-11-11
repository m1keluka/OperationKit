#!/usr/bin/env bash
# test-integrity-fixture-test.sh — fixture test for scripts/test-integrity.py.
#
# Builds throwaway git repos and asserts the gate's test-deletion rule:
# a deleted test passes only when the code it tests is deleted in the same diff,
# and every other deletion (or a new skip) still fails.
#
# USAGE: scripts/test-integrity-fixture-test.sh
# EXIT:  0 when every assertion passes; 1 otherwise.

set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECK="$REPO_ROOT/scripts/test-integrity.py"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
FAILED=0
ok()  { echo "  PASS  $*"; }
bad() { echo "  FAIL  $*"; FAILED=1; }

# new_repo NAME — a repo with a base commit holding sources + tests.
new_repo() {
  local r="$WORK/$1"
  mkdir -p "$r/src/lib" && cd "$r" || exit 1
  git init -q -b main
  git config user.email fixture@example.com
  git config user.name fixture
  echo 'export const foo = 1' > src/foo.ts
  echo "import { foo } from './foo.js'; test('foo', () => {})" > src/foo.test.ts
  echo 'export const List = 1' > src/List.tsx
  echo "import { List } from './List'; test('l', () => {})" > src/List.named.test.tsx
  echo 'export const core = 1' > src/core.ts
  echo "import { core } from './core.js'; test('c', () => {})" > src/spawn.test.ts
  echo 'export const db = 1' > src/lib/db.ts
  echo "import { db } from './lib/db.js'; import { core } from './core.js'; test('m', () => {})" > src/mixed.test.ts
  echo "import { core } from './core.js'; vi.mock('./lib/db.js'); test('k', () => {})" > src/mocked.test.ts
  echo "test('none', () => {})" > src/orphan.test.ts
  echo 'export const mv = 1' > src/mv.ts
  echo "import { mv } from './mv.js'; test('mv', () => {})" > src/mv.test.ts
  git add -A && git commit -qm base
  BASE=$(git rev-parse HEAD)
}

# run_check EXPECTED_EXIT LABEL [GREP_PATTERN...] — commit, run, assert.
run_check() {
  local want=$1 label=$2; shift 2
  git add -A && git commit -qm head --allow-empty
  local out rc
  out=$(python3 "$CHECK" "$BASE" "$(git rev-parse HEAD)" 2>&1); rc=$?
  if [ "$rc" != "$want" ]; then
    bad "$label: exit $rc, want $want"; echo "$out" | sed 's/^/        /'; return
  fi
  for pat in "$@"; do
    if ! grep -qE -- "$pat" <<<"$out"; then
      bad "$label: output missing /$pat/"; echo "$out" | sed 's/^/        /'; return
    fi
  done
  ok "$label"
}

echo '=== allowed: test deleted together with the code it tests ==='
new_repo allowed-name
git rm -q src/foo.ts src/foo.test.ts
run_check 0 'same-name source deleted' \
  'ALLOWED deleted test src/foo.test.ts: its source src/foo.ts is deleted too'

new_repo allowed-qualifier
git rm -q src/List.tsx src/List.named.test.tsx
run_check 0 'qualified test name (List.named.test.tsx -> List.tsx)' \
  'ALLOWED deleted test src/List.named.test.tsx: its source src/List.tsx'

new_repo allowed-imports
git rm -q src/core.ts src/spawn.test.ts src/mocked.test.ts
run_check 0 'every import target deleted (vi.mock of a kept file ignored)' \
  'ALLOWED deleted test src/spawn.test.ts: every import is deleted: src/core.ts' \
  'ALLOWED deleted test src/mocked.test.ts: every import is deleted: src/core.ts'

echo '=== rejected: test deleted while the code it tests survives ==='
new_repo rejected-plain
git rm -q src/foo.test.ts
run_check 1 'test deleted, source kept' \
  'REJECTED deleted test src/foo.test.ts' '::error title=Test file deleted::src/foo.test.ts'

new_repo rejected-partial
git rm -q src/core.ts src/mixed.test.ts
run_check 1 'one import deleted, another kept' \
  'REJECTED deleted test src/mixed.test.ts.*src/lib/db.ts'

new_repo rejected-orphan
git rm -q src/orphan.test.ts src/core.ts
run_check 1 'test with no imports cannot ride an unrelated deletion' \
  'REJECTED deleted test src/orphan.test.ts.*imports no relative module'

new_repo rejected-moved
mkdir -p src/moved && git mv src/mv.ts src/moved/mv.ts && git rm -q src/mv.test.ts
run_check 1 'source moved, not removed' 'REJECTED deleted test src/mv.test.ts'

new_repo rejected-mixed-batch
git rm -q src/foo.ts src/foo.test.ts src/orphan.test.ts
run_check 1 'one allowed + one rejected in the same diff still fails' \
  'ALLOWED deleted test src/foo.test.ts' 'REJECTED deleted test src/orphan.test.ts'

echo '=== unchanged behaviour ==='
new_repo skip-rule
echo "test.skip('x', () => {})" >> src/foo.test.ts
run_check 1 'new .skip( still fails' 'New test skip/only introduced'

new_repo clean
echo 'export const bar = 2' >> src/foo.ts
run_check 0 'no test changes is clean' 'OK: no new skips'

new_repo stale-branch
git checkout -q -b feature
echo 'export const bar = 2' >> src/foo.ts && git add -A && git commit -qm feature
FEATURE=$(git rev-parse HEAD)
git checkout -q main
echo 'export const late = 1' > src/late.ts
echo "import { late } from './late.js'; test('late', () => {})" > src/late.test.ts
git add -A && git commit -qm 'base moves on'
TIP=$(git rev-parse HEAD)
out=$(python3 "$CHECK" "$TIP" "$FEATURE" 2>&1); rc=$?
if [ "$rc" = 0 ] && ! grep -q 'late.test.ts' <<<"$out"; then
  ok 'test added to base after the branch was cut is not counted as deleted'
else bad "stale branch: exit $rc"; echo "$out" | sed 's/^/        /'; fi

new_repo bad-base
cd "$WORK/bad-base" || exit 1
out=$(python3 "$CHECK" 0000000000000000000000000000000000000000 HEAD 2>&1); rc=$?
if [ "$rc" != 0 ]; then ok "unreachable base sha fails closed (exit $rc)"; else bad 'unreachable base sha exited 0'; fi

[ "$FAILED" = 0 ] && echo 'ALL PASS' || echo 'FAILURES above'
exit "$FAILED"
