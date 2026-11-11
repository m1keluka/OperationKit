#!/usr/bin/env bash
# Prove the Cloudflare key-auth bypass list is what we think it is, and that the
# guard in install/api-bypass-lib.sh refuses an operator route even if someone
# adds one by mistake.  bash install/test/api-bypass-paths-test.sh
# No root, no network, no Cloudflare account.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
LIB=$HERE/..
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT

fails=0
check() { if [ "$2" = "$3" ]; then echo "  PASS  $1"; else echo "  FAIL  $1 (got '$2', want '$3')"; fails=$((fails+1)); fi; }

# paths CONF — the expanded path list for CONF (empty output + stderr on refusal).
paths() { OK_API_BYPASS_CONF=$1 bash -c 'set -euo pipefail; source "$0/lib.sh"; source "$0/api-bypass-lib.sh"; ok_api_bypass_paths' "$LIB" 2>"$WORK/err"; }
# refused CONF REASON — the list must be rejected, and the message must say why.
refused() {
  local conf=$1 want=$2 out
  out=$(paths "$conf")
  if [ -n "$out" ]; then check "refuses $want" "accepted: $out" refused; return; fi
  if grep -q "$want" "$WORK/err"; then check "refuses $want" refused refused
  else check "refuses $want" "wrong message: $(tr '\n' ' ' < "$WORK/err")" "message naming $want"; fi
}
w() { printf '%s\n' "$@" > "$WORK/c.conf"; printf '%s' "$WORK/c.conf"; }

echo "== the shipped list"
SHIPPED=$(paths "$LIB/api-bypass-paths.conf")
check "the shipped list parses" "$([ -n "$SHIPPED" ] && echo ok || cat "$WORK/err")" ok
check "29 paths (13 routes x2, plus 3 single addresses)" "$(wc -l <<<"$SHIPPED")" 29
check "every path is under /api/" "$(grep -vc '^/api/' <<<"$SHIPPED")" 0
for p in /api/objectives /api/objectives/\* /api/mcp /api/mcp/\* /api/agent /api/agents \
         /api/agent-chat/agents /api/briefing /api/docs /api/kb-wiki /api/files \
         /api/workspaces /api/models /api/projects /api/feed \
         /api/health /api/openapi.json /api/auth/me; do
  check "covers $p" "$(grep -cxF "$p" <<<"$SHIPPED")" 1
done
# The whole point: the operator surface is NOT in the list.
for p in /api/internal /api/admin /api/secrets /api/secret-upload /api/webhooks \
         /api/public /api/llm /api/alerts /api/costs /api/intel /api/status; do
  check "never bypasses $p" "$(grep -c "^$p" <<<"$SHIPPED")" 0
done
check "no bare /api or /api/*" "$(grep -cxE '/api|/api/\*' <<<"$SHIPPED")" 0
check "/api/auth is bypassed only at the exact /api/auth/me" "$(grep -c '^/api/auth' <<<"$SHIPPED")" 1

echo "== the guard refuses what must stay behind Access"
refused "$(w 'prefix /api/internal')"        /api/internal
refused "$(w 'exact /api/internal/deploy')"  /api/internal
refused "$(w 'prefix /api/admin')"           /api/admin
refused "$(w 'prefix /api/secrets')"         /api/secrets
refused "$(w 'exact /api/secret-upload')"    /api/secret-upload
refused "$(w 'prefix /api/webhooks')"        /api/webhooks
refused "$(w 'prefix /api/auth')"            /api/auth
refused "$(w 'exact /api/auth/token')"       /api/auth
refused "$(w 'prefix /api/auth/me')"         /api/auth
refused "$(w 'prefix /api/public')"          /api/public
refused "$(w 'exact /api/llm/v1/messages')"  /api/llm
refused "$(w 'prefix /api/alerts')"          /api/alerts
refused "$(w 'prefix /api/costs')"           /api/costs
refused "$(w 'prefix /api/intel')"           /api/intel
refused "$(w 'prefix /api/status')"          /api/status
# A denied route hidden among good ones still stops the whole step.
refused "$(w 'prefix /api/objectives' 'prefix /api/internal' 'exact /api/health')" /api/internal

echo "== the guard refuses a blanket or malformed entry"
refused "$(w 'prefix /api')"            'not a plain path'
refused "$(w 'prefix /api/*')"          'do not write a wildcard'
refused "$(w 'prefix /')"               'not a plain path'
refused "$(w 'prefix /health')"         'not a plain path'
refused "$(w 'prefix /api/../admin')"   'not a plain path'
refused "$(w 'allow /api/objectives')"  "not a mode"
refused "$(w 'prefix')"                 'has no path'
refused "$(w 'prefix /api/a /api/b')"   'one route per line'
refused "$(w 'prefix /api/docs' 'prefix /api/docs')" 'listed twice'
refused "$(w '# only comments')"        'no routes'

echo "== comments and spacing do not change the result"
check "comments/blank lines ignored" \
  "$(paths "$(w '# header' '' '  prefix   /api/objectives   # the board' '' 'exact /api/health')" | tr '\n' ' ')" \
  "/api/objectives /api/objectives/* /api/health "

echo "== telling Cloudflare apart from the app (what verify.sh keys off)"
# "<http code>|<redirect url>|<content type>"
cf_answered() { bash -c 'set -euo pipefail; source "$0/lib.sh"; source "$0/api-bypass-lib.sh"; if ok_api_bypass_at_cloudflare "$1"; then echo cloudflare; else echo app; fi' "$LIB" "$1"; }
check "sign-in redirect = Cloudflare"       "$(cf_answered '302|https://acme.cloudflareaccess.com/cdn-cgi/access/login/x|text/html')" cloudflare
check "bare 403 html = Cloudflare"          "$(cf_answered '403||text/html; charset=utf-8')"                                            cloudflare
check "bare 401 no body = Cloudflare"       "$(cf_answered '401||')"                                                                    cloudflare
check "unreachable is NOT read as Cloudflare" "$(cf_answered '000||')"                                                                  app
check "401 JSON = the app turned it away"   "$(cf_answered '401||application/json; charset=utf-8')"                                     app
check "200 JSON = the app answered"         "$(cf_answered '200||application/json')"                                                    app

echo "== paths another Access app already owns (obj 900069)"
# One Cloudflare `GET .../access/apps` body: the host-wide app, a separate MCP
# bypass app that already owns /api/mcp (the shape seen on a real client install), and our own app.
APPS='{"success":true,"result":[
  {"id":"host","name":"Operation Kit - Example","domain":"ops.example.com","destinations":[{"uri":"ops.example.com"}]},
  {"id":"mcp","name":"MCP bypass","destinations":[{"type":"public","uri":"ops.example.com/api/mcp"},{"type":"public","uri":"ops.example.com/api/mcp/*"}]},
  {"id":"self","name":"Operation Kit API (key auth)","destinations":[{"uri":"ops.example.com/api/objectives"},{"uri":"ops.example.com/api/mcp"}]},
  {"id":"other","name":"Someone else","destinations":[{"uri":"other.example.com/api/files"}]}
]}'
conflicts() { bash -c 'set -euo pipefail; source "$0/lib.sh"; source "$0/api-bypass-lib.sh"; ok_api_bypass_conflicts "$1" "$2" "$3" "$4"' \
  "$LIB" "$APPS" ops.example.com "Operation Kit API (key auth)" "$1"; }
WANT=$'/api/mcp\n/api/mcp/*\n/api/objectives\n/api/objectives/*\n/api/health'
check "names the owner of a clashing path" "$(conflicts "$WANT" | tr '\n' ';' | tr '\t' ' ')" '/api/mcp mcp MCP bypass;/api/mcp/* mcp MCP bypass;'
check "our own app is never a conflict" "$(conflicts "$WANT" | grep -c 'self' || true)" 0
check "the bare host-wide app is not a conflict" "$(conflicts "$WANT" | grep -c 'host' || true)" 0
check "another hostname is not a conflict" "$(conflicts '/api/files' | wc -l | tr -d ' ')" 0
check "a clash-free list yields nothing" "$(conflicts "$(printf '/api/health\n/api/feed')")" ''
check "paths are reported in list order" "$(conflicts "$(printf '/api/mcp/*\n/api/mcp')" | cut -f1 | tr '\n' ' ')" '/api/mcp/* /api/mcp '

# Whether the owning app is itself a bypass / key-auth app decides skip vs stop.
isbypass() { bash -c 'set -euo pipefail; source "$0/lib.sh"; source "$0/api-bypass-lib.sh"; if ok_api_bypass_policies_are_bypass "$1"; then echo bypass; else echo gated; fi' "$LIB" "$1"; }
check "a Bypass/Everyone app is a bypass app"   "$(isbypass '{"result":[{"decision":"bypass","include":[{"everyone":{}}]}]}')" bypass
check "bypass alongside allow still counts"     "$(isbypass '{"result":[{"decision":"allow"},{"decision":"bypass"}]}')"        bypass
check "an allow-only app is NOT a bypass app"   "$(isbypass '{"result":[{"decision":"allow"}]}')"                              gated
check "a service-token app is NOT a bypass app" "$(isbypass '{"result":[{"decision":"non_identity"}]}')"                       gated
check "an app with no policies is NOT a bypass app" "$(isbypass '{"result":[]}')"                                              gated
check "an unreadable policy list is NOT a bypass app" "$(isbypass 'not json')"                                                 gated

echo; [ "$fails" -eq 0 ] && echo "api-bypass paths test: ALL PASS" || { echo "api-bypass paths test: $fails FAIL"; exit 1; }
