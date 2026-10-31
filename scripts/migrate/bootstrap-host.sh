#!/usr/bin/env bash
# bootstrap-host.sh — prepare a fresh OVH Rise-4 (Ubuntu 24.04) for Command Center.
#
# Run as ROOT on the NEW host, once, after OVH hands it over:
#   sudo bash bootstrap-host.sh --timezone <same-as-DO> --mike-uid <same-as-DO> \
#     [--swap-gb 16] [--dry-run]
#
# The timezone MUST match the DigitalOcean droplet (preflight.sh prints it):
# every cron entry in scripts/install-*-cron.sh is wall-clock. mike's UID must
# match too: the copy uses rsync --numeric-ids, and OVH's Ubuntu image already
# has an `ubuntu` user on 1000.
#
# Idempotent: every step checks current state first and re-running is a no-op.
# Steps that can lock you out (sshd hardening, enabling ufw) ask for a typed
# confirmation. Supersedes scripts/bootstrap.sh for this host: same packages,
# minus the /opt/stack + OpenHands layout that compose no longer uses.
set -euo pipefail
# shellcheck source=scripts/migrate/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  sed -n '2,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

GITLEAKS_VERSION=8.21.2   # keep in sync with .github/workflows/oss-sync.yml
NODE_MAJOR=22             # matches app/Dockerfile + CI
TIMEZONE=
MIKE_UID=
SWAP_GB=16

parse_common_args "$@"
set -- "${REST_ARGS[@]+"${REST_ARGS[@]}"}"
while [ $# -gt 0 ]; do
  case "$1" in
    --timezone) shift; TIMEZONE=${1:-} ;;
    --timezone=*) TIMEZONE=${1#--timezone=} ;;
    --mike-uid) shift; MIKE_UID=${1:-} ;;
    --mike-uid=*) MIKE_UID=${1#--mike-uid=} ;;
    --swap-gb) shift; SWAP_GB=${1:-} ;;
    --swap-gb=*) SWAP_GB=${1#--swap-gb=} ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done
[ "$(id -u)" -eq 0 ] || die "run as root"
[ -n "$TIMEZONE" ] || die "--timezone is required (use the DO droplet's: preflight.sh prints it)"
[[ "$MIKE_UID" =~ ^[0-9]+$ ]] || die "--mike-uid is required (DO droplet: id -u mike; preflight.sh prints it)"
[[ "$SWAP_GB" =~ ^[0-9]+$ ]] || die "--swap-gb must be an integer"
. /etc/os-release
[ "${VERSION_ID:-}" = "24.04" ] || die "expected Ubuntu 24.04, got ${PRETTY_NAME:-unknown}"

export DEBIAN_FRONTEND=noninteractive

apt_repo() { # name keyurl keyring listline
  local name=$1 keyurl=$2 keyring=$3 line=$4
  if [ -s "$keyring" ] && [ -s "/etc/apt/sources.list.d/$name.list" ]; then
    log "apt repo $name already configured"
    return 0
  fi
  run install -m 0755 -d "$(dirname "$keyring")"
  if [ "$DRY_RUN" -eq 1 ]; then
    log "[dry-run] would fetch $keyurl -> $keyring and write /etc/apt/sources.list.d/$name.list"
    return 0
  fi
  curl -fsSL "$keyurl" | gpg --dearmor --yes -o "$keyring"
  chmod a+r "$keyring"
  printf '%s\n' "$line" > "/etc/apt/sources.list.d/$name.list"
}

step "1. Base packages"
run apt-get update -qq
run apt-get install -y -qq ca-certificates curl gnupg git jq unzip htop rsync sqlite3 restic \
  tmux ufw fail2ban unattended-upgrades mdadm smartmontools nvme-cli acl

step "2. Third-party apt repos: Docker, Caddy, NodeSource, GitHub CLI"
arch=$(dpkg --print-architecture)
apt_repo docker https://download.docker.com/linux/ubuntu/gpg /etc/apt/keyrings/docker.gpg \
  "deb [arch=$arch signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $VERSION_CODENAME stable"
apt_repo caddy-stable https://dl.cloudsmith.io/public/caddy/stable/gpg.key /usr/share/keyrings/caddy-stable-archive-keyring.gpg \
  "deb [signed-by=/usr/share/keyrings/caddy-stable-archive-keyring.gpg] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main"
apt_repo nodesource https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key /etc/apt/keyrings/nodesource.gpg \
  "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_$NODE_MAJOR.x nodistro main"
apt_repo github-cli https://cli.github.com/packages/githubcli-archive-keyring.gpg /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  "deb [arch=$arch signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main"
run apt-get update -qq
run apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin \
  caddy nodejs gh
run systemctl enable --now docker

step "3. gitleaks $GITLEAKS_VERSION (used by the OSS sync gate)"
if command -v gitleaks >/dev/null 2>&1 && gitleaks version 2>/dev/null | grep -q "$GITLEAKS_VERSION"; then
  log "gitleaks $GITLEAKS_VERSION already installed"
elif [ "$DRY_RUN" -eq 1 ]; then
  log "[dry-run] would install gitleaks $GITLEAKS_VERSION to /usr/local/bin"
else
  tmp=$(mktemp -d)
  curl -fsSL --retry 3 -o "$tmp/gl.tgz" \
    "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"
  tar -xzf "$tmp/gl.tgz" -C "$tmp" gitleaks
  install -m 0755 "$tmp/gitleaks" /usr/local/bin/gitleaks
  rm -rf "$tmp"
fi

step "4. User mike (sudo NOPASSWD + docker group — preview-spool + scripts rely on both)"
if id mike >/dev/null 2>&1; then
  [ "$(id -u mike)" = "$MIKE_UID" ] || die "mike exists with uid $(id -u mike), source uses $MIKE_UID — fix before copying data"
  log "user mike exists (uid $MIKE_UID)"
else
  holder=$(getent passwd "$MIKE_UID" | cut -d: -f1 || true)
  [ -z "$holder" ] || die "uid $MIKE_UID is taken by '$holder' (OVH image user). Remove or renumber it first: usermod -u 2000 $holder && groupmod -g 2000 $holder"
  run adduser --disabled-password --gecos "" --uid "$MIKE_UID" mike
fi
run usermod -aG sudo,docker mike
if [ ! -f /etc/sudoers.d/mike ]; then
  if [ "$DRY_RUN" -eq 1 ]; then log "[dry-run] would write /etc/sudoers.d/mike (NOPASSWD)"; else
    printf 'mike ALL=(ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/mike
    chmod 440 /etc/sudoers.d/mike
    visudo -cf /etc/sudoers.d/mike >/dev/null
  fi
fi
# The OVH panel installs Mike's public key for root (or 'ubuntu'). Copy it once.
if [ ! -s /home/operator/.ssh/authorized_keys ]; then
  key_src=
  for f in /root/.ssh/authorized_keys /home/ubuntu/.ssh/authorized_keys; do
    [ -s "$f" ] && { key_src=$f; break; }
  done
  [ -n "$key_src" ] || die "no authorized_keys to copy — add your SSH key in the OVH panel first"
  run install -d -m 700 -o mike -g mike /home/operator/.ssh
  run install -m 600 -o mike -g mike "$key_src" /home/operator/.ssh/authorized_keys
fi

step "5. Directory layout (must match docker-compose.yml bind mounts)"
for d in data/command-center projects second-brain ai-workspace transcripts assistant \
         .config/command-center .config/gh .doppler .claude-auth .cc-migrate/logs; do
  if [ -d "/home/operator/$d" ]; then continue; fi
  run install -d -o mike -g mike "/home/operator/$d"
done
run install -d /etc/caddy/sites-enabled

step "6. Timezone $TIMEZONE"
if [ "$(timedatectl show -p Timezone --value)" = "$TIMEZONE" ]; then log "already $TIMEZONE"; else
  run timedatectl set-timezone "$TIMEZONE"
fi

step "7. Swap (${SWAP_GB} GiB swapfile — 128 GB RAM, swap is a crash cushion, not capacity)"
if swapon --show=NAME --noheadings | grep -q .; then log "swap already active"; elif [ "$SWAP_GB" -eq 0 ]; then log "swap disabled by --swap-gb 0"; else
  run fallocate -l "${SWAP_GB}G" /swapfile
  run chmod 600 /swapfile
  run mkswap /swapfile
  run swapon /swapfile
  if ! grep -q '^/swapfile ' /etc/fstab; then
    if [ "$DRY_RUN" -eq 1 ]; then log "[dry-run] would append /swapfile to /etc/fstab"; else echo '/swapfile none swap sw 0 0' >> /etc/fstab; fi
  fi
  if [ "$DRY_RUN" -eq 1 ]; then log "[dry-run] would set vm.swappiness=10"; else
    printf 'vm.swappiness=10\n' > /etc/sysctl.d/90-cc-swap.conf
    sysctl -q --system
  fi
fi

step "8. Unattended security upgrades (no automatic reboot — reboots are Mike's call)"
if [ "$DRY_RUN" -eq 1 ]; then log "[dry-run] would write /etc/apt/apt.conf.d/20auto-upgrades + 52cc-unattended"; else
  printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' > /etc/apt/apt.conf.d/20auto-upgrades
  printf 'Unattended-Upgrade::Automatic-Reboot "false";\nUnattended-Upgrade::Remove-Unused-Kernel-Packages "true";\n' > /etc/apt/apt.conf.d/52cc-unattended
fi
run systemctl enable --now unattended-upgrades

step "9. fail2ban (sshd jail)"
if [ ! -f /etc/fail2ban/jail.d/cc-sshd.local ]; then
  if [ "$DRY_RUN" -eq 1 ]; then log "[dry-run] would write /etc/fail2ban/jail.d/cc-sshd.local"; else
    printf '[sshd]\nenabled = true\nmaxretry = 5\nbantime = 1h\n' > /etc/fail2ban/jail.d/cc-sshd.local
  fi
fi
run systemctl enable --now fail2ban
run systemctl restart fail2ban

step "10. RAID monitoring (mdadm emails nobody by default — verify.sh + the CC disk watchdog read /proc/mdstat)"
run systemctl enable --now mdmonitor.service 2>/dev/null || warn "mdmonitor unit not present; skip"
run systemctl enable --now smartmontools.service 2>/dev/null || warn "smartd unit not present; skip"

step "11. sshd hardening (key-only, no root password login)"
want_sshd=$'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin prohibit-password\n'
if [ -f /etc/ssh/sshd_config.d/90-cc.conf ] && [ "$(cat /etc/ssh/sshd_config.d/90-cc.conf)" = "${want_sshd%$'\n'}" ]; then
  log "sshd already hardened"
else
  log "Before confirming: keep THIS session open and test 'ssh mike@<host>' from a second terminal afterwards."
  confirm HARDEN-SSH "disable SSH password logins (key-only)"
  if [ "$DRY_RUN" -eq 0 ]; then
    printf '%s' "$want_sshd" > /etc/ssh/sshd_config.d/90-cc.conf
    sshd -t
    systemctl reload ssh
  fi
fi

step "12. ufw: 22/80/443 only (same as scripts/bootstrap.sh; 3002/4000 stay on 127.0.0.1 per compose)"
if ufw status | grep -q 'Status: active'; then
  log "ufw already active:"
  ufw status | sed 's/^/  /'
else
  run ufw default deny incoming
  run ufw default allow outgoing
  run ufw allow 22/tcp
  run ufw allow 80/tcp
  run ufw allow 443/tcp
  confirm ENABLE-UFW "enable the firewall (22/80/443 allowed — SSH stays open)"
  run ufw --force enable
fi

step "Done"
log "Next: as mike, run scripts/migrate/preflight.sh --src mike@<do-ip>"
