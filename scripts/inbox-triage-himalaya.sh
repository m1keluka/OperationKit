#!/usr/bin/env bash
# Inbox triage via himalaya CLI.
#
# Empties Gmail INBOX by classifying every envelope into one of four target
# folders (Gmail labels): ACTION, FYI, AUTO, ARCHIVE.
#
# This script is designed to run on the operator's host shell (where himalaya is
# installed at /home/operator/.local/bin/himalaya), NOT inside the command-center
# container (no himalaya, no OAuth there). It will refuse to run otherwise.
#
# Classification rules (in priority order):
#   FYI      receipts, invoices, statements, financial institutions
#   AUTO     no-reply / notifications / build alerts / SaaS automation
#   ARCHIVE  marketing, promotions, bulk-mail patterns
#   ACTION   default — anything left over is treated as a real human email
#            that needs a human's attention.
#
# The script defaults to DRY RUN. You must pass --execute (or set EXECUTE=1)
# to actually move messages. The dry run logs every classification decision so
# you can sanity-check the rules before draining a real inbox.
#
# Usage:
#   inbox-triage-himalaya.sh [--execute] [--cleanup-old-folders]
#                            [--batch-size N] [--max-batches N]
#                            [--state-dir DIR] [--no-resume]
#
# Env overrides:
#   HIMALAYA           path to himalaya binary    (default: /home/operator/.local/bin/himalaya)
#   HIMALAYA_CONFIG    path to himalaya config    (default: /home/operator/.config/himalaya/config.toml)
#   ACCOUNT            himalaya account name      (default: <unset> = config default)
#   INBOX_FOLDER       source folder              (default: INBOX)
#   BATCH_SIZE         envelopes per page         (default: 50)
#   MAX_BATCHES        cap on batches per run     (default: 0 = unlimited)
#   SLEEP_BETWEEN      pause between batches sec  (default: 1)
#   STATE_DIR          checkpoint + log dir       (default: $HOME/.local/share/inbox-triage)
#   EXECUTE            "1" enables real moves     (default: dry run)
#
# Exit codes:
#   0  success — inbox is empty (or max batches reached cleanly)
#   2  preflight failure (missing himalaya, config, network, folders)
#   3  himalaya command failed mid-run; safe to re-invoke (resumes from state)
#   4  invalid CLI argument

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

HIMALAYA="${HIMALAYA:-/home/operator/.local/bin/himalaya}"
HIMALAYA_CONFIG="${HIMALAYA_CONFIG:-/home/operator/.config/himalaya/config.toml}"
ACCOUNT="${ACCOUNT:-}"
INBOX_FOLDER="${INBOX_FOLDER:-INBOX}"
BATCH_SIZE="${BATCH_SIZE:-50}"
MAX_BATCHES="${MAX_BATCHES:-0}"
SLEEP_BETWEEN="${SLEEP_BETWEEN:-1}"
STATE_DIR="${STATE_DIR:-$HOME/.local/share/inbox-triage}"
EXECUTE="${EXECUTE:-0}"
CLEANUP_OLD=0
RESUME=1

FOLDER_ACTION="ACTION"
FOLDER_FYI="FYI"
FOLDER_AUTO="AUTO"
FOLDER_ARCHIVE="ARCHIVE"

KEEP_FOLDERS=("$INBOX_FOLDER" "$FOLDER_ACTION" "$FOLDER_FYI" "$FOLDER_AUTO" "$FOLDER_ARCHIVE" \
              "[Gmail]/All Mail" "[Gmail]/Sent Mail" "[Gmail]/Drafts" "[Gmail]/Spam" "[Gmail]/Trash" \
              "[Gmail]/Starred" "[Gmail]/Important")

# ---------------------------------------------------------------------------
# CLI parsing
# ---------------------------------------------------------------------------

while [[ $# -gt 0 ]]; do
  case "$1" in
    --execute)              EXECUTE=1; shift ;;
    --dry-run)              EXECUTE=0; shift ;;
    --cleanup-old-folders)  CLEANUP_OLD=1; shift ;;
    --batch-size)           BATCH_SIZE="$2"; shift 2 ;;
    --max-batches)          MAX_BATCHES="$2"; shift 2 ;;
    --state-dir)            STATE_DIR="$2"; shift 2 ;;
    --no-resume)            RESUME=0; shift ;;
    --account)              ACCOUNT="$2"; shift 2 ;;
    --inbox)                INBOX_FOLDER="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 4
      ;;
  esac
done

mkdir -p "$STATE_DIR"
LOG_FILE="$STATE_DIR/triage-$(date +%Y%m%d-%H%M%S).log"
STATE_FILE="$STATE_DIR/state.tsv"          # tab-separated: id<TAB>destination<TAB>timestamp
CHECKPOINT_FILE="$STATE_DIR/checkpoint"    # last successfully processed envelope id

touch "$STATE_FILE"
touch "$CHECKPOINT_FILE"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

ts()  { date '+%Y-%m-%d %H:%M:%S'; }
log() { local m="[$(ts)] $*"; echo "$m"; echo "$m" >> "$LOG_FILE"; }
die() { log "FATAL: $*"; exit "${2:-2}"; }

hima() {
  local args=()
  [[ -n "$ACCOUNT" ]] && args+=(-a "$ACCOUNT")
  "$HIMALAYA" -c "$HIMALAYA_CONFIG" "${args[@]}" "$@"
}

# Lowercase helper (portable to bash 4+)
lc() { printf '%s' "${1,,}"; }

# Match a string against a pipe-separated set of extended regex alternatives.
# Returns 0 on match, 1 otherwise. Uses grep -E for reliable alternation.
matches_any() {
  local haystack="$1" pattern="$2"
  printf '%s' "$haystack" | grep -qiE -- "$pattern"
}

# ---------------------------------------------------------------------------
# Classifier
# ---------------------------------------------------------------------------
#
# classify <from> <subject>  ->  echoes one of ACTION|FYI|AUTO|ARCHIVE
#
# Patterns are extended regex. Order matters: FYI > AUTO > ARCHIVE > ACTION.
# Keep these lists tight — anything you accidentally route into AUTO/ARCHIVE
# is a real human email that won't be seen.
classify() {
  local from subj
  from="$(lc "$1")"
  subj="$(lc "$2")"

  # --- FYI: financial -----------------------------------------------------
  local fyi_from='(@|\.)(stripe|paypal|squareup|quickbooks|intuit|xero|waveapps|freshbooks|mercury|chase|amex|americanexpress|capitalone|bankofamerica|wellsfargo|ally|fidelity|vanguard|schwab|coinbase|robinhood|wise|revolut|brex|ramp|expensify|bill|venmo|cashapp|wisetransfer|plaid)\.com'
  local fyi_subj='(receipt|invoice|payment received|payment sent|payment confirmation|your payment|paid in full|account statement|monthly statement|balance summary|wire transfer|ach transfer|deposit|withdrawal|refund|tax document|w-?2|1099|charge of|you were charged|subscription renewed|order confirmation|order #|order number)'
  if matches_any "$from" "$fyi_from" || matches_any "$subj" "$fyi_subj"; then
    echo "$FOLDER_FYI"; return
  fi

  # --- AUTO: automation / no-reply / SaaS notifications -------------------
  local auto_local='^(noreply|no-reply|do-not-reply|donotreply|notifications|notification|alerts|alert|automated|system|mailer|news|newsletter|updates|hello|info|support|help|team|contact|admin|digest|reports|reply\+|bounces|postmaster|mailer-daemon)@'
  local auto_from='(@|\.)(github|gitlab|bitbucket|atlassian|jira|linear\.app|notion\.so|slack|discord|zoom\.us|asana|trello|monday|clickup|airtable|figma|loom|calendly|googlegroups|amazonaws|digitalocean|vercel|netlify|render\.com|railway\.app|supabase|sentry|datadoghq|pagerduty|cloudflare|godaddy|namecheap|squarespace|wix|wordpress|shopify|mailchimp|sendgrid|postmark|mailgun|resend|customer\.io|hubspot|salesforce|pipedrive|zoho|intercom|drift|zendesk|freshdesk|loops\.so|substack)\.(com|so|app|io|net|org)'
  local auto_subj='(verify your|confirm your|verification code|password reset|2fa|two-factor|sign-?in|signed in|new login|security alert|account alert|build (succeeded|failed)|deploy(ment)? (succeeded|failed)|pipeline (succeeded|failed)|workflow (succeeded|failed)|pull request|merge request|new comment|mentioned you|assigned you|new follower|weekly digest|monthly digest|weekly summary|monthly summary|your weekly|your monthly)'
  if matches_any "$from" "$auto_local" || matches_any "$from" "$auto_from" || matches_any "$subj" "$auto_subj"; then
    echo "$FOLDER_AUTO"; return
  fi

  # --- ARCHIVE: marketing / promo / bulk ----------------------------------
  local archive_from='^(marketing|promo|promotions|deals|sales|offers|community|events|webinars|insights|content)@'
  local archive_subj='(% off|free trial|limited time|webinar|case study|whitepaper|free ebook|free guide|exclusive offer|introducing|announcing|launching|new feature|update from|product update|tips for|trends in|recommended for you|just for you|don.t miss)'
  if matches_any "$from" "$archive_from" || matches_any "$subj" "$archive_subj"; then
    echo "$FOLDER_ARCHIVE"; return
  fi

  # --- ACTION: default ----------------------------------------------------
  echo "$FOLDER_ACTION"
}

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

preflight() {
  [[ -x "$HIMALAYA" ]] || die "himalaya binary not found or not executable at $HIMALAYA"
  [[ -f "$HIMALAYA_CONFIG" ]] || die "himalaya config missing at $HIMALAYA_CONFIG"
  command -v jq >/dev/null 2>&1 || die "jq is required for envelope parsing — install with 'sudo apt install jq'"

  log "Using himalaya:  $HIMALAYA"
  log "Using config:    $HIMALAYA_CONFIG"
  [[ -n "$ACCOUNT" ]] && log "Account:         $ACCOUNT"
  log "Inbox folder:    $INBOX_FOLDER"
  log "Batch size:      $BATCH_SIZE"
  log "State dir:       $STATE_DIR"
  log "Mode:            $([[ $EXECUTE == 1 ]] && echo EXECUTE || echo DRY-RUN)"

  log "Probing connectivity (himalaya folder list)..."
  local folders
  if ! folders="$(hima folder list -o json 2>>"$LOG_FILE")"; then
    die "himalaya folder list failed — check OAuth/IMAP credentials" 2
  fi

  # Ensure target folders exist.
  for f in "$FOLDER_ACTION" "$FOLDER_FYI" "$FOLDER_AUTO" "$FOLDER_ARCHIVE"; do
    if printf '%s' "$folders" | jq -e --arg n "$f" '..|.name? // empty | select(. == $n)' >/dev/null 2>&1; then
      log "Folder OK:       $f"
    else
      log "Folder MISSING:  $f — creating"
      if [[ "$EXECUTE" == "1" ]]; then
        hima folder add "$f" >>"$LOG_FILE" 2>&1 || die "Failed to create folder $f"
      else
        log "  (dry run, skipping creation)"
      fi
    fi
  done
}

# ---------------------------------------------------------------------------
# Envelope fetch + classify + move
# ---------------------------------------------------------------------------
#
# Strategy: always read page 1. As we move envelopes off the inbox, the next
# page-1 read returns the next batch. This avoids pagination drift caused by
# the inbox shrinking under us. If a batch fails to shrink (move errors), the
# script bails out so the operator can inspect.

fetch_page1_json() {
  hima envelope list -f "$INBOX_FOLDER" --page 1 --page-size "$BATCH_SIZE" -o json 2>>"$LOG_FILE"
}

# Map a destination folder name to a single-character tag for logs.
tag_for() {
  case "$1" in
    "$FOLDER_ACTION")  echo "A" ;;
    "$FOLDER_FYI")     echo "F" ;;
    "$FOLDER_AUTO")    echo "U" ;;
    "$FOLDER_ARCHIVE") echo "X" ;;
    *)                 echo "?" ;;
  esac
}

# Returns count of envelopes still in the inbox after this batch.
process_batch() {
  local batch_no="$1"
  local json
  json="$(fetch_page1_json)" || { log "envelope list failed on batch $batch_no"; return 3; }

  local count
  count="$(printf '%s' "$json" | jq 'length')"
  if [[ "$count" == "0" ]]; then
    log "Inbox is empty."
    return 0
  fi
  log "Batch $batch_no: $count envelopes"

  # Stream id<TAB>from<TAB>subject lines. jq tolerates schema variation across
  # himalaya versions (some emit .from.addr, some .from[0].addr, etc.).
  local processed_in_batch=0
  local entries
  entries="$(printf '%s' "$json" | jq -r '
    .[] |
    [
      (.id // .uid // .internal_id // empty | tostring),
      ((.from // {}) | (if type=="array" then .[0] else . end)
        | (.addr // .address // .email // .name // "")),
      (.subject // "")
    ] | @tsv
  ')"

  if [[ -z "$entries" ]]; then
    log "Could not parse envelopes (himalaya schema mismatch?) — see $LOG_FILE"
    return 3
  fi

  while IFS=$'\t' read -r mid from subject; do
    [[ -z "$mid" ]] && continue
    local dest
    dest="$(classify "$from" "$subject")"

    # Truncate the subject for log readability.
    local short_subj="${subject:0:70}"
    log "  [$(tag_for "$dest")] id=$mid from=${from:0:40} subj=$short_subj"

    if [[ "$EXECUTE" == "1" ]]; then
      if hima message move "$mid" -f "$INBOX_FOLDER" "$dest" >>"$LOG_FILE" 2>&1; then
        printf '%s\t%s\t%s\n' "$mid" "$dest" "$(ts)" >> "$STATE_FILE"
        echo "$mid" > "$CHECKPOINT_FILE"
        processed_in_batch=$((processed_in_batch + 1))
      else
        log "  MOVE FAILED for id=$mid — aborting batch (re-invoke to resume)"
        return 3
      fi
    else
      processed_in_batch=$((processed_in_batch + 1))
    fi
  done <<< "$entries"

  log "Batch $batch_no done: $processed_in_batch processed"

  # In dry-run mode we'd loop forever since nothing moves. Stop after one batch.
  if [[ "$EXECUTE" != "1" ]]; then
    log "Dry run — stopping after first batch. Re-run with --execute to apply."
    return 10
  fi

  return 0
}

# ---------------------------------------------------------------------------
# Old folder cleanup
# ---------------------------------------------------------------------------
#
# Lists every folder that is NOT in KEEP_FOLDERS, expunges it (move-all to
# Trash / delete contents), then deletes the folder itself.

cleanup_old_folders() {
  log "Cleaning up non-keep folders"
  local folders_json
  folders_json="$(hima folder list -o json 2>>"$LOG_FILE")" \
    || die "Could not list folders during cleanup" 3

  local names
  names="$(printf '%s' "$folders_json" | jq -r '..|.name? // empty')"

  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    local keep=0
    for k in "${KEEP_FOLDERS[@]}"; do
      [[ "$f" == "$k" ]] && keep=1 && break
    done
    if [[ "$keep" == "1" ]]; then
      log "  keep:   $f"
      continue
    fi
    log "  purge:  $f"
    if [[ "$EXECUTE" == "1" ]]; then
      hima folder expunge "$f" >>"$LOG_FILE" 2>&1 || log "    expunge failed (continuing)"
      hima folder delete  "$f" >>"$LOG_FILE" 2>&1 || log "    delete failed (continuing)"
    fi
  done <<< "$names"
}

# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

main() {
  log "==== inbox triage start ===="
  preflight

  local batch_no=0
  local start_epoch
  start_epoch="$(date +%s)"

  while :; do
    batch_no=$((batch_no + 1))

    set +e
    process_batch "$batch_no"
    local rc=$?
    set -e

    case "$rc" in
      0)
        # Check whether inbox is now empty.
        local remaining
        remaining="$(fetch_page1_json | jq 'length')"
        if [[ "$remaining" == "0" ]]; then
          log "Inbox drained to 0."
          break
        fi
        ;;
      10)
        # dry-run early exit
        break
        ;;
      *)
        log "Batch returned rc=$rc — stopping. Re-invoke to resume."
        exit "$rc"
        ;;
    esac

    if [[ "$MAX_BATCHES" -gt 0 && "$batch_no" -ge "$MAX_BATCHES" ]]; then
      log "Reached MAX_BATCHES=$MAX_BATCHES — stopping (inbox not yet empty)."
      break
    fi

    sleep "$SLEEP_BETWEEN"
  done

  if [[ "$CLEANUP_OLD" == "1" ]]; then
    cleanup_old_folders
  fi

  # Final report
  local final
  final="$(fetch_page1_json | jq 'length')" || final="?"
  local elapsed=$(( $(date +%s) - start_epoch ))
  local mins=$(( elapsed / 60 )); local secs=$(( elapsed % 60 ))

  log "==== summary ===="
  log "  batches:         $batch_no"
  log "  elapsed:         ${mins}m ${secs}s"
  log "  inbox remaining: $final"
  log "  state file:      $STATE_FILE"
  log "  log file:        $LOG_FILE"

  if [[ "$EXECUTE" == "1" && "$final" == "0" ]]; then
    log "SUCCESS — inbox is empty."
  elif [[ "$EXECUTE" != "1" ]]; then
    log "DRY RUN complete. Re-run with --execute to actually move messages."
  else
    log "Inbox NOT empty ($final left). Re-invoke to continue."
  fi
}

main "$@"
