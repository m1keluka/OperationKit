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
check "one Access app on the domain" "$(st '[.result.apps[]|.domain]')" '["ops.example-capital.com"]'
check "one-time PIN login method" "$(st '[.result.idps[].type]')" '["onetimepin"]'
check "app admits only the one-time PIN, auto-redirect, 24h session" "$(st '.result.apps[0]|[(.allowed_idps|length), .auto_redirect_to_identity, .session_duration]')" '[1,true,"24h"]'
check "allowed-people policy" "$(st '[.result.policies[][]|select(.name=="Allowed people")|.include[0].email.email]')" '["alex.partner@example-capital.com"]'
check "verify robot policy" "$(st '[.result.policies[][]|select(.name=="Install verify robot")|.decision]')" '["non_identity"]'
check "secrets stored by name" "$(cut -d= -f1 "$WORK/ok/secrets/stack.env" | sort | tr '\n' ' ')" "OK_CF_ACCESS_AUD OK_CF_ACCESS_TEAM OK_VERIFY_CF_CLIENT_ID OK_VERIFY_CF_CLIENT_SECRET TUNNEL_TOKEN "
check "one login: team domain stored" "$(grep '^OK_CF_ACCESS_TEAM=' "$WORK/ok/secrets/stack.env" | cut -d= -f2)" example-capital.cloudflareaccess.com
check "one login: the app's AUD tag stored" "$(grep '^OK_CF_ACCESS_AUD=' "$WORK/ok/secrets/stack.env" | cut -d= -f2)" "$(st '.result.apps[0].aud' | tr -d '"')"
check "stack.env is mode 600" "$(stat -c %a "$WORK/ok/secrets/stack.env")" 600
check "no secret value printed" "$(bash "$CF" status --config "$WORK/client.conf" | grep -c 'mock-svc-secret\|mock-tunnel-token\|mock-token' || true)" 0

echo "== up #2 (re-run must reuse everything)"; bash "$CF" up --config "$WORK/client.conf" | sed 's/^/    /'
check "still one tunnel" "$(st '[.result.tunnels[]|select(.deleted|not)]|length')" 1
check "still one dns record" "$(st '.result.dns|length')" 1
check "still one app" "$(st '.result.apps|length')" 1
check "still two policies" "$(st '[.result.policies[][]]|length')" 2
check "still one service token" "$(st '.result.svc|length')" 1
check "AUD unchanged on re-run" "$(grep '^OK_CF_ACCESS_AUD=' "$WORK/ok/secrets/stack.env" | cut -d= -f2)" "$(st '.result.apps[0].aud' | tr -d '"')"

echo "== agent-pass add (an outside AI tool gets its own door key)"
bash "$CF" agent-pass add claude-code --config "$WORK/client.conf" > "$WORK/out"; sed 's/^/    /' "$WORK/out"
check "pass service token named per tool" "$(st '[.result.svc[].name|select(startswith("ok-example-capital-agent-"))]')" '["ok-example-capital-agent-claude-code"]'
check "pass policy admits only that token" "$(st '[.result.policies[][]|select(.name=="Agent pass: claude-code")|.decision]')" '["non_identity"]'
check "pass policy precedence is unique" "$(st '[.result.policies[][]|.precedence]|(length==(unique|length))')" true
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

echo "== status"; bash "$CF" status --config "$WORK/client.conf" | sed 's/^/    /'

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
check "app deleted" "$(st '.result.apps|length')" 0
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

echo; [ "$fails" -eq 0 ] && echo "cloudflare mock test: ALL PASS" || { echo "cloudflare mock test: $fails FAIL"; exit 1; }
