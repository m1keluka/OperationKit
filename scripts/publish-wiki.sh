#!/usr/bin/env bash
# publish-wiki.sh — publish docs/wiki/ to the public GitHub wiki, gated.
#
# PURPOSE
#   The source of truth for the public OperationKit wiki lives HERE, in this
#   private repo, at docs/wiki/*.md — so the wiki stays in lockstep with the
#   product docs it's drawn from (docs/product/, docs/api/, docs/architecture/)
#   instead of drifting as a hand-edited page on github.com.
#
#   This script assembles docs/wiki/ into a scratch tree, runs it through the
#   SAME genericize + gate pipeline oss-sync.yml uses for the main OSS cut
#   (scripts/oss-genericize.sh + scripts/oss-sync-gate.sh), and — only if the
#   gate passes — pushes the result as the GitHub wiki git repo for
#   PUBLIC_WIKI_REPO (owner/Name.wiki, e.g. m1keluka/OperationKit.wiki).
#
#   FAIL-CLOSED, same discipline as oss-sync.yml: a gate failure aborts before
#   any push. This is a MANUAL/CI publish step, not a continuous sync — running
#   it is a deliberate decision, same as the main OSS cut.
#
# USAGE
#   scripts/publish-wiki.sh [--push]
#     (no flag)  assemble + genericize + gate only; leaves the result in
#                $WORK_DIR for inspection. Does not touch the network.
#     --push     also clone the wiki repo and push the result.
#
# ENV
#   PUBLIC_WIKI_REPO   owner/Repo.wiki form, e.g. m1keluka/OperationKit.wiki
#                      (default: m1keluka/OperationKit.wiki)
#   GH_TOKEN           GitHub token with push access to the wiki repo. Read
#                      from the environment only — never hardcoded here.
#   GITLEAKS_BIN       path to gitleaks (default: `gitleaks` on PATH)
#
# EXIT
#   0 on a clean gate (and, with --push, a successful push). Non-zero on any
#   gate failure or push failure. No partial push: the wiki clone/commit/push
#   sequence only runs after the gate exits 0.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

PUBLIC_WIKI_REPO="${PUBLIC_WIKI_REPO:-m1keluka/OperationKit.wiki}"
DO_PUSH=0
for arg in "$@"; do
  case "$arg" in
    --push) DO_PUSH=1 ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

if [ ! -d "$REPO_ROOT/docs/wiki" ]; then
  echo "ERROR: $REPO_ROOT/docs/wiki does not exist — nothing to publish." >&2
  exit 1
fi

WORK_DIR="$(mktemp -d -t publish-wiki-XXXXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT

RAW_DIR="$WORK_DIR/raw"
TREE_DIR="$WORK_DIR/tree"
mkdir -p "$RAW_DIR" "$TREE_DIR"

echo "=== publish-wiki: assembling docs/wiki/ ==="
cp -a "$REPO_ROOT/docs/wiki/." "$RAW_DIR/"
cp -a "$REPO_ROOT/docs/wiki/." "$TREE_DIR/"
echo "  $(find "$TREE_DIR" -type f | wc -l) page(s) assembled"

echo
echo "=== publish-wiki: genericizing (W3 string-replacement table, text-only) ==="
# NOTE: this does NOT call scripts/oss-genericize.sh. That script's first step
# (oss-blank-slate.py) asserts specific product-tree files exist
# (app/client/src/components/MeetingQueueDrawer.tsx etc.) and fails closed when
# they don't — correct for the full product-tree OSS cut, wrong for a
# docs/wiki/-only tree, which never contains those files. Wiki pages are prose,
# not product code, so there is nothing to structurally de-seed here (no
# hardcoded workspace-slug literals, no agent roster, no Supabase dev seed).
# scripts/oss-sync-gate.sh — the actual safety net (denylist + gitleaks +
# real-content absence) — still runs unmodified below, against this tree.
"$SCRIPT_DIR/oss-wiki-genericize.sh" "$TREE_DIR"

echo
echo "=== publish-wiki: running the wiki safety gate ==="
# Reuses scripts/oss-denylist.txt and the same gitleaks invocation as
# scripts/oss-sync-gate.sh (the main OSS cut's gate) so one denylist protects
# both publish paths. Drops that gate's agent-roster/seed-file checks, which
# assert product-tree properties a prose-only wiki tree doesn't have — see
# scripts/oss-wiki-gate.sh's header.
chmod +x "$SCRIPT_DIR/oss-wiki-gate.sh"
GATE_DIR="$TREE_DIR" PREGEN_DIR="$RAW_DIR" "$SCRIPT_DIR/oss-wiki-gate.sh"
GATE_RC=$?

if [ "$GATE_RC" -ne 0 ]; then
  echo "publish-wiki: gate FAILED — refusing to publish." >&2
  exit "$GATE_RC"
fi

echo
echo "=== publish-wiki: gate passed. Assembled tree at $TREE_DIR ==="

if [ "$DO_PUSH" -eq 0 ]; then
  echo "publish-wiki: --push not set — stopping before any network call."
  echo "  Inspect the assembled tree, or re-run with --push to publish to"
  echo "  https://github.com/${PUBLIC_WIKI_REPO}"
  # Copy the gated tree somewhere the caller can still inspect it after the
  # trap cleans up WORK_DIR.
  OUT_DIR="${PUBLISH_WIKI_OUT:-$REPO_ROOT/.wiki-publish-preview}"
  rm -rf "$OUT_DIR"
  cp -a "$TREE_DIR" "$OUT_DIR"
  echo "  Gated tree copied to: $OUT_DIR"
  exit 0
fi

if [ -z "${GH_TOKEN:-}" ]; then
  echo "ERROR: --push requires GH_TOKEN in the environment (not found)." >&2
  exit 1
fi

echo
echo "=== publish-wiki: pushing to https://github.com/${PUBLIC_WIKI_REPO}.git ==="
WIKI_CLONE="$WORK_DIR/wiki-clone"
WIKI_URL="https://x-access-token:${GH_TOKEN}@github.com/${PUBLIC_WIKI_REPO}.git"

if git clone --quiet "$WIKI_URL" "$WIKI_CLONE" 2>"$WORK_DIR/clone.log"; then
  echo "  cloned existing wiki repo"
else
  echo "  wiki repo not clonable yet (GitHub returns not-found until the first"
  echo "  page is created via the web UI). See docs/wiki in this repo and"
  echo "  create a Home page by hand once, then re-run with --push."
  cat "$WORK_DIR/clone.log" >&2
  exit 1
fi

rsync -a --delete --exclude='.git/' "$TREE_DIR/" "$WIKI_CLONE/"

cd "$WIKI_CLONE"
git config user.email "wiki-publish@operationkit.local"
git config user.name "OperationKit Wiki Publish"
git add -A
if git diff --cached --quiet; then
  echo "  no changes — wiki already up to date"
  exit 0
fi
git commit -q -m "docs: publish wiki from upstream docs/wiki (gated)"
git push --quiet origin HEAD:master 2>"$WORK_DIR/push.log" || git push --quiet origin HEAD:main 2>>"$WORK_DIR/push.log"
echo "  pushed."
