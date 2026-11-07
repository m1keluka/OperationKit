#!/usr/bin/env bash
# install/cloudflare.sh — put the client's sub-domain behind Cloudflare.
#
#   sudo bash install/cloudflare.sh up     --config client.conf [--dry-run] [--replace-dns]
#   sudo bash install/cloudflare.sh down   --config client.conf [--dry-run]
#   sudo bash install/cloudflare.sh status --config client.conf
#   sudo bash install/cloudflare.sh agent-pass add|remove <name> --config client.conf
#   sudo bash install/cloudflare.sh agent-pass list --config client.conf
#   sudo bash install/cloudflare.sh api-bypass [remove] --config client.conf
#   sudo bash install/cloudflare.sh api-bic    [remove] --config client.conf [--dry-run]
#
# `up` (idempotent — every object is looked up by name first and reused):
#   1. finds the zone (ZONE) and its Cloudflare account: the account id comes
#      from GET /zones?name=<ZONE> (result[0].account.id), so nobody has to look
#      it up or type it
#   2. creates a Cloudflare Tunnel "ok-<CLIENT_SLUG>" (remotely managed) and
#      routes DOMAIN -> the app container. The server opens NO web ports: the
#      tunnel connector dials OUT to Cloudflare.
#   3. points DOMAIN at the tunnel (proxied CNAME)
#   4. makes sure the Access login method exists (one-time email code, Google
#      or Microsoft). The default, ACCESS_LOGIN_METHOD=otp, is Cloudflare's
#      "One-time PIN" provider: it works for every install with no Google or
#      Microsoft app to register
#   5. creates a Cloudflare Access application on DOMAIN that only lets
#      ACCESS_ALLOWED_EMAILS / ACCESS_ALLOWED_EMAIL_DOMAIN through. Its
#      allowed_idps holds ONLY that one login method, with auto-redirect on (no
#      provider picker) and ACCESS_SESSION_DURATION (default 24h)
#   6. creates an Access service token used ONLY by install/verify.sh to test the
#      site through Cloudflare without a human typing an email code
#   7. stores the tunnel token + service token in secrets/stack.env (mode 600)
#   8. creates a SECOND, path-limited Access application, "Operation Kit API
#      (key auth)", whose only policy is Bypass/Everyone. It covers just the
#      bot-facing API routes listed in install/api-bypass-paths.conf, so a bot
#      calling the board API with its Operation Kit key reaches the app and the
#      KEY is what decides, instead of being bounced to the Cloudflare sign-in
#      page. Cloudflare matches the most specific application first, so this
#      app wins on those paths and the host-wide app (step 5) still covers
#      everything else. The guard in install/api-bypass-lib.sh refuses to put
#      an operator route (/api/internal, /api/admin, /api/secrets,
#      /api/secret-upload, /api/webhooks, /api/auth except the exact
#      /api/auth/me, /api/public, /api/llm, /api/alerts, /api/costs,
#      /api/intel, /api/status) or a blanket /api/* in it. Set
#      API_KEY_AUTH_BYPASS="off" in client.conf to skip the step.
#   9. stores the Zero Trust team domain + the Access app's AUD tag in
#      secrets/stack.env as OK_CF_ACCESS_TEAM / OK_CF_ACCESS_AUD. The app uses
#      them to verify Cloudflare's signed identity header and skip its own
#      sign-in page (one login). Without them the password login is used.
#  10. adds ONE narrow Cloudflare Configuration Rule that switches Browser
#      Integrity Check OFF for this install's own API paths — and nothing else.
#      Without it a bot that gets past step 8 still meets Cloudflare error 1010
#      ("banned ... based on your browser's signature"), because a script is not
#      a browser. The rule lives in the zone's http_config_settings phase, its
#      action_parameters hold exactly one key (bic:false), and its expression
#      matches only `http.host eq DOMAIN and starts_with(path, "/api/")`. The
#      zone-wide Browser Integrity Check switch, every WAF rule, every rate
#      limit and every other Configuration Rule are left exactly as they were.
#      Set API_BROWSER_INTEGRITY_EXCEPTION="off" in client.conf to skip it.
# `down` removes exactly what `up` created (app, service token, DNS record,
# tunnel) plus every agent pass, and blanks OK_CF_ACCESS_TEAM/AUD. It never touches the zone, other DNS records
# or the login methods.
#
# `agent-pass add <name>` lets ONE outside AI tool (Claude Code, Grok, Codex…)
# through the Access front door without a person typing an email code: it
# creates an Access service token "ok-<CLIENT_SLUG>-agent-<name>" and an app
# policy that admits only that token. The two header values are written to
# secrets/agent-pass-<name>.env (mode 600) and never printed; the person reads
# them in their own terminal. The tool still needs an Operation Kit agent key on
# top: the pass only opens the door. `agent-pass remove <name>` revokes it.
# docs/CONNECT-YOUR-AGENT.md walks through it.
#
# `api-bypass` re-runs step 8 on its own, in place: run it after editing
# install/api-bypass-paths.conf to add a route a bot needs. It is idempotent —
# it looks the app up BY NAME and updates it, never making a second one.
# A path another Access application already owns is left to its owner: if that
# app is itself a bypass/key-auth app the path is skipped with a warning, and if
# it is not, the step stops and names it. Either way the other app is never
# created, edited or deleted (obj 900069).
# ROLLBACK: `api-bypass remove` deletes the app and its policy, which puts every
# API route back behind the Cloudflare sign-in immediately (bots then get the
# sign-in page again). `down` removes it too. Nothing else is touched.
#
# `api-bic` re-runs step 10 on its own, in place, and is the reconcile path for
# an install made before step 10 existed: pulling new code does NOT change
# anything at Cloudflare, so an existing install must run this once (update.sh
# does it for you by re-running the installer). It is idempotent — the rule is
# looked up inside the phase, and a rule that is already exactly right costs no
# mutating call at all. Before it changes anything it writes the phase's current
# contents to INSTALL_DIR/backups/cloudflare-bic-<UTC time>.json (mode 600).
# ROLLBACK: `api-bic remove` deletes just that one rule by id, leaving the phase
# and every other rule in it untouched; `down` removes it too. Or restore the
# snapshot by hand from the dashboard. Browser Integrity Check for the rest of
# the zone was never changed, so there is nothing to put back.
#
# The API token is read from $INSTALL_DIR/secrets/cloudflare-api-token (one
# line, mode 600). It is sent to Cloudflare in a header file, never on a command
# line, and never printed. Token permissions needed (INSTALL.md lists them):
#   Zone: Zone Read, DNS Edit, Config Rules Edit · Account: Cloudflare Tunnel Edit,
#   Access: Apps and Policies Edit, Access: Organizations, Identity Providers,
#   and Groups Edit, Access: Service Tokens Edit
set -euo pipefail
# shellcheck source=install/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
# shellcheck source=install/api-bypass-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/api-bypass-lib.sh"
# shellcheck source=install/bic-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/bic-lib.sh"

CF_API=${CF_API_BASE:-https://api.cloudflare.com/client/v4}
ACTION=${1:-}; shift || true
PASS_CMD= PASS_NAME=
if [ "$ACTION" = agent-pass ]; then
  PASS_CMD=${1:-}; shift || true
  case "$PASS_CMD" in
    add|remove) PASS_NAME=${1:-}; shift || true
      [[ "$PASS_NAME" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || { echo "agent-pass $PASS_CMD needs a name: lowercase letters, digits, dashes (e.g. claude-code)" >&2; exit 2; } ;;
    list) ;;
    *) echo "usage: cloudflare.sh agent-pass add|remove <name> | list --config client.conf" >&2; exit 2 ;;
  esac
fi
BYPASS_CMD=
if [ "$ACTION" = api-bypass ]; then
  case "${1:-}" in
    remove) BYPASS_CMD=remove; shift ;;
    ''|--*) BYPASS_CMD=up ;;
    *) echo "usage: cloudflare.sh api-bypass [remove] --config client.conf" >&2; exit 2 ;;
  esac
fi
BIC_CMD=
if [ "$ACTION" = api-bic ]; then
  case "${1:-}" in
    remove) BIC_CMD=remove; shift ;;
    ''|--*) BIC_CMD=up ;;
    *) echo "usage: cloudflare.sh api-bic [remove] --config client.conf" >&2; exit 2 ;;
  esac
fi
CONFIG=
REPLACE_DNS=0
while [ $# -gt 0 ]; do
  case "$1" in
    --config) shift; CONFIG=${1:-} ;;
    --dry-run) DRY_RUN=1 ;;
    --replace-dns) REPLACE_DNS=1 ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done
case "$ACTION" in up|down|status|agent-pass|api-bypass|api-bic) ;; *) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;; esac
[ -n "$CONFIG" ] || die "--config <file> is required"
conf_load "$CONFIG"; conf_validate; ok_paths
command -v jq >/dev/null || die "jq is required (install/bootstrap-host.sh installs it)"

SLUG=$(conf CLIENT_SLUG); DOMAIN=$(conf DOMAIN); ZONE=$(conf ZONE)
TUNNEL_NAME="ok-$SLUG"
APP_NAME="Operation Kit - $(conf CLIENT_NAME)"
SVC_TOKEN_NAME="ok-$SLUG-verify"
# The second, path-limited Access app (step 8). Looked up BY NAME, so re-running
# updates it instead of adding another one. The name is part of the contract:
# install/verify.sh and the docs both refer to it.
API_APP_NAME="Operation Kit API (key auth)"
API_POLICY_NAME="Key auth (Operation Kit checks the key)"
PASS_PREFIX="ok-$SLUG-agent-"

TOKEN_FILE=${CF_API_TOKEN_FILE:-$OK_SECRETS/cloudflare-api-token}
[ -s "$TOKEN_FILE" ] || die "Cloudflare API token file missing: $TOKEN_FILE (see INSTALL.md, 'Handing over the Cloudflare token')"
HDR=$(mktemp); chmod 600 "$HDR"
trap 'rm -f "$HDR"' EXIT
printf 'Authorization: Bearer %s\nContent-Type: application/json\n' "$(tr -d '[:space:]' < "$TOKEN_FILE")" > "$HDR"

# cf METHOD PATH [JSON] — prints the response body; dies with Cloudflare's own
# error message (never the token) when success != true.
cf() {
  local method=$1 path=$2 body=${3-} out
  if [ -n "$body" ]; then
    # Body on stdin, not argv: it can carry an IdP client secret.
    out=$(curl -sS --retry 3 -X "$method" -H @"$HDR" --data-binary @- "$CF_API$path" <<<"$body") || die "network error calling Cloudflare ($method $path)"
  else
    out=$(curl -sS --retry 3 -X "$method" -H @"$HDR" "$CF_API$path") || die "network error calling Cloudflare ($method $path)"
  fi
  if [ "$(jq -r '.success' <<<"$out" 2>/dev/null)" != "true" ]; then
    die "Cloudflare refused $method $path: $(jq -c '[.errors[]?|{code,message}]' <<<"$out" 2>/dev/null || echo 'unreadable response')"
  fi
  printf '%s' "$out"
}
# mut METHOD PATH [JSON] — a mutating call; skipped under --dry-run.
mut() {
  if [ "$DRY_RUN" -eq 1 ]; then printf '  [dry-run] %s %s\n' "$1" "$2" >&2; printf '{"success":true,"result":{"id":"dry-run"}}'; return 0; fi
  cf "$@"
}

step "Cloudflare: zone $ZONE"
zone_json=$(cf GET "/zones?name=$ZONE")
ZONE_ID=$(jq -r '.result[0].id // empty' <<<"$zone_json")
ACCOUNT_ID=$(jq -r '.result[0].account.id // empty' <<<"$zone_json")
[ -n "$ZONE_ID" ] || die "the zone '$ZONE' is not on this Cloudflare account (or the token cannot read it)"
log "zone found"

find_tunnel() { cf GET "/accounts/$ACCOUNT_ID/cfd_tunnel?name=$TUNNEL_NAME&is_deleted=false" | jq -r '.result[0].id // empty'; }
find_dns()    { cf GET "/zones/$ZONE_ID/dns_records?name=$DOMAIN" | jq -c '.result[0] // empty'; }
# The host-wide app: domain is the bare host. The key-auth app's domain carries a
# path (DOMAIN/api/...), so it cannot match here — the name filter is belt-and-braces.
find_app()     { cf GET "/accounts/$ACCOUNT_ID/access/apps" | jq -r --arg d "$DOMAIN" --arg n "$API_APP_NAME" '[.result[]? | select(.domain == $d and .name != $n)][0].id // empty'; }
find_api_app() { cf GET "/accounts/$ACCOUNT_ID/access/apps" | jq -r --arg n "$API_APP_NAME" '[.result[]? | select(.name == $n)][0].id // empty'; }
find_svc()    { cf GET "/accounts/$ACCOUNT_ID/access/service_tokens" | jq -r --arg n "${1:-$SVC_TOKEN_NAME}" '[.result[]? | select(.name == $n)][0].id // empty'; }
list_passes() { cf GET "/accounts/$ACCOUNT_ID/access/service_tokens" | jq -r --arg p "$PASS_PREFIX" '.result[]? | select(.name | startswith($p)) | "\(.id) \(.name | ltrimstr($p))"'; }

# ── Key-auth API bypass (step 8) ─────────────────────────────────────────────
# One extra Access application, path-limited to the bot-facing API routes, with
# a single Bypass/Everyone policy. Cloudflare stops asking for a sign-in on
# those paths; Operation Kit's own API key becomes the only check, which is what
# a bot can actually send. Every other path — including every operator route —
# still hits the host-wide app from step 5.
#
# The paths come from ONE place, install/api-bypass-paths.conf, read through
# ok_api_bypass_paths() in install/api-bypass-lib.sh, which REFUSES an operator
# route or a blanket /api/*. If someone adds one, this step stops the install
# rather than opening it.
#
# A path another Access application already owns is SKIPPED, not fought over
# (obj 900069). Cloudflare rejects a duplicate destination outright ("the
# destination … belongs to another application", code 12132), so one
# pre-existing app — a real client install had a separate MCP bypass app owning
# /api/mcp — used to stop this whole step, and with it update.sh. We now ask
# Cloudflare which apps exist first and leave that path to its owner. Two cases,
# deliberately different:
#   · the owner is itself a bypass / key-auth app (it has a `bypass` policy) —
#     the end result for a bot is already what we wanted, so skip the path, say
#     so, and carry on. The other app is never edited or deleted.
#   · the owner is anything else — those paths stay behind a sign-in, so the
#     install would be half-open. Stop and name the app, rather than ship it.
api_bypass_up() {
  local paths dests body pid prec n apps conflicts kept skipped line cpath cid cname pol
  step "Cloudflare Access: API routes your bots call with a key"
  paths=$(ok_api_bypass_paths) || exit 1   # refused: the guard already said why

  # Which of our paths does a DIFFERENT Access app already own on this hostname?
  apps=$(cf GET "/accounts/$ACCOUNT_ID/access/apps")
  conflicts=$(ok_api_bypass_conflicts "$apps" "$DOMAIN" "$API_APP_NAME" "$paths")
  if [ -n "$conflicts" ]; then
    skipped=''
    while IFS=$'\t' read -r cpath cid cname; do
      [ -n "$cpath" ] || continue
      pol=$(cf GET "/accounts/$ACCOUNT_ID/access/apps/$cid/policies")
      if ok_api_bypass_policies_are_bypass "$pol"; then
        warn "$cpath is already a destination of the Access app '$cname' ($cid), which is itself a bypass/key-auth app — leaving that path to it (its app is not touched)"
        skipped="$skipped$cpath"$'\n'
      else
        die "$cpath is already a destination of the Access app '$cname' ($cid), and that app has no Bypass policy — a bot's key would never be checked there. Either make that app a bypass app, remove $cpath from it, or drop the route from $(ok_api_bypass_conf). Nothing was changed."
      fi
    done <<<"$conflicts"
    # Keep our list in file order, minus everything another bypass app owns.
    kept=$(grep -vxF -f <(printf '%s' "$skipped") <<<"$paths" || true)
    if [ -z "${kept//[[:space:]]/}" ]; then
      log "every path on the list is already covered by another bypass app — nothing left for '$API_APP_NAME' to own, and nothing was changed"
      return 0
    fi
    paths=$kept
  fi

  n=$(printf '%s\n' "$paths" | wc -l | tr -d ' ')
  dests=$(printf '%s\n' "$paths" | jq -R --arg d "$DOMAIN" '{type:"public", uri:($d + .)}' | jq -sc .)
  # `domain` is kept alongside `destinations` for older Access API behaviour;
  # Cloudflare derives it from the first destination anyway.
  body=$(jq -nc --arg n "$API_APP_NAME" --arg d "$DOMAIN$(printf '%s\n' "$paths" | head -1)" --argjson dest "$dests" \
    '{name:$n, type:"self_hosted", domain:$d, destinations:$dest, session_duration:"24h",
      app_launcher_visible:false, auto_redirect_to_identity:false, skip_interstitial:true}')
  API_APP_ID=$(find_api_app)
  if [ -n "$API_APP_ID" ]; then
    mut PUT "/accounts/$ACCOUNT_ID/access/apps/$API_APP_ID" "$body" >/dev/null
    log "'$API_APP_NAME' exists — its $n paths refreshed"
  else
    API_APP_ID=$(mut POST "/accounts/$ACCOUNT_ID/access/apps" "$body" | jq -r .result.id)
    log "'$API_APP_NAME' created over $n paths"
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    log "  [dry-run] would upsert the Bypass policy '$API_POLICY_NAME' (include: Everyone)"
    printf '%s\n' "$paths" | sed 's/^/    [dry-run] bypass /' >&2
    return 0
  fi
  body=$(jq -nc --arg n "$API_POLICY_NAME" '{name:$n, decision:"bypass", include:[{everyone:{}}], precedence:1}')
  # Match the policy by WHAT IT DOES (decision bypass + include Everyone), not
  # only by our name for it (obj 900069): an install whose policy was renamed in
  # the dashboard, or created by an earlier version, would otherwise get a
  # SECOND Bypass/Everyone policy added on every re-run. Our own name still wins
  # when both are present.
  pid=$(cf GET "/accounts/$ACCOUNT_ID/access/apps/$API_APP_ID/policies" | jq -r --arg n "$API_POLICY_NAME" '
    [.result[]? | select(.name == $n)][0].id
    // [.result[]? | select((.decision // "") == "bypass" and ((.include // []) | map(has("everyone")) | any))][0].id
    // empty')
  if [ -n "$pid" ]; then mut PUT "/accounts/$ACCOUNT_ID/access/apps/$API_APP_ID/policies/$pid" "$body" >/dev/null
  else
    prec=$(cf GET "/accounts/$ACCOUNT_ID/access/apps/$API_APP_ID/policies" | jq '[.result[]?.precedence // 0] | max // 0 | . + 1')
    mut POST "/accounts/$ACCOUNT_ID/access/apps/$API_APP_ID/policies" "$(jq -c --argjson p "$prec" '. + {precedence:$p}' <<<"$body")" >/dev/null
  fi
  log "bypass policy in place: Cloudflare lets these through and the Operation Kit key decides"
  log "paths: $(printf '%s\n' "$paths" | tr '\n' ' ')"
  log "everything else on $DOMAIN — including /api/internal, /api/admin, /api/secrets and the rest of /api/auth — still needs the Cloudflare sign-in"
}

api_bypass_down() {
  local a
  a=$(find_api_app)
  if [ -n "$a" ]; then
    mut DELETE "/accounts/$ACCOUNT_ID/access/apps/$a" >/dev/null
    log "'$API_APP_NAME' removed — every API route is behind the Cloudflare sign-in again (bots will now get the sign-in page)"
  else log "'$API_APP_NAME': none"; fi
}


# ── Browser-integrity exception for this install's API paths (step 10) ───────
# Step 8 above tells Cloudflare ACCESS to stop asking for a sign-in on the
# bot-facing API routes. That is necessary and not sufficient: Browser Integrity
# Check is a separate layer, and it refuses the request for a completely
# different reason — the caller is a script, not a browser — with error 1010.
# The caller sees HTTP 403 and an HTML page instead of the app's JSON, so a
# perfectly good Operation Kit key looks broken.
#
# What goes in: ONE Configuration Rule, scoped to this install's hostname and
# its /api/ paths, carrying one setting. What stays exactly as it was: the
# zone's Browser Integrity Check switch, every WAF rule and rate limit, the
# Access applications and the sign-in, every OTHER Configuration Rule in the
# same phase (we add / patch / delete OUR rule by id, never rewriting the list),
# and every other hostname in the zone. install/bic-lib.sh holds the pure parts
# and install/test/bic-lib-test.sh proves each of those claims.

# cf_try METHOD PATH [JSON] — like cf(), but never exits: prints the HTTP status
# code on line 1 and Cloudflare's body after it, so a caller can tell "not there
# yet" (404) apart from "your token may not" (403). Never prints the token.
cf_try() {
  local method=$1 path=$2 body=${3-} out
  if [ -n "$body" ]; then
    out=$(curl -sS --retry 3 -w '\n%{http_code}' -X "$method" -H @"$HDR" --data-binary @- "$CF_API$path" <<<"$body") || { printf '000\n{}'; return 0; }
  else
    out=$(curl -sS --retry 3 -w '\n%{http_code}' -X "$method" -H @"$HDR" "$CF_API$path") || { printf '000\n{}'; return 0; }
  fi
  printf '%s\n%s' "${out##*$'\n'}" "${out%$'\n'*}"
}

# bic_call METHOD PATH [JSON] — a rulesets call that must succeed. On refusal it
# dies with the cause in plain language (token permission vs plan/limit vs
# anything else) and says that nothing was changed, so a failure is never read
# as a half-applied success.
bic_call() {
  local r code body hint
  r=$(cf_try "$1" "$2" "${3-}")
  code=${r%%$'\n'*}; body=${r#*$'\n'}
  [ "$code" != 000 ] || die "browser-integrity exception: could not reach Cloudflare ($1 $2). Nothing was changed."
  if [ "$(jq -r '.success' <<<"$body" 2>/dev/null)" != "true" ]; then
    hint=$(ok_bic_error_hint "$body") || hint=
    if [ -n "$hint" ]; then
      die "browser-integrity exception: $hint (Cloudflare answered HTTP $code). Nothing was changed."
    fi
    die "browser-integrity exception: Cloudflare refused $1 $2 (HTTP $code): $(jq -c '[.errors[]?|{code,message}]' <<<"$body" 2>/dev/null || echo 'unreadable response'). Nothing was changed."
  fi
  printf '%s' "$body"
}

# bic_phase — prints the zone's http_config_settings phase ruleset (the JSON
# `result`), or nothing at all when the zone has no Configuration Rules yet.
# A refusal that is NOT "no such ruleset" stops the step with its own message.
bic_phase() {
  local r code body hint
  r=$(cf_try GET "/zones/$ZONE_ID/rulesets/phases/$OK_BIC_PHASE/entrypoint")
  code=${r%%$'\n'*}; body=${r#*$'\n'}
  [ "$code" != 000 ] || die "browser-integrity exception: could not reach Cloudflare (reading the $OK_BIC_PHASE phase). Nothing was changed."
  if [ "$(jq -r '.success' <<<"$body" 2>/dev/null)" = "true" ]; then jq -c '.result' <<<"$body"; return 0; fi
  if [ "$code" = 404 ] || jq -e '[.errors[]? | select((.message // "") | test("not found|does not exist"; "i"))] | length > 0' <<<"$body" >/dev/null 2>&1; then
    return 0   # this zone simply has no Configuration Rules yet
  fi
  hint=$(ok_bic_error_hint "$body") || hint=
  [ -z "$hint" ] || die "browser-integrity exception: $hint (Cloudflare answered HTTP $code). Nothing was changed."
  die "browser-integrity exception: Cloudflare refused to show this zone's Configuration Rules (HTTP $code): $(jq -c '[.errors[]?|{code,message}]' <<<"$body" 2>/dev/null || echo 'unreadable response'). Nothing was changed."
}

# bic_snapshot JSON LABEL — keep what the phase looked like BEFORE we touch it.
# A ruleset body holds no secrets, but the file is written 600 like everything
# else. This is the thing to read if a rollback ever has to be done by hand.
bic_snapshot() {
  local f
  if [ "$DRY_RUN" -eq 1 ]; then log "  [dry-run] would snapshot the $OK_BIC_PHASE phase under $OK_DIR/backups/"; return 0; fi
  mkdir -p "$OK_DIR/backups"; chmod 700 "$OK_DIR/backups" 2>/dev/null || true
  f=$OK_DIR/backups/cloudflare-bic-$(date -u +%Y%m%dT%H%M%SZ)-$2.json
  (umask 077; printf '%s\n' "${1:-$OK_BIC_EMPTY}" > "$f")
  log "  before-state saved: $f (restore by hand from the dashboard if ever needed)"
}

# bic_others JSON — the rules in the phase that are not ours, as text, so the
# before/after comparison is one string equality.
bic_others() { ok_bic_other_rules "${1:-$OK_BIC_EMPTY}" "$DOMAIN"; }

api_bic_up() {
  local phase rs_id before after rid rule n r
  step "Cloudflare: browser-integrity exception for https://$DOMAIN/api/"
  ok_bic_check_domain "$DOMAIN" || exit 1
  rule=$(ok_bic_rule_body "$DOMAIN") || exit 1
  phase=$(bic_phase)
  rs_id=$(jq -r '.id // empty' <<<"${phase:-$OK_BIC_EMPTY}")
  before=$(bic_others "$phase")
  if [ -z "$before" ]; then n=0; else n=$(printf '%s\n' "$before" | wc -l | tr -d ' '); fi
  log "this zone has $n other Configuration Rule(s) in the $OK_BIC_PHASE phase — none of them is edited or re-ordered"

  if [ -n "$phase" ] && ok_bic_rule_is_current "$phase" "$DOMAIN"; then
    log "the exception is already exactly right (one rule, bic:false, scoped to $DOMAIN and /api/) — nothing to change"
    return 0
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    if [ -z "$rs_id" ]; then log "  [dry-run] would create this zone's $OK_BIC_PHASE phase holding one rule:"
    else log "  [dry-run] would add or correct exactly one rule in the existing $OK_BIC_PHASE phase:"; fi
    log "  [dry-run]   expression: $(ok_bic_expression "$DOMAIN")"
    log "  [dry-run]   action: set_config, action_parameters: {\"bic\": false} — and nothing else"
    log "  [dry-run]   the other $n rule(s) in the phase would not be sent to Cloudflare at all"
    return 0
  fi
  bic_snapshot "$phase" before-up

  if [ -z "$rs_id" ]; then
    # No Configuration Rules in this zone at all: create the phase holding only
    # our rule. Nothing can be lost here — there was nothing to lose.
    # Two documented ways to make a phase entry point exist; some accounts
    # answer the first with a refusal, so fall back to the explicit create
    # rather than stopping. Both send the same single rule.
    r=$(cf_try PUT "/zones/$ZONE_ID/rulesets/phases/$OK_BIC_PHASE/entrypoint" \
      "$(jq -nc --arg n "$OK_BIC_RULESET_NAME" --argjson r "$rule" '{name:$n, rules:[$r]}')")
    if [ "$(jq -r '.success' <<<"${r#*$'\n'}" 2>/dev/null)" != "true" ]; then
      bic_call POST "/zones/$ZONE_ID/rulesets" \
        "$(jq -nc --arg n "$OK_BIC_RULESET_NAME" --arg p "$OK_BIC_PHASE" --argjson r "$rule" \
           '{name:$n, kind:"zone", phase:$p, rules:[$r]}')" >/dev/null
    fi
    log "Configuration Rules created for this zone, holding the one exception rule"
  else
    rid=$(ok_bic_find_rule "$phase" "$DOMAIN") || exit 1
    if [ -n "$rid" ]; then
      bic_call PATCH "/zones/$ZONE_ID/rulesets/$rs_id/rules/$rid" "$rule" >/dev/null
      log "the existing exception rule was corrected in place (no second rule added)"
    else
      bic_call POST "/zones/$ZONE_ID/rulesets/$rs_id/rules" "$rule" >/dev/null
      log "exception rule added to the existing $OK_BIC_PHASE phase"
    fi
  fi

  # Say it worked only when Cloudflare agrees it worked, and only when
  # everything that was not ours came through unchanged.
  phase=$(bic_phase)
  ok_bic_rule_is_current "$phase" "$DOMAIN" \
    || die "browser-integrity exception: Cloudflare accepted the change but the rule does not read back as expected. Check Rules -> Configuration Rules in the dashboard before trusting the API path."
  after=$(bic_others "$phase")
  [ "$before" = "$after" ] \
    || die "browser-integrity exception: the other Configuration Rules in this zone are not what they were before the change. This script edits only its own rule — compare against the snapshot under $OK_DIR/backups/ and the dashboard."
  log "done: Browser Integrity Check no longer applies to https://$DOMAIN/api/* — and to nothing else"
  log "the zone-wide Browser Integrity Check setting, the WAF, rate limits, the sign-in UI and the other $n rule(s) are untouched"
  log "to undo: sudo bash $OK_LIB_DIR/cloudflare.sh api-bic remove --config <your client.conf>"
}

api_bic_down() {
  local phase rs_id rid before after
  phase=$(bic_phase)
  rs_id=$(jq -r '.id // empty' <<<"${phase:-$OK_BIC_EMPTY}")
  if [ -z "$rs_id" ]; then log "browser-integrity exception: none (this zone has no Configuration Rules)"; return 0; fi
  rid=$(ok_bic_find_rule "$phase" "$DOMAIN") || exit 1
  if [ -z "$rid" ]; then log "browser-integrity exception: none"; return 0; fi
  before=$(bic_others "$phase")
  if [ "$DRY_RUN" -eq 1 ]; then log "  [dry-run] would delete rule $rid from the $OK_BIC_PHASE phase and leave every other rule alone"; return 0; fi
  bic_snapshot "$phase" before-remove
  bic_call DELETE "/zones/$ZONE_ID/rulesets/$rs_id/rules/$rid" >/dev/null
  phase=$(bic_phase)
  after=$(bic_others "$phase")
  [ "$before" = "$after" ] || warn "the other Configuration Rules in this zone changed during the removal — compare against the snapshot under $OK_DIR/backups/"
  log "browser-integrity exception removed — Browser Integrity Check applies to $DOMAIN/api/ again (bots will get Cloudflare error 1010)"
}

if [ "$ACTION" = agent-pass ]; then
  a=$(find_app)
  [ -n "$a" ] || die "no Access app on $DOMAIN yet — run the installer (or 'cloudflare.sh up') first"
  if [ "$PASS_CMD" = list ]; then
    passes=$(list_passes)
    if [ -z "$passes" ]; then log "no agent passes"; else log "agent passes:"; printf '%s\n' "$passes" | awk '{print "  - " $2}'; fi
    exit 0
  fi
  PASS_TOKEN_NAME="$PASS_PREFIX$PASS_NAME"
  POLICY_NAME="Agent pass: $PASS_NAME"
  PASS_FILE="$OK_SECRETS/agent-pass-$PASS_NAME.env"
  sid=$(find_svc "$PASS_TOKEN_NAME")
  pid=$(cf GET "/accounts/$ACCOUNT_ID/access/apps/$a/policies" | jq -r --arg n "$POLICY_NAME" '[.result[]? | select(.name == $n)][0].id // empty')
  if [ "$PASS_CMD" = remove ]; then
    if [ -n "$pid" ]; then mut DELETE "/accounts/$ACCOUNT_ID/access/apps/$a/policies/$pid" >/dev/null; log "policy '$POLICY_NAME' removed"; fi
    if [ -n "$sid" ]; then mut DELETE "/accounts/$ACCOUNT_ID/access/service_tokens/$sid" >/dev/null; log "service token removed"; fi
    run rm -f "$PASS_FILE"
    [ -n "$pid$sid" ] || log "no agent pass named '$PASS_NAME'"
    log "agent pass '$PASS_NAME' revoked: that tool can no longer get past the Cloudflare sign-in"
    exit 0
  fi
  if [ -n "$sid" ] && [ -s "$PASS_FILE" ]; then
    log "agent pass '$PASS_NAME' already exists (header values in $PASS_FILE). To replace it: agent-pass remove $PASS_NAME, then add again."
    exit 0
  fi
  [ -z "$sid" ] || mut DELETE "/accounts/$ACCOUNT_ID/access/service_tokens/$sid" >/dev/null   # values were lost: re-issue
  svc=$(mut POST "/accounts/$ACCOUNT_ID/access/service_tokens" "$(jq -nc --arg n "$PASS_TOKEN_NAME" '{name:$n, duration:"8760h"}')")
  sid=$(jq -r .result.id <<<"$svc")
  if [ "$DRY_RUN" -eq 0 ]; then
    (umask 077; jq -r '"CF_ACCESS_CLIENT_ID=\(.result.client_id)\nCF_ACCESS_CLIENT_SECRET=\(.result.client_secret)"' <<<"$svc" > "$PASS_FILE")
  fi
  unset svc
  body=$(jq -nc --arg n "$POLICY_NAME" --arg t "$sid" '{name:$n, decision:"non_identity", include:[{service_token:{token_id:$t}}]}')
  if [ -n "$pid" ]; then
    mut PUT "/accounts/$ACCOUNT_ID/access/apps/$a/policies/$pid" "$body" >/dev/null
  else
    prec=$(cf GET "/accounts/$ACCOUNT_ID/access/apps/$a/policies" | jq '[.result[]?.precedence // 0] | max // 0 | . + 1')
    mut POST "/accounts/$ACCOUNT_ID/access/apps/$a/policies" "$(jq -c --argjson p "$prec" '. + {precedence:$p}' <<<"$body")" >/dev/null
  fi
  log "agent pass '$PASS_NAME' created. It expires in one year."
  log "The two header values are in $PASS_FILE (root only). Read them in your own terminal, never in a chat:"
  log "  ssh -t root@<server> cat $PASS_FILE"
  exit 0
fi

if [ "$ACTION" = api-bypass ]; then
  if [ "$BYPASS_CMD" = remove ]; then
    step "Cloudflare Access: putting the API routes back behind the sign-in"
    api_bypass_down
  else
    [ -n "$(find_app)" ] || die "no Access app on $DOMAIN yet — run the installer (or 'cloudflare.sh up') first"
    api_bypass_up
  fi
  exit 0
fi

# The reconcile path for an install made before step 10 existed. On its own it
# never touches the tunnel, DNS, Access, the app or any secret.
if [ "$ACTION" = api-bic ]; then
  if [ "$BIC_CMD" = remove ]; then
    step "Cloudflare: removing the browser-integrity exception for $DOMAIN/api/"
    api_bic_down
  else
    api_bic_up
  fi
  exit 0
fi

if [ "$ACTION" = status ]; then
  t=$(find_tunnel); d=$(find_dns); a=$(find_app); s=$(find_svc)
  have() { [ -n "$1" ] && echo present || echo MISSING; }
  printf '  tunnel %-28s %s\n' "$TUNNEL_NAME" "$(have "$t")"
  if [ -n "$t" ]; then
    printf '  tunnel connections            %s\n' "$(cf GET "/accounts/$ACCOUNT_ID/cfd_tunnel/$t" | jq -r '.result.connections | length')"
  fi
  printf '  dns    %-28s %s\n' "$DOMAIN" "$(jq -r '"\(.type) -> \(.content) proxied=\(.proxied)"' <<<"${d:-null}" 2>/dev/null || echo MISSING)"
  printf '  access app                    %s\n' "$(have "$a")"
  b=$(find_api_app)
  if [ -n "$b" ]; then
    printf '  API bypass app                present (%s paths, key auth)\n' "$(cf GET "/accounts/$ACCOUNT_ID/access/apps/$b" | jq -r '(.result.destinations // []) | length')"
  else
    printf '  API bypass app                MISSING (bots get the Cloudflare sign-in — run: cloudflare.sh api-bypass)\n'
  fi
  bic_phase_json=$(bic_phase)
  if [ -n "$bic_phase_json" ] && ok_bic_rule_is_current "$bic_phase_json" "$DOMAIN"; then
    printf '  browser-integrity exception   present (%s/api/* only, bic:false)\n' "$DOMAIN"
  else
    printf '  browser-integrity exception   MISSING (bots get Cloudflare error 1010 — run: cloudflare.sh api-bic)\n'
  fi
  printf '  verify service token          %s\n' "$(have "$s")"
  printf '  agent passes                  %s\n' "$(list_passes | wc -l | tr -d ' ')"
  printf '  one login (team + AUD stored) %s\n' "$([ -n "$(env_get "$OK_SECRETS_ENV" OK_CF_ACCESS_AUD)" ] && echo on || echo off)"
  exit 0
fi

if [ "$ACTION" = down ]; then
  step "Cloudflare: removing what the installer created for $DOMAIN"
  a=$(find_app)
  if [ -n "$a" ]; then mut DELETE "/accounts/$ACCOUNT_ID/access/apps/$a" >/dev/null; log "access app removed"; else log "access app: none"; fi
  api_bypass_down
  api_bic_down
  s=$(find_svc)
  if [ -n "$s" ]; then mut DELETE "/accounts/$ACCOUNT_ID/access/service_tokens/$s" >/dev/null; log "verify service token removed"; else log "service token: none"; fi
  while read -r pass_id pass_name; do
    [ -n "$pass_id" ] || continue
    mut DELETE "/accounts/$ACCOUNT_ID/access/service_tokens/$pass_id" >/dev/null; run rm -f "$OK_SECRETS/agent-pass-$pass_name.env"
    log "agent pass '$pass_name' removed"
  done < <(list_passes)
  t=$(find_tunnel)
  d=$(find_dns)
  if [ -n "$d" ] && [ -n "$t" ] && [ "$(jq -r .content <<<"$d")" = "$t.cfargotunnel.com" ]; then
    mut DELETE "/zones/$ZONE_ID/dns_records/$(jq -r .id <<<"$d")" >/dev/null; log "dns record removed"
  elif [ -n "$d" ]; then
    warn "dns record for $DOMAIN does not point at our tunnel — left untouched"
  else log "dns record: none"; fi
  if [ -n "$t" ]; then
    mut DELETE "/accounts/$ACCOUNT_ID/cfd_tunnel/$t/connections" >/dev/null || true
    mut DELETE "/accounts/$ACCOUNT_ID/cfd_tunnel/$t" >/dev/null; log "tunnel removed"
  else log "tunnel: none"; fi
  # No Access app any more: switch the app back to its own password sign-in.
  if [ "$DRY_RUN" -eq 0 ] && [ -n "$(env_get "$OK_SECRETS_ENV" OK_CF_ACCESS_AUD)" ]; then
    env_set "$OK_SECRETS_ENV" OK_CF_ACCESS_TEAM ""; env_set "$OK_SECRETS_ENV" OK_CF_ACCESS_AUD ""
    log "one-login settings cleared (restart the app: the password sign-in is back)"
  fi
  exit 0
fi

# ── up ────────────────────────────────────────────────────────────────────────
step "Cloudflare Tunnel $TUNNEL_NAME"
TUNNEL_ID=$(find_tunnel)
if [ -n "$TUNNEL_ID" ]; then log "tunnel exists — reusing"
else
  TUNNEL_ID=$(mut POST "/accounts/$ACCOUNT_ID/cfd_tunnel" "$(jq -nc --arg n "$TUNNEL_NAME" '{name:$n, config_src:"cloudflare"}')" | jq -r .result.id)
  log "tunnel created"
fi
ingress=$(jq -nc --arg h "$DOMAIN" '{config:{ingress:[
  {hostname:$h, service:"http://command-center:3002", originRequest:{connectTimeout:30, noTLSVerify:false}},
  {service:"http_status:404"}]}}')
mut PUT "/accounts/$ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/configurations" "$ingress" >/dev/null
log "tunnel routes $DOMAIN -> app container (port 3002 inside the private Docker network)"
if [ "$DRY_RUN" -eq 0 ]; then
  env_set "$OK_SECRETS_ENV" TUNNEL_TOKEN "$(cf GET "/accounts/$ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/token" | jq -r .result)"
  log "tunnel connector token stored as TUNNEL_TOKEN in secrets/stack.env"
fi

step "DNS $DOMAIN -> tunnel"
want_target="$TUNNEL_ID.cfargotunnel.com"
rec=$(find_dns)
if [ -z "$rec" ]; then
  mut POST "/zones/$ZONE_ID/dns_records" "$(jq -nc --arg n "$DOMAIN" --arg c "$want_target" \
    '{type:"CNAME", name:$n, content:$c, proxied:true, ttl:1, comment:"Operation Kit tunnel"}')" >/dev/null
  log "CNAME created (proxied)"
elif [ "$(jq -r .content <<<"$rec")" = "$want_target" ] && [ "$(jq -r .proxied <<<"$rec")" = "true" ]; then
  log "CNAME already points at the tunnel"
elif [ "$REPLACE_DNS" -eq 1 ] || [[ "$(jq -r .content <<<"$rec")" == *.cfargotunnel.com ]]; then
  mut PUT "/zones/$ZONE_ID/dns_records/$(jq -r .id <<<"$rec")" "$(jq -nc --arg n "$DOMAIN" --arg c "$want_target" \
    '{type:"CNAME", name:$n, content:$c, proxied:true, ttl:1, comment:"Operation Kit tunnel"}')" >/dev/null
  log "existing record re-pointed at the tunnel"
else
  die "$DOMAIN already has a $(jq -r .type <<<"$rec") record pointing somewhere else. Pick another DOMAIN, or re-run with --replace-dns if the client confirms it can be replaced."
fi

step "Cloudflare Access (Zero Trust) sign-in layer"
# Two different problems look alike here: the token lacks the Access
# "Organizations" permission (Cloudflare answers 401/403, "Authentication
# error"), or Zero Trust was never switched on (no organization). Tell them apart.
org_out=$(curl -sS --retry 3 -w '\n%{http_code}' -H @"$HDR" "$CF_API/accounts/$ACCOUNT_ID/access/organizations") \
  || die "network error calling Cloudflare (GET access/organizations)"
org_code=${org_out##*$'\n'}; org_out=${org_out%$'\n'*}
org=$(jq -r 'select(.success == true) | .result.auth_domain // empty' <<<"$org_out" 2>/dev/null || true)
if [ -z "$org" ]; then
  if [[ "$org_code" =~ ^(401|403)$ ]] || jq -e '[.errors[]? | select(.code == 10000 or .code == 9109 or (.message | test("auth|permission|unauthori"; "i")))] | length > 0' <<<"$org_out" >/dev/null 2>&1; then
    die "the Cloudflare API token cannot read the Zero Trust organization (HTTP $org_code). Edit the token and add the permission 'Account → Access: Organizations, Identity Providers, and Groups → Edit' (INSTALL.md step 2 lists all six), then re-run."
  fi
  die "Cloudflare Zero Trust is not switched on for this account yet. In the Cloudflare dashboard open 'Zero Trust', pick a team name and the Free plan (one-time, about 2 minutes), then re-run. INSTALL.md step 2 shows the clicks."
fi
log "Zero Trust team domain: $org"

method=$(conf ACCESS_LOGIN_METHOD otp)
case "$method" in
  otp)       idp_type=onetimepin; idp_name="One-time PIN" ;;
  google)    idp_type=google;     idp_name="Google" ;;
  microsoft) idp_type=azureAD;    idp_name="Microsoft" ;;
esac
IDP_ID=$(cf GET "/accounts/$ACCOUNT_ID/access/identity_providers" | jq -r --arg t "$idp_type" '[.result[]? | select(.type == $t)][0].id // empty')
if [ -n "$IDP_ID" ]; then log "login method '$idp_name' already set up — reusing"
else
  case "$idp_type" in
    onetimepin) idp_cfg='{}' ;;
    google)
      [ -n "$(env_get "$OK_SECRETS_ENV" GOOGLE_CLIENT_ID)" ] || die "ACCESS_LOGIN_METHOD=google needs GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET in the secrets hand-over file"
      idp_cfg=$(jq -nc --arg i "$(env_get "$OK_SECRETS_ENV" GOOGLE_CLIENT_ID)" --arg s "$(env_get "$OK_SECRETS_ENV" GOOGLE_CLIENT_SECRET)" '{client_id:$i, client_secret:$s}') ;;
    azureAD)
      [ -n "$(env_get "$OK_SECRETS_ENV" AZURE_CLIENT_ID)" ] || die "ACCESS_LOGIN_METHOD=microsoft needs AZURE_CLIENT_ID, AZURE_CLIENT_SECRET and AZURE_DIRECTORY_ID in the secrets hand-over file"
      idp_cfg=$(jq -nc --arg i "$(env_get "$OK_SECRETS_ENV" AZURE_CLIENT_ID)" --arg s "$(env_get "$OK_SECRETS_ENV" AZURE_CLIENT_SECRET)" \
        --arg d "$(env_get "$OK_SECRETS_ENV" AZURE_DIRECTORY_ID)" '{client_id:$i, client_secret:$s, directory_id:$d}') ;;
  esac
  IDP_ID=$(mut POST "/accounts/$ACCOUNT_ID/access/identity_providers" \
    "$(jq -nc --arg n "$idp_name" --arg t "$idp_type" --argjson c "$idp_cfg" '{name:$n, type:$t, config:$c}')" | jq -r .result.id)
  log "login method '$idp_name' created"
fi

SVC_ID=$(find_svc)
if [ -n "$SVC_ID" ] && [ -n "$(env_get "$OK_SECRETS_ENV" OK_VERIFY_CF_CLIENT_SECRET)" ]; then
  log "verify service token exists — reusing"
else
  if [ -n "$SVC_ID" ]; then mut DELETE "/accounts/$ACCOUNT_ID/access/service_tokens/$SVC_ID" >/dev/null; fi
  svc=$(mut POST "/accounts/$ACCOUNT_ID/access/service_tokens" "$(jq -nc --arg n "$SVC_TOKEN_NAME" '{name:$n, duration:"8760h"}')")
  SVC_ID=$(jq -r .result.id <<<"$svc")
  if [ "$DRY_RUN" -eq 0 ]; then
    env_set "$OK_SECRETS_ENV" OK_VERIFY_CF_CLIENT_ID "$(jq -r .result.client_id <<<"$svc")"
    env_set "$OK_SECRETS_ENV" OK_VERIFY_CF_CLIENT_SECRET "$(jq -r .result.client_secret <<<"$svc")"
  fi
  log "verify service token created (stored by name in secrets/stack.env)"
fi

include=$(jq -nc --arg emails "$(conf ACCESS_ALLOWED_EMAILS)" --arg dom "$(conf ACCESS_ALLOWED_EMAIL_DOMAIN)" '
  [($emails | split(",")[] | gsub("\\s"; "") | select(length > 0) | {email:{email:.}}),
   ($dom | gsub("\\s"; "") | select(length > 0) | {email_domain:{domain:.}})]')
app_body=$(jq -nc --arg n "$APP_NAME" --arg d "$DOMAIN" --arg idp "$IDP_ID" --arg dur "$(conf ACCESS_SESSION_DURATION 24h)" '
  {name:$n, domain:$d, type:"self_hosted", session_duration:$dur, allowed_idps:[$idp],
   auto_redirect_to_identity:true, app_launcher_visible:false, http_only_cookie_attribute:true,
   same_site_cookie_attribute:"lax", skip_interstitial:true}')
APP_ID=$(find_app)
if [ -n "$APP_ID" ]; then
  mut PUT "/accounts/$ACCOUNT_ID/access/apps/$APP_ID" "$app_body" >/dev/null
  log "access app exists — settings refreshed"
else
  APP_ID=$(mut POST "/accounts/$ACCOUNT_ID/access/apps" "$app_body" | jq -r .result.id)
  log "access app created"
fi

# Two app-scoped policies: people (allow) and the verify robot (service auth).
upsert_policy() { # name json
  local name=$1 body=$2 pid
  pid=$(cf GET "/accounts/$ACCOUNT_ID/access/apps/$APP_ID/policies" 2>/dev/null | jq -r --arg n "$name" '[.result[]? | select(.name == $n)][0].id // empty' || true)
  if [ -n "$pid" ]; then mut PUT "/accounts/$ACCOUNT_ID/access/apps/$APP_ID/policies/$pid" "$body" >/dev/null; log "policy '$name' updated"
  else mut POST "/accounts/$ACCOUNT_ID/access/apps/$APP_ID/policies" "$body" >/dev/null; log "policy '$name' created"; fi
}
if [ "$DRY_RUN" -eq 1 ]; then
  log "  [dry-run] would upsert policies: 'Allowed people' include=$(jq -c 'length' <<<"$include") rule(s); 'Install verify robot'"
else
  upsert_policy "Allowed people" "$(jq -nc --argjson inc "$include" '{name:"Allowed people", decision:"allow", include:$inc, precedence:1}')"
  upsert_policy "Install verify robot" "$(jq -nc --arg t "$SVC_ID" '{name:"Install verify robot", decision:"non_identity", include:[{service_token:{token_id:$t}}], precedence:2}')"
fi

# Step 8 (obj 900028): let bots reach the board API with their Operation Kit key.
# On by default — without it a key-authenticated bot only ever sees Cloudflare's
# sign-in page. API_KEY_AUTH_BYPASS="off" in client.conf skips it.
case "$(conf API_KEY_AUTH_BYPASS on)" in
  off|no|0|false) warn "API_KEY_AUTH_BYPASS=off — bots calling the API with a key will get the Cloudflare sign-in page, not an answer" ;;
  *) api_bypass_up ;;
esac

# Step 10 (obj 900259): Access letting a bot through is not enough on its own —
# Browser Integrity Check still refuses a request that is not from a browser
# (error 1010). On by default; API_BROWSER_INTEGRITY_EXCEPTION="off" skips it.
case "$(conf API_BROWSER_INTEGRITY_EXCEPTION on)" in
  off|no|0|false) warn "API_BROWSER_INTEGRITY_EXCEPTION=off — if this zone has Browser Integrity Check on, bots calling the API with a key will get Cloudflare error 1010 instead of an answer" ;;
  *) api_bic_up ;;
esac

# One login (obj 720332): the app verifies Cloudflare's signed identity header
# against this team's public keys and this app's AUD tag. Neither is secret.
step "One login: let the app trust the Cloudflare sign-in"
if [ "$DRY_RUN" -eq 1 ]; then
  log "  [dry-run] would store OK_CF_ACCESS_TEAM=$org and the app's AUD tag in secrets/stack.env"
else
  APP_AUD=$(cf GET "/accounts/$ACCOUNT_ID/access/apps/$APP_ID" | jq -r '.result.aud // empty')
  [ -n "$APP_AUD" ] || die "Cloudflare did not return the Access app's AUD tag — cannot switch on one login"
  env_set "$OK_SECRETS_ENV" OK_CF_ACCESS_TEAM "$org"
  env_set "$OK_SECRETS_ENV" OK_CF_ACCESS_AUD "$APP_AUD"
  log "team $org + app AUD stored: people who pass Cloudflare Access skip the app's own sign-in"
fi

log "Cloudflare done: https://$DOMAIN is served through the tunnel and gated by Access ($idp_name)."
