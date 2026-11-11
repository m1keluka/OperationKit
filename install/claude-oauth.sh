# shellcheck shell=bash
# install/claude-oauth.sh — "Sign in with Claude" for the installer (obj 720330).
# Sourced by install/claude-login.sh. The same OAuth + PKCE flow `claude
# setup-token` runs (and the app's Settings → Seats uses), so the operator can
# sign in from any browser without installing Claude Code on a laptop:
#
#   claude_oauth_begin DIR          prints the sign-in link; keeps the PKCE
#                                   verifier + state in DIR (mode 600)
#   claude_oauth_exchange DIR CODE  CODE = what Claude shows ("code#state"),
#                                   a bare code, or the whole callback URL;
#                                   prints the subscription token on stdout
#   claude_oauth_interactive DIR    the prompt loop (up to 3 codes); prompts
#                                   on stderr, token on stdout
#   claude_paste_clean TEXT         strips what terminals add to a paste
#
# Exit codes of claude_oauth_exchange:
#   2 the code belongs to a different sign-in link (state differed AND Claude
#     refused the code)     3 link expired           4 Claude refused the code
#   5 reply was not a subscription token (never an API key)
#   6 could not reach Claude (a real network failure: DNS, connect, TLS, timeout)
#   7 nothing pasted        8 Claude answered with an error (429 / 5xx / not JSON)
#   9 that exact code was already tried (codes work once — get a new one)
# After a failure, DIR/detail holds a short, secret-free reason (HTTP status +
# OAuth error, or curl's message) that claude_oauth_error appends.
#
# Why the state is not a hard gate (obj 900541): what binds a code to THIS link
# is PKCE — Claude only swaps the code for a token when our verifier matches the
# challenge in the link. A state that differs is therefore checked by Claude, not
# by us: we still send the exchange, and only call it "a different sign-in link"
# when Claude also refuses the code. A strict local compare rejected valid codes
# whenever the terminal mangled the "#state" half of the paste.
#
# The verifier and the token never go on a command line (ps-visible) or a log.
# Needs: openssl, curl, jq (all installed by bootstrap-host.sh).

CLAUDE_OAUTH_CLIENT_ID=9d1c250a-e61b-44d9-88ed-5944d1962f5e
CLAUDE_OAUTH_AUTHORIZE_URL=${CLAUDE_OAUTH_AUTHORIZE_URL:-https://claude.com/cai/oauth/authorize}
CLAUDE_OAUTH_TOKEN_URL=${CLAUDE_OAUTH_TOKEN_URL:-https://platform.claude.com/v1/oauth/token}
CLAUDE_OAUTH_REDIRECT_URI=https://platform.claude.com/oauth/code/callback
CLAUDE_OAUTH_SCOPE=user:inference          # setup-token: inference only …
CLAUDE_OAUTH_EXPIRES_IN=31536000           # … and a one-year token
CLAUDE_OAUTH_TTL=${CLAUDE_OAUTH_TTL:-600}  # seconds the link stays usable
CLAUDE_OAUTH_TRIES=${CLAUDE_OAUTH_TRIES:-3}

_claude_b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

# Undo what a terminal, a web console or a clipboard adds to a paste:
#  - bracketed-paste markers ESC[200~ / ESC[201~ (also with the ESC eaten) and any
#    other ANSI escape sequence — `tr -d [:space:]` keeps all of these;
#  - CR (Windows), tabs, newlines, spaces, other control bytes;
#  - non-breaking / zero-width spaces and a BOM (rich-text clipboards);
#  - quotes, backticks and <> someone copied around the value;
#  - percent-encoding (a URL-encoded "%23" for the "#").
# None of these characters can be part of a Claude code, state or token.
claude_paste_clean() {
  local s=${1-}
  s=$(printf '%s' "$s" | LC_ALL=C sed -E \
      -e $'s/\x1b\\[[0-9;?]*[ -/]*[@-~]//g' \
      -e $'s/\x1b[]P^_][^\x07\x1b]*(\x07|\x1b\\\\)?//g' \
      -e $'s/\x1b.//g' \
      -e 's/\[20[01]~//g' \
      -e $'s/\xc2\xa0//g; s/\xe2\x80[\x8b-\x8f]//g; s/\xe2\x81\xa0//g; s/\xef\xbb\xbf//g' \
    | LC_ALL=C tr -d '\000-\040\177"`<>\\'"'")
  if [[ "$s" == *%[0-9A-Fa-f][0-9A-Fa-f]* ]]; then
    s=$(printf '%b' "$(LC_ALL=C sed -E 's/%([0-9A-Fa-f]{2})/\\x\1/g' <<<"$s")" | LC_ALL=C tr -d '\000-\040\177')
  fi
  printf '%s' "$s"
}

# Split a cleaned paste into CODE and STATE (globals _CO_CODE / _CO_STATE).
# Accepts "code#state", a bare "code", or …/oauth/code/callback?code=…&state=….
_claude_split_paste() {
  local s=$1
  _CO_CODE=; _CO_STATE=
  if [[ "$s" == *://* || "$s" == code=* || "$s" == \?code=* ]]; then
    [[ "$s" =~ (^|[?&])code=([^&#]*) ]] && _CO_CODE=${BASH_REMATCH[2]}
    if [[ "$s" =~ (^|[?&])state=([^&#]*) ]]; then _CO_STATE=${BASH_REMATCH[2]}
    elif [[ "$s" == *"#"* ]]; then _CO_STATE=${s##*#}; fi
    return 0
  fi
  _CO_CODE=${s%%#*}
  [[ "$s" == *"#"* ]] && _CO_STATE=${s#*#}
  _CO_STATE=${_CO_STATE%%#*}
  return 0
}

# A short reason a human can act on. Only the OAuth error fields are kept (never
# the body), sk-ant-… values are redacted and the charset is narrowed.
_claude_detail() {
  printf '%s' "$1" | sed -E 's/sk-ant-[A-Za-z0-9_-]+/[redacted]/g' | LC_ALL=C tr -cd 'A-Za-z0-9 _.:,()/=-' | cut -c1-160
}

claude_oauth_begin() {
  local dir=$1 verifier state challenge
  ( umask 077
    verifier=$(openssl rand 32 | _claude_b64url)
    state=$(openssl rand 32 | _claude_b64url)
    printf '%s' "$verifier" > "$dir/verifier"
    printf '%s' "$state" > "$dir/state"
    : > "$dir/tried"
    date +%s > "$dir/started" )
  challenge=$(printf '%s' "$(cat "$dir/verifier")" | openssl dgst -sha256 -binary | _claude_b64url)
  state=$(cat "$dir/state")
  jq -rn --arg base "$CLAUDE_OAUTH_AUTHORIZE_URL" --arg cid "$CLAUDE_OAUTH_CLIENT_ID" \
    --arg ru "$CLAUDE_OAUTH_REDIRECT_URI" --arg sc "$CLAUDE_OAUTH_SCOPE" --arg ch "$challenge" --arg st "$state" \
    '$base + "?code=true&client_id=" + ($cid|@uri) + "&response_type=code&redirect_uri=" + ($ru|@uri)
     + "&scope=" + ($sc|@uri) + "&code_challenge=" + $ch + "&code_challenge_method=S256&state=" + $st'
}

claude_oauth_exchange() {
  local dir=$1 pasted code state ours mismatch="" send_state resp errf status token curl_rc fp err
  rm -f "$dir/detail"
  pasted=$(claude_paste_clean "${2-}")
  [ -n "$pasted" ] || return 7
  if [ $(( $(date +%s) - $(cat "$dir/started") )) -ge "$CLAUDE_OAUTH_TTL" ]; then
    rm -f "$dir/verifier"
    return 3
  fi
  [ -s "$dir/verifier" ] || return 3
  _claude_split_paste "$pasted"; code=$_CO_CODE; state=$_CO_STATE
  [ -n "$code" ] || return 7
  ours=$(cat "$dir/state")
  if [ -n "$state" ] && [ "$state" != "$ours" ]; then
    mismatch=1
    printf 'pasted code ends with …#%s, this link'"'"'s state ends with …%s' \
      "$(printf '%s' "$state" | tail -c 6 | LC_ALL=C tr -cd 'A-Za-z0-9_-')" "$(printf '%s' "$ours" | tail -c 6)" > "$dir/state_note"
  else
    rm -f "$dir/state_note"
  fi
  # A code works once. Re-sending one Claude already saw only burns a try and
  # earns a misleading "rejected": stop before the network instead.
  fp=$(printf '%s' "$code" | openssl dgst -sha256 | sed 's/^.*= *//')
  if grep -qxF "$fp" "$dir/tried" 2>/dev/null; then return 9; fi
  printf '%s\n' "$fp" >> "$dir/tried"
  # Send back the state Claude echoed (what its authorize step recorded); ours otherwise.
  send_state=${state:-$ours}
  resp=$(mktemp); errf=$(mktemp); chmod 600 "$resp" "$errf"
  curl_rc=0
  status=$(CODE=$code STATE=$send_state jq -cn --rawfile v "$dir/verifier" \
      --arg cid "$CLAUDE_OAUTH_CLIENT_ID" --arg ru "$CLAUDE_OAUTH_REDIRECT_URI" --argjson exp "$CLAUDE_OAUTH_EXPIRES_IN" \
      '{grant_type:"authorization_code", code:env.CODE, redirect_uri:$ru, client_id:$cid, code_verifier:$v, state:env.STATE, expires_in:$exp}' |
    curl -sS --connect-timeout 15 --max-time 30 -o "$resp" -w '%{http_code}' -H 'Content-Type: application/json' \
      --data-binary @- "$CLAUDE_OAUTH_TOKEN_URL" 2>"$errf") || curl_rc=$?
  status=${status:-000}
  if [ "$curl_rc" -ne 0 ] || [ "$status" = 000 ]; then
    # Only this branch is "could not reach Claude": no HTTP answer at all.
    _claude_detail "$(head -n1 "$errf" | sed 's/^curl: //')" > "$dir/detail"
    rm -f "$resp" "$errf"; return 6
  fi
  rm -f "$errf"
  if [ "$status" != 200 ]; then
    if jq -e 'type == "object"' "$resp" >/dev/null 2>&1; then
      err=$(jq -r '[ (.error | if type=="object" then (.type // empty), (.message // empty) else . end),
                     (.error_description // empty) ] | map(select(type=="string" and . != "")) | join(": ")' "$resp" 2>/dev/null)
      _claude_detail "HTTP $status${err:+ $err}" > "$dir/detail"
      rm -f "$resp"
      case "$status" in
        429|5??) return 8 ;;
        4??) [ -n "$mismatch" ] && return 2; return 4 ;;
        *) return 8 ;;
      esac
    fi
    # A web page (proxy, firewall, bot check) instead of Claude's JSON answer.
    _claude_detail "HTTP $status, not a Claude reply ($(head -c 200 "$resp" | grep -oiE '<title>[^<]{0,80}' | sed 's/<title>//I' | head -n1))" > "$dir/detail"
    rm -f "$resp"; return 8
  fi
  token=$(jq -r '.access_token // empty' "$resp" 2>/dev/null); rm -f "$resp"
  # Subscription only: anything that is not an OAuth token (e.g. sk-ant-api…) is refused.
  [[ "$token" == sk-ant-oat* ]] || return 5
  rm -f "$dir/verifier"
  printf '%s\n' "$token"
}

claude_oauth_error() {
  local rc=$1 dir=${2-} msg detail=
  case "$rc" in
    2) msg="Claude did not accept that code, and it does not belong to the link printed above — open THAT link (not an older one), sign in, and copy the new code" ;;
    3) msg="the sign-in link expired (10 minutes) — run this again for a new link" ;;
    4) msg="Claude did not accept that code (each code works once and expires within minutes) — open the link above again, sign in, and paste the NEW code" ;;
    5) msg="Claude did not return a subscription token for this account (Pro, Max or Team is needed)" ;;
    6) msg="could not reach Claude's sign-in service ($CLAUDE_OAUTH_TOKEN_URL) — check the server's internet access / DNS / firewall" ;;
    7) msg="nothing was pasted" ;;
    8) msg="Claude's sign-in service answered with an error — wait a minute, open the link above again and paste the new code" ;;
    9) msg="that code was already tried and a code works only once — open the link above again, sign in, and paste the NEW code" ;;
    *) msg="sign-in failed ($rc)" ;;
  esac
  if [ -n "$dir" ]; then
    [ -s "$dir/detail" ] && detail=$(cat "$dir/detail")
    if [ "$rc" = 2 ] && [ -s "$dir/state_note" ]; then detail="${detail:+$detail; }$(cat "$dir/state_note")"; fi
  fi
  printf '%s%s\n' "$msg" "${detail:+ [$detail]}"
}

# The way around the code flow: a setup token made on any machine with Claude Code.
claude_setup_token_hint() {
  local cmd=${1:-bash install/claude-login.sh --config <config>}
  cat <<EOF
Other way to connect (no code to paste):
  1. On any computer with Claude Code installed (laptop is fine), run:   claude setup-token
     and sign in with the client's Claude account. It prints a token starting with sk-ant-oat.
  2. Back on this server run:   $cmd --token
     and paste that token (typing is hidden).
EOF
}

# The prompt loop: up to CLAUDE_OAUTH_TRIES codes. Prompts and warnings go to
# stderr, the token to stdout. A pasted setup token (sk-ant-oat…) is accepted as
# is. Empty lines (e.g. the Enter after a paste that already ended in a newline)
# do not use up a try. On failure prints the reason + the --token way and returns 1.
claude_oauth_interactive() {
  local dir=$1 hint_cmd=${2-} tries=0 empties=0 pasted rc value msg
  # Make the terminal deliver a paste as plain text (no ESC[200~ … ESC[201~).
  [ -t 2 ] && printf '\033[?2004l' >&2
  while :; do
    printf 'Paste the code (hidden), or a setup token sk-ant-oat…, then press Enter: ' >&2
    pasted=; IFS= read -rs pasted || [ -n "$pasted" ] || { echo >&2; pasted=$'\004'; }
    echo >&2
    if [ "$pasted" = $'\004' ]; then
      printf '[%s] STOP: input closed before a code was pasted. Nothing was saved.\n' "$(date '+%H:%M:%S')" >&2
      claude_setup_token_hint "$hint_cmd" >&2; return 1
    fi
    pasted=$(claude_paste_clean "$pasted")
    if [ -z "$pasted" ]; then
      empties=$((empties + 1))
      [ "$empties" -lt 5 ] && continue
      printf '[%s] STOP: nothing was pasted. Nothing was saved.\n' "$(date '+%H:%M:%S')" >&2
      claude_setup_token_hint "$hint_cmd" >&2; return 1
    fi
    if [[ "$pasted" == sk-ant-oat* ]]; then printf '%s\n' "$pasted"; return 0; fi
    tries=$((tries + 1))
    rc=0; value=$(claude_oauth_exchange "$dir" "$pasted") || rc=$?
    if [ "$rc" -eq 0 ] && [ -n "$value" ]; then printf '%s\n' "$value"; return 0; fi
    msg=$(claude_oauth_error "$rc" "$dir")
    case "$rc" in
      2|4|8|9)
        if [ "$tries" -lt "$CLAUDE_OAUTH_TRIES" ]; then
          printf '[%s] WARN: %s. Try again (%s of %s).\n' "$(date '+%H:%M:%S')" "$msg" "$tries" "$CLAUDE_OAUTH_TRIES" >&2
          continue
        fi ;;
    esac
    printf '[%s] STOP: %s. Nothing was saved.\n' "$(date '+%H:%M:%S')" "$msg" >&2
    claude_setup_token_hint "$hint_cmd" >&2
    return 1
  done
}
