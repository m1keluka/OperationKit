#!/usr/bin/env bash
# verify.sh — phase 3: prove the new host works. Read-only except where noted.
#
# Run on the NEW host as mike after cutover.sh:
#   bash scripts/migrate/verify.sh [--new-ip IP] [--test-card] [--skip-accounts] [--dry-run]
#
# A cc_live_ API key is needed for the authenticated checks (MCP, API key page,
# test card). Create one in Settings > You > API key, then either export it as
# CC_API_KEY (`read -rs CC_API_KEY; export CC_API_KEY`) or let the script
# prompt for it (input hidden). The key goes to curl through a 600 temp file,
# never argv, never the log.
#
#   --new-ip IP      also check public DNS resolves to IP, and test HTTPS via
#                    --resolve before DNS has flipped
#   --test-card      [confirm] create a throwaway card, start it, wait for
#                    `working`, then cancel it (uses one subscription session)
#   --skip-accounts  skip the per-slot Claude/Codex login probe
#
# Account probe: one tiny `claude -p` per slot (a-g) as ccuser with
# ANTHROPIC_API_KEY stripped, so it can only pass on the subscription login.
set -euo pipefail
# shellcheck source=scripts/migrate/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

DOMAIN=cc.example.com
BASE=http://127.0.0.1:3002
NEW_IP=
TEST_CARD=0
SKIP_ACCOUNTS=0

parse_common_args "$@"
set -- "${REST_ARGS[@]+"${REST_ARGS[@]}"}"
while [ $# -gt 0 ]; do
  case "$1" in
    --new-ip) shift; NEW_IP=${1:-} ;;
    --new-ip=*) NEW_IP=${1#--new-ip=} ;;
    --test-card) TEST_CARD=1 ;;
    --skip-accounts) SKIP_ACCOUNTS=1 ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done
require_user_mike

HDR_FILE=$(mktemp)
chmod 600 "$HDR_FILE"
trap 'rm -f "$HDR_FILE"' EXIT
have_key=0
if [ -z "${CC_API_KEY:-}" ] && have_tty; then
  printf 'cc_live_ API key for authenticated checks (hidden; empty = skip those checks): ' > /dev/tty
  IFS= read -rs CC_API_KEY < /dev/tty || CC_API_KEY=
  printf '\n' > /dev/tty
fi
if [ -n "${CC_API_KEY:-}" ]; then
  case "$CC_API_KEY" in cc_live_*) ;; *) die "that is not a cc_live_ key" ;; esac
  printf 'Authorization: Bearer %s\n' "$CC_API_KEY" > "$HDR_FILE"
  unset CC_API_KEY
  have_key=1
fi
# api METHOD PATH [json-body] — authenticated call; prints the body.
api() {
  local method=$1 path=$2 body=${3:-}
  if [ -n "$body" ]; then
    curl -fsS -X "$method" -H @"$HDR_FILE" -H 'Content-Type: application/json' --data "$body" "$BASE$path"
  else
    curl -fsS -X "$method" -H @"$HDR_FILE" "$BASE$path"
  fi
}

# ── services ────────────────────────────────────────────────────────────────
step "containers"
for c in command-center litellm litellm-db; do
  st=$(docker inspect -f '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{else}}n/a{{end}}' "$c" 2>/dev/null) || st=missing
  case "$st" in running/healthy|running/n/a) pass "$c $st" ;; *) fail "$c $st" ;; esac
done
if curl -fsS "$BASE/api/health" >/dev/null 2>&1; then pass "GET /api/health (local)"; else fail "GET /api/health (local)"; fi
if curl -fsS http://127.0.0.1:4000/health/liveliness >/dev/null 2>&1; then pass "LiteLLM liveliness"; else fail "LiteLLM liveliness"; fi

step "board + TLS"
if [ -n "$NEW_IP" ]; then
  got=$(dig +short "$DOMAIN" @1.1.1.1 | tail -1)
  if [ "$got" = "$NEW_IP" ]; then pass "DNS $DOMAIN -> $NEW_IP"; else note "DNS $DOMAIN -> ${got:-none} (not yet $NEW_IP)"; fi
  resolve=(--resolve "$DOMAIN:443:$NEW_IP")
else
  resolve=()
fi
html=$(curl -fsS "${resolve[@]+"${resolve[@]}"}" "https://$DOMAIN/" 2>/dev/null || true)
if [[ "$html" == *'<div id="root"'* ]] || [[ "$html" == *'/assets/'* ]]; then pass "board shell served over HTTPS"; else fail "board shell not served over HTTPS (caddy / client dist?)"; fi
if [ -s "$CC_REPO/app/client/dist/index.html" ]; then pass "client dist present (bind-mounted)"; else fail "app/client/dist/index.html missing — board will be blank"; fi
settings=$(curl -fsS "${resolve[@]+"${resolve[@]}"}" "https://$DOMAIN/settings/you" 2>/dev/null || true)
if [ -n "$settings" ]; then pass "Settings > You route served (SPA)"; else fail "Settings > You route not served"; fi
exp=$(echo | openssl s_client -servername "$DOMAIN" -connect "${NEW_IP:-$DOMAIN}:443" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null || true)
if [ -n "$exp" ]; then pass "TLS cert: $exp"; else note "could not read TLS cert yet"; fi

# ── authenticated checks ────────────────────────────────────────────────────
step "API key page, MCP endpoint"
if [ "$have_key" -eq 1 ]; then
  if api GET /api/auth/api-key >/dev/null 2>&1; then pass "GET /api/auth/api-key (the Settings > API key page's data)"; else fail "GET /api/auth/api-key"; fi
  mcp=$(api POST /api/mcp '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' 2>/dev/null || true)
  if [[ "$mcp" == *'"tools"'* ]]; then
    n=$(printf '%s' "$mcp" | grep -o '"name"' | wc -l)
    pass "POST /api/mcp tools/list ($n tools)"
  else
    fail "POST /api/mcp tools/list"
  fi
else
  note "no API key given — skipped API key page + MCP checks"
fi

# ── test card ───────────────────────────────────────────────────────────────
if [ "$TEST_CARD" -eq 1 ]; then
  step "test card -> working"
  if [ "$have_key" -eq 0 ]; then
    fail "--test-card needs an API key"
  else
    confirm TEST-CARD "create + start a throwaway card (one short subscription session), then cancel it"
    if [ "$DRY_RUN" -eq 0 ]; then
      created=$(api POST /api/objectives '{"title":"Migration smoke test (safe to cancel)","description":"Post-migration check. Reply with the word OK and stop. Do not edit any files.","workspace":"operationkit","skip_ai_review":true}')
      id=$(printf '%s' "$created" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
      [ -n "$id" ] || die "card create failed"
      log "created card $id"
      api PATCH "/api/objectives/$id/status" '{"status":"working"}' >/dev/null
      st=
      for _ in $(seq 1 36); do
        st=$(api GET "/api/objectives/$id" | grep -o '"status":"[a-z_]*"' | head -1 | cut -d'"' -f4)
        sid=$(api GET "/api/objectives/$id" | grep -o '"session_id":"[^"]*"' | head -1 || true)
        log "card $id status=$st ${sid:+(session attached)}"
        [ "$st" = working ] && [ -n "$sid" ] && break
        sleep 5
      done
      if [ "$st" = working ]; then pass "test card $id reached working"; else fail "test card $id stuck at '$st'"; fi
      api PATCH "/api/objectives/$id/status" '{"status":"cancelled"}' >/dev/null && log "card $id cancelled"
    fi
  fi
fi

# ── Claude / Codex account slots ────────────────────────────────────────────
if [ "$SKIP_ACCOUNTS" -eq 0 ]; then
  step "account slots (subscription login only — ANTHROPIC_API_KEY stripped)"
  for slot in a b c d e f g; do
    case "$slot" in [a-e]) home=/home/ccuser-$slot ;; *) home=/app/data/cc-accounts/$slot ;; esac
    if ! docker exec command-center test -d "$home/.claude"; then note "slot $slot: no $home/.claude (slot unused?)"; continue; fi
    if [ "$DRY_RUN" -eq 1 ]; then log "[dry-run] would probe slot $slot ($home)"; continue; fi
    out=$(docker exec -u ccuser -e HOME="$home" command-center \
      env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN timeout 90 claude -p 'Reply with exactly: OK' --max-turns 1 2>&1 | tail -3 || true)
    if [[ "$out" == *OK* ]]; then
      pass "slot $slot logged in ($home)"
    else
      fail "slot $slot NOT usable ($home): $(printf '%s' "$out" | tr '\n' ' ' | cut -c1-160)"
      printf '      re-login: docker exec -it -u ccuser -e HOME=%s command-center env -u ANTHROPIC_API_KEY claude\n' "$home"
      printf '                then /login -> "Claude account with subscription" -> the account for slot %s; /exit\n' "$slot"
    fi
  done
  if docker exec command-center test -f /home/ccuser-codex/.codex/auth.json; then
    if docker exec -u ccuser -e HOME=/home/ccuser-codex command-center codex login status >/dev/null 2>&1; then
      pass "codex slot logged in"
    else
      fail "codex slot: re-login with docker exec -it -u ccuser -e HOME=/home/ccuser-codex command-center codex login"
    fi
  else
    note "codex slot has no auth.json"
  fi
fi

# ── OSS sync gate ───────────────────────────────────────────────────────────
step "OSS sync (the publish itself runs in GitHub Actions; this checks the host side)"
if command -v gitleaks >/dev/null 2>&1; then pass "gitleaks $(gitleaks version 2>/dev/null)"; else fail "gitleaks missing (bootstrap-host.sh step 3)"; fi
if [ "$DRY_RUN" -eq 1 ]; then
  log "[dry-run] would run scripts/oss-gate-roster-test.sh (gate vs synthetic trees, no publish)"
else
  wd=$(mktemp -d)
  if bash "$CC_REPO/scripts/oss-gate-roster-test.sh" "$wd" > "$MIGRATE_LOG_DIR/oss-gate-roster-test.log" 2>&1; then
    pass "oss-gate-roster-test.sh (real gitleaks gate on clean + dirty fixtures)"
  else
    fail "oss-gate-roster-test.sh — see $MIGRATE_LOG_DIR/oss-gate-roster-test.log"
  fi
  rm -rf "$wd"
fi
if gh run list -R your-org/operationkit --workflow oss-sync.yml -L 1 --json conclusion,createdAt -q '.[0] | "\(.conclusion) \(.createdAt)"' 2>/dev/null | sed 's/^/  last oss-sync run: /'; then :; else note "gh could not list oss-sync runs"; fi

# ── schedulers ──────────────────────────────────────────────────────────────
step "crons, timers, host-boot hooks"
crontab -l 2>/dev/null | grep -E '^[^#]' | sed 's/^/  /' || true
for m in update-active-state generate-daily-digest campaign-audit cron-health-check dream-cycle disk-cleanup; do
  if crontab -l 2>/dev/null | grep -E '^[^#]' | grep -q "$m"; then pass "cron: $m"; else fail "cron missing: $m"; fi
done
if crontab -l 2>/dev/null | grep -E '^[^#]' | grep -q reconcile-clients; then pass "cron: reconcile-clients"; else note "cron reconcile-clients not installed (its installer skips when the endpoint is absent)"; fi
systemctl list-timers --all --no-pager 'cc-*' | sed 's/^/  /'
if systemctl is-active --quiet cc-preview-spool.path; then pass "cc-preview-spool.path active"; else fail "cc-preview-spool.path inactive"; fi
if systemctl is-enabled --quiet cc-backup.timer 2>/dev/null; then pass "cc-backup.timer enabled"; else fail "cc-backup.timer not enabled (install-backup-timer.sh)"; fi
if docker logs --since 15m command-center 2>&1 | grep -q '\[host-boot\]'; then pass "host-boot.d ticking (seen in last 15m of logs)"; else note "no [host-boot] log line in last 15m (it ticks every 5m; quiet when hooks print nothing)"; fi
if docker logs --since 15m command-center 2>&1 | grep -q '\[disk-watchdog\]'; then pass "disk watchdog running"; else note "no [disk-watchdog] line in last 15m"; fi

# ── disk + RAID ─────────────────────────────────────────────────────────────
step "disk + RAID health"
df -h / | sed 's/^/  /'
free_pct=$(df -Pk / | awk 'NR==2{printf "%d", $4*100/$2}')
if [ "$free_pct" -ge 15 ]; then pass "root fs ${free_pct}% free"; else fail "root fs only ${free_pct}% free"; fi
if grep -E '^\s+[0-9]+ blocks' /proc/mdstat | grep -q '_'; then fail "RAID degraded:"; grep -A2 '^md' /proc/mdstat | sed 's/^/  /'; else pass "md arrays in sync"; fi
for md in /dev/md[0-9]*; do
  [ -b "$md" ] || continue
  state=$(sudo mdadm --detail "$md" | awk -F' : ' '/State :/{print $2}')
  case "$state" in clean|active|"clean "*|"active "*) pass "$md state: $state" ;; *) fail "$md state: $state" ;; esac
done
for d in /dev/nvme[0-9]n1; do
  [ -b "$d" ] || continue
  if sudo smartctl -H "$d" 2>/dev/null | grep -qE 'PASSED|OK'; then pass "SMART $d"; else fail "SMART $d not PASSED"; fi
done
wt=$(find "$PROJECTS_DIR" -maxdepth 1 \( -name '*-wt-*' -o -name '.cc-worktree-*' \) | wc -l)
log "ad-hoc worktrees under projects/: $wt"

summary
