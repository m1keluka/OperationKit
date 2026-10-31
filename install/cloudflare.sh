#!/usr/bin/env bash
# install/cloudflare.sh — put the client's sub-domain behind Cloudflare.
#
#   sudo bash install/cloudflare.sh up     --config client.conf [--dry-run] [--replace-dns]
#   sudo bash install/cloudflare.sh down   --config client.conf [--dry-run]
#   sudo bash install/cloudflare.sh status --config client.conf
#   sudo bash install/cloudflare.sh agent-pass add|remove <name> --config client.conf
#   sudo bash install/cloudflare.sh agent-pass list --config client.conf
#
# `up` (idempotent — every object is looked up by name first and reused):
#   1. finds the zone (ZONE) and its Cloudflare account
#   2. creates a Cloudflare Tunnel "ok-<CLIENT_SLUG>" (remotely managed) and
#      routes DOMAIN -> the app container. The server opens NO web ports: the
#      tunnel connector dials OUT to Cloudflare.
#   3. points DOMAIN at the tunnel (proxied CNAME)
#   4. makes sure the Access login method exists (one-time email code, Google
#      or Microsoft)
#   5. creates a Cloudflare Access application on DOMAIN that only lets
#      ACCESS_ALLOWED_EMAILS / ACCESS_ALLOWED_EMAIL_DOMAIN through
#   6. creates an Access service token used ONLY by install/verify.sh to test the
#      site through Cloudflare without a human typing an email code
#   7. stores the tunnel token + service token in secrets/stack.env (mode 600)
# `down` removes exactly what `up` created (app, service token, DNS record,
# tunnel) plus every agent pass. It never touches the zone, other DNS records
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
# The API token is read from $INSTALL_DIR/secrets/cloudflare-api-token (one
# line, mode 600). It is sent to Cloudflare in a header file, never on a command
# line, and never printed. Token permissions needed (INSTALL.md lists them):
#   Zone: Zone Read, DNS Edit · Account: Cloudflare Tunnel Edit,
#   Access: Apps and Policies Edit, Access: Organizations, Identity Providers,
#   and Groups Edit, Access: Service Tokens Edit
set -euo pipefail
# shellcheck source=install/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

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
case "$ACTION" in up|down|status|agent-pass) ;; *) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;; esac
[ -n "$CONFIG" ] || die "--config <file> is required"
conf_load "$CONFIG"; conf_validate; ok_paths
command -v jq >/dev/null || die "jq is required (install/bootstrap-host.sh installs it)"

SLUG=$(conf CLIENT_SLUG); DOMAIN=$(conf DOMAIN); ZONE=$(conf ZONE)
TUNNEL_NAME="ok-$SLUG"
APP_NAME="Operation Kit - $(conf CLIENT_NAME)"
SVC_TOKEN_NAME="ok-$SLUG-verify"
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
find_app()    { cf GET "/accounts/$ACCOUNT_ID/access/apps" | jq -r --arg d "$DOMAIN" '[.result[]? | select(.domain == $d)][0].id // empty'; }
find_svc()    { cf GET "/accounts/$ACCOUNT_ID/access/service_tokens" | jq -r --arg n "${1:-$SVC_TOKEN_NAME}" '[.result[]? | select(.name == $n)][0].id // empty'; }
list_passes() { cf GET "/accounts/$ACCOUNT_ID/access/service_tokens" | jq -r --arg p "$PASS_PREFIX" '.result[]? | select(.name | startswith($p)) | "\(.id) \(.name | ltrimstr($p))"'; }

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

if [ "$ACTION" = status ]; then
  t=$(find_tunnel); d=$(find_dns); a=$(find_app); s=$(find_svc)
  have() { [ -n "$1" ] && echo present || echo MISSING; }
  printf '  tunnel %-28s %s\n' "$TUNNEL_NAME" "$(have "$t")"
  if [ -n "$t" ]; then
    printf '  tunnel connections            %s\n' "$(cf GET "/accounts/$ACCOUNT_ID/cfd_tunnel/$t" | jq -r '.result.connections | length')"
  fi
  printf '  dns    %-28s %s\n' "$DOMAIN" "$(jq -r '"\(.type) -> \(.content) proxied=\(.proxied)"' <<<"${d:-null}" 2>/dev/null || echo MISSING)"
  printf '  access app                    %s\n' "$(have "$a")"
  printf '  verify service token          %s\n' "$(have "$s")"
  printf '  agent passes                  %s\n' "$(list_passes | wc -l | tr -d ' ')"
  exit 0
fi

if [ "$ACTION" = down ]; then
  step "Cloudflare: removing what the installer created for $DOMAIN"
  a=$(find_app)
  if [ -n "$a" ]; then mut DELETE "/accounts/$ACCOUNT_ID/access/apps/$a" >/dev/null; log "access app removed"; else log "access app: none"; fi
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
org=$(cf GET "/accounts/$ACCOUNT_ID/access/organizations" | jq -r '.result.auth_domain // empty' 2>/dev/null || true)
if [ -z "$org" ]; then
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

log "Cloudflare done: https://$DOMAIN is served through the tunnel and gated by Access ($idp_name)."
