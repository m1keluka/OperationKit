#!/usr/bin/env bash
# preflight.sh — read-only readiness checks on BOTH hosts before any copy.
#
# Run on the NEW (OVH) host as mike, with agent forwarding to the old host:
#   ssh -A mike@<ovh-ip>
#   bash ~/cc-migrate/scripts/migrate/preflight.sh --src mike@<do-ip> [--sizes]
#
# Changes nothing on either host (it has no mutating steps, so --dry-run is
# accepted and behaves identically). Secret files are checked for EXISTENCE
# only — never read. Exit 0 only if every FAIL-level check passes.
#
# --sizes   also `du` the big trees on the source (slow on a full 800 GB disk;
#           uses ionice/nice so it does not starve the live host).
set -euo pipefail
# shellcheck source=scripts/migrate/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

parse_common_args "$@"
SIZES=0
for a in "${REST_ARGS[@]+"${REST_ARGS[@]}"}"; do
  case "$a" in
    --sizes) SIZES=1 ;;
    *) die "unknown argument: $a" ;;
  esac
done
require_src
require_user_mike

# ── Source host ──────────────────────────────────────────────────────────────
step "SOURCE ($SRC_HOST): reachability + toolchain"
if src true 2>/dev/null; then pass "ssh reachable (agent forwarding works)"; else
  fail "cannot ssh to $SRC_HOST — run from 'ssh -A' so your laptop key is forwarded"
  summary || exit 1
fi
if src sudo -n true 2>/dev/null; then pass "passwordless sudo on source"; else fail "sudo -n fails on source (needed to read ccuser/root-owned files)"; fi
src_os=$(src "grep -oP '^PRETTY_NAME=\"\K[^\"]+' /etc/os-release" 2>/dev/null || echo unknown)
log "source OS: $src_os"
src_uid=$(src id -u mike 2>/dev/null || echo unknown)
log "source uid of mike: $src_uid (bootstrap-host.sh --mike-uid must match)"
src_tz=$(src timedatectl show -p Timezone --value 2>/dev/null || src cat /etc/timezone 2>/dev/null || echo unknown)
log "source timezone: $src_tz (cron schedules are wall-clock — destination must match)"
log "source docker: $(src docker --version 2>/dev/null || echo MISSING)"
log "source compose: $(src docker compose version --short 2>/dev/null || echo MISSING)"
log "source caddy: $(src caddy version 2>/dev/null | cut -d' ' -f1 || echo MISSING)"

step "SOURCE: disk"
src df -h / | sed 's/^/  /'
src_used_k=$(src df -Pk / | awk 'NR==2{print $3}')
log "source used: $((src_used_k / 1024 / 1024)) GiB"

step "SOURCE: containers (anything beyond litellm, litellm-db, command-center is VERIFY ON HOST)"
src docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.Status}}' 2>/dev/null | sed 's/^/  /' || fail "docker ps failed on source"
for c in command-center litellm litellm-db; do
  if src docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null | grep -qx true; then pass "container running: $c"; else fail "container not running: $c"; fi
done
extra=$(src docker ps -a --format '{{.Names}}' 2>/dev/null | grep -vxE 'command-center|litellm|litellm-db|cc-(pr|preview)-.*' || true)
if [ -n "$extra" ]; then
  note "extra containers on source (not in docker-compose.yml) — decide per container: $(echo "$extra" | tr '\n' ' ')"
fi
if src docker volume inspect operationkit_litellm_postgres_data >/dev/null 2>&1 \
  || src docker volume ls --format '{{.Name}}' | grep -q 'litellm_postgres_data$'; then
  pass "litellm_postgres_data volume present"
else
  fail "litellm_postgres_data volume not found"
fi

step "SOURCE: required files (existence only — contents never read)"
check_src_path() {
  local kind=$1 path=$2 level=${3:-fail}
  if src sudo -n test "-$kind" "$path" 2>/dev/null; then pass "present: $path"
  elif [ "$level" = warn ]; then note "absent: $path"
  else fail "absent: $path"; fi
}
check_src_path f "$CC_DB"
for f in "${SECRET_FILES[@]}"; do check_src_path f "$f" warn; done
for d in "${SECRET_DIRS[@]}"; do check_src_path d "$d" warn; done
for d in "${ACCOUNT_DIRS[@]}"; do check_src_path d "$d" warn; done
for s in f g grok; do check_src_path d "$CC_DATA/cc-accounts/$s" warn; done
check_src_path f /etc/caddy/Caddyfile
check_src_path d /etc/caddy/sites-enabled warn
check_src_path f /etc/systemd/system/cc-preview-spool.path warn
check_src_path f "$OPERATOR_HOME/ai-workspace/host-boot.d/run-all.sh" warn
check_src_path d "$OPERATOR_HOME/second-brain"
check_src_path d "$OPERATOR_HOME/ai-workspace"
check_src_path d "$OPERATOR_HOME/transcripts" warn
check_src_path d "$OPERATOR_HOME/assistant" warn
check_src_path d "$OPERATOR_HOME/.config/gh" warn
# The two encryption keys may live in .env instead of the host files; the app
# accepts either (services/secrets-crypto.ts, services/crypto.ts). Check by NAME.
for k in SECRETS_MASTER_KEY TEST_CRED_ENCRYPTION_KEY CC_JWT_SECRET LITELLM_SALT_KEY POSTGRES_PASSWORD; do
  if src sudo -n grep -qE "^(export )?$k=." "$CC_REPO/.env" 2>/dev/null; then
    pass ".env defines $k (name only)"
  else
    note ".env does not define $k — if it is also not a host key file, VERIFY ON HOST where it comes from"
  fi
done

step "SOURCE: schedulers to replicate"
cron_lines=$(src 'crontab -l 2>/dev/null | grep -cvE "^\s*(#|$)" || true')
log "mike crontab active entries: $cron_lines (markers below; full list is reinstalled from scripts/install-*-cron.sh)"
src 'crontab -l 2>/dev/null | grep -oE "# command-center: [a-z-]+" | sort -u' | sed 's/^/  /' || true
root_cron=$(src 'sudo -n crontab -l 2>/dev/null | grep -cvE "^\s*(#|$)" || true')
if [ "${root_cron:-0}" -gt 0 ]; then note "root crontab has $root_cron entries — VERIFY ON HOST and port by hand"; fi
log "cc-* systemd units on source:"
src "systemctl list-unit-files 'cc-*' --no-legend 2>/dev/null" | sed 's/^/  /' || true

step "SOURCE: worktree count (the ENOSPC driver)"
wt=$(src "find $PROJECTS_DIR -maxdepth 1 \( -name '*-wt-*' -o -name '.cc-worktree-*' \) | wc -l" || echo '?')
log "ad-hoc worktrees under $PROJECTS_DIR: $wt (excluded from presync)"
for r in example-platform operationkit; do
  n=$(src "git -C $PROJECTS_DIR/$r worktree list 2>/dev/null | wc -l" || echo '?')
  log "  $r registered worktrees: $n"
done

if [ "$SIZES" -eq 1 ]; then
  step "SOURCE: tree sizes (ionice)"
  for d in "$PROJECTS_DIR" "$CC_DATA" "$OPERATOR_HOME/second-brain" "$OPERATOR_HOME/ai-workspace" "$OPERATOR_HOME/transcripts"; do
    src "sudo -n ionice -c3 nice -n19 du -sh --exclude=node_modules $d 2>/dev/null" | sed 's/^/  /' || true
  done
fi

# ── Destination host (this machine) ─────────────────────────────────────────
step "DESTINATION ($(hostname)): OS + toolchain"
. /etc/os-release
if [ "${VERSION_ID:-}" = "24.04" ]; then pass "Ubuntu 24.04"; else fail "expected Ubuntu 24.04, got ${PRETTY_NAME:-unknown}"; fi
if sudo -n true 2>/dev/null; then pass "passwordless sudo"; else fail "sudo -n fails for mike"; fi
for bin in docker caddy rsync sqlite3 restic node git gh tmux ufw fail2ban-client mdadm smartctl; do
  if command -v "$bin" >/dev/null 2>&1; then pass "installed: $bin"; else fail "missing: $bin (run bootstrap-host.sh)"; fi
done
if command -v gitleaks >/dev/null 2>&1; then pass "installed: gitleaks"; else note "missing: gitleaks (only the local OSS gate check in verify.sh needs it)"; fi
if docker compose version >/dev/null 2>&1; then pass "docker compose plugin"; else fail "docker compose plugin missing"; fi
node_major=$(node -v 2>/dev/null | sed 's/^v//; s/\..*//' || echo 0)
if [ "${node_major:-0}" -ge 22 ]; then pass "node >= 22 (CI + image use 22)"; else fail "node 22+ required, got $(node -v 2>/dev/null || echo none)"; fi
if id -nG mike | grep -qw docker; then pass "mike in docker group"; else fail "mike not in docker group"; fi
if [ "$(id -u mike)" = "$src_uid" ]; then pass "mike uid matches source ($src_uid)"; else fail "mike uid $(id -u mike) != source $src_uid (rsync --numeric-ids would mis-own files)"; fi
dst_tz=$(timedatectl show -p Timezone --value 2>/dev/null || echo unknown)
if [ "$dst_tz" = "$src_tz" ]; then pass "timezone matches source ($dst_tz)"; else fail "timezone $dst_tz != source $src_tz (sudo timedatectl set-timezone $src_tz)"; fi
if swapon --show=NAME --noheadings | grep -q .; then pass "swap active"; else note "no swap configured"; fi

step "DESTINATION: RAID + disks"
nvme=$(lsblk -dno NAME,TYPE | awk '$1 ~ /^nvme/ && $2=="disk"' | wc -l)
if [ "$nvme" -eq 4 ]; then pass "4 NVMe disks visible"; else note "expected 4 NVMe disks, found $nvme"; fi
if [ -r /proc/mdstat ] && grep -q '^md' /proc/mdstat; then
  grep -A2 '^md' /proc/mdstat | sed 's/^/  /'
  if grep -E '^\s+[0-9]+ blocks' /proc/mdstat | grep -q '_'; then fail "a RAID array is degraded (see [U_] above)"; else pass "all md arrays fully in sync"; fi
  grep -qE 'resync|recovery' /proc/mdstat && note "RAID resync in progress — fine to continue, slower I/O until done"
else
  fail "no md software RAID found — the runbook assumes OVH software RAID"
fi
df -h / | sed 's/^/  /'
dst_avail_k=$(df -Pk / | awk 'NR==2{print $4}')
if [ "$dst_avail_k" -gt $((src_used_k * 2)) ]; then pass "free space > 2x source used"
elif [ "$dst_avail_k" -gt "$src_used_k" ]; then note "free space covers source used, but < 2x headroom"
else fail "not enough free space for the source data"; fi

step "DESTINATION: network"
if sudo -n ufw status 2>/dev/null | grep -q 'Status: active'; then
  pass "ufw active"
  allowed=$(sudo -n ufw status | awk '/ALLOW/{print $1}' | sed 's#/.*##' | sort -u | tr '\n' ' ')
  log "ufw allows: $allowed"
  extra_ports=$(echo "$allowed" | tr ' ' '\n' | grep -vxE '22|80|443|OpenSSH|' || true)
  if [ -z "$extra_ports" ]; then pass "only 22/80/443 open"; else note "extra ufw rules: $extra_ports"; fi
else
  fail "ufw not active"
fi
for p in 3002 4000; do
  if ss -ltnH "sport = :$p" | grep -q .; then note "port $p already listening (expected only after cutover)"; else pass "port $p free"; fi
done

step "DESTINATION: repo checkout"
if [ -d "$CC_REPO/.git" ]; then
  pass "repo present at $CC_REPO ($(git -C "$CC_REPO" rev-parse --short HEAD))"
else
  note "repo not yet at $CC_REPO — presync.sh brings it over with projects/"
fi

summary
