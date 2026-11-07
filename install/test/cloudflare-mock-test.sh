#!/usr/bin/env bash
# Exercise install/cloudflare.sh against install/test/cloudflare-mock.mjs:
# up (create) -> up again (idempotent, no duplicates) -> status -> down (clean).
# No root, no network, no real Cloudflare account.  bash install/test/cloudflare-mock-test.sh
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
CF=$HERE/../cloudflare.sh
WORK=$(mktemp -d); trap 'kill $MOCK 2>/dev/null || true; rm -rf "$WORK"' EXIT
PORT=$((20000 + RANDOM % 20000))
PORT=$PORT node "$HERE/cloudflare-mock.mjs" > "$WORK/mock.log" 2>&1 & MOCK=$!
for _ in $(seq 50); do curl -fs "http://127.0.0.1:$PORT/__state" >/dev/null 2>&1 && break; sleep 0.1; done
sed -e "s#^INSTALL_DIR=.*#INSTALL_DIR=\"$WORK/ok\"#" "$HERE/../client.conf.example" > "$WORK/client.conf"
mkdir -p "$WORK/ok/secrets"; printf 'mock-token\n' > "$WORK/ok/secrets/cloudflare-api-token"
export CF_API_BASE=http://127.0.0.1:$PORT/client/v4
st() { curl -fs "http://127.0.0.1:$PORT/__state" | jq -c "$1"; }
fails=0; check() { if [ "$2" = "$3" ]; then echo "  PASS  $1"; else echo "  FAIL  $1 (got $2, want $3)"; fails=$((fails+1)); fi; }

echo "== up #1"; bash "$CF" up --config "$WORK/client.conf" | sed 's/^/    /'
check "one tunnel" "$(st '[.result.tunnels[]|select(.deleted|not)]|length')" 1
check "tunnel routes the domain to the app" "$(st '.result.configs[]|.ingress[0].hostname+" "+.ingress[0].service')" '"ops.example-capital.com http://command-center:3002"'
check "proxied CNAME to the tunnel" "$(st '.result.dns[0]|(.type+" "+(.proxied|tostring)+" "+(.content|endswith(".cfargotunnel.com")|tostring))')" '"CNAME true true"'
check "one Access app on the bare domain" "$(st '[.result.apps[]|select(.domain=="ops.example-capital.com")|.domain]')" '["ops.example-capital.com"]'
check "one-time PIN login method" "$(st '[.result.idps[].type]')" '["onetimepin"]'
check "app admits only the one-time PIN, auto-redirect, 24h session" "$(st '.result.apps[0]|[(.allowed_idps|length), .auto_redirect_to_identity, .session_duration]')" '[1,true,"24h"]'
check "allowed-people policy" "$(st '[.result.policies[][]|select(.name=="Allowed people")|.include[0].email.email]')" '["alex.partner@example-capital.com"]'
check "verify robot policy" "$(st '[.result.policies[][]|select(.name=="Install verify robot")|.decision]')" '["non_identity"]'
# Step 8 (obj 900028): the key-auth API bypass app, created by `up` by default.
API_Q='[.result.apps[]|select(.name=="Operation Kit API (key auth)")]'
check "key-auth API app created" "$(st "$API_Q|length")" 1
check "its only policy is Bypass/Everyone" "$(st '[.result.policies[][]|select(.name=="Key auth (Operation Kit checks the key)")|[.decision,(.include[0]|keys[0])]]')" '[["bypass","everyone"]]'
check "covers 29 paths (13 routes x2 + 3 single addresses)" "$(st "$API_Q|.[0].destinations|length")" 29
check "every path is on this domain, under /api/" "$(st "$API_Q|.[0].destinations|map(.uri)|map(select(startswith(\"ops.example-capital.com/api/\")))|length")" 29
check "bots can reach the board and MCP" "$(st "$API_Q|.[0].destinations|map(.uri)|map(select(.==\"ops.example-capital.com/api/objectives\" or .==\"ops.example-capital.com/api/objectives/*\" or .==\"ops.example-capital.com/api/mcp\"))|length")" 3
# The guard: the operator surface is never in the bypass app.
check "operator routes are NOT bypassed" "$(st "$API_Q|.[0].destinations|map(.uri)|map(select(test(\"/api/(internal|admin|secrets|secret-upload|webhooks|public|llm|alerts|costs|intel|status)\")))|length")" 0
check "/api/auth bypassed only at the exact /api/auth/me" "$(st "$API_Q|.[0].destinations|map(.uri)|map(select(contains(\"/api/auth\")))")" '["ops.example-capital.com/api/auth/me"]'
check "no blanket /api wildcard" "$(st "$API_Q|.[0].destinations|map(.uri)|map(select(endswith(\"/api\") or endswith(\"/api/*\")))|length")" 0
check "secrets stored by name" "$(cut -d= -f1 "$WORK/ok/secrets/stack.env" | sort | tr '\n' ' ')" "OK_CF_ACCESS_AUD OK_CF_ACCESS_TEAM OK_VERIFY_CF_CLIENT_ID OK_VERIFY_CF_CLIENT_SECRET TUNNEL_TOKEN "
check "one login: team domain stored" "$(grep '^OK_CF_ACCESS_TEAM=' "$WORK/ok/secrets/stack.env" | cut -d= -f2)" example-capital.cloudflareaccess.com
check "one login: the app's AUD tag stored" "$(grep '^OK_CF_ACCESS_AUD=' "$WORK/ok/secrets/stack.env" | cut -d= -f2)" "$(st '.result.apps[0].aud' | tr -d '"')"
check "stack.env is mode 600" "$(stat -c %a "$WORK/ok/secrets/stack.env")" 600
check "no secret value printed" "$(bash "$CF" status --config "$WORK/client.conf" | grep -c 'mock-svc-secret\|mock-tunnel-token\|mock-token' || true)" 0

echo "== up #2 (re-run must reuse everything)"; bash "$CF" up --config "$WORK/client.conf" | sed 's/^/    /'
check "still one tunnel" "$(st '[.result.tunnels[]|select(.deleted|not)]|length')" 1
check "still one dns record" "$(st '.result.dns|length')" 1
check "still two apps (host-wide + key-auth API)" "$(st '.result.apps|length')" 2
check "still three policies" "$(st '[.result.policies[][]]|length')" 3
check "still one key-auth API app (updated, not duplicated)" "$(st '[.result.apps[]|select(.name=="Operation Kit API (key auth)")]|length')" 1
check "still one bypass policy" "$(st '[.result.policies[][]|select(.decision=="bypass")]|length')" 1
check "key-auth app still covers 29 paths" "$(st '[.result.apps[]|select(.name=="Operation Kit API (key auth)")][0].destinations|length')" 29
check "still one service token" "$(st '.result.svc|length')" 1
check "AUD unchanged on re-run" "$(grep '^OK_CF_ACCESS_AUD=' "$WORK/ok/secrets/stack.env" | cut -d= -f2)" "$(st '.result.apps[0].aud' | tr -d '"')"

echo "== agent-pass add (an outside AI tool gets its own door key)"
bash "$CF" agent-pass add claude-code --config "$WORK/client.conf" > "$WORK/out"; sed 's/^/    /' "$WORK/out"
check "pass service token named per tool" "$(st '[.result.svc[].name|select(startswith("ok-example-capital-agent-"))]')" '["ok-example-capital-agent-claude-code"]'
check "pass policy admits only that token" "$(st '[.result.policies[][]|select(.name=="Agent pass: claude-code")|.decision]')" '["non_identity"]'
check "pass policy precedence is unique within its app" "$(st '[.result.policies[]|([.[].precedence]|length==(unique|length))]|all')" true
check "pass header values written by name" "$(cut -d= -f1 "$WORK/ok/secrets/agent-pass-claude-code.env" | tr '\n' ' ')" "CF_ACCESS_CLIENT_ID CF_ACCESS_CLIENT_SECRET "
check "pass file is mode 600" "$(stat -c %a "$WORK/ok/secrets/agent-pass-claude-code.env")" 600
check "pass secret never printed" "$(grep -c 'mock-svc-secret' "$WORK/out" || true)" 0
bash "$CF" agent-pass add claude-code --config "$WORK/client.conf" >/dev/null
check "re-adding reuses the pass" "$(st '[.result.svc[]|select(.name=="ok-example-capital-agent-claude-code")]|length')" 1
bash "$CF" agent-pass add grok --config "$WORK/client.conf" >/dev/null
check "list shows both passes" "$(bash "$CF" agent-pass list --config "$WORK/client.conf" | grep -c '  - ')" 2
if bash "$CF" agent-pass add 'Bad Name' --config "$WORK/client.conf" >/dev/null 2>&1; then check "rejects a bad pass name" accepted rejected; else check "rejects a bad pass name" rejected rejected; fi
bash "$CF" agent-pass remove grok --config "$WORK/client.conf" >/dev/null
check "remove revokes token" "$(st '[.result.svc[]|select(.name=="ok-example-capital-agent-grok")]|length')" 0
check "remove deletes policy" "$(st '[.result.policies[][]|select(.name=="Agent pass: grok")]|length')" 0
check "remove deletes header file" "$(test -e "$WORK/ok/secrets/agent-pass-grok.env" && echo present || echo gone)" gone

echo "== api-bypass on its own (add a route, re-run, then roll back)"
bash "$CF" api-bypass --config "$WORK/client.conf" | sed 's/^/    /'
check "re-running api-bypass does not duplicate the app" "$(st '[.result.apps[]|select(.name=="Operation Kit API (key auth)")]|length')" 1
cp "$HERE/../api-bypass-paths.conf" "$WORK/paths.conf"; echo 'exact /api/my-bot-route' >> "$WORK/paths.conf"
OK_API_BYPASS_CONF=$WORK/paths.conf bash "$CF" api-bypass --config "$WORK/client.conf" >/dev/null
check "a new route is picked up in place" "$(st '[.result.apps[]|select(.name=="Operation Kit API (key auth)")][0].destinations|map(.uri)|map(select(endswith("/api/my-bot-route")))|length')" 1
cp "$HERE/../api-bypass-paths.conf" "$WORK/paths.conf"; echo 'prefix /api/internal' >> "$WORK/paths.conf"
if OK_API_BYPASS_CONF=$WORK/paths.conf bash "$CF" api-bypass --config "$WORK/client.conf" > "$WORK/out" 2>&1; then check "refuses to bypass /api/internal" ran-ok refused
else check "refuses to bypass /api/internal" "$(grep -c 'must stay behind the Cloudflare sign-in' "$WORK/out")" 1; fi
check "the refused route never reached Cloudflare" "$(st '[.result.apps[]|select(.name=="Operation Kit API (key auth)")][0].destinations|map(.uri)|map(select(contains("/api/internal")))|length')" 0
bash "$CF" api-bypass remove --config "$WORK/client.conf" | sed 's/^/    /'
check "rollback removes the app" "$(st '[.result.apps[]|select(.name=="Operation Kit API (key auth)")]|length')" 0
check "rollback leaves the host-wide app alone" "$(st '[.result.apps[]|.domain]')" '["ops.example-capital.com"]'
bash "$CF" up --config "$WORK/client.conf" >/dev/null
check "up puts it back" "$(st '[.result.apps[]|select(.name=="Operation Kit API (key auth)")]|length')" 1

echo "== API_KEY_AUTH_BYPASS=off skips the step and says so"
bash "$CF" api-bypass remove --config "$WORK/client.conf" >/dev/null
sed -i 's/^API_KEY_AUTH_BYPASS=.*/API_KEY_AUTH_BYPASS="off"/' "$WORK/client.conf"
bash "$CF" up --config "$WORK/client.conf" > "$WORK/out" 2>&1
check "off is honoured" "$(st '[.result.apps[]|select(.name=="Operation Kit API (key auth)")]|length')" 0
check "off warns that bots will hit the sign-in page" "$(grep -c 'will get the Cloudflare sign-in page' "$WORK/out")" 1
sed -i 's/^API_KEY_AUTH_BYPASS=.*/API_KEY_AUTH_BYPASS="on"/' "$WORK/client.conf"
bash "$CF" up --config "$WORK/client.conf" >/dev/null

echo "== status"; bash "$CF" status --config "$WORK/client.conf" | sed 's/^/    /'
check "status reports the API bypass app" "$(bash "$CF" status --config "$WORK/client.conf" | grep -c 'API bypass app .*present (29 paths, key auth)')" 1

echo "== foreign record is never overwritten"
curl -fs -X POST -H 'Authorization: Bearer mock-token' -H 'content-type: application/json' \
  --data '{"type":"A","name":"other.example-capital.com","content":"203.0.113.9"}' "$CF_API_BASE/zones/zone1/dns_records" >/dev/null
sed -i 's#^DOMAIN=.*#DOMAIN="other.example-capital.com"#' "$WORK/client.conf"
if bash "$CF" up --config "$WORK/client.conf" > "$WORK/out" 2>&1; then check "refuses to replace an A record" ran-ok refused
else check "refuses to replace an A record" "$(grep -c 'already has a A record' "$WORK/out")" 1; fi
sed -i 's#^DOMAIN=.*#DOMAIN="ops.example-capital.com"#' "$WORK/client.conf"

echo "== down"; bash "$CF" down --config "$WORK/client.conf" | sed 's/^/    /'
check "tunnel deleted" "$(st '[.result.tunnels[]|select(.deleted|not)]|length')" 0
check "only the foreign dns record left" "$(st '[.result.dns[].name]')" '["other.example-capital.com"]'
check "both apps deleted" "$(st '.result.apps|length')" 0
check "service tokens deleted (verify + agent passes)" "$(st '.result.svc|length')" 0
check "agent pass header file deleted" "$(test -e "$WORK/ok/secrets/agent-pass-claude-code.env" && echo present || echo gone)" gone
check "login method kept (shared)" "$(st '.result.idps|length')" 1
check "down also removes the browser-integrity exception" "$(st '[.result.rulesets[]|select(.phase=="http_config_settings")][0].rules|map(select(.description=="Operation Kit: API key auth (no browser integrity check)"))|length // 0')" 0
check "one login switched off after down" "$(grep -c '^OK_CF_ACCESS_AUD=.\+' "$WORK/ok/secrets/stack.env" || true)" 0

echo "== zero trust not enabled -> plain-language stop"
kill $MOCK; wait $MOCK 2>/dev/null || true
MOCK_NO_ORG=1 PORT=$PORT node "$HERE/cloudflare-mock.mjs" > "$WORK/mock.log" 2>&1 & MOCK=$!
for _ in $(seq 50); do curl -fs "http://127.0.0.1:$PORT/__state" >/dev/null 2>&1 && break; sleep 0.1; done
bash "$CF" up --config "$WORK/client.conf" > "$WORK/out" 2>&1 || true
check "tells the person to switch on Zero Trust" "$(grep -c 'Zero Trust is not switched on' "$WORK/out")" 1

echo "== token without the Access Organizations permission -> names the missing permission"
kill $MOCK; wait $MOCK 2>/dev/null || true
MOCK_NO_ORG_SCOPE=1 PORT=$PORT node "$HERE/cloudflare-mock.mjs" > "$WORK/mock.log" 2>&1 & MOCK=$!
for _ in $(seq 50); do curl -fs "http://127.0.0.1:$PORT/__state" >/dev/null 2>&1 && break; sleep 0.1; done
bash "$CF" up --config "$WORK/client.conf" > "$WORK/out" 2>&1 || true
check "names the missing Organizations permission" "$(grep -c 'Access: Organizations, Identity Providers, and Groups' "$WORK/out")" 1
check "does not blame Zero Trust" "$(grep -c 'Zero Trust is not switched on' "$WORK/out" || true)" 0


# ── obj 900069: a path a DIFFERENT Access app already owns ───────────────────
# The shape seen on a real client install: a separate MCP bypass app already owns /api/mcp on this
# hostname. Cloudflare answers 12132 ("belongs to another application"), which
# used to stop the whole Cloudflare step and with it update.sh. The mock
# enforces that duplicate-destination rule, so these checks fail without the fix.
echo "== a path another Access app already owns (obj 900069)"
kill $MOCK; wait $MOCK 2>/dev/null || true
PORT=$PORT node "$HERE/cloudflare-mock.mjs" > "$WORK/mock.log" 2>&1 & MOCK=$!
for _ in $(seq 50); do curl -fs "http://127.0.0.1:$PORT/__state" >/dev/null 2>&1 && break; sleep 0.1; done
cfapi() { curl -s -X "$1" -H 'Authorization: Bearer mock-token' -H 'content-type: application/json' ${3:+--data "$3"} "$CF_API_BASE$2"; }
FOREIGN=$(cfapi POST /accounts/acct1/access/apps \
  '{"name":"MCP bypass (pre-existing)","type":"self_hosted","domain":"ops.example-capital.com/api/mcp","destinations":[{"type":"public","uri":"ops.example-capital.com/api/mcp"},{"type":"public","uri":"ops.example-capital.com/api/mcp/*"}]}' | jq -r .result.id)
FPOL=$(cfapi POST "/accounts/acct1/access/apps/$FOREIGN/policies" \
  '{"name":"Bypass everyone","decision":"bypass","include":[{"everyone":{}}]}' | jq -r .result.id)
if bash "$CF" up --config "$WORK/client.conf" > "$WORK/out" 2>&1; then check "up completes despite the clash" ok ok
else check "up completes despite the clash" "failed: $(tail -2 "$WORK/out" | tr '\n' ' ')" ok; fi
OURS='[.result.apps[]|select(.name=="Operation Kit API (key auth)")]'
check "our app skips the two owned paths (29 - 2)" "$(st "$OURS|.[0].destinations|length")" 27
check "our app does not claim /api/mcp" "$(st "$OURS|.[0].destinations|map(.uri)|map(select(contains(\"/api/mcp\")))|length")" 0
check "it still claims the rest of the list" "$(st "$OURS|.[0].destinations|map(.uri)|map(select(endswith(\"/api/objectives\")))|length")" 1
check "the skip names both paths and the other app" "$(grep -c "is already a destination of the Access app 'MCP bypass (pre-existing)'" "$WORK/out")" 2
check "the other app is not touched" "$(st "[.result.apps[]|select(.id==\"$FOREIGN\")][0]|[.name,(.destinations|length)]")" '["MCP bypass (pre-existing)",2]'
check "the other app keeps its policy" "$(st "[.result.policies[\"$FOREIGN\"][]?]|length")" 1

echo "== the same path owned by an app that is NOT a bypass app -> refuse, change nothing"
bash "$CF" api-bypass remove --config "$WORK/client.conf" >/dev/null
cfapi PUT "/accounts/acct1/access/apps/$FOREIGN/policies/$FPOL" \
  '{"name":"Allowed people","decision":"allow","include":[{"email":{"email":"someone@example-capital.com"}}]}' >/dev/null
if bash "$CF" api-bypass --config "$WORK/client.conf" > "$WORK/out" 2>&1; then check "refuses when the owner is not a bypass app" ran-ok refused
else check "refuses when the owner is not a bypass app" "$(grep -c 'has no Bypass policy' "$WORK/out")" 1; fi
check "the refusal names the owning app" "$(grep -c "MCP bypass (pre-existing)" "$WORK/out")" 1
check "nothing was created on refusal" "$(st "$OURS|length")" 0
check "the other app is still untouched" "$(st "[.result.apps[]|select(.id==\"$FOREIGN\")][0].destinations|length")" 2

echo "== a renamed Bypass/Everyone policy is reused, not duplicated"
cfapi PUT "/accounts/acct1/access/apps/$FOREIGN/policies/$FPOL" \
  '{"name":"Bypass everyone","decision":"bypass","include":[{"everyone":{}}]}' >/dev/null
bash "$CF" api-bypass --config "$WORK/client.conf" >/dev/null 2>&1
OURS_ID=$(st "$OURS|.[0].id" | tr -d '"')
OURS_POL=$(st "[.result.policies[\"$OURS_ID\"][]]|.[0].id" | tr -d '"')
cfapi PUT "/accounts/acct1/access/apps/$OURS_ID/policies/$OURS_POL" \
  '{"name":"Renamed in the dashboard","decision":"bypass","include":[{"everyone":{}}],"precedence":1}' >/dev/null
bash "$CF" api-bypass --config "$WORK/client.conf" >/dev/null 2>&1
check "still exactly one policy on our app" "$(st "[.result.policies[\"$OURS_ID\"][]]|length")" 1
check "and it is still Bypass/Everyone" "$(st "[.result.policies[\"$OURS_ID\"][]|[.decision,(.include[0]|keys[0])]]")" '[["bypass","everyone"]]'

# ── obj 900259: the narrow Browser Integrity Check exception ─────────────────
# Cloudflare Access stepping aside (step 8 above) is not enough on its own:
# Browser Integrity Check refuses a non-browser caller for its own reasons and
# answers error 1010. `api-bic` adds ONE Configuration Rule to fix exactly that.
# These checks hold it to "one rule, one setting, one hostname, one path prefix,
# and nothing of the client's is read, moved or rewritten".
echo "== browser-integrity exception: scope, idempotency, other rules, rollback (obj 900259)"
kill $MOCK; wait $MOCK 2>/dev/null || true
PORT=$PORT node "$HERE/cloudflare-mock.mjs" > "$WORK/mock.log" 2>&1 & MOCK=$!
for _ in $(seq 50); do curl -fs "http://127.0.0.1:$PORT/__state" >/dev/null 2>&1 && break; sleep 0.1; done
rawst() { curl -fs "http://127.0.0.1:$PORT/__state" | jq -r "$1"; }
BIC_DESC='Operation Kit: API key auth for ops.example-capital.com/api/ (no browser integrity check)'
PHASE='[.result.rulesets[]|select(.phase=="http_config_settings")][0]'
# "ours" is matched the way a reader would check it: a rule that switches the
# browser integrity check off for THIS install's hostname.
MINE="$PHASE|.rules|map(select(.description==\"$BIC_DESC\"))"
ANY_OURS="$PHASE|.rules|map(select((.description // \"\")|startswith(\"Operation Kit: API key auth for\")))"
WANT_EXPR='(http.host eq "ops.example-capital.com" and starts_with(http.request.uri.path, "/api/"))'

# The client already runs a Configuration Rule of their own, on another
# hostname in the same zone. It must come out of all of this byte-identical.
cfapi() { curl -s -X "$1" -H 'Authorization: Bearer mock-token' -H 'content-type: application/json' ${3:+--data "$3"} "$CF_API_BASE$2"; }
cfapi PUT /zones/zone1/rulesets/phases/http_config_settings/entrypoint \
  '{"name":"Client configuration rules","rules":[{"action":"set_config","action_parameters":{"ssl":"strict","rocket_loader":true},"expression":"(http.host eq \"shop.example-capital.com\")","description":"client: strict SSL on the shop"}]}' >/dev/null
CLIENT_RULE=$(st "$PHASE|.rules[0]")

bash "$CF" api-bic --config "$WORK/client.conf" > "$WORK/out" 2>&1 || true
sed 's/^/    /' "$WORK/out"
check "no second phase ruleset is created" "$(st '.result.rulesets|length')" 1
check "exactly one rule of ours" "$(st "$MINE|length")" 1
check "its action is set_config" "$(rawst "$MINE|.[0].action")" set_config
check "its ONLY action parameter is bic:false" "$(st "$MINE|.[0].action_parameters")" '{"bic":false}'
check "it matches this install's host and /api/ only" "$(rawst "$MINE|.[0].expression")" "$WANT_EXPR"
check "it is enabled" "$(rawst "$MINE|.[0].enabled")" true
check "the client's own rule is untouched" "$(st "$PHASE|.rules[0]")" "$CLIENT_RULE"
check "the phase holds exactly two rules" "$(st "$PHASE|.rules|length")" 2
check "nothing changed the zone-wide browser integrity setting" "$(rawst '[.result.calls[]|select(test("/settings"))]|length')" 0
check "a before-state snapshot was written" "$([ "$(find "$WORK/ok/backups" -name 'cloudflare-bic-*-before-up.json' | wc -l)" -ge 1 ] && echo yes || echo no)" yes
check "the snapshot is mode 600" "$(stat -c %a "$(find "$WORK/ok/backups" -name 'cloudflare-bic-*-before-up.json' | head -1)")" 600

echo "== re-running it is a no-op"
MINE_ID=$(rawst "$MINE|.[0].id")
bash "$CF" api-bic --config "$WORK/client.conf" > "$WORK/out" 2>&1
check "says it is already right" "$(grep -c 'already exactly right' "$WORK/out")" 1
check "still exactly one rule of ours" "$(st "$MINE|length")" 1
check "same rule, not a replacement" "$(rawst "$MINE|.[0].id")" "$MINE_ID"
check "no mutating call was made on the re-run" "$(grep -cE 'PATCH|POST|PUT' <<<"$(rawst '.result.calls[-3:][]')" || true)" 0
check "the client's rule is still untouched" "$(st "$PHASE|.rules[0]")" "$CLIENT_RULE"

echo "== a rule edited in the dashboard is corrected in place, never duplicated"
RSID=$(rawst "$PHASE|.id")
# (a) somebody widened the settings and the path in the dashboard, keeping the name
cfapi PATCH "/zones/zone1/rulesets/$RSID/rules/$MINE_ID" \
  "$(jq -nc --arg d "$BIC_DESC" '{action:"set_config", action_parameters:{bic:false, security_level:"under_attack"}, expression:"(http.host eq \"ops.example-capital.com\")", description:$d}')" >/dev/null
bash "$CF" api-bic --config "$WORK/client.conf" > "$WORK/out" 2>&1
check "corrected in place" "$(grep -c 'corrected in place' "$WORK/out")" 1
check "still exactly one rule of ours" "$(st "$MINE|length")" 1
check "the stray extra setting is gone" "$(st "$MINE|.[0].action_parameters")" '{"bic":false}'
check "the widened expression is narrowed back" "$(rawst "$MINE|.[0].expression")" "$WANT_EXPR"
check "the client's rule is STILL untouched" "$(st "$PHASE|.rules[0]")" "$CLIENT_RULE"
# (b) somebody RENAMED it in the dashboard: it is still recognised by shape
#     (set_config, bic-only, about this hostname) and corrected, not duplicated
cfapi PATCH "/zones/zone1/rulesets/$RSID/rules/$MINE_ID" \
  '{"action":"set_config","action_parameters":{"bic":false},"expression":"(http.host eq \"ops.example-capital.com\" and starts_with(http.request.uri.path, \"/\"))","description":"renamed in the dashboard"}' >/dev/null
bash "$CF" api-bic --config "$WORK/client.conf" > "$WORK/out" 2>&1
check "a renamed rule is reused, not duplicated" "$(st "$PHASE|.rules|length")" 2
check "its name and scope are restored" "$(rawst "$MINE|.[0].expression")" "$WANT_EXPR"
check "the client's rule is STILL untouched after the rename" "$(st "$PHASE|.rules[0]")" "$CLIENT_RULE"

echo "== the hostname comes from the config, never from the code"
sed -i 's#^DOMAIN=.*#DOMAIN="board.example-capital.com"#' "$WORK/client.conf"
bash "$CF" api-bic --config "$WORK/client.conf" >/dev/null 2>&1
check "a second install in the same zone gets its own rule" "$(st "$ANY_OURS|length")" 2
check "and that rule names ITS hostname, not the first one's" \
  "$(rawst "$ANY_OURS|map(select(.expression|contains(\"board.\")))|.[0].expression")" \
  '(http.host eq "board.example-capital.com" and starts_with(http.request.uri.path, "/api/"))'
bash "$CF" api-bic remove --config "$WORK/client.conf" >/dev/null 2>&1
sed -i 's#^DOMAIN=.*#DOMAIN="ops.example-capital.com"#' "$WORK/client.conf"
check "removing one install's rule leaves the other install's rule" "$(st "$MINE|length")" 1
check "and removes only that one" "$(st "$ANY_OURS|length")" 1

echo "== dry-run changes nothing"
bash "$CF" api-bic remove --config "$WORK/client.conf" >/dev/null 2>&1
check "removed for the dry-run check" "$(st "$MINE|length")" 0
bash "$CF" api-bic --config "$WORK/client.conf" --dry-run > "$WORK/out" 2>&1
check "dry-run prints the exact expression it would add" "$(grep -c "starts_with(http.request.uri.path, \"/api/\")" "$WORK/out")" 1
check "dry-run prints the one setting it would set" "$(grep -c '{"bic": false}' "$WORK/out")" 1
check "dry-run added nothing" "$(st "$MINE|length")" 0
check "dry-run left the client's rule alone" "$(st "$PHASE|.rules|length")" 1

echo "== rollback removes our rule and only our rule"
bash "$CF" api-bic --config "$WORK/client.conf" >/dev/null 2>&1
check "back in place" "$(st "$MINE|length")" 1
bash "$CF" api-bic remove --config "$WORK/client.conf" > "$WORK/out" 2>&1
sed 's/^/    /' "$WORK/out"
check "our rule is gone" "$(st "$MINE|length")" 0
check "the phase ruleset itself is NOT deleted" "$(st '.result.rulesets|length')" 1
check "the client's rule survives the rollback" "$(st "$PHASE|.rules[0]")" "$CLIENT_RULE"
check "removing twice is harmless" "$(bash "$CF" api-bic remove --config "$WORK/client.conf" 2>&1 | grep -c 'exception: none')" 1
check "a before-state snapshot was written for the removal" "$([ "$(find "$WORK/ok/backups" -name 'cloudflare-bic-*-before-remove.json' | wc -l)" -ge 1 ] && echo yes || echo no)" yes

echo "== API_BROWSER_INTEGRITY_EXCEPTION=off skips the step and says so"
sed -i 's/^API_BROWSER_INTEGRITY_EXCEPTION=.*/API_BROWSER_INTEGRITY_EXCEPTION="off"/' "$WORK/client.conf"
bash "$CF" up --config "$WORK/client.conf" > "$WORK/out" 2>&1
check "off is honoured" "$(st "$MINE|length")" 0
check "off warns about error 1010" "$(grep -c 'Cloudflare error 1010' "$WORK/out")" 1
sed -i 's/^API_BROWSER_INTEGRITY_EXCEPTION=.*/API_BROWSER_INTEGRITY_EXCEPTION="on"/' "$WORK/client.conf"
if sed -i 's/^API_BROWSER_INTEGRITY_EXCEPTION=.*/API_BROWSER_INTEGRITY_EXCEPTION="maybe"/' "$WORK/client.conf" \
   && bash "$CF" api-bic --config "$WORK/client.conf" >/dev/null 2>&1; then check "a typo in the switch is refused" accepted refused
else check "a typo in the switch is refused" refused refused; fi
sed -i 's/^API_BROWSER_INTEGRITY_EXCEPTION=.*/API_BROWSER_INTEGRITY_EXCEPTION="on"/' "$WORK/client.conf"

echo "== a token without Config Rules permission names the permission, and changes nothing"
kill $MOCK; wait $MOCK 2>/dev/null || true
MOCK_NO_CONFIG_RULES_PERM=1 PORT=$PORT node "$HERE/cloudflare-mock.mjs" > "$WORK/mock.log" 2>&1 & MOCK=$!
for _ in $(seq 50); do curl -fs "http://127.0.0.1:$PORT/__state" >/dev/null 2>&1 && break; sleep 0.1; done
if bash "$CF" api-bic --config "$WORK/client.conf" > "$WORK/out" 2>&1; then check "a refused token stops the step" ran-ok refused
else check "a refused token stops the step" refused refused; fi
check "it names the exact permission to add" "$(grep -c 'Config Rules' "$WORK/out")" 1
check "it says nothing was changed" "$(grep -c 'Nothing was changed' "$WORK/out")" 1
check "it does not claim success" "$(grep -c 'done: Browser Integrity Check no longer applies' "$WORK/out" || true)" 0
check "nothing reached Cloudflare" "$(st '.result.rulesets|length')" 0

echo "== a zone with no room for another Configuration Rule says so"
kill $MOCK; wait $MOCK 2>/dev/null || true
MOCK_CONFIG_RULES_PLAN_LIMIT=1 PORT=$PORT node "$HERE/cloudflare-mock.mjs" > "$WORK/mock.log" 2>&1 & MOCK=$!
for _ in $(seq 50); do curl -fs "http://127.0.0.1:$PORT/__state" >/dev/null 2>&1 && break; sleep 0.1; done
cfapi PUT /zones/zone1/rulesets/phases/http_config_settings/entrypoint \
  '{"name":"Client configuration rules","rules":[{"action":"set_config","action_parameters":{"ssl":"strict"},"expression":"(http.host eq \"shop.example-capital.com\")","description":"client: strict SSL on the shop"}]}' >/dev/null
if bash "$CF" api-bic --config "$WORK/client.conf" > "$WORK/out" 2>&1; then check "a full zone stops the step" ran-ok refused
else check "a full zone stops the step" refused refused; fi
check "it explains the plan limit and the way out" "$(grep -c 'Configuration Rule (plan limit' "$WORK/out")" 1
check "it offers the off switch" "$(grep -c 'API_BROWSER_INTEGRITY_EXCEPTION' "$WORK/out")" 1
check "the client's rule survived the failure" "$(st "$PHASE|.rules|length")" 1

echo "== a zone with no Configuration Rules at all, where the entry-point PUT is refused"
kill $MOCK; wait $MOCK 2>/dev/null || true
MOCK_NO_PUT_ENTRYPOINT=1 PORT=$PORT node "$HERE/cloudflare-mock.mjs" > "$WORK/mock.log" 2>&1 & MOCK=$!
for _ in $(seq 50); do curl -fs "http://127.0.0.1:$PORT/__state" >/dev/null 2>&1 && break; sleep 0.1; done
bash "$CF" api-bic --config "$WORK/client.conf" > "$WORK/out" 2>&1 || true
check "it still gets created (explicit-create fallback)" "$(st "$MINE|length")" 1
check "in the right phase" "$(rawst "$PHASE|.phase")" http_config_settings
check "with the one setting" "$(st "$MINE|.[0].action_parameters")" '{"bic":false}'
check "and it did not report success before trying the fallback" "$(grep -c 'Nothing was changed' "$WORK/out" || true)" 0

echo; [ "$fails" -eq 0 ] && echo "cloudflare mock test: ALL PASS" || { echo "cloudflare mock test: $fails FAIL"; exit 1; }
