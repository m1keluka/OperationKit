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
#      The same check names Cloudflare error 1010 separately when Browser
#      Integrity Check — a different layer, with a different fix — is what
#      turned the caller away, and then proves the other direction: an
#      authenticated caller sending NO Cloudflare headers gets 200 JSON.
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
#   9. the card browser (Playwright/Chromium) is locked down: its OS sandbox is
#      on, it runs as the unprivileged `ccuser` account and not as root, its
#      egress guard is listening, and — proved live, through the same proxy
#      Chromium uses — the cloud metadata endpoint and an off-allowlist site are
#      both refused while an ALLOWED origin still loads. Playwright/Chromium
#      must be pinned to a version, never `latest`.
# --local-only skips 4-5 (installs made with --skip-cloudflare). --skip-card
# skips 8 (it still asks the app for its Claude seat status, read-only, to say why). Secrets are read from files, sent in
# header files, and never printed.
set -euo pipefail
# shellcheck source=install/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
# shellcheck source=install/api-bypass-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/api-bypass-lib.sh"
# shellcheck source=install/bic-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/bic-lib.sh"

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
# at_cloudflare lives in install/api-bypass-lib.sh so it can be unit-tested;
# is_bic lives in install/bic-lib.sh for the same reason. Between them they tell
# the three look-alike refusals apart: the Cloudflare sign-in page, Cloudflare
# error 1010, and the app's own JSON 401/403. Each has a different fix, so the
# whole point is to never report one as another.
at_cloudflare() { ok_api_bypass_at_cloudflare "$@"; }
is_bic() { ok_bic_is_1010 "$@"; }

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
else pass "app only listens on 127.0.0.1 and the Docker bridge (no public address)"; fi

# 3. local health
curl -fsS "$LOCAL/api/health" >/dev/null 2>&1 && pass "app healthy on the server" || fail "app not answering on $LOCAL"
# 3b. card sandboxes on the default Docker bridge reach the app (obj 900185)
BRIDGE_IP=$(env_get "$OK_SETTINGS_ENV" OK_DOCKER_BRIDGE_IP 2>/dev/null || true)
if [ -z "$BRIDGE_IP" ]; then
  fail "no OK_DOCKER_BRIDGE_IP in $OK_SETTINGS_ENV — re-run install.sh (or update.sh)"
else
  bcode=$(bridge_health "$BRIDGE_IP")
  [ "$bcode" = 200 ] && pass "sandboxes reach the app on the Docker bridge (http://$BRIDGE_IP:3002 -> 200)" \
    || fail "a container on the Docker bridge got ${bcode:-000} from http://$BRIDGE_IP:3002/api/health"
fi

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
      pass "a missing key is refused by the APP, not by Cloudflare ($probe with no key -> 401 JSON)"
    elif is_bic "$r" "$TMPD/nokey"; then
      # Obj 900259. Access let it through and Browser Integrity Check still said
      # no, because the caller is a script. Naming this separately matters: the
      # fix is a different command from the one for a sign-in page.
      fail "$probe got Cloudflare error 1010 ('banned … based on your browser's signature'): Browser Integrity Check is refusing your bots before the app sees them. Run: bash $OK_LIB_DIR/cloudflare.sh api-bic --config $CONFIG"
    elif at_cloudflare "$r"; then
      fail "$probe is still behind the Cloudflare sign-in (got $rcode) — a bot's key is never checked. Run: bash $OK_LIB_DIR/cloudflare.sh api-bypass --config $CONFIG"
    else
      fail "$probe with no key returned $rcode ($rctype) — expected 401 JSON from the app"
    fi
    # The other half of the same promise: a caller the app DOES accept gets a
    # real answer, with no Cloudflare header of any kind on the request.
    if [ -n "${AUTH_HDR-}" ]; then
      akey=$(curl -sS -o "$TMPD/akey" -w '%{http_code}|%{content_type}' -H @"$AUTH_HDR" "https://$DOMAIN$probe" 2>/dev/null || printf '000|')
      if [ "${akey%%|*}" = 200 ] && [[ "${akey##*|}" == application/json* ]]; then
        pass "an authenticated caller gets a real answer through Cloudflare ($probe -> 200 JSON, no Cloudflare headers sent)"
      elif is_bic "$akey|" "$TMPD/akey"; then
        fail "$probe with a valid credential got Cloudflare error 1010 — Browser Integrity Check is refusing it. Run: bash $OK_LIB_DIR/cloudflare.sh api-bic --config $CONFIG"
      else
        fail "$probe with a valid credential returned ${akey%%|*} (${akey##*|}) — expected 200 JSON"
      fi
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

# 7. the first admin's setup password. With one login (obj 900108) the admin
# signs in through Cloudflare Access and has no password to change, so the
# setup password is a working break-glass login that expires. Without one
# login it must still force a change before anything else works.
if [ -s "$OK_ADMIN_SETUP_FILE" ]; then
  admin_body=$(jq -nc --arg u "$(conf ADMIN_USERNAME admin)" --rawfile p "$OK_ADMIN_SETUP_FILE" '{username:$u, password:($p|rtrimstr("\n"))}')
  saved=${AUTH_HDR-}; AUTH_HDR=
  err=$(api POST /api/auth/token "$admin_body" | jq -r '.code // .error // empty')
  AUTH_HDR=$saved
  if one_login_on; then
    if [ "$(code)" = 200 ]; then pass "first admin is not asked for a password change (one login); setup password is break-glass"
    elif [ "$(code)" = 401 ]; then pass "first admin's setup password has expired or been replaced (one login)"
    elif [ "$(code)" = 403 ] && [ "$err" = password_change_required ]; then
      fail "one login: this admin was created before one login was switched on, so they are still marked 'must change password' — issue a fresh break-glass password to clear it: bash install/admin-password.sh --config <config>"
    else fail "one login: the first admin should not be forced to change a password — got $(code) $err"; fi
  else
    if [ "$(code)" = 403 ] && [ "$err" = password_change_required ]; then pass "first admin must choose a new password before using the app"
    elif [ "$(code)" = 401 ]; then pass "first admin has already replaced the setup password"
    else fail "setup password check: unexpected $(code) $err"; fi
  fi
fi

# 8. a test card end to end
if [ "$SKIP_CARD" -eq 1 ]; then
  # --skip-card only means the caller chose not to run a card. install.sh
  # passes it when no Claude token is in the secrets env file, but seats added
  # in Settings → Seats are not in that file. So ask the app (read-only)
  # instead of claiming Claude is disconnected.
  seats_usable=$( (app_internal GET /api/internal/install/seat-status 2>/dev/null || true) | jq -r '.claude.usable // empty' 2>/dev/null || true)
  if [ "$seats_usable" = true ]; then
    log "  SKIP  test card (--skip-card; the app already has a usable Claude seat — re-run verify without --skip-card to test it end to end)"
  elif [ "$seats_usable" = false ]; then
    log "  SKIP  test card (--skip-card; no usable Claude seat yet — connect one with install/claude-login.sh or Settings → Seats, then re-run verify without --skip-card)"
  else
    log "  SKIP  test card (--skip-card; Claude seat status not checked — re-run verify without --skip-card once a Claude seat is connected in Settings → Seats)"
  fi
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

# 9. the card browser is locked down (obj 900024)
#    Four things, each of which has silently regressed before or could:
#      a. Chromium's OS sandbox is ON  (it used to be --no-sandbox, always)
#      b. the browser process is NOT root
#      c. the egress guard is running, and an off-allowlist navigation is refused
#      d. Playwright and Chromium are pinned, not floating
#    (c) is proved by actually asking the guard to reach somewhere it must not,
#    through the same proxy Chromium is pointed at — not by reading config.
log "9. card browser (Playwright / Chromium) lockdown"
if ! bstat=$(app_internal GET /api/internal/install/browser-status 2>/dev/null); then
  fail "could not ask the app about the card browser (docker logs command-center)"
else
  if [ "$(jq -r '.sandbox' <<<"$bstat")" = true ]; then
    pass "Chromium OS sandbox is ON"
  else
    fail "Chromium OS sandbox is OFF — set BROWSER_SANDBOX=\"on\" in $CONFIG and re-run install.sh"
  fi

  # The browser is launched by the session user, never by root. Check the
  # account the sessions actually run as rather than trusting configuration.
  browser_user=$(docker exec command-center sh -lc 'id -un ccuser 2>/dev/null' 2>/dev/null | tr -d '\r')
  if [ -n "$browser_user" ] && [ "$browser_user" != root ]; then
    pass "card browser runs as non-root user '$browser_user'"
  else
    fail "card browser would run as root (expected the unprivileged 'ccuser' account)"
  fi

  guard_running=$(jq -r '.egress_guard.running' <<<"$bstat")
  guard_port=$(jq -r '.egress_guard.port // empty' <<<"$bstat")
  if [ "$guard_running" = true ] && [ -n "$guard_port" ]; then
    pass "egress guard listening on 127.0.0.1:$guard_port"
    # The live proof: ask the guard for a destination no install allows.
    # 169.254.169.254 is the cloud metadata address — the single worst thing a
    # hijacked browser could reach from this host.
    blocked_code=$(docker exec command-center sh -lc \
      "curl -s -o /dev/null -w '%{http_code}' --max-time 10 -x http://127.0.0.1:$guard_port http://169.254.169.254/ 2>/dev/null" 2>/dev/null | tr -d '\r')
    if [ "$blocked_code" = 403 ]; then
      pass "navigation to the cloud metadata endpoint is blocked (HTTP 403 from the guard)"
    else
      fail "the card browser was NOT blocked from the cloud metadata endpoint (got '${blocked_code:-no answer}', expected 403)"
    fi
    offlist_code=$(docker exec command-center sh -lc \
      "curl -s -o /dev/null -w '%{http_code}' --max-time 10 -x http://127.0.0.1:$guard_port http://verify-not-allowed.example.com/ 2>/dev/null" 2>/dev/null | tr -d '\r')
    if [ "$offlist_code" = 403 ]; then
      pass "navigation outside the allowed origins is blocked (HTTP 403 from the guard)"
    else
      fail "an off-allowlist navigation was NOT blocked (got '${offlist_code:-no answer}', expected 403)"
    fi
    # …and the other direction: an ALLOWED origin must still work, or we have
    # simply broken preview review instead of securing it.
    allowed_code=$(docker exec command-center sh -lc \
      "curl -s -o /dev/null -w '%{http_code}' --max-time 10 -x http://127.0.0.1:$guard_port http://127.0.0.1:3002/api/health 2>/dev/null" 2>/dev/null | tr -d '\r')
    if [ "$allowed_code" = 200 ]; then
      pass "navigation to an allowed origin still works (HTTP 200 through the guard)"
    elif [ "$(jq -r '.allow_loopback' <<<"$bstat")" != true ]; then
      log "  SKIP  allowed-origin check (BROWSER_ALLOW_LOOPBACK is off on this install)"
    else
      fail "an ALLOWED origin did not load through the guard (got '${allowed_code:-no answer}', expected 200) — the browser policy is too tight"
    fi
  else
    fail "the card browser's egress guard is not running — the browser would have unrestricted network access"
  fi

  pw=$(jq -r '.pins.playwright' <<<"$bstat"); cr=$(jq -r '.pins.chromium' <<<"$bstat")
  if [ -n "$pw" ] && [ "$pw" != latest ] && [ "$pw" != null ]; then
    pass "Playwright pinned at $pw (Chromium $cr)"
  else
    fail "Playwright is not pinned to a version"
  fi

  while IFS= read -r w; do [ -z "$w" ] || log "  NOTE  $w"; done < <(jq -r '.warnings[]?' <<<"$bstat")
  [ "$(jq -r '.locked_down' <<<"$bstat")" = true ] \
    && pass "card browser is at the locked-down defaults" \
    || log "  NOTE  one or more card-browser controls were widened on purpose (see NOTEs above)"
fi

printf '\n%d pass, %d fail\n' "$PASS_COUNT" "$FAIL_COUNT"
[ "$FAIL_COUNT" -eq 0 ]
