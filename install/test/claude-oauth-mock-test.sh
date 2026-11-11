#!/usr/bin/env bash
# Exercise install/claude-oauth.sh (the installer's "Sign in with Claude") against
# install/test/claude-oauth-mock.mjs: link shape, PKCE, the token exchange, and
# the refusals — state mismatch, expired link, bad code, API-key reply.
# No root, no network, no real Claude account.  bash install/test/claude-oauth-mock-test.sh
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
WORK=$(mktemp -d); trap 'kill $MOCK 2>/dev/null || true; rm -rf "$WORK"' EXIT
PORT=$((20000 + RANDOM % 20000))
PORT=$PORT node "$HERE/claude-oauth-mock.mjs" > "$WORK/mock.log" 2>&1 & MOCK=$!
for _ in $(seq 50); do curl -fs "http://127.0.0.1:$PORT/__last" >/dev/null 2>&1 && break; sleep 0.1; done
export CLAUDE_OAUTH_TOKEN_URL=http://127.0.0.1:$PORT/v1/oauth/token
# shellcheck source=install/claude-oauth.sh
source "$HERE/../claude-oauth.sh"
fails=0; check() { if [ "$2" = "$3" ]; then echo "  PASS  $1"; else echo "  FAIL  $1 (got $2, want $3)"; fails=$((fails+1)); fi; }
param() { jq -rn --arg u "$1" --arg k "$2" '$u|split("?")[1]|split("&")|map(split("="))|map(select(.[0]==$k))|.[0][1]'; }
last() { curl -fs "http://127.0.0.1:$PORT/__last" | jq -r "$1"; }
fresh() { rm -rf "$WORK/l"; mkdir -m 700 "$WORK/l"; URL=$(claude_oauth_begin "$WORK/l"); STATE=$(param "$URL" state); export STATE; }

echo "== link"
fresh
check "claude.ai authorize endpoint" "${URL%%\?*}" "https://claude.com/cai/oauth/authorize"
check "Claude Code client id" "$(param "$URL" client_id)" "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
check "manual-code redirect" "$(param "$URL" redirect_uri)" "https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback"
check "inference-only scope (setup-token)" "$(param "$URL" scope)" "user%3Ainference"
check "S256 PKCE" "$(param "$URL" code_challenge_method)" "S256"
check "verifier + state files are private" "$(stat -c %a "$WORK/l/verifier") $(stat -c %a "$WORK/l/state")" "600 600"
check "verifier is not in the link" "$(grep -c "$(cat "$WORK/l/verifier")" <<<"$URL" || true)" 0

echo "== good code"
TOKEN=$(claude_oauth_exchange "$WORK/l" "good#$STATE")
check "prints the subscription token" "$TOKEN" "sk-ant-oat01-fake-mock-token-0000"
check "sent grant + code + state + 1y expiry" "$(last '[.grant_type,.code,(.state==env.STATE|tostring),.expires_in]|join(" ")' )" "authorization_code good true 31536000"
SENT_V=$(last .code_verifier)
check "verifier matches the link's challenge" "$(printf '%s' "$SENT_V" | openssl dgst -sha256 -binary | _claude_b64url)" "$(param "$URL" code_challenge)"
check "verifier dropped after success" "$([ -e "$WORK/l/verifier" ] && echo kept || echo gone)" gone

echo "== refusals"
fresh; rc=0; claude_oauth_exchange "$WORK/l" "good#someone-elses-state" >/dev/null || rc=$?
check "state mismatch → 2" "$rc" 2
fresh; echo $(( $(date +%s) - 601 )) > "$WORK/l/started"; rc=0; claude_oauth_exchange "$WORK/l" "good#$STATE" >/dev/null || rc=$?
check "expired link → 3" "$rc" 3
fresh; rc=0; claude_oauth_exchange "$WORK/l" "typo#$STATE" >/dev/null || rc=$?
check "bad code → 4" "$rc" 4
rc=0; out=$(claude_oauth_exchange "$WORK/l" "apikey#$STATE") || rc=$?
check "API key reply refused → 5" "$rc" 5
check "API key never printed" "$out" ""
rc=0; claude_oauth_exchange "$WORK/l" "   " >/dev/null || rc=$?
check "empty paste → 7" "$rc" 7
CLAUDE_OAUTH_TOKEN_URL=http://127.0.0.1:1/nope; rc=0; claude_oauth_exchange "$WORK/l" "good#$STATE" >/dev/null || rc=$?
check "unreachable → 6" "$rc" 6

[ "$fails" -eq 0 ] && echo "ALL PASS" || { echo "$fails FAILED"; exit 1; }
