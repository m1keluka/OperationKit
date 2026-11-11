#!/usr/bin/env bash
# Exercise install/claude-oauth.sh (the installer's "Sign in with Claude") against
# install/test/claude-oauth-mock.mjs: link shape, PKCE, the token exchange, what
# terminals do to a paste (code#state, CR, bracketed paste, URL form), the state
# rules, error-code mapping (only a real network failure says "could not reach"),
# single-use codes, and the prompt loop with its `claude setup-token` fallback.
# No root, no network, no real Claude account.  bash install/test/claude-oauth-mock-test.sh
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
WORK=$(mktemp -d); trap 'kill $MOCK 2>/dev/null || true; rm -rf "$WORK"' EXIT
PORT=$((20000 + RANDOM % 20000))
PORT=$PORT node "$HERE/claude-oauth-mock.mjs" > "$WORK/mock.log" 2>&1 & MOCK=$!
for _ in $(seq 50); do curl -fs "http://127.0.0.1:$PORT/__last" >/dev/null 2>&1 && break; sleep 0.1; done
MOCK_URL=http://127.0.0.1:$PORT/v1/oauth/token
export CLAUDE_OAUTH_TOKEN_URL=$MOCK_URL
# shellcheck source=install/claude-oauth.sh
source "$HERE/../claude-oauth.sh"
fails=0; check() { if [ "$2" = "$3" ]; then echo "  PASS  $1"; else echo "  FAIL  $1 (got $(printf '%q' "$2"), want $(printf '%q' "$3"))"; fails=$((fails+1)); fi; }
has() { if grep -qF -- "$3" <<<"$2"; then echo "  PASS  $1"; else echo "  FAIL  $1 (missing: $3)"; printf '%s\n' "$2" | sed 's/^/        | /'; fails=$((fails+1)); fi; }
hasnt() { if grep -qF -- "$3" <<<"$2"; then echo "  FAIL  $1 (should not contain: $3)"; fails=$((fails+1)); else echo "  PASS  $1"; fi; }
param() { jq -rn --arg u "$1" --arg k "$2" '$u|split("?")[1]|split("&")|map(split("="))|map(select(.[0]==$k))|.[0][1]'; }
last() { curl -fs "http://127.0.0.1:$PORT/__last" | jq -r "$1"; }
count() { curl -fs "http://127.0.0.1:$PORT/__count"; }
# A fresh link in DIR (default $WORK/l); the mock then accepts "good" only with ITS verifier.
fresh() {
  local d=${1:-$WORK/l}; rm -rf "$d"; mkdir -m 700 "$d"
  URL=$(claude_oauth_begin "$d"); STATE=$(param "$URL" state); export STATE
  curl -fs -X POST "http://127.0.0.1:$PORT/__expect" -d "{\"challenge\":\"$(param "$URL" code_challenge)\"}" >/dev/null
}
xrc() { rc=0; OUT=$(claude_oauth_exchange "$@") || rc=$?; }

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

echo "== what terminals do to a paste (each must still sign in)"
ESC=$'\033'
paste_ok() { fresh; xrc "$WORK/l" "$2"; check "$1" "$rc:$OUT" "0:sk-ant-oat01-fake-mock-token-0000"; check "$1: clean code sent" "$(last .code)" good; }
paste_ok "code#state (Claude's copy button)"            "good#$STATE"
paste_ok "trailing CR + LF (Windows / PowerShell)"      "good#$STATE"$'\r\n'
paste_ok "bracketed paste ESC[200~ … ESC[201~"          "${ESC}[200~good#$STATE${ESC}[201~"
paste_ok "bracketed paste with the ESC eaten ([200~)"   "[200~good#${STATE}[201~"
paste_ok "bracketed paste + CR (DO web console)"        "${ESC}[200~good#$STATE${ESC}[201~"$'\r'
paste_ok "spaces / tab / NBSP / zero-width space"       $' \tgood#​'"$STATE"$'  '
paste_ok "quoted"                                        "\"good#$STATE\""
paste_ok "URL-encoded # (%23)"                           "good%23$STATE"
paste_ok "the whole callback URL"                        "https://platform.claude.com/oauth/code/callback?code=good&state=$STATE"
paste_ok "bare code (no #state)"                         "good"
check "clean: bracketed + CR → exact" "$(claude_paste_clean "${ESC}[200~abc#def${ESC}[201~"$'\r')" "abc#def"
check "clean: setup token survives" "$(claude_paste_clean "${ESC}[200~sk-ant-oat01-AbC_d-9${ESC}[201~"$'\r\n')" "sk-ant-oat01-AbC_d-9"

echo "== state"
# The state differs but the code is bound to THIS link's verifier (PKCE): Claude
# accepts it, so we must too — this is the false "different sign-in link".
fresh; xrc "$WORK/l" "good#mangled-by-the-terminal"
check "state differs, code valid for this link → signs in" "$rc:$OUT" "0:sk-ant-oat01-fake-mock-token-0000"
check "…and sends back the state Claude echoed" "$(last .state)" "mangled-by-the-terminal"
# A code genuinely made by a DIFFERENT link: its PKCE challenge is not ours.
fresh "$WORK/other"; OTHER_STATE=$STATE            # mock now expects the OTHER link's challenge
rm -rf "$WORK/l"; mkdir -m 700 "$WORK/l"; claude_oauth_begin "$WORK/l" >/dev/null
xrc "$WORK/l" "good#$OTHER_STATE"
check "code from a different link → 2" "$rc" 2
MSG=$(claude_oauth_error "$rc" "$WORK/l")
has  "…message names the link mix-up" "$MSG" "does not belong to the link printed above"
has  "…and shows which states differed" "$MSG" "ends with …#${OTHER_STATE: -6}, this link's state ends with …$(tail -c 6 "$WORK/l/state")"
hasnt "…and never blames the network" "$MSG" "internet"
fresh; xrc "$WORK/l" "typo#$STATE"
check "bad code, right state → 4 (not 2)" "$rc" 4
has "…with Claude's reason" "$(claude_oauth_error "$rc" "$WORK/l")" "HTTP 400 invalid_grant: Invalid authorization code"

echo "== single-use codes"
fresh; xrc "$WORK/l" "typo#$STATE"; n=$(count)
xrc "$WORK/l" $'\033[200~typo#'"$STATE"$'\033[201~\r'
check "same code again → 9 (already tried)" "$rc" 9
check "…without another call to Claude" "$(count)" "$n"
has "…and asks for a NEW code" "$(claude_oauth_error 9)" "paste the NEW code"
xrc "$WORK/l" "good#$STATE"
check "a new code after a failed one still works" "$rc:$OUT" "0:sk-ant-oat01-fake-mock-token-0000"

echo "== refusals + error mapping"
fresh; echo $(( $(date +%s) - 601 )) > "$WORK/l/started"; xrc "$WORK/l" "good#$STATE"
check "expired link → 3" "$rc" 3
fresh; xrc "$WORK/l" "apikey#$STATE"
check "API key reply refused → 5" "$rc" 5
check "API key never printed" "$OUT" ""
xrc "$WORK/l" "   "
check "empty paste → 7" "$rc" 7
xrc "$WORK/l" $'\033[200~\033[201~\r'
check "paste of only escape codes → 7" "$rc" 7
fresh; xrc "$WORK/l" "ratelimit#$STATE"
check "HTTP 429 → 8 (not 'could not reach')" "$rc" 8
has "…reason shown" "$(claude_oauth_error "$rc" "$WORK/l")" "HTTP 429 rate_limit_error: Rate limited"
fresh; xrc "$WORK/l" "boom#$STATE"
check "HTTP 500 → 8" "$rc" 8
hasnt "…not blamed on the network" "$(claude_oauth_error "$rc" "$WORK/l")" "internet"
fresh; xrc "$WORK/l" "html#$STATE"
check "HTTP 403 web page (proxy / bot check) → 8, not 'bad code'" "$rc" 8
has "…says it was not Claude answering" "$(claude_oauth_error "$rc" "$WORK/l")" "HTTP 403, not a Claude reply (Attention Required)"
fresh; CLAUDE_OAUTH_TOKEN_URL=http://127.0.0.1:1/nope; xrc "$WORK/l" "good#$STATE"; CLAUDE_OAUTH_TOKEN_URL=$MOCK_URL
check "unreachable → 6" "$rc" 6
MSG=$(CLAUDE_OAUTH_TOKEN_URL=http://127.0.0.1:1/nope claude_oauth_error "$rc" "$WORK/l")
has "…says could not reach + curl's reason" "$MSG" "could not reach Claude's sign-in service"
has "…includes the connection error" "$MSG" "onnect"
fresh; printf 'pasted code ends …#x, sk-ant-oat01-SECRETSECRET' > "$WORK/l/detail"
hasnt "detail never shows an sk-ant value" "$(_claude_detail "$(cat "$WORK/l/detail")")" "SECRETSECRET"

echo "== prompt loop (claude_oauth_interactive)"
loop() { local in=$1; fresh; rc=0; OUT=$(printf '%s' "$in" | claude_oauth_interactive "$WORK/l" "sudo bash /x/claude-login.sh --config c.conf" 2>"$WORK/err") || rc=$?; ERR=$(cat "$WORK/err"); }
loop $'\033[200~good#'"$STATE"$'\033[201~\r\n'
check "bracketed-paste code signs in on the 1st try" "$rc:$OUT" "0:sk-ant-oat01-fake-mock-token-0000"
hasnt "…token never on stderr" "$ERR" "sk-ant-oat01-fake"
loop $'\n\n'"good#$STATE"$'\n'
check "blank lines (the extra Enter) do not use a try" "$rc:$OUT" "0:sk-ant-oat01-fake-mock-token-0000"
loop $'sk-ant-oat01-pasted-setup-token\r\n'
check "a pasted setup token is taken as is" "$rc:$OUT" "0:sk-ant-oat01-pasted-setup-token"
loop "typo1#$STATE"$'\n'"typo2#$STATE"$'\n'"good#$STATE"$'\n'
check "two rejected codes, then a good one → signs in" "$rc:$OUT" "0:sk-ant-oat01-fake-mock-token-0000"
has "…warned with the try count" "$ERR" "Try again (2 of 3)"
loop "typo1#$STATE"$'\n'"typo2#$STATE"$'\n'"typo3#$STATE"$'\n'
check "three rejected codes → fails" "$rc:$OUT" "1:"
has "…STOP names the real reason" "$ERR" "STOP: Claude did not accept that code"
hasnt "…not 'could not reach Claude'" "$ERR" "could not reach"
has "…prints the setup-token way" "$ERR" "claude setup-token"
has "…with the exact rerun command" "$ERR" "sudo bash /x/claude-login.sh --config c.conf --token"
fresh; rc=0; OUT=$(printf 'good#%s\n' "$STATE" | CLAUDE_OAUTH_TOKEN_URL=http://127.0.0.1:1/nope claude_oauth_interactive "$WORK/l" "sudo bash /x/claude-login.sh --config c.conf" 2>"$WORK/err") || rc=$?; ERR=$(cat "$WORK/err")
check "network failure stops at once" "$rc:$OUT" "1:"
has "…as a network problem" "$ERR" "STOP: could not reach Claude's sign-in service"
has "…with the setup-token way" "$ERR" "--config c.conf --token"
loop ""
check "closed input → fails cleanly" "$rc:$OUT" "1:"
has "…and says so" "$ERR" "input closed before a code was pasted"

[ "$fails" -eq 0 ] && echo "ALL PASS" || { echo "$fails FAILED"; exit 1; }
