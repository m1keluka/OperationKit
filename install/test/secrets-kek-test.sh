#!/usr/bin/env bash
# Sprint 6b secrets (obj 900540): installer side of D2 and D5. No root, no
# Docker, fake keys only.   bash install/test/secrets-kek-test.sh
#
# D2 kek_file_ensure: writes secrets/secrets-kek from the existing
#   SECRETS_MASTER_KEY (same key, so stored secrets still decrypt), mode 400,
#   never prints the value, is a no-op on re-run, and STOPS when the file and
#   stack.env disagree. The compose file mounts it read-only into the app only
#   and no longer passes SECRETS_MASTER_KEY as an environment variable.
# D5 audit_retention_cron_ensure: one monthly job that runs the app's retention
#   script with --apply.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
INST=$HERE/..
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

fails=0
check() { if [ "$2" = "$3" ]; then echo "  PASS  $1"; else echo "  FAIL  $1 (got '$2', want '$3')"; fails=$((fails+1)); fi; }

# shellcheck source=install/lib.sh
source "$INST/lib.sh"
DRY_RUN=0
OK_DIR=$WORK/ok
OK_STATE=$OK_DIR/state
OK_SECRETS=$OK_DIR/secrets
OK_SECRETS_ENV=$OK_SECRETS/stack.env
mkdir -p "$OK_SECRETS"; chmod 700 "$OK_SECRETS"
FAKE_KEY=$(printf 'fake-kek-for-tests-only-01234567' | base64)   # 32 bytes, base64
printf 'SECRETS_MASTER_KEY=%s\nOTHER=1\n' "$FAKE_KEY" > "$OK_SECRETS_ENV"; chmod 600 "$OK_SECRETS_ENV"

echo "D2: KEK host file"
out=$(kek_file_ensure 2>&1)
check "file created" "$([ -f "$OK_SECRETS/secrets-kek" ] && echo yes)" yes
check "mode 400" "$(stat -c %a "$OK_SECRETS/secrets-kek")" 400
check "same key as stack.env (stored secrets still decrypt)" "$(tr -d '\n' < "$OK_SECRETS/secrets-kek")" "$FAKE_KEY"
check "value never printed" "$(grep -c -- "$FAKE_KEY" <<<"$out" || true)" 0
check "stack.env copy kept (rollback cannot mint a new key)" "$(env_get "$OK_SECRETS_ENV" SECRETS_MASTER_KEY)" "$FAKE_KEY"

out=$(kek_file_ensure 2>&1)
check "re-run keeps it" "$(grep -c 'kept' <<<"$out")" 1

chmod 600 "$OK_SECRETS/secrets-kek"; printf '%s\n' "$(printf 'another-fake-key-for-tests-only' | base64)" > "$OK_SECRETS/secrets-kek"
rc=0; out=$( (kek_file_ensure) 2>&1) || rc=$?
check "two different keys: stops" "$rc" 1
check "two different keys: says so" "$(grep -c 'DIFFERENT keys' <<<"$out")" 1

rm -f "$OK_SECRETS/secrets-kek"; printf 'OTHER=1\n' > "$OK_SECRETS_ENV"
rc=0; ( kek_file_ensure ) >/dev/null 2>&1 || rc=$?
check "no key anywhere: stops" "$rc" 1

DRY_RUN=1; printf 'SECRETS_MASTER_KEY=%s\n' "$FAKE_KEY" > "$OK_SECRETS_ENV"
kek_file_ensure >/dev/null
check "dry run writes nothing" "$([ -e "$OK_SECRETS/secrets-kek" ] && echo exists || echo none)" none
printf 'OTHER=1\n' > "$OK_SECRETS_ENV"   # fresh install dry run: secret_ensure wrote nothing
rc=0; ( kek_file_ensure ) >/dev/null 2>&1 || rc=$?
check "dry run on a fresh install (no key written yet) does not stop" "$rc" 0
DRY_RUN=0

echo "D2: compose wiring"
COMPOSE=$INST/docker-compose.yml
check "KEK mounted read-only at /run/secrets" "$(grep -c 'OK_KEK_FILE:?run ./install.sh}:/run/secrets/operationkit-secrets-kek:ro' "$COMPOSE")" 1
check "app pinned to the host-file provider" "$(grep -c 'SECRETS_KEK_PROVIDER: host-file' "$COMPOSE")" 1
check "SECRETS_MASTER_KEY no longer an env var of the app" "$(grep -cE '^\s+SECRETS_MASTER_KEY:' "$COMPOSE" || true)" 0
check "installer writes OK_KEK_FILE for compose (no SECRET in the name: install.env is non-secret)" "$(grep -c '^OK_KEK_FILE=\$OK_SECRETS/secrets-kek$' "$INST/../install.sh")" 1

echo "D5: retention cron"
OK_RETENTION_CRON_FILE=$WORK/cron-retention audit_retention_cron_ensure >/dev/null
check "one monthly job" "$(grep -cE '^15 4 1 \* \* root docker exec command-center tsx server/src/scripts/secrets-audit-retention.ts --apply' "$WORK/cron-retention")" 1
check "cron file mode 644" "$(stat -c %a "$WORK/cron-retention")" 644

[ "$fails" -eq 0 ] && echo "ALL PASS" || { echo "$fails FAILED"; exit 1; }
