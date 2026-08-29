#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Apply the GitHub branch-protection ruleset that makes `gate` (the Actions
# job in .github/workflows/gate.yml) required on `main`.
#
# REQUIRES GitHub Pro on a private repo (rulesets are plan-gated on Free — the
# .githooks/pre-push hook is the free-tier interim block). Token needs admin.
#
# Modes:
#   soft     Create/update the ruleset WITH repo-admin bypass (bypass_mode:always).
#            Non-admins must PR + pass the check; repo admins can still push
#            directly. Safe to run first — no lockout. (default)
#   enforce  Remove bypass_actors so NOBODY can push directly to main, including
#            admins. This is the true push-to-prod block. ⚠ Requires an explicit
#            owner decision — do not run until the loop is dogfooded and the repo
#            owner has signed off.
#   status   Print the current ruleset.
#   delete   Remove the ruleset (full rollback).
#
# Usage: bash scripts/apply-branch-protection.sh [soft|enforce|status|delete]
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO="${HARNESS_REPO:-your-org/operationkit}"
RULESET_NAME="harness-gate-main"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JSON="${SCRIPT_DIR}/branch-protection-ruleset.json"
MODE="${1:-soft}"

ruleset_id() {
  gh api "repos/${REPO}/rulesets" --jq ".[] | select(.name==\"${RULESET_NAME}\") | .id" 2>/dev/null | head -1
}

case "${MODE}" in
  status)
    id="$(ruleset_id || true)"
    if [[ -z "${id}" ]]; then echo "[harness] No '${RULESET_NAME}' ruleset found."; exit 0; fi
    gh api "repos/${REPO}/rulesets/${id}" --jq '{name, enforcement, bypass_actors, rules: [.rules[].type]}'
    ;;
  soft)
    id="$(ruleset_id || true)"
    if [[ -z "${id}" ]]; then
      echo "[harness] Creating ruleset '${RULESET_NAME}' (soft: admin bypass on)..."
      gh api -X POST "repos/${REPO}/rulesets" --input "${JSON}" --jq '.id,.enforcement'
    else
      echo "[harness] Updating ruleset #${id} to soft (admin bypass on)..."
      gh api -X PUT "repos/${REPO}/rulesets/${id}" --input "${JSON}" --jq '.id,.enforcement'
    fi
    echo "[harness] Soft gate active. Repo admins can still push; non-admins need PR + gate."
    ;;
  enforce)
    id="$(ruleset_id || true)"
    if [[ -z "${id}" ]]; then echo "[harness] Run 'soft' first to create the ruleset."; exit 1; fi
    echo "[harness] ⚠ Removing bypass — NO ONE (incl. admins) can push directly to main."
    # Uses the no-bypass variant (bypass_actors: []); keeps all rules. No jq needed.
    gh api -X PUT "repos/${REPO}/rulesets/${id}" --input "${SCRIPT_DIR}/branch-protection-ruleset-enforce.json" --jq '.id,.enforcement,(.bypass_actors|length)'
    echo "[harness] ENFORCED. Direct push-to-prod is now blocked for everyone. Rollback: bash $0 soft"
    ;;
  delete)
    id="$(ruleset_id || true)"
    if [[ -z "${id}" ]]; then echo "[harness] Nothing to delete."; exit 0; fi
    gh api -X DELETE "repos/${REPO}/rulesets/${id}"
    echo "[harness] Ruleset '${RULESET_NAME}' deleted."
    ;;
  *)
    echo "Usage: $0 [soft|enforce|status|delete]"; exit 1 ;;
esac
