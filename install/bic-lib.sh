# shellcheck shell=bash disable=SC2034
# install/bic-lib.sh — the narrow Browser Integrity Check exception for this
# install's own API paths.
#
# THE PROBLEM. Cloudflare's Browser Integrity Check (BIC) looks at a request's
# browser signature and turns away anything that does not look like a browser. A
# bot calling the board API with an Operation Kit key is exactly that, so it gets
# Cloudflare's **error 1010** page ("the owner of this website has banned your
# access based on your browser's signature") — HTTP 403, text/html, and the app
# never sees the request. That is a DIFFERENT failure from Cloudflare Access's
# sign-in page (install/api-bypass-lib.sh) and different again from the app's own
# 401/403 JSON. docs/CLOUDFLARE-API-ACCESS.md tells the three apart.
#
# THE FIX, and how narrow it is. ONE Configuration Rule in this zone's
# `http_config_settings` phase, action `set_config`, whose action_parameters hold
# EXACTLY ONE key — `bic: false` — and whose expression matches ONLY
#
#     http.host eq "<this install's DOMAIN>" and starts_with(http.request.uri.path, "/api/")
#
# so it cannot affect another hostname in the zone, the sign-in UI, or anything
# outside /api/. The zone-wide Browser Integrity Check setting is NOT touched; no
# WAF rule, rate limit, security level or Access application is touched; and no
# other Configuration Rule is read-modify-written — the rule is added, updated
# and removed through the per-rule endpoints, so unrelated rules in the same
# phase are preserved by construction rather than by care.
#
# Nothing here prints or reads a secret, and nothing here is specific to any one
# client: the hostname always comes from the caller's client.conf DOMAIN.
#
# Everything in this file is PURE (JSON / strings in, JSON / strings out) so
# install/test/bic-lib-test.sh can exercise it with no network and no account.

# The zone-level phase that holds Configuration Rules.
OK_BIC_PHASE=http_config_settings
# The marker we own a rule by. It carries the hostname, so two Operation Kit
# installs sharing one Cloudflare zone own two separate rules and neither can
# find, correct or delete the other one. A rule with any other description
# belongs to somebody else and is never touched.
# ok_bic_rule_desc DOMAIN
ok_bic_rule_desc() { printf "Operation Kit: API key auth for %s/api/ (no browser integrity check)" "$1"; }
# The name given to the phase ruleset when this install has to create it.
OK_BIC_RULESET_NAME="Operation Kit configuration rules"
# An empty phase, for the callers that have to pass SOMETHING when the zone has
# no Configuration Rules at all.
OK_BIC_EMPTY='{"rules":[]}'

# ok_bic_check_domain DOMAIN — die unless DOMAIN is a single, literal hostname.
# A wildcard, or an apex typed where a sub-domain belongs, would widen the
# exception past this install.
ok_bic_check_domain() {
  local d=${1-}
  [ -n "$d" ] || die "browser-integrity exception: DOMAIN is empty — there is nothing to scope the rule to"
  [[ "$d" != *'*'* ]] || die "browser-integrity exception: DOMAIN '$d' contains a wildcard — the rule must name one exact hostname"
  [[ "$d" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] \
    || die "browser-integrity exception: DOMAIN '$d' is not a plain hostname"
  return 0
}

# ok_bic_expression DOMAIN — the one expression the rule may ever carry.
ok_bic_expression() {
  ok_bic_check_domain "$1" || return 1
  printf '(http.host eq "%s" and starts_with(http.request.uri.path, "/api/"))' "$1"
}

# ok_bic_rule_body DOMAIN — the complete rule object. `bic: false` is the ONLY
# action parameter: every other Configuration-Rule setting (ssl, polish,
# security_level, rocket_loader …) is left to whatever the zone already does.
ok_bic_rule_body() {
  local expr
  expr=$(ok_bic_expression "$1") || return 1
  jq -nc --arg e "$expr" --arg d "$(ok_bic_rule_desc "$1")" \
    '{action:"set_config", action_parameters:{bic:false}, expression:$e, description:$d, enabled:true}'
}

# ok_bic_find_rule RULESET_JSON DOMAIN — the id of OUR rule inside a phase
# ruleset body, or nothing. Matched by our description first; failing that by
# shape — a set_config rule whose ONLY action parameter is bic:false and whose
# expression names THIS install's hostname — so a rule renamed or re-scoped in
# the dashboard is recognised as ours and corrected, instead of being left
# behind while a second one is added next to it. The shape test is deliberately
# tight: a rule that sets anything besides bic, or that is about another
# hostname, is somebody else's and is never matched.
ok_bic_find_rule() {
  ok_bic_expression "$2" >/dev/null || return 1   # validates DOMAIN
  jq -r --arg d "$(ok_bic_rule_desc "$2")" --arg h "$(printf 'http.host eq "%s"' "$2")" '
    ((.result // .).rules // [])
    | ( [ .[] | select((.description // "") == $d) ][0].id
        // [ .[] | select((.action // "") == "set_config"
                          and ((.action_parameters // {}) | keys) == ["bic"]
                          and (.action_parameters.bic == false)
                          and ((.expression // "") | contains($h))) ][0].id
        // empty )
  ' <<<"$1" 2>/dev/null
}

# ok_bic_rule_is_current RULESET_JSON DOMAIN — true when our rule is already
# exactly right, so a re-run makes no mutating API call at all.
# (jq note: `.enabled // true` would be wrong — jq's // treats a literal
# false as absent, so a rule someone DISABLED in the dashboard would read as
# enabled and a re-run would leave it switched off. has() is the honest test.)
ok_bic_rule_is_current() {
  local expr
  expr=$(ok_bic_expression "$2") || return 1
  jq -e --arg d "$(ok_bic_rule_desc "$2")" --arg e "$expr" '
    ((.result // .).rules // [])
    | [ .[] | select((.description // "") == $d
                     and (.action // "") == "set_config"
                     and ((.action_parameters // {}) | keys) == ["bic"]
                     and (.action_parameters.bic == false)
                     and ((.expression // "") == $e)
                     and ((if has("enabled") then .enabled else true end) == true)) ] | length == 1
  ' >/dev/null 2>&1 <<<"$1"
}

# ok_bic_other_rules RULESET_JSON DOMAIN — one "<id>\t<description>" line per
# rule in the phase that is NOT ours. install/cloudflare.sh prints the count
# before and after a change, and install/test/bic-lib-test.sh asserts the list
# comes out of a full up / re-run / remove cycle byte-for-byte unchanged.
ok_bic_other_rules() {
  local mine
  mine=$(ok_bic_find_rule "$1" "$2") || return 1
  jq -r --arg m "$mine" '
    ((.result // .).rules // [])[]
    | select((.id // "") != $m or $m == "")
    | "\(.id // "")\t\(.description // .action // "")"
  ' <<<"$1" 2>/dev/null
}

# ok_bic_is_1010 "<http code>|<redirect url>|<content type>" [BODY FILE] — true
# when Cloudflare's Browser Integrity Check turned the caller away, as opposed to
# the Access sign-in (ok_api_bypass_at_cloudflare) or the app's own JSON refusal.
# BIC answers 403 with an HTML body; when the body is readable, error 1010 (or
# the "browser signature" wording) settles it beyond doubt.
ok_bic_is_1010() {
  local c rest loc ctype body=${2-}
  c=${1%%|*}; rest=${1#*|}; loc=${rest%%|*}; ctype=${rest#*|}
  case "$ctype" in application/json*) return 1 ;; esac   # the app always answers JSON
  case "$loc" in *cloudflareaccess.com*) return 1 ;; esac # that is the sign-in, not BIC
  [ "$c" = 403 ] || return 1
  if [ -n "$body" ] && [ -s "$body" ]; then
    grep -qiE 'error (code )?1010|browser.?s signature|browser signature' "$body" && return 0
    grep -qiE 'cloudflare' "$body" && return 0
    return 1
  fi
  case "$ctype" in text/html*) return 0 ;; esac
  return 1
}

# ok_bic_error_hint ERRORS_JSON — the plain-language next step for a Cloudflare
# refusal on the rulesets API, or nothing when it is not a refusal we know.
# Keeps the two look-alike causes apart: a token missing the Config Rules
# permission, and a zone with no room left for another Configuration Rule.
ok_bic_error_hint() {
  local e=$1
  if jq -e '[.errors[]? | select(.code == 10000 or .code == 9109
        or ((.message // "") | test("authenticat|permission|unauthori|not allowed|forbidden"; "i")))] | length > 0' <<<"$e" >/dev/null 2>&1; then
    printf 'the Cloudflare API token cannot write Configuration Rules. Edit the token and add "Zone -> Config Rules -> Edit" on this zone (INSTALL.md lists every permission the installer needs), then re-run.'
    return 0
  fi
  if jq -e '[.errors[]? | select(((.message // "") | test("plan|quota|exceed|limit|not available|upgrade|entitle"; "i")))] | length > 0' <<<"$e" >/dev/null 2>&1; then
    printf 'this Cloudflare zone cannot take another Configuration Rule (plan limit or entitlement). Free a slot under Rules -> Configuration Rules in the dashboard, or set API_BROWSER_INTEGRITY_EXCEPTION="off" in client.conf and switch Browser Integrity Check off for the zone by hand.'
    return 0
  fi
  return 1
}
