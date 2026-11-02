#!/usr/bin/env bash
# Exercise install/b2-setup.sh and install/backup.sh (retention, verify) against
# install/test/b2-mock.mjs and a fake restic. No root, no network, no real
# Backblaze account, fake sample keys only.   bash install/test/b2-setup-test.sh
#
# Covers: the prompt is skipped when not interactive; Enter skips; a bad key, a
# key without delete and a wrong bucket are refused; the application key never
# appears in output, logs, curl's argv or client.conf; BACKUP_TARGET lands in
# client.conf (mode kept) and the keys in stack.env (mode 600); exactly one
# nightly job; retention settings reach restic forget; verify prints PASS and
# FAIL; a re-run is idempotent.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
INST=$HERE/..
WORK=$(mktemp -d); MOCK=
trap '[ -z "$MOCK" ] || kill "$MOCK" 2>/dev/null || true; rm -rf "$WORK"' EXIT
PORT=$((20000 + RANDOM % 20000))
PORT=$PORT node "$HERE/b2-mock.mjs" > "$WORK/mock.log" 2>&1 & MOCK=$!
for _ in $(seq 50); do curl -fs "http://127.0.0.1:$PORT/__state" >/dev/null 2>&1 && break; sleep 0.1; done

KID=000000000000000000000001a
KEY=fakekeyfakekeyfakekeyfakekey11
KID_NODELETE=000000000000000000000002a
KEY_NODELETE=fakekeyfakekeyfakekeyfakekey22
WANT_TARGET=s3:https://s3.us-west-004.backblazeb2.com/ok-test-bucket/operationkit

fails=0
check() { if [ "$2" = "$3" ]; then echo "  PASS  $1"; else echo "  FAIL  $1 (got '$2', want '$3')"; fails=$((fails+1)); fi; }
count() { grep -c -- "$1" "$2" 2>/dev/null || true; }

# ── a fake install: config, secrets, a small database, home ──────────────────
OK=$WORK/ok
mkdir -p "$OK/state/data" "$OK/state/home/projects" "$OK/secrets" "$OK/logs" "$WORK/bin" "$WORK/repo"
chmod 700 "$OK/secrets"
sed -e "s#^INSTALL_DIR=.*#INSTALL_DIR=\"$OK\"#" "$INST/client.conf.example" > "$WORK/client.conf"
chmod 640 "$WORK/client.conf"
printf 'OK_BACKUP_PASSWORD=%s\n' "fake-restic-password-for-tests" > "$OK/secrets/stack.env"; chmod 600 "$OK/secrets/stack.env"
echo "note" > "$OK/state/home/projects/readme.txt"
SQL="CREATE TABLE workspaces(id); CREATE TABLE users(id); CREATE TABLE objectives(id); CREATE TABLE projects(id);
INSERT INTO workspaces VALUES(1); INSERT INTO users VALUES(1),(2); INSERT INTO objectives VALUES(1),(2),(3);"
if command -v sqlite3 >/dev/null 2>&1; then sqlite3 "$OK/state/data/command-center.db" "$SQL"
elif command -v python3 >/dev/null 2>&1; then python3 -I -c 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.executescript(sys.argv[2]); c.commit()' "$OK/state/data/command-center.db" "$SQL"
else node --no-warnings -e 'const {DatabaseSync}=require("node:sqlite"); new DatabaseSync(process.argv[1]).exec(process.argv[2])' "$OK/state/data/command-center.db" "$SQL"; fi

# ── shims: root without root, no docker, a recording curl, a fake restic ──────
REAL_CURL=$(command -v curl)
cat > "$WORK/bin/id" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = -u ]; then echo 0; else exec /usr/bin/id "$@"; fi
EOF
printf '#!/usr/bin/env bash\nexit 1\n' > "$WORK/bin/docker"
cat > "$WORK/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
[ -z "${FAKE_TIMERS:-}" ] || printf 'Mon 2026-11-02 04:00:00 UTC 4h - - %s b2-backup.service\n' "$FAKE_TIMERS"
EOF
cat > "$WORK/bin/curl" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$WORK/curl-argv.log"
exec "$REAL_CURL" "\$@"
EOF
cat > "$WORK/bin/restic" <<'EOF'
#!/usr/bin/env bash
# Fake restic: a folder per snapshot under $FAKE_REPO. Logs the arguments and
# whether the credentials arrived (compared here, never logged).
set -euo pipefail
creds=bad
[ "${AWS_ACCESS_KEY_ID:-}" = "$FAKE_EXPECT_KID" ] && [ "${AWS_SECRET_ACCESS_KEY:-}" = "$FAKE_EXPECT_KEY" ] \
  && [ -r "${RESTIC_PASSWORD_FILE:-/nonexistent}" ] && [ "$RESTIC_REPOSITORY" = "$FAKE_EXPECT_TARGET" ] && creds=ok
echo "creds=$creds $*" >> "$FAKE_REPO/restic.log"
[ "$creds" = ok ] || { echo "Fatal: wrong credentials" >&2; exit 1; }
cmd=$1; shift
case "$cmd" in
  cat) [ -f "$FAKE_REPO/config" ] ;;
  init) touch "$FAKE_REPO/config" ;;
  backup) dir=${*: -1}; n=$(find "$FAKE_REPO" -maxdepth 1 -name 'snap-*' | wc -l); mkdir -p "$FAKE_REPO/snap-$n$dir"; cp -a "$dir/." "$FAKE_REPO/snap-$n$dir/" ;;
  forget|check) [ "$cmd" != check ] || [ "${FAKE_RESTIC_CORRUPT:-0}" = 0 ] ;;
  snapshots) if [[ " $* " == *" --json "* ]]; then echo '[{"short_id":"f00dfeed"}]'; else echo "f00dfeed  nightly"; fi ;;
  restore) t=; while [ $# -gt 0 ]; do [ "$1" = --target ] && t=$2; shift; done
           last=$(find "$FAKE_REPO" -maxdepth 1 -name 'snap-*' | sort | tail -1); [ -n "$last" ] || exit 1
           cp -a "$last/." "$t/"
           if [ "${FAKE_RESTIC_CORRUPT:-0}" = 1 ]; then f=$(find "$t" -name command-center.db | head -1); printf 'garbage' > "$f"; fi ;;
  *) echo "fake restic: unsupported $cmd" >&2; exit 1 ;;
esac
EOF
chmod +x "$WORK/bin/"*
export PATH="$WORK/bin:$PATH" OK_B2_API_BASE="http://127.0.0.1:$PORT" OK_CRON_FILE="$WORK/cron.d-operationkit-backup"
export FAKE_REPO=$WORK/repo FAKE_EXPECT_KID=$KID FAKE_EXPECT_KEY=$KEY FAKE_EXPECT_TARGET=$WANT_TARGET
B2="$INST/b2-setup.sh"; BK="$INST/backup.sh"; CONF=$WORK/client.conf
conf_val() { sed -n "s/^$1=\"\(.*\)\"$/\1/p" "$CONF"; }

echo "== not interactive: no prompt, nothing changes"
out=$(bash "$B2" --config "$CONF" < /dev/null 2>&1) && rc=0 || rc=$?
check "exits 0" "$rc" 0
check "says it was skipped and how to run it later" "$(grep -c 'skipped (not an interactive terminal)' <<<"$out")" 1
check "BACKUP_TARGET still empty" "$(conf_val BACKUP_TARGET)" ""
check "install.sh only offers it in a terminal" "$(grep -c '\[ -t 0 \] && \[ -t 1 \]; then' "$INST/../install.sh")" 1

export OK_B2_ASSUME_TTY=1
echo "== interactive, Enter = skip"
out=$(printf '\n' | bash "$B2" --config "$CONF" 2>&1) && rc=0 || rc=$?
check "exits 0" "$rc" 0
check "skipped" "$(grep -c 'skipped. Backups stay on this server only' <<<"$out")" 1
check "BACKUP_TARGET still empty" "$(conf_val BACKUP_TARGET)" ""

echo "== wrong key is refused, and never printed"
out=$(printf 'y\n%s\n%s\n' "$KID" "fakekeyWRONGfakekeyWRONGfakekey" | bash "$B2" --config "$CONF" 2>&1) && rc=0 || rc=$?
check "exits non-zero" "$([ "$rc" -ne 0 ] && echo yes)" yes
check "plain message" "$(grep -c 'did not accept this keyID' <<<"$out")" 1
check "wrong key not echoed" "$(grep -c 'WRONG' <<<"$out" || true)" 0

echo "== key without deleteFiles is refused"
out=$(printf 'y\n%s\n%s\n' "$KID_NODELETE" "$KEY_NODELETE" | bash "$B2" --config "$CONF" 2>&1) && rc=0 || rc=$?
check "exits non-zero" "$([ "$rc" -ne 0 ] && echo yes)" yes
check "names the missing capability" "$(grep -c 'cannot deleteFiles' <<<"$out")" 1

echo "== bucket other than the key's is refused"
out=$(printf 'y\n%s\n%s\nsome-other-bucket\n' "$KID" "$KEY" | bash "$B2" --config "$CONF" 2>&1) && rc=0 || rc=$?
check "exits non-zero" "$([ "$rc" -ne 0 ] && echo yes)" yes
check "says which bucket the key is limited to" "$(grep -c "limited to the bucket 'ok-test-bucket'" <<<"$out")" 1
check "nothing written yet" "$(conf_val BACKUP_TARGET)" ""

echo "== good key: saved, scheduled once, first snapshot, restore test"
out=$(printf 'y\n%s\n%s\n\n\n' "$KID" "$KEY" | FAKE_TIMERS=b2-backup.timer bash "$B2" --config "$CONF" 2>&1) && rc=0 || rc=$?
printf '%s\n' "$out" | sed 's/^/    /'
check "exits 0" "$rc" 0
check "BACKUP_TARGET written to client.conf" "$(conf_val BACKUP_TARGET)" "$WANT_TARGET"
check "client.conf keeps its mode" "$(stat -c %a "$CONF")" 640
check "client.conf holds no key" "$(count "$KEY" "$CONF")" 0
check "key ID stored in stack.env" "$(grep -c "^OK_BACKUP_ACCESS_KEY_ID=$KID\$" "$OK/secrets/stack.env")" 1
check "application key stored in stack.env" "$(grep -c "^OK_BACKUP_SECRET_ACCESS_KEY=$KEY\$" "$OK/secrets/stack.env")" 1
check "stack.env is mode 600" "$(stat -c %a "$OK/secrets/stack.env")" 600
check "backup password kept" "$(grep -c '^OK_BACKUP_PASSWORD=fake-restic-password-for-tests$' "$OK/secrets/stack.env")" 1
check "application key never printed" "$(grep -c "$KEY" <<<"$out" || true)" 0
check "application key not in any log" "$(grep -rl "$KEY" "$OK/logs" "$WORK/repo/restic.log" 2>/dev/null | wc -l)" 0
check "application key never on curl's command line" "$(count "$KEY" "$WORK/curl-argv.log")" 0
check "Backblaze got the right key (via the header)" "$(curl -fs "http://127.0.0.1:$PORT/__state" | jq -r '.[-1]|"\(.id) \(.ok)"')" "$KID true"
check "session token never printed" "$(grep -c 'MOCK-SESSION-TOKEN' <<<"$out" || true)" 0
check "exactly one nightly job" "$(grep -c 'backup.sh run --label nightly' "$OK_CRON_FILE")" 1
check "warns about a second, hand-made timer" "$(grep -c 'another backup timer is active' <<<"$out")" 1
check "restic got the credentials every time" "$(count 'creds=bad' "$WORK/repo/restic.log")" 0
check "first snapshot sent" "$(count 'creds=ok backup' "$WORK/repo/restic.log")" 1
check "default retention 7/4/6" "$(grep -c -- '--keep-daily 7 --keep-weekly 4 --keep-monthly 6' "$WORK/repo/restic.log")" 1
check "one-line result" "$(grep -c "^Off-site backups: ON -> $WANT_TARGET | first snapshot f00dfeed sent, restore test PASS" <<<"$out")" 1
check "setup log is mode 600" "$(stat -c %a "$OK/logs/b2-setup.log")" 600

echo "== re-run: keep (default) changes nothing"
cp "$CONF" "$WORK/conf.before"; cp "$OK/secrets/stack.env" "$WORK/env.before"
out=$(printf '\n' | bash "$B2" --config "$CONF" 2>&1) && rc=0 || rc=$?
check "exits 0" "$rc" 0
check "says it is already set up" "$(grep -c 'already set up' <<<"$out")" 1
check "client.conf unchanged" "$(cmp -s "$CONF" "$WORK/conf.before" && echo same)" same
check "stack.env unchanged" "$(cmp -s "$OK/secrets/stack.env" "$WORK/env.before" && echo same)" same

echo "== re-run: replace with the same key is idempotent"
out=$(printf 'y\n%s\n%s\n\n\n' "$KID" "$KEY" | bash "$B2" --config "$CONF" --skip-first-backup 2>&1) && rc=0 || rc=$?
check "exits 0" "$rc" 0
check "one BACKUP_TARGET line" "$(grep -c '^BACKUP_TARGET=' "$CONF")" 1
check "one key ID line" "$(grep -c '^OK_BACKUP_ACCESS_KEY_ID=' "$OK/secrets/stack.env")" 1
check "one application key line" "$(grep -c '^OK_BACKUP_SECRET_ACCESS_KEY=' "$OK/secrets/stack.env")" 1
check "still exactly one nightly job" "$(grep -c 'backup.sh run --label nightly' "$OK_CRON_FILE")" 1
check "key not printed on re-run" "$(grep -c "$KEY" <<<"$out" || true)" 0

echo "== retention settings are honoured"
sed -i -e 's/^BACKUP_KEEP_DAILY=.*/BACKUP_KEEP_DAILY="3"/' -e 's/^BACKUP_KEEP_WEEKLY=.*/BACKUP_KEEP_WEEKLY="2"/' -e 's/^BACKUP_KEEP_MONTHLY=.*/BACKUP_KEEP_MONTHLY="12"/' "$CONF"
bash "$BK" run --label nightly --config "$CONF" > "$WORK/run.out" 2>&1 || { cat "$WORK/run.out"; false; }
check "restic forget used 3/2/12" "$(grep -c -- '--keep-daily 3 --keep-weekly 2 --keep-monthly 12' "$WORK/repo/restic.log")" 1
sed -i 's/^BACKUP_KEEP_DAILY=.*/BACKUP_KEEP_DAILY="seven"/' "$CONF"
out=$(bash "$BK" list --config "$CONF" 2>&1) && rc=0 || rc=$?
check "a non-number is refused" "$(grep -c 'BACKUP_KEEP_DAILY must be a whole number' <<<"$out")" 1
sed -i 's/^BACKUP_KEEP_DAILY=.*/BACKUP_KEEP_DAILY="7"/' "$CONF"

echo "== verify: PASS on a good snapshot"
out=$(bash "$BK" verify --config "$CONF" 2>&1) && rc=0 || rc=$?
printf '%s\n' "$out" | sed 's/^/    /'
check "exits 0" "$rc" 0
check "prints PASS" "$(grep -c '^RESTORE TEST: PASS' <<<"$out")" 1
check "integrity checked" "$(grep -c 'PASS  database integrity_check: ok' <<<"$out")" 1
check "row counts shown" "$(grep -c 'workspaces 1, users 2, objectives 3' <<<"$out")" 1
check "scratch copy removed" "$(find "$OK/backups" -maxdepth 1 -name '.verify-*' | wc -l)" 0

echo "== verify: FAIL on a damaged snapshot"
out=$(FAKE_RESTIC_CORRUPT=1 bash "$BK" verify --config "$CONF" 2>&1) && rc=0 || rc=$?
check "exits non-zero" "$([ "$rc" -ne 0 ] && echo yes)" yes
check "prints FAIL" "$(grep -c '^RESTORE TEST: FAIL' <<<"$out")" 1
check "scratch copy removed after FAIL" "$(find "$OK/backups" -maxdepth 1 -name '.verify-*' | wc -l)" 0

echo "== verify without BACKUP_TARGET checks the newest local backup"
sed -i 's/^BACKUP_TARGET=.*/BACKUP_TARGET=""/' "$CONF"
out=$(bash "$BK" verify --config "$CONF" 2>&1) && rc=0 || rc=$?
check "exits 0" "$rc" 0
check "local restore test PASS" "$(grep -c '^RESTORE TEST: PASS.*on this server' <<<"$out")" 1

echo
if [ "$fails" -eq 0 ]; then echo "b2-setup-test: all checks passed"; else echo "b2-setup-test: $fails check(s) FAILED"; exit 1; fi
