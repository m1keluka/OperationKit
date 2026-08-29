#!/usr/bin/env bash
# vps-schedule.sh — schedule `claude -p` jobs on the VPS host (crontab / at).
#
# Use this when a scheduled task needs host-local resources: localhost CC API
# (port 3002), /home/operator/transcripts/, /home/operator/.config/command-center/,
# host crontab, or anything else that lives on the droplet rather than the
# claude.ai cloud sandbox. For pure-LLM scheduled work that doesn't touch
# host state, use the built-in /schedule (CCR) skill instead.
#
# Subcommands:
#   add       <name> <cron-expr> <prompt-file>     install recurring crontab line
#   add-once  <name> <rfc3339-utc> <prompt-file>   install one-shot job (at if available, else self-removing crontab)
#   list                                           list all schedule-vps jobs (recurring + one-shot)
#   show      <name>                               print metadata + prompt for a job
#   remove    <name>                               remove crontab/at entry and metadata
#   run-once-cleanup <name>                        internal: called by self-removing crontab line after firing
#
# Marker convention (so we never disturb unrelated cron lines):
#   recurring : "# command-center-schedule:<name>"
#   one-shot  : "# command-center-schedule:<name>:once"
#
# Files written per job:
#   /home/operator/.config/command-center/schedule/<name>.prompt    prompt body
#   /home/operator/.config/command-center/schedule/<name>.json      metadata
#   /home/operator/transcripts/schedule-<name>.log                  job stdout/stderr

set -u -o pipefail

CONFIG_DIR=/home/operator/.config/command-center/schedule
LOG_DIR=/home/operator/transcripts
WRAPPER=${CC_REPO_DIR:-/home/operator/projects/operationkit}/scripts/run-claude-scheduled.sh
TAG_PREFIX="# command-center-schedule:"
SELF="$(readlink -f "$0")"

die() { echo "ERROR: $*" >&2; exit 1; }
note() { echo "$*" >&2; }

ensure_dirs() {
  mkdir -p "$CONFIG_DIR" "$LOG_DIR"
}

require_crontab() {
  command -v crontab >/dev/null 2>&1 || die "crontab not on PATH (run this on the host or in a container with cron)"
}

valid_name() {
  [[ "$1" =~ ^[a-z0-9][a-z0-9_-]{0,63}$ ]] || die "invalid name '$1' (use [a-z0-9_-], 1-64 chars, leading alnum)"
}

cron_get() { crontab -l 2>/dev/null || true; }

cron_set() {
  local tmp; tmp=$(mktemp)
  cat > "$tmp"
  crontab "$tmp" || { rm -f "$tmp"; die "failed to install crontab"; }
  rm -f "$tmp"
}

cron_drop_markers() {
  # stdin: crontab. args: literal marker strings; drop lines whose tail equals
  # any marker. Anchoring at end-of-line prevents the prefix-collision bug
  # where removing `foo` would also strip `foo-2` (since `foo` is a substring
  # of `foo-2`).
  python3 -c '
import sys
markers = sys.argv[1:]
for line in sys.stdin:
    s = line.rstrip("\n")
    if any(s.endswith(m) for m in markers):
        continue
    sys.stdout.write(line)
' "$@"
}

rfc3339_to_cron_min_hour_dom_mon() {
  # Convert RFC3339 UTC timestamp to "M H D Mo *" (UTC-interpreted; caller must put CRON_TZ=UTC at top of crontab — see ensure_cron_tz_utc).
  # Returns the five fields on stdout.
  local rfc="$1"
  date -u -d "$rfc" +"%-M %-H %-d %-m *" 2>/dev/null || die "could not parse RFC3339 timestamp '$rfc'"
}

ensure_cron_tz_utc() {
  # Make sure the crontab has `CRON_TZ=UTC` so our UTC-derived schedules fire as intended.
  # Idempotent: only inserts if no CRON_TZ line exists.
  local cur; cur=$(cron_get)
  if printf "%s\n" "$cur" | grep -q '^CRON_TZ='; then
    return 0
  fi
  printf "CRON_TZ=UTC\n%s\n" "$cur" | cron_set
}

write_metadata() {
  local name="$1" target_kind="$2" schedule="$3" prompt_file="$4"
  local now; now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  cat > "$CONFIG_DIR/$name.json" <<EOF
{
  "name": "$name",
  "kind": "$target_kind",
  "schedule": "$schedule",
  "prompt_file": "$CONFIG_DIR/$name.prompt",
  "log_file": "$LOG_DIR/schedule-$name.log",
  "wrapper": "$WRAPPER",
  "created_at": "$now"
}
EOF
  cp -f "$prompt_file" "$CONFIG_DIR/$name.prompt"
  chmod 600 "$CONFIG_DIR/$name.prompt" "$CONFIG_DIR/$name.json"
}

cmd_add() {
  local name="${1:-}" cron_expr="${2:-}" prompt_file="${3:-}"
  [ -n "$name" ] && [ -n "$cron_expr" ] && [ -n "$prompt_file" ] || die "usage: add <name> <cron-expr> <prompt-file>"
  valid_name "$name"
  [ -f "$prompt_file" ] || die "prompt file not found: $prompt_file"
  local fields; fields=$(echo "$cron_expr" | awk '{print NF}')
  [ "$fields" = "5" ] || die "cron-expr must have 5 fields (got $fields): '$cron_expr'"
  ensure_dirs
  require_crontab

  local marker="${TAG_PREFIX}${name}"
  local log="$LOG_DIR/schedule-$name.log"
  local line="$cron_expr $WRAPPER $name >> $log 2>&1 $marker"

  ensure_cron_tz_utc
  local cur; cur=$(cron_get)
  local stripped; stripped=$(printf "%s\n" "$cur" | cron_drop_markers "$marker")
  printf "%s\n%s\n" "$stripped" "$line" | cron_set

  write_metadata "$name" "recurring" "$cron_expr" "$prompt_file"
  note "installed recurring schedule '$name' ($cron_expr) — log: $log"
}

cmd_add_once() {
  local name="${1:-}" when="${2:-}" prompt_file="${3:-}"
  [ -n "$name" ] && [ -n "$when" ] && [ -n "$prompt_file" ] || die "usage: add-once <name> <rfc3339-utc> <prompt-file>"
  valid_name "$name"
  [ -f "$prompt_file" ] || die "prompt file not found: $prompt_file"
  ensure_dirs

  # Sanity-check the timestamp parses.
  date -u -d "$when" +%s >/dev/null 2>&1 || die "could not parse RFC3339 timestamp '$when'"

  local log="$LOG_DIR/schedule-$name.log"

  if command -v at >/dev/null 2>&1; then
    require_at_running
    write_metadata "$name" "once-at" "$when" "$prompt_file"
    # at -t format is YYYYMMDDhhmm[.ss] in $TZ; force UTC.
    local at_t; at_t=$(date -u -d "$when" +%Y%m%d%H%M)
    local at_id
    at_id=$(TZ=UTC printf "%s\n" "$WRAPPER $name >> $log 2>&1" | TZ=UTC at -t "$at_t" 2>&1 | awk '/^job/ {print $2; exit}')
    [ -n "$at_id" ] || die "at(1) did not return a job id — check atd is running"
    # Stash at job id in metadata for later removal.
    local meta="$CONFIG_DIR/$name.json"
    python3 -c '
import json, sys
p = sys.argv[1]; jid = sys.argv[2]
with open(p) as f: d = json.load(f)
d["at_job_id"] = jid
with open(p, "w") as f: json.dump(d, f, indent=2); f.write("\n")
' "$meta" "$at_id"
    note "installed one-shot schedule '$name' via at (job $at_id, fires $when UTC) — log: $log"
    return 0
  fi

  # Fallback: self-removing crontab line.
  require_crontab
  ensure_cron_tz_utc
  local fields; fields=$(rfc3339_to_cron_min_hour_dom_mon "$when")
  local marker="${TAG_PREFIX}${name}:once"
  local cmd="$WRAPPER $name --once >> $log 2>&1"
  local line="$fields $cmd $marker"

  local cur; cur=$(cron_get)
  local stripped; stripped=$(printf "%s\n" "$cur" | cron_drop_markers "$marker")
  printf "%s\n%s\n" "$stripped" "$line" | cron_set

  write_metadata "$name" "once-cron" "$when" "$prompt_file"
  note "installed one-shot schedule '$name' via self-removing crontab (fires $when UTC) — log: $log"
}

require_at_running() {
  # at(1) is installed but atd may not be — best-effort check.
  if command -v pgrep >/dev/null 2>&1; then
    pgrep -x atd >/dev/null 2>&1 || note "warning: atd does not appear to be running — your at job will be queued but may not fire"
  fi
}

cmd_list() {
  ensure_dirs
  if ! command -v crontab >/dev/null 2>&1; then
    note "(crontab not on PATH — listing metadata only)"
  else
    local cur; cur=$(cron_get)
    printf "%s\n" "$cur" | grep -F "$TAG_PREFIX" || true
  fi
  echo "---"
  if compgen -G "$CONFIG_DIR/*.json" >/dev/null; then
    for f in "$CONFIG_DIR"/*.json; do
      printf "%s\n" "$f"
      cat "$f"
      echo
    done
  else
    echo "(no schedule-vps jobs registered)"
  fi
}

cmd_show() {
  local name="${1:-}"
  [ -n "$name" ] || die "usage: show <name>"
  valid_name "$name"
  local meta="$CONFIG_DIR/$name.json"
  [ -f "$meta" ] || die "no metadata for '$name' at $meta"
  echo "=== metadata ==="
  cat "$meta"
  echo
  echo "=== prompt ==="
  cat "$CONFIG_DIR/$name.prompt" 2>/dev/null || echo "(prompt missing)"
}

cmd_remove() {
  local name="${1:-}"
  [ -n "$name" ] || die "usage: remove <name>"
  valid_name "$name"

  if command -v crontab >/dev/null 2>&1; then
    local marker_recurring="${TAG_PREFIX}${name}"
    local marker_once="${TAG_PREFIX}${name}:once"
    local cur; cur=$(cron_get)
    local stripped
    stripped=$(printf "%s\n" "$cur" | cron_drop_markers "$marker_recurring" "$marker_once")
    printf "%s\n" "$stripped" | cron_set
  fi

  # If we tracked an at job id, try to remove it too.
  local meta="$CONFIG_DIR/$name.json"
  if [ -f "$meta" ] && command -v atrm >/dev/null 2>&1; then
    local at_id
    at_id=$(grep -oE '"at_job_id": *"[^"]*"' "$meta" | head -1 | cut -d'"' -f4 || true)
    if [ -n "$at_id" ]; then
      atrm "$at_id" 2>/dev/null || note "(atrm $at_id failed — may have already fired)"
    fi
  fi

  rm -f "$CONFIG_DIR/$name.json" "$CONFIG_DIR/$name.prompt"
  note "removed schedule '$name'"
}

cmd_run_once_cleanup() {
  # Called by the wrapper after a --once invocation finishes.
  local name="${1:-}"
  [ -n "$name" ] || die "usage: run-once-cleanup <name>"
  valid_name "$name"
  command -v crontab >/dev/null 2>&1 || return 0
  local marker="${TAG_PREFIX}${name}:once"
  local cur; cur=$(cron_get)
  printf "%s\n" "$cur" | cron_drop_markers "$marker" | cron_set
  rm -f "$CONFIG_DIR/$name.json" "$CONFIG_DIR/$name.prompt"
}

main() {
  local sub="${1:-}"
  shift || true
  case "$sub" in
    add)              cmd_add "$@" ;;
    add-once)         cmd_add_once "$@" ;;
    list)             cmd_list "$@" ;;
    show)             cmd_show "$@" ;;
    remove)           cmd_remove "$@" ;;
    run-once-cleanup) cmd_run_once_cleanup "$@" ;;
    ""|-h|--help)
      sed -n '1,30p' "$SELF"
      exit 0
      ;;
    *) die "unknown subcommand '$sub' (try: add add-once list show remove)";;
  esac
}

main "$@"
