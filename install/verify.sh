#!/usr/bin/env bash
# install/verify.sh — prove an install works, end to end.
#
#   sudo bash install/verify.sh --config client.conf [--local-only] [--skip-card]
#        [--card-timeout 600]
#
# Checks (each prints PASS / FAIL; exit 1 if any FAIL):
#   1. the app (and the Cloudflare connector) containers are running
#   2. the firewall is on and no web port is open to the internet
#   3. the app answers on the server itself
#   4. https://DOMAIN is behind Cloudflare Access (a stranger gets the
#      Cloudflare sign-in page, not the app), AND the key-auth bypass is right:
#      a keyless call to a bot-facing API route reaches the APP and is turned
#      away by it (401 JSON) instead of being redirected to the Cloudflare
#      sign-in, while an operator route (/api/internal) still gets the
#      redirect. A bypass that is missing, too wide or too narrow fails here.
#   5. through Cloudflare, with the install's robot pass (Access service token),
#      the site loads and shows the client's brand name
#   6. password sign-in works (a throw-away `ok-verify` admin, removed after)
#   7. the first admin is still forced to choose a new password (until they do)
#   8. a test card runs end to end: created, started, the AI worker answers,
#      and it ran inside its own sandbox container with only 2 folders mounted.
#      The card is a throw-away: its title carries this run's unique marker (so
#      the board's duplicate-title guard cannot refuse a second run with a 409)
#      and it is deleted again on the way out, pass or fail.
#      First it asks the app whether ANY Claude seat can run a sandboxed
#      session; if none can (e.g. only an old CLI-login seat, which the sandbox
#      refuses) it fails at once with the fix instead of waiting --card-timeout.
# --local-only skips 4-5 (installs made with --skip-cloudflare). --skip-card
# skips 8 (before Claude is connected). Secrets are read from files, sent in
# header files, and never printed.
set -euo pipefail
# shellcheck source=install/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
# shellcheck source=install/api-bypass-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/api-bypass-lib.sh"

CONFIG=
LOCAL_ONLY=0
SKIP_CARD=0
CARD_TIMEOUT=600
while [ $# -gt 0 ]; do
  case "$1" in
    --config) shift; CONFIG=${1:-} ;;
    --local-only) LOCAL_ONLY=1 ;;
    --skip-card) SKIP_CARD=1 ;;
    --card-timeout) shift; CARD_TIMEOUT=${1:-600} ;;
    -h|--help) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done
[ -n "$CONFIG" ] || die "--config <file> is required"
[ "$LOCAL_ONLY" -eq 0 ] || export OK_LOCAL_ONLY=1
conf_load "$CONFIG"; conf_validate; ok_paths
# An install made with --skip-cloudflare has no Cloudflare side to check.
if [ "$LOCAL_ONLY" -eq 0 ] && local_mode; then LOCAL_ONLY=1; fi
require_root
DOMAIN=$(conf DOMAIN); SLUG=$(conf CLIENT_SLUG)
LOCAL=http://127.0.0.1:3002
VERIFY_USER=ok-verify

TMPD=$(mktemp -d); chmod 700 "$TMPD"
# The throw-away card from check 8, removed on the way out however we exit
# (obj 900069) — it must not pile up on the client's board or trip the board's
# duplicate-title guard on the next run.
VERIFY_CARD_ID=
cleanup() {
  if [ -n "$VERIFY_CARD_ID" ] && [ -n "${AUTH_HDR-}" ]; then
    api DELETE "/api/objectives/$VERIFY_CARD_ID" >/dev/null 2>&1 || true
    log "  test card #$VERIFY_CARD_ID removed"
  fi
  printf '{"action":"remove","username":"%s"}' "$VERIFY_USER" \
    | docker exec -i command-center tsx server/src/scripts/install-verify-user.ts >/dev/null 2>&1 || true
  rm -rf "$TMPD"
}
trap cleanup EXIT

# Where API calls go: through Cloudflare (with the robot pass) unless local-only.
CF_HDR=$TMPD/cf.hdr; : > "$CF_HDR"
if [ "$LOCAL_ONLY" -eq 0 ]; then
  BASE=https://$DOMAIN
  printf 'CF-Access-Client-Id: %s\nCF-Access-Client-Secret: %s\n' \
    "$(env_get "$OK_SECRETS_ENV" OK_VERIFY_CF_CLIENT_ID)" "$(env_get "$OK_SECRETS_ENV" OK_VERIFY_CF_CLIENT_SECRET)" > "$CF_HDR"
else
  BASE=$LOCAL
fi
api() { # METHOD PATH [JSON] — body to stdout, HTTP code to $TMPD/code
  local m=$1 p=$2 b=${3-}
  # Request bodies go through a file so passwords never appear in `ps`.
  printf '%s' "$b" > "$TMPD/req"
  curl -sS -o "$TMPD/body" -w '%{http_code}' -X "$m" -H @"$CF_HDR" ${AUTH_HDR:+-H @"$AUTH_HDR"} \
    -H 'Content-Type: application/json' ${b:+--data @"$TMPD/req"} "$BASE$p" > "$TMPD/code" || echo 000 > "$TMPD/code"
  cat "$TMPD/body"
}
code() { cat "$TMPD/code"; }

# nokey PATH — call https://DOMAIN<PATH> as a total stranger: no Operation Kit
# key, no Cloudflare service-token headers, no redirect following. Prints
# "<http code>|<redirect url>|<content type>". This is exactly what a bot that
# only has an Operation Kit API key looks like to Cloudflare.
nokey() { curl -sS -o "$TMPD/nokey" -w '%{http_code}|%{redirect_url}|%{content_type}' "https://$DOMAIN$1" 2>/dev/null || printf '000||'; }
# at_cloudflare lives in install/api-bypass-lib.sh so it can be unit-tested.
at_cloudflare() { ok_api_bypass_at_cloudflare "$@"; }

step "Verifying $([ "$LOCAL_ONLY" -eq 1 ] && echo "$SLUG (local only)" || echo "https://$DOMAIN (through Cloudflare)")"

# 1. containers
[ "$(docker inspect -f '{{.State.Running}}' command-center 2>/dev/null)" = true ] && pass "app container running" || fail "app container not running"
if [ "$LOCAL_ONLY" -eq 0 ]; then
  cf=$(docker ps --filter label=com.docker.compose.service=cloudflared --filter status=running -q | head -1)
  [ -n "$cf" ] && pass "Cloudflare connector running" || fail "Cloudflare connector not running"
fi

# 2. no open web ports
if ufw status 2>/dev/null | grep -q 'Status: active'; then
  if ufw status | grep -qE '^(80|443)(/tcp)? +ALLOW'; then fail "firewall allows port 80/443"; else pass "firewall on, only SSH open"; fi
else
  fail "firewall (ufw) is not active"
fi
if ss -ltnH 2>/dev/null | awk '{print $4}' | grep -qE '^(0\.0\.0\.0|\[::\]|\*):(3002|80|443)$'; then
  fail "a web port is listening on all interfaces"
else pass "app only listens on 127.0.0.1"; fi

# 3. local health
curl -fsS "$LOCAL/api/health" >/dev/null 2>&1 && pass "app healthy on the server" || fail "app not answering on $LOCAL"

# 4-5. Cloudflare
if [ "$LOCAL_ONLY" -eq 0 ]; then
  read -r stranger loc < <(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' "https://$DOMAIN/" || echo "000 -")
  if [[ "$stranger" =~ ^(302|303|401|403)$ ]] && [[ "$loc" == *cloudflareaccess.com* || "$stranger" =~ ^(401|403)$ ]]; then
    pass "Cloudflare Access is in front (stranger got $stranger -> Cloudflare sign-in)"
  else fail "https://$DOMAIN did not show the Cloudflare sign-in (got $stranger)"; fi
  api GET /api/health >/dev/null
  [ "$(code)" = 200 ] && pass "site loads through the tunnel (robot pass)" || fail "through the tunnel: /api/health -> $(code)"
  # One login (obj 720332): the robot's Cloudflare token is real and signed but
  # carries no email. "no_email" therefore proves the app fetched the team's
  # keys and checked signature, AUD and issuer — without signing anyone in.
  reason=$(api POST /api/auth/cloudflare-access | jq -r '.reason // .code // empty' 2>/dev/null || true)
  if [ "$reason" = no_email ]; then pass "one login on: app verifies Cloudflare's signed identity (team keys + AUD)"
  else fail "one login: expected the app to verify the Cloudflare token (reason no_email), got '${reason:-HTTP $(code)}' — check OK_CF_ACCESS_TEAM/AUD in secrets/stack.env and restart the app"; fi

  # 4b. Key-auth API bypass (obj 900028). A bot sends ONE thing: its Operation
  # Kit key. So the test is what a keyless stranger gets on a bot-facing route:
  # it must be the APP saying 401 in JSON ("your key is missing/invalid"), not
  # Cloudflare's HTML sign-in. Then the opposite, on the operator API: that one
  # must still be stopped by Cloudflare before the app ever sees it.
  if [ "$(conf API_KEY_AUTH_BYPASS on)" != off ]; then
    probe=$(ok_api_bypass_probe)
    r=$(nokey "$probe"); rcode=${r%%|*}; rctype=${r##*|}
    if [ "$rcode" = 000 ]; then
      fail "could not reach https://$DOMAIN$probe at all (network/tunnel problem, not the bypass)"
    elif [ "$rcode" = 401 ] && [[ "$rctype" == application/json* ]]; then
      pass "bots can reach the API with just their key ($probe with no key -> 401 JSON from the app)"
    elif at_cloudflare "$r"; then
      fail "$probe is still behind the Cloudflare sign-in (got $rcode) — a bot's key is never checked. Run: bash $OK_LIB_DIR/cloudflare.sh api-bypass --config $CONFIG"
    else
      fail "$probe with no key returned $rcode ($rctype) — expected 401 JSON from the app"
    fi
    r=$(nokey /api/internal/objectives)
    if [ "${r%%|*}" = 000 ]; then fail "could not reach https://$DOMAIN/api/internal/objectives at all (network/tunnel problem)"
    elif at_cloudflare "$r"; then pass "the operator API is still behind Cloudflare (/api/internal with no key -> ${r%%|*})"
    else fail "/api/internal is NOT behind the Cloudflare sign-in (got ${r%%|*}, ${r##*|}) — the bypass list is too wide. Check install/api-bypass-paths.conf, then re-run cloudflare.sh api-bypass"; fi
    for d in /api/admin/seats /api/secrets /api/auth/token; do
      r=$(nokey "$d")
      if [ "${r%%|*}" = 000 ]; then fail "could not reach https://$DOMAIN$d at all (network/tunnel problem)"
      elif at_cloudflare "$r"; then pass "$d is still behind Cloudflare (${r%%|*})"
      else fail "$d is NOT behind the Cloudflare sign-in (got ${r%%|*}, ${r##*|}) — the bypass list is too wide"; fi
    done
  else
    log "  SKIP  key-auth API bypass (API_KEY_AUTH_BYPASS=off in $CONFIG — bots get the Cloudflare sign-in page)"
  fi
fi
brand=$(api GET /api/branding | jq -r '.name // empty' 2>/dev/null || true)
[ "$brand" = "$(conf BRAND_NAME OperationKit)" ] && pass "brand name shown: $brand" || fail "brand name is '$brand', expected '$(conf BRAND_NAME OperationKit)'"

# 6. sign-in with a throw-away admin
openssl rand -hex 16 > "$TMPD/vpw"
jq -nc --arg u "$VERIFY_USER" --rawfile p "$TMPD/vpw" --arg w "$SLUG" '{action:"create", username:$u, password:($p|rtrimstr("\n")), workspace:$w}' \
  | docker exec -i command-center tsx server/src/scripts/install-verify-user.ts >/dev/null
login_body=$(jq -nc --arg u "$VERIFY_USER" --rawfile p "$TMPD/vpw" '{username:$u, password:($p|rtrimstr("\n"))}')
tok=$(api POST /api/auth/token "$login_body" | jq -r '.token // empty')
if [ -n "$tok" ]; then
  AUTH_HDR=$TMPD/auth.hdr; printf 'Authorization: Bearer %s\n' "$tok" > "$AUTH_HDR"; unset tok
  me=$(api GET /api/auth/me | jq -r '.username // empty')
  [ "$me" = "$VERIFY_USER" ] && pass "password sign-in works" || fail "signed in but /api/auth/me returned $(code)"
else
  fail "password sign-in failed ($(code))"
fi

# 7. first admin forced to change the setup password
if [ -s "$OK_ADMIN_SETUP_FILE" ]; then
  admin_body=$(jq -nc --arg u "$(conf ADMIN_USERNAME admin)" --rawfile p "$OK_ADMIN_SETUP_FILE" '{username:$u, password:($p|rtrimstr("\n"))}')
  saved=${AUTH_HDR-}; AUTH_HDR=
  err=$(api POST /api/auth/token "$admin_body" | jq -r '.code // .error // empty')
  AUTH_HDR=$saved
  if [ "$(code)" = 403 ] && [ "$err" = password_change_required ]; then pass "first admin must choose a new password before using the app"
  elif [ "$(code)" = 401 ]; then pass "first admin has already replaced the setup password"
  else fail "setup password check: unexpected $(code) $err"; fi
fi

# 8. a test card end to end
if [ "$SKIP_CARD" -eq 1 ]; then
  log "  SKIP  test card (Claude not connected yet — run install/claude-login.sh, then re-run verify)"
elif [ -z "${AUTH_HDR-}" ]; then
  fail "test card skipped: not signed in"
elif ! seats=$(app_internal GET /api/internal/install/seat-status 2>/dev/null); then
  fail "test card skipped: could not ask the app for its Claude seats (docker logs command-center)"
elif [ "$(jq -r '.claude.usable' <<<"$seats")" != true ]; then
  # Without this the card would sit in the queue for the whole --card-timeout.
  fail "test card skipped: no Claude seat can run a sandboxed session ($(jq -r '.claude.seats' <<<"$seats") seat(s) configured). Connect Claude: sudo bash $OK_LIB_DIR/claude-login.sh --config $CONFIG — or Settings → Seats → Add Claude seat. A seat added by signing in to the Claude CLI on the server does not work inside the sandbox."
else
  # The title is unique per run and `force` is set (obj 900069): the board
  # refuses a second card with the same normalized title in the same workspace
  # inside the duplicate-guard window (409), so the fixed title "Install check:
  # say hello" made every verify after the first one fail. The marker is also
  # what the worker has to echo back, so one value does both jobs.
  marker="OK-INSTALL-CHECK-$(date +%s)-$RANDOM"
  card=$(jq -nc --arg w "$SLUG" --arg m "$marker" '{title:("Install check: say hello " + $m), workspace:$w, start:true, skip_ai_review:true, force:true,
    description:("This is an automated install check. Reply with exactly this text and nothing else, then stop: " + $m + ". Do not create or edit any files.")}')
  id=$(api POST /api/objectives "$card" | jq -r '.id // .objective.id // empty')
  if [ -z "$id" ]; then fail "could not create the test card ($(code): $(head -c 300 "$TMPD/body"))"; else
    VERIFY_CARD_ID=$id   # cleanup() removes it on the way out, pass or fail
    log "  test card #$id started — waiting up to ${CARD_TIMEOUT}s for the AI worker"
    waited=0; seen=0
    while [ "$waited" -lt "$CARD_TIMEOUT" ]; do
      if api GET "/api/objectives/$id/output" | grep -q "$marker"; then
        # The marker is also in the prompt; require it in an assistant event.
        if jq -e --arg m "$marker" '[.. | objects | select(.type? == "assistant" or .type? == "result") | tostring | select(contains($m))] | length > 0' "$TMPD/body" >/dev/null 2>&1; then seen=1; break; fi
      fi
      sleep 10; waited=$((waited + 10))
      [ $((waited % 60)) -eq 0 ] && log "  … ${waited}s, card status: $(api GET "/api/objectives/$id" | jq -r '.status // "?"')"
    done
    [ "$seen" -eq 1 ] && pass "test card #$id: AI worker answered in ${waited}s" || fail "test card #$id: no answer within ${CARD_TIMEOUT}s (docker logs command-center)"
    jail=$(docker ps -a --filter "label=ok.objective=$id" -q | head -1)
    if [ "$(conf SESSION_ISOLATION docker)" = docker ]; then
      if [ -n "$jail" ]; then
        mounts=$(docker inspect -f '{{range .Mounts}}{{.Destination}} {{end}}' "$jail")
        if [ "$(wc -w <<<"$mounts")" -eq 2 ] && ! grep -q docker.sock <<<"$mounts"; then
          pass "test card ran in its own sandbox (mounts: $mounts)"
        else fail "sandbox has unexpected mounts: $mounts"; fi
      else fail "no sandbox container found for card #$id"; fi
    fi
  fi
fi

printf '\n%d pass, %d fail\n' "$PASS_COUNT" "$FAIL_COUNT"
[ "$FAIL_COUNT" -eq 0 ]
