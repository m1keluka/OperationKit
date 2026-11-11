#!/usr/bin/env bash
# install/claude-login.sh — connect Claude for the server's AI worker sessions.
#
# Run it YOURSELF in a terminal (not through an AI assistant), so the token only
# ever appears on your own screen:
#   ssh -t <server> sudo bash <repo>/install/claude-login.sh --config <config>
#
# Two ways to sign in (CLAUDE_AUTH in the config file):
#   login    (Claude Pro / Max / Team subscription — recommended)
#            1. This script prints a "Sign in with Claude" link. Open it in any
#               browser and sign in with the client's Claude account.
#            2. Claude shows an "Authentication code". Paste it here (hidden).
#               The script swaps it for a one-year subscription token — the
#               same thing `claude setup-token` makes. No laptop install needed.
#            Already have a setup token (sk-ant-oat…)? Paste that instead.
#   api-key  (pay-per-use Anthropic API key, starts with sk-ant-api…)
#            Paste the key when asked. Typing is hidden.
#
# Options:
#   --config FILE      client config (required)
#   --from-file FILE   read the token/key from a file instead (deleted after use)
#   --token            login mode: skip the link, paste a setup token directly
#
# The value is stored in secrets/stack.env (mode 600) and the app is restarted
# so new sessions use it. It is never printed.
set -euo pipefail
# shellcheck source=install/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
# shellcheck source=install/claude-oauth.sh
source "$(dirname "${BASH_SOURCE[0]}")/claude-oauth.sh"

CONFIG=; FROM_FILE=; PASTE_TOKEN=
while [ $# -gt 0 ]; do
  case "$1" in
    --config) shift; CONFIG=${1:-} ;;
    --from-file) shift; FROM_FILE=${1:-} ;;
    --token) PASTE_TOKEN=1 ;;
    -h|--help) sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done
[ -n "$CONFIG" ] || die "--config <file> is required"
conf_load "$CONFIG"; conf_validate; ok_paths
require_root
mode=$(conf CLAUDE_AUTH login)

if [ -n "$FROM_FILE" ]; then
  [ -s "$FROM_FILE" ] || die "file is empty or missing: $FROM_FILE"
  value=$(head -n1 "$FROM_FILE" | tr -d '[:space:]')
  shred -u "$FROM_FILE" 2>/dev/null || rm -f "$FROM_FILE"
else
  [ -t 0 ] || die "no terminal to type into — run with: ssh -t <server> sudo bash $0 --config $CONFIG (or use --from-file)"
  if [ "$mode" = login ] && [ -z "$PASTE_TOKEN" ]; then
    # Sign in with Claude: link + paste code (the in-app flow, minus the app).
    oauth_dir=$(mktemp -d); chmod 700 "$oauth_dir"
    trap 'rm -rf "$oauth_dir"' EXIT
    url=$(claude_oauth_begin "$oauth_dir")
    echo "1. Open this link in any browser and sign in with the client's Claude account (Pro, Max or Team):"
    echo
    echo "   $url"
    echo
    echo "2. Claude shows an Authentication code. Copy it."
    value=
    for attempt in 1 2 3; do
      printf 'Paste the code (hidden), or a setup token sk-ant-oat…, then press Enter: '
      IFS= read -rs pasted; echo
      pasted=$(tr -d '[:space:]' <<<"$pasted")
      if [[ "$pasted" == sk-ant-oat* ]]; then value=$pasted; break; fi
      rc=0; value=$(claude_oauth_exchange "$oauth_dir" "$pasted") || rc=$?
      [ "$rc" -eq 0 ] && break
      value=
      case "$rc" in
        2|4|7) [ "$attempt" -lt 3 ] && { warn "$(claude_oauth_error "$rc"). Try again."; continue; } ;;
      esac
      die "$(claude_oauth_error "$rc"). Nothing was saved."
    done
    unset pasted
    [ -n "$value" ] || die "sign-in did not finish. Nothing was saved."
    log "Signed in with Claude."
  else
    if [ "$mode" = login ]; then
      echo "On a machine with Claude Code run:  claude setup-token   (sign in with the client's Claude account)"
      printf 'Paste the token it printed (hidden), then press Enter: '
    else
      printf 'Paste the Anthropic API key (hidden), then press Enter: '
    fi
    IFS= read -rs value; echo
    value=$(tr -d '[:space:]' <<<"$value")
  fi
fi

if [ "$mode" = login ]; then
  [[ "$value" == sk-ant-oat* ]] || die "that does not look like a Claude setup token (it should start with sk-ant-oat). Nothing was saved."
  env_set "$OK_SECRETS_ENV" SESSION_JAIL_CLAUDE_OAUTH_TOKEN "$value"
  env_set "$OK_SECRETS_ENV" SESSION_JAIL_ANTHROPIC_API_KEY ""
else
  [[ "$value" == sk-ant-* ]] || die "that does not look like an Anthropic API key (it should start with sk-ant-). Nothing was saved."
  env_set "$OK_SECRETS_ENV" SESSION_JAIL_ANTHROPIC_API_KEY "$value"
  env_set "$OK_SECRETS_ENV" SESSION_JAIL_CLAUDE_OAUTH_TOKEN ""
fi
unset value
log "Claude credential saved (secrets/stack.env, mode 600)."

# Prove it works before telling anyone it does: one tiny call from the sandbox image.
key=SESSION_JAIL_CLAUDE_OAUTH_TOKEN; as=CLAUDE_CODE_OAUTH_TOKEN
[ "$mode" = login ] || { key=SESSION_JAIL_ANTHROPIC_API_KEY; as=ANTHROPIC_API_KEY; }
envf=$(mktemp); chmod 600 "$envf"
printf '%s=%s\n' "$as" "$(env_get "$OK_SECRETS_ENV" "$key")" > "$envf"
if out=$(docker run --rm --env-file "$envf" ok-jail:local claude -p "Reply with exactly: CLAUDE-OK" 2>&1) && grep -q CLAUDE-OK <<<"$out"; then
  log "Claude answered from the sandbox image — sign-in works."
else
  rm -f "$envf"
  die "Claude did not answer with this credential. Check the account, then run this again. ($(tail -n1 <<<"$out" | cut -c1-160))"
fi
rm -f "$envf"

log "Restarting the app so new sessions use it…"
dc up -d command-center >/dev/null
until curl -fsS http://127.0.0.1:3002/api/health >/dev/null 2>&1; do sleep 3; done
log "Done. Next: sudo bash $OK_LIB_DIR/verify.sh --config $CONFIG"
