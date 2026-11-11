#!/usr/bin/env bash
# install/b2-setup.sh — switch on off-site backups to Backblaze B2, interactively.
#
#   sudo bash install/b2-setup.sh --config client.conf [--yes] [--skip-first-backup] [--dry-run]
#
# Run it in YOUR OWN terminal on the server (ssh -t …), never through a chat:
# it asks for the B2 application key. install.sh offers it at the end of an
# interactive install when BACKUP_TARGET is empty (Enter = skip).
#
# It asks for:
#   1. the B2 keyID and applicationKey (the key is read hidden: never echoed,
#      never on a command line, never written to a log)
#   2. the bucket (pre-filled when the key is limited to one bucket) and a
#      folder inside it (default: operationkit)
# and then:
#   * checks the key against Backblaze (b2_authorize_account): accepted, limited
#     to that bucket, and able to list, read, write and delete files (restic
#     needs all four; `forget`/`prune` delete old snapshots)
#   * takes the S3 endpoint from Backblaze's answer, writes
#     BACKUP_TARGET="s3:<endpoint>/<bucket>/<folder>" into client.conf (no
#     secret in there), and the two keys into secrets/stack.env (mode 600) as
#     OK_BACKUP_ACCESS_KEY_ID / OK_BACKUP_SECRET_ACCESS_KEY — the same names
#     install/backup.sh reads and the --secrets-file hand-over writes
#   * re-writes the ONE nightly job (/etc/cron.d/operationkit-backup): it does
#     the local copy and the off-site send together, so there is never a
#     second timer
#   * sends the first snapshot and runs the restore test (backup.sh verify),
#     then prints a one-line result. Details: INSTALL_DIR/logs/b2-setup.log
#
# Not interactive (no terminal, e.g. run by Claude Code over plain ssh): prints
# how to run it later and exits 0 without asking anything. Safe to re-run: an
# existing setup is kept unless you choose to replace the key.
set -euo pipefail
# shellcheck source=install/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

CONFIG=; ASSUME_YES=0; FIRST_BACKUP=1
while [ $# -gt 0 ]; do
  case "$1" in
    --config) shift; CONFIG=${1:-} ;;
    --yes) ASSUME_YES=1 ;;
    --skip-first-backup) FIRST_BACKUP=0 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,33p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
  shift
done
[ -n "$CONFIG" ] || die "--config <file> is required"
[ -f "$CONFIG" ] || die "config file not found: $CONFIG"
CONFIG=$(cd "$(dirname "$CONFIG")" && pwd)/$(basename "$CONFIG")
export DRY_RUN
conf_load "$CONFIG"; conf_validate; ok_paths

LATER="sudo bash $OK_LIB_DIR/b2-setup.sh --config $CONFIG"
# A terminal on both ends, or the test hook. Checked BEFORE anything else so a
# non-interactive caller is never left waiting on a prompt.
if ! { [ "${OK_B2_ASSUME_TTY:-0}" = 1 ] || { [ -t 0 ] && [ -t 1 ]; }; }; then
  log "Off-site backup setup skipped (not an interactive terminal). To set it up later, in your own terminal:"
  log "  ssh -t <server> $LATER"
  exit 0
fi
require_root

B2_API=${OK_B2_API_BASE:-https://api.backblazeb2.com}
LOGFILE=$OK_DIR/logs/b2-setup.log
NEEDED_CAPS=(listBuckets listFiles readFiles writeFiles deleteFiles)

ask() { # PROMPT DEFAULT → answer on stdout (prompt goes to stderr)
  local a
  printf '%s' "$1" >&2
  IFS= read -r a || a=
  printf '%s' "${a:-$2}"
}
yes_no() { # PROMPT → 0 for y/yes
  case "$(ask "$1" n | tr '[:upper:]' '[:lower:]')" in y|yes) return 0 ;; *) return 1 ;; esac
}

step "Off-site backups (Backblaze B2 + restic)"
current=$(conf BACKUP_TARGET)
have_keys=0
[ -n "$(env_get "$OK_SECRETS_ENV" OK_BACKUP_ACCESS_KEY_ID)" ] && [ -n "$(env_get "$OK_SECRETS_ENV" OK_BACKUP_SECRET_ACCESS_KEY)" ] && have_keys=1
if [ -n "$current" ] && [ "$have_keys" -eq 1 ]; then
  log "  already set up: $current"
  if ! yes_no "  Replace the B2 key or bucket? [y/N] "; then
    log "  kept as it is. Restore test: sudo bash $OK_LIB_DIR/backup.sh verify --config $CONFIG"
    exit 0
  fi
elif [ "$ASSUME_YES" -eq 0 ]; then
  cat >&2 <<'EOF'

  Nightly backups are kept on THIS server. A copy off the server survives losing it.
  Backblaze B2 costs about $6.95 per TB per month, the first 10 GB are free; a small
  team's year of nightly backups usually stays inside the free part.
  You need (INSTALL.md, "Backups and restore"): a PRIVATE bucket and an application
  key limited to that bucket with Read and Write access.

EOF
  if ! yes_no "  Set up off-site backups to Backblaze B2 now? [y/N] (Enter = skip) "; then
    log "  skipped. Backups stay on this server only. Later: $LATER"
    exit 0
  fi
fi

# ── 1. the key (hidden) ───────────────────────────────────────────────────────
kid=$(ask "  B2 keyID: " "")
kid=${kid//[[:space:]]/}
printf '  B2 applicationKey (typing is hidden): ' >&2
IFS= read -rs appkey || appkey=
printf '\n' >&2
appkey=${appkey//[[:space:]]/}
[[ "$kid" =~ ^[A-Za-z0-9]{10,40}$ ]] || die "that keyID does not look like a B2 keyID (letters and digits, from Application Keys in the B2 web app)"
[[ "$appkey" =~ ^[A-Za-z0-9/+=_-]{20,100}$ ]] || die "that applicationKey does not look right (it is shown once, when the key is created; make a new key if it is lost)"

# ── 2. check it with Backblaze ────────────────────────────────────────────────
# The credentials go to curl in a config read from stdin (-K -), so they are
# never on a command line (ps) and never in a log. The answer holds a session
# token, so it is parsed here and never printed.
log "  checking the key with Backblaze"
resp=$( { printf 'header = "Authorization: Basic %s"\n' "$(printf '%s:%s' "$kid" "$appkey" | base64 -w0)"; } \
  | curl -sS --max-time 30 -K - -w '\n%{http_code}' "$B2_API/b2api/v2/b2_authorize_account" 2>/dev/null) \
  || die "could not reach Backblaze ($B2_API). Check the server's internet access, then re-run: $LATER"
code=${resp##*$'\n'}; body=${resp%$'\n'*}; unset resp
case "$code" in
  200) ;;
  401) die "Backblaze did not accept this keyID / applicationKey. Check both (the applicationKey is shown only once), then re-run." ;;
  *) die "Backblaze answered HTTP $code. Try again in a minute: $LATER" ;;
esac
s3url=$(jq -r '.s3ApiUrl // empty' <<<"$body")
key_bucket=$(jq -r '.allowed.bucketName // empty' <<<"$body")
prefix=$(jq -r '.allowed.namePrefix // empty' <<<"$body")
caps=" $(jq -r '(.allowed.capabilities // []) | join(" ")' <<<"$body") "
unset body
missing=()
for c in "${NEEDED_CAPS[@]}"; do [[ "$caps" == *" $c "* ]] || missing+=("$c"); done
[ "${#missing[@]}" -eq 0 ] || die "this key cannot ${missing[*]}. Create the key with 'Read and Write' access (restic needs listBuckets, listFiles, readFiles, writeFiles, deleteFiles), then re-run."
[[ "$s3url" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] || die "Backblaze did not return a usable S3 endpoint for this key"
pass "key accepted; it can list, read, write and delete files"

# ── 3. bucket + folder ────────────────────────────────────────────────────────
if [ -n "$key_bucket" ]; then
  bucket=$(ask "  Bucket [$key_bucket]: " "$key_bucket")
  [ "$bucket" = "$key_bucket" ] || die "this key is limited to the bucket '$key_bucket', not '$bucket'"
  pass "key is limited to the bucket '$bucket' (good: it cannot touch any other bucket)"
else
  warn "this key can reach EVERY bucket in the account. A key limited to one bucket is safer (INSTALL.md, Backups)."
  bucket=$(ask "  Bucket: " "")
fi
[[ "$bucket" =~ ^[A-Za-z0-9-]{6,63}$ ]] || die "'$bucket' is not a B2 bucket name (6-63 letters, digits, dashes)"
folder=$(ask "  Folder inside the bucket [${prefix:-}operationkit]: " "${prefix:-}operationkit")
folder=${folder#/}; folder=${folder%/}
if ! [[ "$folder" =~ ^[A-Za-z0-9._/-]{1,100}$ ]] || [[ "$folder" == *..* ]]; then
  die "the folder may use letters, digits, '.', '_', '-' and '/' only"
fi
[ -z "$prefix" ] || [[ "$folder" == "$prefix"* ]] || die "this key only reaches files that start with '$prefix'; choose a folder under it"
target="s3:$s3url/$bucket/$folder"

# ── 4. save ───────────────────────────────────────────────────────────────────
step "Saving"
if [ "$DRY_RUN" -eq 1 ]; then
  log "  [dry-run] would set BACKUP_TARGET=\"$target\" in $CONFIG and store the two keys in $OK_SECRETS_ENV"
  unset appkey kid
  exit 0
fi
install -d -m 700 "$OK_SECRETS"
env_set "$OK_SECRETS_ENV" OK_BACKUP_ACCESS_KEY_ID "$kid"
env_set "$OK_SECRETS_ENV" OK_BACKUP_SECRET_ACCESS_KEY "$appkey"
unset appkey kid
secret_ensure OK_BACKUP_PASSWORD rand_hex
chmod 600 "$OK_SECRETS_ENV"
log "  OK_BACKUP_ACCESS_KEY_ID, OK_BACKUP_SECRET_ACCESS_KEY: stored in $OK_SECRETS_ENV (mode 600)"
conf_set "$CONFIG" BACKUP_TARGET "$target"
log "  BACKUP_TARGET=\"$target\" written to $CONFIG"

if ! command -v restic >/dev/null 2>&1; then
  log "  installing restic"
  apt-get -o Acquire::Retries=3 install -y -qq restic >/dev/null 2>&1 || die "restic could not be installed (sudo apt-get install restic), then re-run"
fi

# One scheduler: re-write the same nightly cron job (local copy + off-site send).
bash "$OK_LIB_DIR/backup.sh" install-cron --config "$CONFIG" | sed 's/^/  /'
other=$(systemctl list-timers --all --no-legend 2>/dev/null | grep -iE 'b2|restic|backup' | grep -v operationkit || true)
[ -z "$other" ] || warn "another backup timer is active on this server: $(awk '{print $(NF-1)}' <<<"$other" | tr '\n' ' ')— the built-in nightly job now sends the off-site copy, so disable the other one (systemctl disable --now <timer>) to avoid two backups a night."

# ── 5. first snapshot + restore test ──────────────────────────────────────────
result="first backup skipped (--skip-first-backup)"
if [ "$FIRST_BACKUP" -eq 1 ]; then
  install -d -m 755 "$OK_DIR/logs"
  step "First off-site snapshot + restore test (log: $LOGFILE)"
  { echo "== $(date -u +%FT%TZ) b2-setup"; } >> "$LOGFILE"
  if bash "$OK_LIB_DIR/backup.sh" run --label nightly --config "$CONFIG" >> "$LOGFILE" 2>&1; then
    snap=$(grep -o 'restic snapshot [^)]*' "$LOGFILE" | tail -1 | awk '{print $3}')
    if bash "$OK_LIB_DIR/backup.sh" verify --config "$CONFIG" >> "$LOGFILE" 2>&1; then
      result="first snapshot ${snap:-?} sent, restore test PASS"
    else
      result="first snapshot ${snap:-?} sent, restore test FAIL (see $LOGFILE)"
    fi
  else
    result="first backup FAILED (see $LOGFILE)"
  fi
  chmod 600 "$LOGFILE"
fi
printf '\nOff-site backups: ON -> %s | %s | nightly at %s\n' "$target" "$result" "$(conf BACKUP_TIME 03:30)"
cat <<EOF
  Save the backup password in a password manager NOW (without it the off-site copies
  cannot be read). Read it in YOUR terminal only:
    ssh -t <server> sudo grep ^OK_BACKUP_PASSWORD= $OK_SECRETS_ENV
EOF
case "$result" in *FAIL*) exit 1 ;; esac
exit 0
