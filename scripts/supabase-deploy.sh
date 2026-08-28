#!/usr/bin/env bash
# supabase-deploy.sh — Zero-setup Supabase deployment from Command Center sessions.
#
# Usage:
#   supabase-deploy.sh <project> status
#   supabase-deploy.sh <project> migrate [--dry-run]
#   supabase-deploy.sh <project> deploy-function <name> [--no-verify-jwt]
#   supabase-deploy.sh <project> deploy-all-functions [--no-verify-jwt]
#   supabase-deploy.sh <project> functions-list
#   supabase-deploy.sh <project> migration-list
#
# Reads project metadata from .supabase-registry.json.
# Only credential needed: SUPABASE_ACCESS_TOKEN (injected into the session env
# from the native secrets store). No DB passwords required — uses the Management API
# via `supabase link` + `--linked` mode.
#
# Auto-links the project on first use (writes .supabase/ in the project dir).
# Concurrent sessions on the same project are safe — link is idempotent and
# push/deploy use the API, not direct DB connections.

set -euo pipefail

REGISTRY="/home/operator/projects/.supabase-registry.json"
SCRIPT_NAME="$(basename "$0")"

usage() {
  cat >&2 <<EOF
Usage: $SCRIPT_NAME <project> <command> [args...]

Commands:
  status                  Verify credentials and project connectivity
  migrate [--dry-run]     Push pending migrations (supabase db push)
  deploy-function <name>  Deploy a single edge function
  deploy-all-functions    Deploy all edge functions in supabase/functions/
  functions-list          List deployed edge functions
  migration-list          List migration status

Projects:
$(jq -r '.projects | keys[]' "$REGISTRY" 2>/dev/null | sed 's/^/  /' || echo "  (registry not found)")
EOF
  exit 1
}

die() { echo "[supabase-deploy] ERROR: $*" >&2; exit 1; }
info() { echo "[supabase-deploy] $*"; }

# ── Validate args ──
[ $# -ge 2 ] || usage
PROJECT="$1"
COMMAND="$2"
shift 2

# ── Check prerequisites ──
command -v jq &>/dev/null || die "jq not installed"
command -v supabase &>/dev/null || die "supabase CLI not installed"
[ -f "$REGISTRY" ] || die "Registry not found at $REGISTRY"

# ── Resolve project from registry ──
REF=$(jq -r ".projects[\"$PROJECT\"].ref // empty" "$REGISTRY")
PROJECT_PATH=$(jq -r ".projects[\"$PROJECT\"].path // empty" "$REGISTRY")

[ -n "$REF" ] || die "Project '$PROJECT' not found in registry. Available: $(jq -r '.projects | keys[]' "$REGISTRY" | tr '\n' ' ')"
[ -d "$PROJECT_PATH" ] || die "Project path '$PROJECT_PATH' does not exist"

# ── Resolve SUPABASE_ACCESS_TOKEN ──
# Injected into the session env from Settings → Secrets. Host/cron callers can
# `docker exec command-center tsx /app/server/src/scripts/secrets-get.ts SUPABASE_ACCESS_TOKEN`.
if [ -z "${SUPABASE_ACCESS_TOKEN:-}" ]; then
  die "SUPABASE_ACCESS_TOKEN is not set. Add it under Settings → Secrets (global)."
fi

# ── Helper: ensure project is linked (idempotent) ──
ensure_linked() {
  cd "$PROJECT_PATH"
  # Check if already linked to the correct ref
  if [ -f ".supabase/project-ref" ] && [ "$(cat .supabase/project-ref 2>/dev/null)" = "$REF" ]; then
    return 0
  fi
  info "Linking project to $REF..."
  # Link without DB password — we use the Management API, not direct connections
  supabase link --project-ref "$REF" <<< "" 2>/dev/null || true
  # Verify link succeeded
  if [ -f ".supabase/project-ref" ] && [ "$(cat .supabase/project-ref 2>/dev/null)" = "$REF" ]; then
    info "Linked successfully."
  else
    # Fallback: create the link file manually (the CLI just writes the ref)
    mkdir -p .supabase
    echo -n "$REF" > .supabase/project-ref
    info "Link file created manually."
  fi
}

# ── Commands ──
case "$COMMAND" in
  status)
    info "Project:      $PROJECT"
    info "Ref:          $REF"
    info "Path:         $PROJECT_PATH"
    info "Access token: ${SUPABASE_ACCESS_TOKEN:+set (${#SUPABASE_ACCESS_TOKEN} chars)}"

    # Check link status
    if [ -f "$PROJECT_PATH/.supabase/project-ref" ]; then
      LINKED_REF=$(cat "$PROJECT_PATH/.supabase/project-ref" 2>/dev/null)
      if [ "$LINKED_REF" = "$REF" ]; then
        info "Linked:       yes (ref matches)"
      else
        info "Linked:       MISMATCH (linked to $LINKED_REF, expected $REF)"
      fi
    else
      info "Linked:       no (will auto-link on first command)"
    fi

    # Check migration count
    MIGRATIONS_DIR="$PROJECT_PATH/supabase/migrations"
    if [ -d "$MIGRATIONS_DIR" ]; then
      MIGRATION_COUNT=$(find "$MIGRATIONS_DIR" -name '*.sql' | wc -l | tr -d ' ')
      info "Migrations:   $MIGRATION_COUNT files"
    else
      info "Migrations:   (no supabase/migrations/ directory)"
    fi

    # Check functions count
    FUNCS_DIR="$PROJECT_PATH/supabase/functions"
    if [ -d "$FUNCS_DIR" ]; then
      FUNC_COUNT=$(find "$FUNCS_DIR" -mindepth 1 -maxdepth 1 -type d ! -name '_*' | wc -l | tr -d ' ')
      info "Functions:    $FUNC_COUNT directories"
    else
      info "Functions:    (no supabase/functions/ directory)"
    fi

    # Verify CLI can reach the project
    info "Verifying CLI connectivity..."
    if supabase projects list 2>/dev/null | grep -q "$REF"; then
      info "CLI auth:     OK (project found in account)"
    else
      info "CLI auth:     WARNING — project $REF not found in supabase projects list"
    fi
    ;;

  migrate)
    ensure_linked
    info "Pushing migrations for $PROJECT (ref: $REF)..."
    cd "$PROJECT_PATH"
    supabase db push "$@"
    info "Migrations applied successfully."
    ;;

  deploy-function)
    FUNC_NAME="${1:?Usage: $SCRIPT_NAME $PROJECT deploy-function <function-name>}"
    shift
    info "Deploying function '$FUNC_NAME' for $PROJECT (ref: $REF)..."
    cd "$PROJECT_PATH"
    supabase functions deploy "$FUNC_NAME" --project-ref "$REF" "$@"
    info "Function '$FUNC_NAME' deployed successfully."
    ;;

  deploy-all-functions)
    FUNCS_DIR="$PROJECT_PATH/supabase/functions"
    [ -d "$FUNCS_DIR" ] || die "No supabase/functions/ directory at $PROJECT_PATH"

    info "Deploying all functions for $PROJECT (ref: $REF)..."
    cd "$PROJECT_PATH"
    DEPLOYED=0
    FAILED=0
    for func_dir in "$FUNCS_DIR"/*/; do
      [ -d "$func_dir" ] || continue
      func_name=$(basename "$func_dir")
      # Skip shared/utility directories (conventionally prefixed with _)
      [[ "$func_name" == _* ]] && continue

      info "  -> $func_name"
      if supabase functions deploy "$func_name" --project-ref "$REF" "$@" 2>&1; then
        DEPLOYED=$((DEPLOYED + 1))
      else
        info "  !! FAILED: $func_name"
        FAILED=$((FAILED + 1))
      fi
    done
    info "Done. Deployed: $DEPLOYED, Failed: $FAILED"
    [ "$FAILED" -eq 0 ] || exit 1
    ;;

  functions-list)
    info "Listing deployed functions for $PROJECT (ref: $REF)..."
    supabase functions list --project-ref "$REF"
    ;;

  migration-list)
    ensure_linked
    info "Migration status for $PROJECT:"
    cd "$PROJECT_PATH"
    supabase migration list
    ;;

  *)
    die "Unknown command '$COMMAND'. Run '$SCRIPT_NAME' with no args for usage."
    ;;
esac
