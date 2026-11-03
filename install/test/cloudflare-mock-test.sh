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

echo; [ "$fails" -eq 0 ] && echo "cloudflare mock test: ALL PASS" || { echo "cloudflare mock test: $fails FAIL"; exit 1; }
