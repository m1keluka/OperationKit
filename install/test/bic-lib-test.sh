#!/usr/bin/env bash
# Prove the narrow browser-integrity exception in install/bic-lib.sh is narrow:
# one hostname, one path prefix, one setting; it finds its own rule and nothing
# else; and it can tell Cloudflare's error 1010 apart from the Access sign-in
# and from the app's own 401.  bash install/test/bic-lib-test.sh
# No root, no network, no Cloudflare account.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
LIB=$HERE/..
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
DOM=ops.example-capital.com

fails=0
check() { if [ "$2" = "$3" ]; then echo "  PASS  $1"; else echo "  FAIL  $1 (got '$2', want '$3')"; fails=$((fails+1)); fi; }
# b FN ARGS… — run one library function in a fresh shell (lib.sh gives it die()).
b() { bash -c 'set -uo pipefail; source "$0/lib.sh"; source "$0/bic-lib.sh"; f=$1; shift; "$f" "$@"' "$LIB" "$@" 2>"$WORK/err"; }
# refused FN ARG WANT — the call must fail AND say why.
refused() {
  local out
  out=$(b "$1" "$2")
  if [ -n "$out" ]; then check "refuses $3" "accepted: $out" refused; return; fi
  if grep -q "$3" "$WORK/err"; then check "refuses $3" refused refused
  else check "refuses $3" "wrong message: $(tr '\n' ' ' < "$WORK/err")" "message naming $3"; fi
}

echo "== the rule is scoped to one hostname and one path prefix"
check "expression names the host and /api/ and nothing else" "$(b ok_bic_expression "$DOM")" \
  '(http.host eq "ops.example-capital.com" and starts_with(http.request.uri.path, "/api/"))'
check "a different install gets a different expression" "$(b ok_bic_expression board.other-client.net)" \
  '(http.host eq "board.other-client.net" and starts_with(http.request.uri.path, "/api/"))'
# Not "no hostname of OURS": no hostname at all. The library must carry no
# literal host but Cloudflare's own, so it cannot be wrong for any client.
check "no hostname is baked into the library" \
  "$(grep -vE '^[[:space:]]*#' "$LIB/bic-lib.sh" | grep -oE '[a-z0-9-]+\.(com|net|org|io|dev)' | grep -v '^cloudflareaccess\.com$' | wc -l | tr -d ' ')" 0

echo "== the rule carries exactly one setting"
RULE=$(b ok_bic_rule_body "$DOM")
check "action is set_config"                  "$(jq -r .action <<<"$RULE")"                 set_config
check "action_parameters has exactly one key" "$(jq -c '.action_parameters|keys' <<<"$RULE")" '["bic"]'
check "and that key is bic:false"             "$(jq -r .action_parameters.bic <<<"$RULE")"  false
check "the rule is enabled"                   "$(jq -r .enabled <<<"$RULE")"                true
check "its description names this install"    "$(jq -r .description <<<"$RULE")" \
  'Operation Kit: API key auth for ops.example-capital.com/api/ (no browser integrity check)'
check "it sets no security level, SSL or WAF option" \
  "$(jq -c '[.action_parameters|keys[]|select(.!="bic")]' <<<"$RULE")" '[]'

echo "== a DOMAIN that would widen the rule is refused"
refused ok_bic_expression ''                      'DOMAIN is empty'
refused ok_bic_expression '*.example-capital.com' 'contains a wildcard'
refused ok_bic_expression 'not a host'            'not a plain hostname'
refused ok_bic_expression 'ops.example-capital.com/api' 'not a plain hostname'
refused ok_bic_rule_body  '*'                     'wildcard'

echo "== finding our rule, and only our rule"
# A phase holding: the client's own rule, another Operation Kit install's rule,
# and ours. Only the third may ever be matched.
PHASE=$(jq -nc --arg d "$(b ok_bic_rule_desc "$DOM")" --arg e "$(b ok_bic_expression "$DOM")" '{
  id:"rs1", phase:"http_config_settings", rules:[
    {id:"client1", action:"set_config", action_parameters:{ssl:"strict"}, expression:"(http.host eq \"shop.example-capital.com\")", description:"client: strict SSL"},
    {id:"client2", action:"set_config", action_parameters:{bic:false}, expression:"(http.host eq \"other.example-capital.com\" and starts_with(http.request.uri.path, \"/api/\"))", description:"Operation Kit: API key auth for other.example-capital.com/api/ (no browser integrity check)"},
    {id:"ours",    action:"set_config", action_parameters:{bic:false}, expression:$e, description:$d, enabled:true}]}')
check "finds our rule by its id"            "$(b ok_bic_find_rule "$PHASE" "$DOM")" ours
check "does not match another install's"    "$(b ok_bic_find_rule "$PHASE" nothing.example-capital.com)" ''
check "already-current is recognised"       "$(b ok_bic_rule_is_current "$PHASE" "$DOM" && echo current || echo stale)" current
check "the other two rules are 'not ours'"  "$(b ok_bic_other_rules "$PHASE" "$DOM" | cut -f1 | tr '\n' ' ')" 'client1 client2 '

echo "== a rule renamed in the dashboard is still ours (same host, bic only)"
RENAMED=$(jq -c '.rules[2].description = "renamed by hand"' <<<"$PHASE")
check "matched by shape"       "$(b ok_bic_find_rule "$RENAMED" "$DOM")" ours
check "but reported as stale"  "$(b ok_bic_rule_is_current "$RENAMED" "$DOM" && echo current || echo stale)" stale

echo "== a rule that does MORE than bic is somebody else's"
WIDER=$(jq -c '.rules[2].description = "renamed by hand" | .rules[2].action_parameters.security_level = "under_attack"' <<<"$PHASE")
check "not matched by shape"   "$(b ok_bic_find_rule "$WIDER" "$DOM")" ''
check "and counted as theirs"  "$(b ok_bic_other_rules "$WIDER" "$DOM" | wc -l | tr -d ' ')" 3

echo "== a disabled or re-scoped rule is stale, so a re-run fixes it"
check "disabled is stale"      "$(b ok_bic_rule_is_current "$(jq -c '.rules[2].enabled=false' <<<"$PHASE")" "$DOM" && echo current || echo stale)" stale
check "wider path is stale"    "$(b ok_bic_rule_is_current "$(jq -c '.rules[2].expression="(http.host eq \"ops.example-capital.com\")"' <<<"$PHASE")" "$DOM" && echo current || echo stale)" stale
check "bic:true is stale"      "$(b ok_bic_rule_is_current "$(jq -c '.rules[2].action_parameters.bic=true' <<<"$PHASE")" "$DOM" && echo current || echo stale)" stale
check "an empty zone is stale" "$(b ok_bic_rule_is_current '{"rules":[]}' "$DOM" && echo current || echo stale)" stale
check "an empty zone has no rules of anyone's" "$(b ok_bic_other_rules '{"rules":[]}' "$DOM")" ''
check "a {result:…} body is read the same way" "$(b ok_bic_find_rule "$(jq -nc --argjson r "$PHASE" '{success:true,result:$r}')" "$DOM")" ours

echo "== telling the three refusals apart (this is what the docs promise)"
printf '%s' '<html>error code: 1010 … banned your access based on your browser'"'"'s signature</html>' > "$WORK/1010.html"
printf '%s' '{"error":"unauthorized"}' > "$WORK/app.json"
is1010() { b ok_bic_is_1010 "$1" "${2-}" && echo bic || echo not-bic; }
check "Cloudflare 1010 HTML is BIC"            "$(is1010 '403||text/html' "$WORK/1010.html")" bic
check "a 403 HTML page with no body to read"   "$(is1010 '403||text/html')"                   bic
check "the app's own 403 JSON is NOT BIC"      "$(is1010 '403||application/json' "$WORK/app.json")" not-bic
check "the app's 401 JSON is NOT BIC"          "$(is1010 '401||application/json' "$WORK/app.json")" not-bic
check "the Access sign-in redirect is NOT BIC" "$(is1010 '302|https://team.cloudflareaccess.com/|text/html')" not-bic
check "a 200 is NOT BIC"                       "$(is1010 '200||application/json')"            not-bic
# and the Access helper must agree in the other direction
atcf() { bash -c 'set -uo pipefail; source "$0/lib.sh"; source "$0/api-bypass-lib.sh"; ok_api_bypass_at_cloudflare "$1" && echo cloudflare || echo app' "$LIB" "$1"; }
check "the sign-in redirect is Access, not the app" "$(atcf '302|https://team.cloudflareaccess.com/|text/html')" cloudflare
check "401 JSON is the app, not Cloudflare"         "$(atcf '401||application/json')"                           app

echo "== a Cloudflare refusal is turned into an instruction"
hint() { b ok_bic_error_hint "$1"; }
check "a permission error names Config Rules" \
  "$(hint '{"success":false,"errors":[{"code":10000,"message":"Authentication error"}]}' | grep -c 'Config Rules -> Edit')" 1
check "a 'not allowed' message is read as permission too" \
  "$(hint '{"success":false,"errors":[{"code":1,"message":"Unauthorized to access requested resource"}]}' | grep -c 'Config Rules')" 1
check "a plan/quota error offers the two ways out" \
  "$(hint '{"success":false,"errors":[{"code":20062,"message":"rules quota exceeded: your plan does not allow more rules"}]}' | grep -c 'API_BROWSER_INTEGRITY_EXCEPTION')" 1
check "a plan error is not blamed on the token" \
  "$(hint '{"success":false,"errors":[{"code":20062,"message":"rules quota exceeded: your plan does not allow more rules"}]}' | grep -c 'Config Rules -> Edit' || true)" 0
check "an unknown error gets no invented advice" \
  "$(hint '{"success":false,"errors":[{"code":1234,"message":"teapot"}]}')" ''
check "an unreadable body gets no invented advice" "$(hint 'not json')" ''

echo "== nothing here can print a secret"
check "the library never reads a token or secret file" \
  "$(grep -cE 'cloudflare-api-token|CLIENT_SECRET|TUNNEL_TOKEN|stack\.env' "$LIB/bic-lib.sh" || true)" 0
check "the library has no set -x" "$(grep -c 'set -x' "$LIB/bic-lib.sh" || true)" 0

echo; [ "$fails" -eq 0 ] && echo "bic lib test: ALL PASS" || { echo "bic lib test: $fails FAIL"; exit 1; }
