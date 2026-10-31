#!/usr/bin/env bash
# cutover.sh — phase 2: the downtime window. Moves Command Center for real.
#
# Run on the NEW host as mike, inside tmux (a dropped SSH must not kill it):
#   tmux new -s cutover
#   bash scripts/migrate/cutover.sh --src mike@<do-ip> --new-ip <ovh-ip> [--dry-run]
#
# Options:
#   --new-ip IP          public IP of this host (used to watch DNS flip over)
#   --drain-timeout MIN  how long to wait for working cards to finish (default 60)
#   --redo STEP          re-run a step already marked done (see list below)
#
# Steps (each writes a marker in ~/.cc-migrate/; a re-run resumes after the
# last finished one — that is what makes the script idempotent):
#   prebuild   build the command-center image here while the old host is live
#   drain      wait until no card is working / in ai_review / planning
#   stop-old   [confirm] stop CC + LiteLLM on the old host, park its crontab
#   dump       sqlite3 .backup + pg_dump on the old host (read-only on live data)
#   final-sync [confirm] last rsync delta with --delete (projects, vault, data…)
#   accounts   copy Claude/Codex account homes (a-g, codex, grok, .claude-auth)
#   restore    [confirm] install the DB + pg_restore LiteLLM here
#   host-config install Caddyfile, preview-spool units, backup timer
#   start      [confirm] docker compose up -d, wait for /api/health, install crons
#   dns        print the DNS change for Mike, wait for it to resolve here
#
# The old host is NEVER deleted from or wiped: services are stopped, data stays,
# its crontab is commented out (not removed). Rollback: docs/migration/ovh-rise4.md §G.
set -euo pipefail
# shellcheck source=scripts/migrate/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  sed -n '2,28p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

NEW_IP=
DRAIN_TIMEOUT_MIN=60
REDO=
DOMAIN=cc.example.com
DUMP_DIR=$CC_DATA/migrate
DB_DUMP=$DUMP_DIR/command-center.cutover.db
PG_DUMP=$DUMP_DIR/litellm.cutover.pgdump

parse_common_args "$@"
set -- "${REST_ARGS[@]+"${REST_ARGS[@]}"}"
while [ $# -gt 0 ]; do
  case "$1" in
    --new-ip) shift; NEW_IP=${1:-} ;;
    --new-ip=*) NEW_IP=${1#--new-ip=} ;;
    --drain-timeout) shift; DRAIN_TIMEOUT_MIN=${1:-} ;;
    --drain-timeout=*) DRAIN_TIMEOUT_MIN=${1#--drain-timeout=} ;;
    --redo) shift; REDO=${1:-} ;;
    --redo=*) REDO=${1#--redo=} ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done
require_src
require_user_mike
[ -n "$NEW_IP" ] || die "--new-ip <this host's public IP> is required"
[[ "$DRAIN_TIMEOUT_MIN" =~ ^[0-9]+$ ]] || die "--drain-timeout must be minutes"
[ -n "${SSH_AUTH_SOCK:-}" ] || die "no SSH agent — reconnect with 'ssh -A'"
[ -d "$CC_REPO/.git" ] || die "$CC_REPO missing — run presync.sh first"
ensure_state_dir
[ -n "${TMUX:-}" ] || warn "not inside tmux — a dropped SSH session will abort the cutover midway"

LOG_FILE=$MIGRATE_LOG_DIR/cutover-$(date -u +%Y%m%dT%H%M%SZ).log
if [ "$DRY_RUN" -eq 0 ]; then
  exec > >(tee -a "$LOG_FILE") 2>&1
  log "logging to $LOG_FILE"
fi

marker() { printf '%s/cutover.%s.done' "$MIGRATE_STATE" "$1"; }
is_done() { [ "$REDO" != "$1" ] && [ -f "$(marker "$1")" ]; }
mark_done() { [ "$DRY_RUN" -eq 1 ] || date -u +%FT%TZ > "$(marker "$1")"; }
begin() { # begin STEP DESCRIPTION -> returns 1 if already done
  if is_done "$1"; then log "skip $1 (done $(cat "$(marker "$1")"); --redo $1 to repeat)"; return 1; fi
  step "$1 — $2"
}

# Read-only board counts from the old host's live DB (inside its container).
board_counts() {
  src docker exec command-center node -e "
    const db = require('better-sqlite3')('/app/data/command-center.db', { readonly: true });
    const rows = db.prepare(\"SELECT status, COUNT(*) AS n FROM objectives WHERE status IN ('planning','queue','working','ai_review') GROUP BY status\").all();
    const m = Object.fromEntries(rows.map(r => [r.status, r.n]));
    console.log(['working','ai_review','planning','queue'].map(s => s + '=' + (m[s] || 0)).join(' '));
  "
}

compose_src() { src_run bash -c "cd $CC_REPO && docker compose $*"; }

# ── prebuild ────────────────────────────────────────────────────────────────
if begin prebuild "build the image on this host (no downtime yet)"; then
  run docker compose --project-directory "$CC_REPO" -f "$CC_REPO/docker-compose.yml" build command-center
  run docker compose --project-directory "$CC_REPO" -f "$CC_REPO/docker-compose.yml" pull litellm litellm-db
  mark_done prebuild
fi

# ── drain ───────────────────────────────────────────────────────────────────
if begin drain "drain the board on the old host"; then
  log "No queue-pause switch exists in the app: do not start or queue new cards now."
  log "Queued cards stay queued in the DB and start on the new host after cutover."
  deadline=$(( $(date +%s) + DRAIN_TIMEOUT_MIN * 60 ))
  while :; do
    counts=$(board_counts 2>/dev/null || echo 'unavailable')
    tmux_n=$(src docker exec command-center sh -c 'tmux ls 2>/dev/null | wc -l' 2>/dev/null || echo '?')
    log "board: $counts | live tmux sessions: $tmux_n"
    if [[ "$counts" == *"working=0 ai_review=0 planning=0"* ]]; then
      pass "board drained"
      break
    fi
    if [ "$DRY_RUN" -eq 1 ]; then log "[dry-run] would keep polling every 60s until drained"; break; fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      warn "drain timeout (${DRAIN_TIMEOUT_MIN}m). In-flight sessions will be killed by the stop."
      confirm FORCE-STOP "proceed with cards still active ($counts) — they resume on the new host"
      break
    fi
    sleep 60
  done
  mark_done drain
fi

# ── stop-old ────────────────────────────────────────────────────────────────
if begin stop-old "stop services on the old host (data stays intact)"; then
  confirm STOP-OLD "stop command-center on $SRC_HOST — DOWNTIME STARTS NOW"
  compose_src stop command-center
  # Cron jobs would keep writing the vault/transcripts on the old host and fork
  # the data. Comment them out (reversible: sed 's/^#MIGRATED //' | crontab -).
  src_run bash -c "mkdir -p ~/.cc-migrate && crontab -l > ~/.cc-migrate/crontab.before-cutover 2>/dev/null || true"
  src_run bash -c "crontab -l 2>/dev/null | sed -E 's/^([^#])/#MIGRATED \\1/' | crontab -"
  src_run sudo -n systemctl stop cc-preview-spool.path cc-preview-spool.service
  log "LiteLLM stays up until its pg_dump in the next step."
  mark_done stop-old
fi

# ── dump ────────────────────────────────────────────────────────────────────
if begin dump "consistent snapshots on the old host"; then
  src_run sudo -n mkdir -p "$DUMP_DIR"
  # SQLite: .backup is page-consistent and WAL-aware. Prefer the host sqlite3
  # CLI; fall back to better-sqlite3 inside the (stopped) CC image.
  if src command -v sqlite3 >/dev/null 2>&1; then
    src_run sudo -n sqlite3 "$CC_DB" ".backup '$DB_DUMP'"
  else
    img=$(src docker inspect -f '{{.Image}}' command-center)
    src_run sudo -n docker run --rm --entrypoint node -v "$CC_DATA:/app/data" "$img" -e "
      require('better-sqlite3')('/app/data/command-center.db', { readonly: true })
        .backup('/app/data/migrate/command-center.cutover.db')
        .then(() => console.log('sqlite backup ok'))
        .catch(e => { console.error(e); process.exit(1) })"
  fi
  if [ "$DRY_RUN" -eq 0 ]; then
    ic=$(src sudo -n sqlite3 "$DB_DUMP" 'PRAGMA integrity_check;' 2>/dev/null || echo 'checked on destination')
    log "source-side integrity_check: $ic"
  fi
  # LiteLLM Postgres: custom-format dump (pg_restore-able, compressed).
  src_run bash -c "docker exec litellm-db pg_dump -U llmproxy -d litellm -Fc | sudo -n tee '$PG_DUMP' >/dev/null"
  if [ "$DRY_RUN" -eq 0 ]; then
    sz=$(src sudo -n stat -c %s "$PG_DUMP")
    [ "${sz:-0}" -gt 0 ] || die "pg_dump is empty — LiteLLM still running on the old host, nothing lost; investigate"
    log "pg_dump size: $sz bytes"
  fi
  compose_src stop litellm litellm-db
  mark_done dump
fi

# ── final-sync ──────────────────────────────────────────────────────────────
if begin final-sync "last delta (old host is quiet now)"; then
  confirm FINAL-SYNC "mirror the old host onto this one with --delete (destination-only files under these trees are removed)"
  # Same filters as presync, plus --delete so removals on the source carry over.
  dry=()
  [ "$DRY_RUN" -eq 1 ] && dry=(--dry-run)
  for name in secrets projects second-brain ai-workspace transcripts assistant ssh gh; do
    PRESYNC_DELETE=1 bash "$MIGRATE_DIR/presync.sh" --src "$SRC_HOST" --only "$name" "${dry[@]+"${dry[@]}"}" \
      || die "final sync of '$name' failed — fix and re-run with --redo final-sync"
  done
  # Data dir: everything except the live DB files; the .backup comes instead.
  pull "$CC_DATA/" "$CC_DATA/" --delete \
    --filter='- /command-center.db' \
    --filter='- /command-center.db-wal' \
    --filter='- /command-center.db-shm' \
    --filter='- /cc-accounts/' \
    --filter='- /backups/'
  mark_done final-sync
fi

# ── accounts ────────────────────────────────────────────────────────────────
if begin accounts "Claude/Codex account homes (copied only now: OAuth tokens rotate)"; then
  for d in "${ACCOUNT_DIRS[@]}"; do
    if src sudo -n test -d "$d"; then
      pull "$d/" "$d/" --delete
      [ "$DRY_RUN" -eq 1 ] || checksum_match "$d"
    else
      note "account dir absent on source: $d"
    fi
  done
  pull "$CC_DATA/cc-accounts/" "$CC_DATA/cc-accounts/" --delete
  [ "$DRY_RUN" -eq 1 ] || checksum_match "$CC_DATA/cc-accounts"
  [ "$FAIL_COUNT" -eq 0 ] || die "account copy mismatch — re-run with --redo accounts"
  mark_done accounts
fi

# ── restore ─────────────────────────────────────────────────────────────────
if begin restore "install the DB snapshot + restore LiteLLM Postgres here"; then
  if [ "$DRY_RUN" -eq 0 ]; then
    [ -s "$DB_DUMP" ] || die "missing $DB_DUMP — re-run --redo final-sync"
    ic=$(sudo sqlite3 "$DB_DUMP" 'PRAGMA integrity_check;')
    [ "$ic" = ok ] || die "integrity_check on $DB_DUMP: $ic"
    pass "sqlite integrity_check ok"
    [ -s "$PG_DUMP" ] || die "missing $PG_DUMP"
  fi
  confirm RESTORE "replace $CC_DB with the cutover snapshot and pg_restore LiteLLM (both currently empty/stale here)"
  run sudo rm -f "$CC_DB-wal" "$CC_DB-shm"
  run sudo install -m 644 "$DB_DUMP" "$CC_DB"
  run docker compose --project-directory "$CC_REPO" -f "$CC_REPO/docker-compose.yml" up -d litellm-db
  if [ "$DRY_RUN" -eq 0 ]; then
    for _ in $(seq 1 60); do
      docker exec litellm-db pg_isready -d litellm -U llmproxy >/dev/null 2>&1 && break
      sleep 2
    done
    docker exec litellm-db pg_isready -d litellm -U llmproxy >/dev/null || die "litellm-db not ready"
    sudo cat "$PG_DUMP" | docker exec -i litellm-db pg_restore -U llmproxy -d litellm --clean --if-exists --no-owner
    pass "pg_restore done"
  fi
  mark_done restore
fi

# ── host-config ─────────────────────────────────────────────────────────────
if begin host-config "Caddy, systemd units, backup timer (crons follow once CC is up)"; then
  if [ -f "$MIGRATE_STATE/src-etc/caddy/Caddyfile" ] && ! diff -q "$MIGRATE_STATE/src-etc/caddy/Caddyfile" "$CC_REPO/config/caddy/Caddyfile" >/dev/null; then
    warn "live Caddyfile on the old host differs from config/caddy/Caddyfile:"
    diff "$MIGRATE_STATE/src-etc/caddy/Caddyfile" "$CC_REPO/config/caddy/Caddyfile" | sed 's/^/    /' || true
    warn "installing the REPO version (source of truth). Port any live-only block into the repo first."
  fi
  run sudo install -m 644 "$CC_REPO/config/caddy/Caddyfile" /etc/caddy/Caddyfile
  if [ -d "$MIGRATE_STATE/src-etc/caddy/sites-enabled" ]; then
    run sudo rsync -a "$MIGRATE_STATE/src-etc/caddy/sites-enabled/" /etc/caddy/sites-enabled/
  fi
  run sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
  run sudo systemctl enable caddy
  run sudo systemctl reload-or-restart caddy
  run sudo bash "$CC_REPO/scripts/install-preview-spool.sh"
  run sudo bash "$MIGRATE_DIR/install-backup-timer.sh"
  mark_done host-config
fi

# ── start ───────────────────────────────────────────────────────────────────
if begin start "bring Command Center up here"; then
  confirm START "start command-center + litellm on this host"
  run docker compose --project-directory "$CC_REPO" -f "$CC_REPO/docker-compose.yml" up -d
  if [ "$DRY_RUN" -eq 0 ]; then
    for _ in $(seq 1 90); do
      curl -fsS http://127.0.0.1:3002/api/health >/dev/null 2>&1 && break
      sleep 2
    done
    curl -fsS http://127.0.0.1:3002/api/health >/dev/null || die "CC not healthy after 3 min: docker compose logs command-center | tail -50"
    pass "CC /api/health ok on 127.0.0.1:3002"
  fi
  # Crons. cron.env came over with the secrets and its CC_SERVICE_TOKEN is
  # signed with the same CC_JWT_SECRET, so the installers are enough. (Not
  # fix-vps-cron.sh: it also RUNS every job once, which would fire the daily
  # audit/digest mid-cutover. Use it only if a cron fails verify.sh.)
  for inst in install-daily-log-cron install-campaign-audit-cron install-reconcile-clients-cron \
              install-cron-health-cron install-dream-cycle-cron install-disk-cleanup-cron; do
    run bash "$CC_REPO/scripts/$inst.sh"
  done
  mark_done start
fi

# ── dns ─────────────────────────────────────────────────────────────────────
if begin dns "point DNS at this host (Mike does this in the DNS provider)"; then
  cat <<EOF

  ┌───────────────────────────────────────────────────────────────────────┐
  │ MIKE: change these A records to $NEW_IP (TTL 300):
  │   $DOMAIN
  │   n8n.example.com   — ONLY if n8n was moved too (runbook §B.6)
  │   llm.mikeluka.com     — LiteLLM admin, moved with compose
  │   *.cc.example.com  — PR previews, if a wildcard record exists
  │ Leave everything else alone. The old droplet stays powered for 48h.
  └───────────────────────────────────────────────────────────────────────┘

EOF
  if [ "$DRY_RUN" -eq 0 ]; then
    for _ in $(seq 1 120); do
      got=$(dig +short "$DOMAIN" @1.1.1.1 | tail -1)
      log "dig $DOMAIN @1.1.1.1 -> ${got:-<none>} (want $NEW_IP)"
      [ "$got" = "$NEW_IP" ] && break
      sleep 30
    done
    [ "$got" = "$NEW_IP" ] || die "DNS not flipped after 60 min — re-run with --redo dns when it is"
    # Kick Caddy so it retries ACME now instead of waiting out its backoff.
    sudo systemctl reload caddy
    for _ in $(seq 1 30); do
      curl -fsS "https://$DOMAIN/api/health" >/dev/null 2>&1 && break
      sleep 10
    done
    if curl -fsS "https://$DOMAIN/api/health" >/dev/null; then pass "https://$DOMAIN/api/health ok (TLS issued)"
    else warn "HTTPS not up yet — check: sudo journalctl -u caddy -n 50"; fi
  fi
  mark_done dns
fi

step "cutover finished — now run: bash $MIGRATE_DIR/verify.sh --new-ip $NEW_IP --test-card"
log "Old host: services stopped, data intact, crontab commented. Rollback = runbook §G."
