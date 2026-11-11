# shellcheck shell=bash
# install/claude-oauth.sh — "Sign in with Claude" for the installer (obj 720330).
# Sourced by install/claude-login.sh. The same OAuth + PKCE flow `claude
# setup-token` runs (and the app's Settings → Seats uses), so the operator can
# sign in from any browser without installing Claude Code on a laptop:
#
#   claude_oauth_begin DIR          prints the sign-in link; keeps the PKCE
#                                   verifier + state in DIR (mode 600)
#   claude_oauth_exchange DIR CODE  CODE = what Claude shows ("code#state");
#                                   prints the subscription token on stdout
#
# Exit codes of claude_oauth_exchange: 2 state mismatch, 3 link expired,
# 4 Claude rejected the code, 5 reply was not a subscription token (never an
# API key), 6 could not reach Claude, 7 nothing pasted.
# The verifier and the token never go on a command line (ps-visible) or a log.
# Needs: openssl, curl, jq (all installed by bootstrap-host.sh).

CLAUDE_OAUTH_CLIENT_ID=9d1c250a-e61b-44d9-88ed-5944d1962f5e
CLAUDE_OAUTH_AUTHORIZE_URL=${CLAUDE_OAUTH_AUTHORIZE_URL:-https://claude.com/cai/oauth/authorize}
CLAUDE_OAUTH_TOKEN_URL=${CLAUDE_OAUTH_TOKEN_URL:-https://platform.claude.com/v1/oauth/token}
CLAUDE_OAUTH_REDIRECT_URI=https://platform.claude.com/oauth/code/callback
CLAUDE_OAUTH_SCOPE=user:inference          # setup-token: inference only …
CLAUDE_OAUTH_EXPIRES_IN=31536000           # … and a one-year token
CLAUDE_OAUTH_TTL=${CLAUDE_OAUTH_TTL:-600}  # seconds the link stays usable

_claude_b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

claude_oauth_begin() {
  local dir=$1 verifier state challenge
  ( umask 077
    verifier=$(openssl rand 32 | _claude_b64url)
    state=$(openssl rand 32 | _claude_b64url)
    printf '%s' "$verifier" > "$dir/verifier"
    printf '%s' "$state" > "$dir/state"
    date +%s > "$dir/started" )
  challenge=$(printf '%s' "$(cat "$dir/verifier")" | openssl dgst -sha256 -binary | _claude_b64url)
  state=$(cat "$dir/state")
  jq -rn --arg base "$CLAUDE_OAUTH_AUTHORIZE_URL" --arg cid "$CLAUDE_OAUTH_CLIENT_ID" \
    --arg ru "$CLAUDE_OAUTH_REDIRECT_URI" --arg sc "$CLAUDE_OAUTH_SCOPE" --arg ch "$challenge" --arg st "$state" \
    '$base + "?code=true&client_id=" + ($cid|@uri) + "&response_type=code&redirect_uri=" + ($ru|@uri)
     + "&scope=" + ($sc|@uri) + "&code_challenge=" + $ch + "&code_challenge_method=S256&state=" + $st'
}

claude_oauth_exchange() {
  local dir=$1 pasted code state resp status token
  pasted=$(tr -d '[:space:]' <<<"${2:-}")
  [ -n "$pasted" ] || return 7
  if [ $(( $(date +%s) - $(cat "$dir/started") )) -ge "$CLAUDE_OAUTH_TTL" ]; then
    rm -f "$dir/verifier"
    return 3
  fi
  [ -s "$dir/verifier" ] || return 3
  code=${pasted%%#*}
  state=; [[ "$pasted" == *"#"* ]] && state=${pasted#*#}
  [ -n "$code" ] || return 7
  # A state that is present must be the one this link was made with.
  if [ -n "$state" ] && [ "$state" != "$(cat "$dir/state")" ]; then return 2; fi
  resp=$(mktemp); chmod 600 "$resp"
  status=$(CODE=$code jq -cn --rawfile v "$dir/verifier" --rawfile s "$dir/state" \
      --arg cid "$CLAUDE_OAUTH_CLIENT_ID" --arg ru "$CLAUDE_OAUTH_REDIRECT_URI" --argjson exp "$CLAUDE_OAUTH_EXPIRES_IN" \
      '{grant_type:"authorization_code", code:env.CODE, redirect_uri:$ru, client_id:$cid, code_verifier:$v, state:$s, expires_in:$exp}' |
    curl -sS --max-time 30 -o "$resp" -w '%{http_code}' -H 'Content-Type: application/json' --data-binary @- "$CLAUDE_OAUTH_TOKEN_URL" 2>/dev/null) || status=000
  case "$status" in
    200) ;;
    400|401|403) rm -f "$resp"; return 4 ;;
    *) rm -f "$resp"; return 6 ;;
  esac
  token=$(jq -r '.access_token // empty' "$resp" 2>/dev/null); rm -f "$resp"
  # Subscription only: anything that is not an OAuth token (e.g. sk-ant-api…) is refused.
  [[ "$token" == sk-ant-oat* ]] || return 5
  rm -f "$dir/verifier"
  printf '%s\n' "$token"
}

claude_oauth_error() {
  case "$1" in
    2) echo "that code is from a different sign-in link — use the code from the link printed above" ;;
    3) echo "the sign-in link expired (10 minutes) — run this again for a new link" ;;
    4) echo "Claude did not accept that code — copy the whole code again (it works once)" ;;
    5) echo "Claude did not return a subscription token for this account" ;;
    6) echo "could not reach Claude to finish signing in — check the server's internet access" ;;
    7) echo "nothing was pasted" ;;
    *) echo "sign-in failed ($1)" ;;
  esac
}
