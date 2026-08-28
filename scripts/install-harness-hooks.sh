#!/usr/bin/env bash
# Point this checkout's git hooks at the versioned .githooks/ dir so the
# pre-push harness gate is active. Idempotent. Run once per checkout/worktree.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

git config core.hooksPath .githooks
chmod +x .githooks/* 2>/dev/null || true

echo "[harness] core.hooksPath -> .githooks (active in ${REPO_ROOT})"
echo "[harness] Direct pushes to 'main' are now blocked here. PR + harness gate required."
echo "[harness] Emergency override: HARNESS_OVERRIDE=1 git push origin main"
