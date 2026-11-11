# shellcheck shell=bash
# install/api-bypass-lib.sh — read and police install/api-bypass-paths.conf.
#
# One list, one parser. install/cloudflare.sh uses it to build the Cloudflare
# Access app "Operation Kit API (key auth)"; install/verify.sh uses it to pick a
# route to probe; install/test/api-bypass-paths-test.sh proves the guard holds.
#
# The guard is the point: every path here is a path Cloudflare stops checking,
# so a typo that reads as "/api/internal" must stop the install, not open the
# operator API to the internet. Nothing below ever prints or reads a secret.

# Paths that must NEVER be bypassed: the operator / money / machine surface.
# A path IS denied when it equals one of these or sits under it.
OK_API_BYPASS_DENY=(
  /api/internal
  /api/admin
  /api/secrets
  /api/secret-upload
  /api/webhooks
  /api/auth
  /api/public
  /api/llm
  /api/alerts
  /api/costs
  /api/intel
  /api/status
)
# The one carve-out: "who am I" for a caller that already holds a valid key.
# Written as "<mode> <path>" so `prefix /api/auth/me` stays refused.
OK_API_BYPASS_DENY_EXCEPT=("exact /api/auth/me")

# ok_api_bypass_conf — where the list lives (override with OK_API_BYPASS_CONF).
ok_api_bypass_conf() {
  printf '%s' "${OK_API_BYPASS_CONF:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/api-bypass-paths.conf}"
}

# ok_api_bypass_check MODE PATH — die unless this entry is safe to bypass.
ok_api_bypass_check() {
  local mode=$1 path=$2 d e
  case "$mode" in prefix|exact) ;; *) die "api-bypass list: '$mode' is not a mode — use 'prefix' or 'exact'" ;; esac
  [[ "$path" != *'*'* ]] || die "api-bypass list: '$path' — do not write a wildcard; 'prefix $path' already covers everything under it"
  [[ "$path" =~ ^/api/[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9][A-Za-z0-9._-]*)*$ ]] \
    || die "api-bypass list: '$path' is not a plain path under /api/ (a blanket /api or /api/* is never allowed)"
  for e in "${OK_API_BYPASS_DENY_EXCEPT[@]}"; do [ "$mode $path" = "$e" ] && return 0; done
  for d in "${OK_API_BYPASS_DENY[@]}"; do
    if [ "$path" = "$d" ] || [[ "$path" == "$d"/* ]]; then
      die "api-bypass list: '$path' is under $d, which must stay behind the Cloudflare sign-in. Remove it from $(ok_api_bypass_conf)."
    fi
  done
  return 0
}

# ok_api_bypass_entries — the checked list as "<mode> <path>" lines, in file order.
# Nothing is printed until EVERY line has passed the guard, so a caller can never
# act on a half-checked list: on refusal you get the message and no output.
ok_api_bypass_entries() {
  local file mode path rest n=0 seen='' out=''
  file=$(ok_api_bypass_conf)
  [ -s "$file" ] || die "api-bypass list missing or empty: $file"
  while read -r mode path rest; do
    n=$((n + 1))
    [ -n "$mode" ] || continue
    [ -n "$path" ] || die "api-bypass list line $n: '$mode' has no path"
    [ -z "$rest" ] || die "api-bypass list line $n: one route per line (got extra '$rest')"
    ok_api_bypass_check "$mode" "$path"
    case " $seen " in *" $mode $path "*) die "api-bypass list line $n: '$mode $path' is listed twice" ;; esac
    seen="$seen $mode $path"
    out="$out$mode $path"$'\n'
  done < <(sed -e 's/#.*//' -e 's/[[:space:]]\{1,\}/ /g' -e 's/^ //' -e 's/ $//' "$file")
  [ -n "$out" ] || die "api-bypass list has no routes: $file"
  printf '%s' "$out"
}

# ok_api_bypass_paths — every path Cloudflare must let through, one per line
# ("prefix /x" becomes "/x" and "/x/*"). This is what the Access app gets.
# Callers MUST write `paths=$(ok_api_bypass_paths) || exit 1`: `die` inside a
# command substitution does not always trip the caller's `set -e`.
ok_api_bypass_paths() {
  local mode path entries out=''
  entries=$(ok_api_bypass_entries) || return 1
  [ -n "$entries" ] || return 1
  while read -r mode path; do
    out="$out$path"$'\n'
    if [ "$mode" = prefix ]; then out="$out$path/*"$'\n'; fi
  done <<<"$entries"
  printf '%s' "$out"
}

# ok_api_bypass_probe — one bypassed path verify.sh can call with no key and
# expect the APP's 401 JSON back (never a Cloudflare sign-in redirect).
ok_api_bypass_probe() { printf '/api/objectives'; }

# ok_api_bypass_at_cloudflare "<http code>|<redirect url>|<content type>" — true
# when Cloudflare Access answered (its sign-in redirect, or its own refusal)
# rather than the app. Operation Kit always answers JSON, and Cloudflare's
# sign-in never does, so the content type settles it; a redirect to
# <team>.cloudflareaccess.com, or a bare 401/403 with no JSON body, is
# Cloudflare. Used by install/verify.sh to tell "the bypass works" from "the
# bypass is missing" and from "the bypass is too wide".
ok_api_bypass_at_cloudflare() {
  local c rest loc ctype
  c=${1%%|*}; rest=${1#*|}; loc=${rest%%|*}; ctype=${rest#*|}
  case "$ctype" in application/json*) return 1 ;; esac
  case "$loc" in *cloudflareaccess.com*) return 0 ;; esac
  [[ "$c" =~ ^(301|302|303|307|308|401|403)$ ]]
}

# ── Paths another Access application already owns (obj 900069) ───────────────
# Cloudflare refuses an Access app whose destination is already a destination of
# a different app on the same hostname ("destination belongs to another
# application", code 12132). A client install can legitimately already have one
# — a real client install had a separate MCP bypass app owning /api/mcp — and before
# this the whole Cloudflare step (and so update.sh) stopped there.
#
# These two helpers are pure: they take JSON in and print/return, so
# install/test/api-bypass-paths-test.sh can exercise them with no network.

# ok_api_bypass_conflicts APPS_JSON DOMAIN SELF_NAME PATHS — which of PATHS are
# already a destination of a DIFFERENT Access application on DOMAIN.
# APPS_JSON is a Cloudflare `GET .../access/apps` body; SELF_NAME is our own
# app's name (matched exactly, the same way we look it up, so refreshing our own
# app is never a conflict); PATHS is the newline-separated expanded path list.
# Prints one "<path><TAB><app id><TAB><app name>" line per collision, in PATHS
# order, and nothing at all when there is none.
ok_api_bypass_conflicts() {
  local apps=$1 domain=$2 self=$3 paths=$4
  jq -r --arg d "$domain" --arg n "$self" --arg p "$paths" '
    ($p | split("\n") | map(select(length > 0))) as $want
    | [ .result[]? | select((.name // "") != $n) | . as $a
        | ($a.destinations // [])[]
        | (.uri // "")
        | select(startswith($d + "/"))
        | { path: .[($d | length):], app_id: ($a.id // ""), app_name: ($a.name // "") } ] as $owned
    | $want[] as $w
    | (($owned | map(select(.path == $w)))[0] // empty)
    | "\($w)\t\(.app_id)\t\(.app_name)"
  ' <<<"$apps" 2>/dev/null
}

# ok_api_bypass_policies_are_bypass POLICIES_JSON — true when that application
# is itself a bypass / key-auth app, i.e. at least one of its policies decides
# `bypass`. Such an app already lets everyone through on the paths it owns, so
# leaving it alone and skipping those paths keeps the same end result for a bot:
# Cloudflare steps aside and the Operation Kit key is the lock. An app WITHOUT a
# bypass policy means the opposite (those paths stay gated), so the caller must
# stop rather than quietly ship a half-open install.
ok_api_bypass_policies_are_bypass() {
  jq -e '[.result[]? | select((.decision // "") == "bypass")] | length > 0' >/dev/null 2>&1 <<<"$1"
}
