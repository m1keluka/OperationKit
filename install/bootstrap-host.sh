#!/usr/bin/env bash
# install/bootstrap-host.sh — prepare a fresh Ubuntu 24.04 server for Operation Kit.
#
# Called by ./install.sh (step 1). Safe to run on its own:
#   sudo bash install/bootstrap-host.sh [--timezone Area/City] [--swap-gb 4]
#        [--skip-firewall] [--skip-ssh-hardening] [--dry-run]
#
# Ported from scripts/migrate/bootstrap-host.sh with the operator-specific parts
# removed (no named user, no RAID, no Caddy, no OSS tooling). Idempotent: every
# step checks current state first, so re-running is a no-op.
#
# Firewall: SSH (22) only. The web traffic arrives through the Cloudflare Tunnel,
# which is an OUTBOUND connection, so ports 80/443 are never opened.
set -euo pipefail
# shellcheck source=install/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

TIMEZONE=
SWAP_GB=4
SKIP_FIREWALL=0
SKIP_SSH=0
while [ $# -gt 0 ]; do
  case "$1" in
    --timezone) shift; TIMEZONE=${1:-} ;;
    --swap-gb) shift; SWAP_GB=${1:-} ;;
    --skip-firewall) SKIP_FIREWALL=1 ;;
    --skip-ssh-hardening) SKIP_SSH=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done
[[ "$SWAP_GB" =~ ^[0-9]+$ ]] || die "--swap-gb must be a whole number"
require_root

. /etc/os-release
if [ "${VERSION_ID:-}" != "24.04" ]; then
  [ "$DRY_RUN" -eq 1 ] || die "this installer supports Ubuntu 24.04 only (found ${PRETTY_NAME:-unknown})"
  warn "not Ubuntu 24.04 (${PRETTY_NAME:-unknown}) — continuing because this is a dry run"
fi
export DEBIAN_FRONTEND=noninteractive

# A package mirror answering 503 for a minute killed the first real install.
# apt retries each download itself (Acquire::Retries) and the whole command is
# retried with a pause, so a short mirror hiccup no longer stops the install.
APT_RETRY_CONF=/etc/apt/apt.conf.d/80-ok-retries
if [ "$DRY_RUN" -eq 0 ] && [ ! -f "$APT_RETRY_CONF" ]; then
  printf 'Acquire::Retries "3";\n' > "$APT_RETRY_CONF"
fi
apt_retry() {
  local n
  if [ "$DRY_RUN" -eq 1 ]; then printf '  [dry-run] apt-get %s\n' "$*"; return 0; fi
  for n in 1 2 3; do
    apt-get -o Acquire::Retries=3 "$@" && return 0
    [ "$n" -lt 3 ] || break
    warn "apt-get $1 failed (attempt $n of 3) — the package mirror may be busy; retrying in $((n * 20))s"
    sleep $((n * 20))
  done
  die "apt-get $1 failed 3 times. Check the server's internet access, then re-run (it is safe to re-run)."
}

step "1/6 Base packages"
if dpkg -s ca-certificates curl gnupg git jq openssl ufw fail2ban unattended-upgrades >/dev/null 2>&1; then
  log "base packages already installed"
else
  apt_retry update -qq
  apt_retry install -y -qq ca-certificates curl gnupg git jq openssl ufw fail2ban unattended-upgrades
fi
# restic encrypts and uploads the off-server backups (install/backup.sh). It is
# in Ubuntu's "universe" section; a server without it still installs, and
# backup.sh says so when BACKUP_TARGET needs it.
if ! command -v restic >/dev/null 2>&1; then
  if [ "$DRY_RUN" -eq 1 ]; then log "  [dry-run] would install restic (off-server backups)"
  elif apt-get -o Acquire::Retries=3 install -y -qq restic >/dev/null 2>&1; then log "restic installed (off-server backups)"
  else warn "restic could not be installed — off-server backups (BACKUP_TARGET) will not run until it is"; fi
fi

step "2/6 Docker Engine + compose plugin (official Docker repo)"
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  log "Docker present: $(docker --version)"
else
  run install -m 0755 -d /etc/apt/keyrings
  if [ "$DRY_RUN" -eq 1 ]; then
    log "  [dry-run] would add the Docker apt repo and install docker-ce + compose plugin"
  else
    curl -fsSL --retry 5 --retry-delay 5 https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg
    printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu %s stable\n' \
      "$(dpkg --print-architecture)" "$VERSION_CODENAME" > /etc/apt/sources.list.d/docker.list
    apt_retry update -qq
    apt_retry install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  fi
  run systemctl enable --now docker
fi

step "3/6 Time zone and swap"
if [ -n "$TIMEZONE" ]; then
  if [ "$(timedatectl show -p Timezone --value 2>/dev/null)" = "$TIMEZONE" ]; then log "time zone already $TIMEZONE"
  else run timedatectl set-timezone "$TIMEZONE"; fi
fi
if swapon --show=NAME --noheadings 2>/dev/null | grep -q .; then log "swap already active"
elif [ "$SWAP_GB" -eq 0 ]; then log "swap disabled (--swap-gb 0)"
else
  # Docker image builds can spike memory on small servers; swap is a cushion.
  run fallocate -l "${SWAP_GB}G" /swapfile
  run chmod 600 /swapfile
  run mkswap /swapfile
  run swapon /swapfile
  if ! grep -q '^/swapfile ' /etc/fstab; then
    if [ "$DRY_RUN" -eq 1 ]; then log "  [dry-run] would add /swapfile to /etc/fstab"; else echo '/swapfile none swap sw 0 0' >> /etc/fstab; fi
  fi
fi

step "4/6 Automatic security updates (no automatic reboots)"
if [ "$DRY_RUN" -eq 1 ]; then log "  [dry-run] would write /etc/apt/apt.conf.d/20auto-upgrades + 52ok-unattended"; else
  printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' > /etc/apt/apt.conf.d/20auto-upgrades
  printf 'Unattended-Upgrade::Automatic-Reboot "false";\nUnattended-Upgrade::Remove-Unused-Kernel-Packages "true";\n' > /etc/apt/apt.conf.d/52ok-unattended
fi
run systemctl enable --now unattended-upgrades
if [ ! -f /etc/fail2ban/jail.d/ok-sshd.local ]; then
  if [ "$DRY_RUN" -eq 1 ]; then log "  [dry-run] would enable the fail2ban sshd jail"; else
    printf '[sshd]\nenabled = true\nmaxretry = 5\nbantime = 1h\n' > /etc/fail2ban/jail.d/ok-sshd.local
  fi
fi
run systemctl enable --now fail2ban

step "5/6 SSH: key-only logins"
# Only harden when a key is already installed — otherwise we would lock out the
# person (or Claude Code) who logged in with a password.
want_sshd=$'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin prohibit-password\n'
if [ "$SKIP_SSH" -eq 1 ]; then
  log "skipped (--skip-ssh-hardening)"
elif [ -f /etc/ssh/sshd_config.d/90-ok.conf ]; then
  log "already key-only"
elif ! find /root/.ssh /home/*/.ssh -maxdepth 1 -name authorized_keys -size +0 2>/dev/null | grep -q .; then
  warn "no SSH key found on this server — leaving password login ON. Add a key, then re-run."
else
  if [ "$DRY_RUN" -eq 1 ]; then log "  [dry-run] would write /etc/ssh/sshd_config.d/90-ok.conf and reload ssh"; else
    printf '%s' "$want_sshd" > /etc/ssh/sshd_config.d/90-ok.conf
    sshd -t
    systemctl reload ssh
  fi
fi

step "6/6 Firewall: allow SSH only (web traffic arrives through the Cloudflare Tunnel)"
if [ "$SKIP_FIREWALL" -eq 1 ]; then
  log "skipped (--skip-firewall)"
elif ufw status 2>/dev/null | grep -q 'Status: active' && [ "$(ufw status | grep -cE '^(80|443)(/tcp)? ')" -eq 0 ]; then
  log "firewall already active, web ports closed"
else
  run ufw default deny incoming
  run ufw default allow outgoing
  run ufw allow 22/tcp
  run ufw delete allow 80/tcp >/dev/null 2>&1 || true
  run ufw delete allow 443/tcp >/dev/null 2>&1 || true
  run ufw --force enable
fi

log "Host ready."
