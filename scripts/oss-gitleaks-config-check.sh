#!/usr/bin/env bash
#
# oss-gitleaks-config-check.sh — negative control for the publish gitleaks config.
#
# The allowlist in scripts/oss-gitleaks.toml exists to silence fake unit-test
# fixtures. The failure mode it must never have is silencing a REAL secret: an
# over-broad regex (or a gitleaks semantics surprise) that blinds a whole rule.
# The unit test (oss-gitleaks-allowlist.test.ts) checks the regexes in isolation;
# this script checks the config the way the gate actually uses it — through the
# pinned gitleaks binary, with the config auto-discovered as ./.gitleaks.toml.
#
# Method (differential, so it needs no knowledge of gitleaks' rule regexes):
#   1. Generate real-shaped secrets at runtime (random, full length, high entropy),
#      one per default rule family the fixtures resemble. Nothing secret-shaped is
#      committed in this file.
#   2. Scan them with defaults only     -> must hit EVERY expected rule (no vacuous pass).
#   3. Scan them with the config under test -> must hit exactly the same findings.
#   Any finding present in (2) but missing in (3) means the allowlist hides a real
#   secret, and this exits 1.
#
# Why step 2 retries (obj 900306):
#   gitleaks' `generic-api-key` rule drops any match containing one of its default
#   STOPWORDS (`gulp`, `auto`, `good`, `smtp`, ...). The 40-char random value in the
#   `client_secret` plant contains such a substring by chance about 1.4% of the time
#   (measured: 7 vacuous in 500 runs), and this script runs TWICE per PR - once as the
#   `gitleaks-config` job and once inside `oss-public-tree` - so roughly one PR in 35
#   went red on "control is vacuous: defaults did not fire ['generic-api-key']" with
#   nothing actually wrong. Observed on run 42515864712, where the two invocations of
#   THIS script on the SAME commit disagreed.
#
#   So a VACUOUS control (step 2 incomplete) is retried with a fresh random draw, up
#   to MAX_ATTEMPTS. A HIDDEN secret (step 3 - the finding this script exists for) is
#   NEVER retried and fails immediately, and exhausting every attempt still fails.
#   This makes the control reliable without making it weaker.
#
# Usage: scripts/oss-gitleaks-config-check.sh [config.toml]
#   default config: scripts/oss-gitleaks.toml   GITLEAKS_BIN defaults to `gitleaks`.
set -euo pipefail

CONFIG="${1:-$(dirname "$0")/oss-gitleaks.toml}"
GITLEAKS_BIN="${GITLEAKS_BIN:-gitleaks}"
[ -f "$CONFIG" ] || { echo "config not found: $CONFIG" >&2; exit 2; }
CONFIG="$(cd "$(dirname "$CONFIG")" && pwd)/$(basename "$CONFIG")"

# One full draw: generate fresh plants, scan both ways, compare.
# Exit 0 = pass, 3 = vacuous control (retryable), 1 = config hides a real secret (fatal).
MAX_ATTEMPTS="${MAX_ATTEMPTS:-8}"

attempt_once() {
  WORK="$(mktemp -d -t oss-gl-check-XXXXXX)"
  mkdir -p "$WORK/default" "$WORK/config"

python3 - "$WORK/default" <<'PY'
import base64, json, secrets, string, sys
A = string.ascii_letters + string.digits
def r(n, al=A): return ''.join(secrets.choice(al) for _ in range(n))
def b64u(b): return base64.urlsafe_b64encode(b).rstrip(b'=').decode()
hdr = b64u(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
pay = b64u(json.dumps({"role": "service_role", "sub": r(12)}).encode())
body = base64.b64encode(secrets.token_bytes(900)).decode()
pem = ("-----BEGIN RSA PRIVATE " "KEY-----\n"
       + '\n'.join(body[i:i+64] for i in range(0, len(body), 64))
       + "\n-----END RSA PRIVATE " "KEY-----")
plants = [
  "const t = 'ghp_" + r(36) + "';",
  "const t = 'gho_" + r(36) + "';",
  "const t = 'ghs_" + r(36) + "';",
  "const t = 'sk_live_" + r(32) + "';",
  "const t = 'AIza" + r(35, A + '-_') + "';",
  "const t = 'xoxb-" + r(12, string.digits) + "-" + r(12, string.digits) + "-" + r(24) + "';",
  "const t = 'AKIA" + r(16, string.ascii_uppercase + '234567') + "';",
  "const t = 'sk-" + r(20) + "T3Blbk" + "FJ" + r(20) + "';",
  "const t = '" + hdr + "." + pay + "." + b64u(secrets.token_bytes(32)) + "';",
  'client_secret: "' + r(40) + '"',
  # Escaped-\n PEM inside a TS string: the same shape the redaction fixtures use.
  "const k = '" + pem.replace('\n', '\\n') + "';",
]
out = sys.argv[1]
open(out + '/plant.ts', 'w').write('\n\n'.join(plants) + '\n')
open(out + '/plant.pem', 'w').write(pem + '\n')
PY
cp "$WORK/default/plant.ts" "$WORK/default/plant.pem" "$WORK/config/"
printf '[extend]\nuseDefault = true\n' > "$WORK/default/.gitleaks.toml"
cp "$CONFIG" "$WORK/config/.gitleaks.toml"

# Same invocation as the gate: --no-git tree scan, config discovered from cwd.
scan() {
  (cd "$WORK/$1" && "$GITLEAKS_BIN" detect --no-git --source . --redact --exit-code 0 \
     --report-format json --report-path "$WORK/$1.json" >/dev/null 2>&1)
}
scan default
scan config

  # Only the comparison is allowed to exit non-zero; everything above it must still
  # abort loudly under errexit.
  set +e
python3 - "$WORK/default.json" "$WORK/config.json" <<'PY'
import json, sys
EXPECTED = {'github-pat', 'github-oauth', 'github-app-token', 'stripe-access-token',
            'gcp-api-key', 'slack-bot-token', 'aws-access-token', 'openai-api-key',
            'jwt', 'generic-api-key', 'private-key'}
def load(p):
    return {(f['File'], f['StartLine'], f['RuleID']) for f in json.load(open(p))
            if f['File'].startswith('plant.')}
default, config = load(sys.argv[1]), load(sys.argv[2])
fail = 0
missing_rules = EXPECTED - {rule for _, _, rule in default}
if missing_rules:
    print(f"  ~ control is vacuous: defaults did not fire {sorted(missing_rules)}")
    fail = 3   # retryable: the control was never established, so nothing is known yet
hidden = sorted(default - config)
for f, line, rule in hidden:
    print(f"  ✗ config hides a real-shaped secret: {rule} ({f}:{line})")
if hidden:
    fail = 1   # NOT retryable: this is the real finding
if not fail:
    print(f"  ✓ gitleaks config hides none of {len(default)} real-shaped secrets "
          f"({len(EXPECTED)} rule families)")
sys.exit(fail)
PY
  rc=$?
  set -e
  rm -rf "$WORK"
  return "$rc"
}

for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
  rc=0
  attempt_once || rc=$?
  case "$rc" in
    0) exit 0 ;;
    3) echo "    (attempt $attempt/$MAX_ATTEMPTS produced a vacuous control - redrawing)" ;;
    *) exit "$rc" ;;
  esac
done

echo "  ✗ control is STILL vacuous after $MAX_ATTEMPTS independent draws." >&2
echo "    That is far past chance - treat it as a real regression in the default" >&2
echo "    ruleset or the plant generator, not as the known stopword flake." >&2
exit 1
