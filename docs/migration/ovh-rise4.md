# Command Center: DigitalOcean → OVHcloud Rise-4 migration runbook

| | Source (today) | Target |
|---|---|---|
| Host | DigitalOcean droplet `command-center`, c2-32vcpu-64gb-intel | OVHcloud Rise-4 bare metal, Vint Hill VA (US-East) |
| CPU / RAM | 32 vCPU / 64 GB | 16 cores / 128 GB |
| Disk | 800 GB, **no snapshots, no backups** | 4 × 960 GB NVMe, software RAID |
| Cost | $978/mo | ~$276/mo + $200 one-time setup |
| Domain | cc.example.com | same |

Saving: about **$700/mo** (~$8.4k/yr). The $200 setup fee is paid back in the first ten days.

Everything below comes from the repo on `main`: `docker-compose.yml`, `config/caddy/Caddyfile`, `config/systemd/*`, `scripts/install-*-cron.sh`, `scripts/host-boot.d/`, `app/server/src/config.ts`, `services/secrets-crypto.ts`, `services/crypto.ts`, `services/account-router.ts`, and `lib/host-disk.ts`. Anything the repo cannot prove is marked **VERIFY ON HOST**.

Scripts: `scripts/migrate/`. Every script uses `set -euo pipefail` and supports `--dry-run`, which prints every mutating command and changes nothing. Every destructive or cutover step asks you to type a word to confirm; there is no `--yes`. No script prints a secret. CI runs shellcheck on all of them.

| Script | Where / as whom | What it does |
|---|---|---|
| `bootstrap-host.sh` | new host, root | packages, mike user, Docker, Caddy, Node 22, gh, gitleaks, ufw, fail2ban, unattended-upgrades, timezone, swap |
| `preflight.sh` | new host, mike | read-only checks on **both** hosts |
| `presync.sh` | new host, mike | phase 1: live bulk copy, repeatable, no downtime |
| `cutover.sh` | new host, mike, in tmux | phase 2: drain, stop, dump, final delta, accounts, restore, start, DNS |
| `verify.sh` | new host, mike | phase 3: acceptance checks |
| `cc-backup.sh` + `config/systemd/cc-backup.{service,timer}` | new host, root (timer) | nightly restic backup to off-site storage |
| `install-backup-timer.sh` | new host, root | installs the units, runs `restic init` once, enables the timer |
| `restore-test.sh` | new host, root | restores a snapshot to scratch space and checks it |

**How the scripts run.** Everything runs on the **new** host and *pulls* from the old one over SSH. Connect from your laptop with agent forwarding (`ssh -A mike@<ovh-ip>`). Your laptop key then reaches the droplet, and no private key has to be copied onto either server. Hosts are passed as arguments (`--src mike@<do-ip>`, `--new-ip <ovh-ip>`). No IP is hard-coded.

---

## A. Mike does these himself

Nothing here can be scripted or delegated. They involve money, DNS, or identity.

- [ ] **Order the Rise-4** in **Vint Hill (US-East)**. OS: **Ubuntu 24.04 LTS** (Server). Use custom partitioning for software RAID (see below).
- [ ] **RAID: choose RAID10 across all 4 NVMe** for `/`, with `/boot` (and `/boot/efi` if offered) as the installer's default RAID1.
  - RAID10 gives **~1.92 TB usable**, about 2.4× today's disk. It survives any 1 disk failure, and a second if it is in the other mirror pair. Writes are fastest, which matters for SQLite WAL, Docker builds and `git worktree add`.
  - RAID1 across 4 disks (4-way mirror) survives 3 failures, but only **~960 GB is usable**. That is barely above today's 800 GB, on a host that has already filled its disk several times (§J). Not worth it.
  - RAID5/6: skip. Slow writes, long rebuilds, and OVH's installer handles it less well.
  - Tradeoff: RAID10 gives up redundancy you will not need (3-disk survival) for headroom you will need. Backups (§I) cover the "whole box lost" case, which no RAID level does.
- [ ] **Add your SSH public key** in the OVH panel at install time (it lands in `root`'s or `ubuntu`'s `authorized_keys`; `bootstrap-host.sh` copies it to `mike`).
- [ ] **Lower the DNS TTL** for `cc.example.com` to **300 s at least 24 h before cutover**. Do the same for `llm.mikeluka.com`, `n8n.example.com` if it moves (§B.6), and any `*.cc.example.com` wildcard.
- [ ] **Approve the cutover window**: 2–3 h, ideally a weekday evening ET when no cards are running (§H).
- [ ] **Create and pay for backup storage**: a private Backblaze B2 bucket plus an application key limited to that bucket (§I). Expect under $1/mo at current sizes.
- [ ] **Create the restic password** in your password manager and paste it into the root-only file (§I.2). Without it the backups cannot be read.
- [ ] **Flip the DNS A records** when `cutover.sh` tells you to (§G).
- [ ] **Destroy the DO droplet only after 48 h of healthy running** on OVH. No script ever deletes the droplet or its data.
- [ ] **Update any third-party IP allowlists** that name the droplet's IP. The new host's outbound IP will be different. **VERIFY ON HOST**: check vendor dashboards (database firewalls, the Twenty droplet's SSH/firewall, Supabase network restrictions) for the old IP.

---

## B. Host bootstrap

### B.1 First login + clone the scripts

```bash
ssh -A root@<ovh-ip>              # or ubuntu@, whichever the OVH image uses
# on the DO droplet (read-only), note two values:
#   timedatectl show -p Timezone --value      -> TZ
#   id -u mike                                -> UID
git clone https://github.com/your-org/operationkit.git /root/cc-migrate   # after this PR merges; or check out the PR branch
sudo bash /root/cc-migrate/scripts/migrate/bootstrap-host.sh --timezone <TZ> --mike-uid <UID> --dry-run
sudo bash /root/cc-migrate/scripts/migrate/bootstrap-host.sh --timezone <TZ> --mike-uid <UID>
```

The **timezone must match** the droplet. Every cron in `scripts/install-*-cron.sh` is wall-clock (for example `0 8 * * *` campaign-audit and `30 2 * * *` dream-cycle). **mike's UID must match** too, because the copy uses `rsync --numeric-ids`. OVH's Ubuntu image ships an `ubuntu` user on UID 1000, and if that is mike's UID on DO the script stops and tells you how to renumber it.

### B.2 What `bootstrap-host.sh` sets up

| Area | Setting | Source of truth in repo |
|---|---|---|
| Packages | curl git jq rsync sqlite3 restic tmux mdadm smartmontools nvme-cli acl | `scripts/bootstrap.sh` + migration needs |
| Docker | docker-ce + **compose plugin** + buildx, `mike` in `docker` group | `scripts/bootstrap.sh` §3; `cc-preview-spool.service` builds as mike |
| Reverse proxy + TLS | **Caddy** (cloudsmith apt repo), auto-TLS via Let's Encrypt | `config/caddy/Caddyfile` |
| Node | **22.x** (NodeSource). Host scripts like `cc-live.mjs` and `loop-closer-nudge.mjs` need it | `app/Dockerfile` `FROM node:22`, CI `node-version: 22` |
| Claude / Codex CLIs | **not on the host**. They are baked into the image (`npm i -g @anthropic-ai/claude-code`, `@openai/codex`) and run via `docker exec` | `app/Dockerfile`, `scripts/run-claude-host.sh` |
| bun | **not used**: no script, Dockerfile or package.json references it | `grep -r bun scripts app/package.json` |
| gh CLI | GitHub apt repo | sessions' `/etc/gh` mount |
| gitleaks | 8.21.2 (same pin as CI) | `.github/workflows/oss-sync.yml` |
| User | `mike`, same UID as DO, sudo NOPASSWD (preview-deploy uses `sudo caddy reload`), docker group | `config/systemd/cc-preview-spool.service` comments |
| Paths | `/home/operator/{data/command-center,projects,second-brain,ai-workspace,transcripts,assistant}`, `~/.config/command-center`, `~/.doppler`, `~/.claude-auth`, `/etc/caddy/sites-enabled` | `docker-compose.yml` volumes, `app/server/src/config.ts` |
| Firewall | ufw deny-in; allow **22, 80, 443 only**. 3002 (CC) and 4000 (LiteLLM) bind to 127.0.0.1 in compose, so they need no rule | `scripts/bootstrap.sh` §1, compose `ports:` |
| fail2ban | sshd jail, 5 tries / 1 h ban | `scripts/bootstrap.sh` |
| unattended-upgrades | security updates daily, **no automatic reboot** | — |
| sshd | key-only (`PasswordAuthentication no`, `PermitRootLogin prohibit-password`). Asks you to type `HARDEN-SSH` | — |
| Swap | 16 GiB swapfile, `vm.swappiness=10` (a crash cushion; 128 GB RAM is the capacity) | — |
| RAID/SMART | `mdmonitor` + `smartd` enabled; `verify.sh` reads `/proc/mdstat`, `mdadm --detail`, `smartctl -H` | — |

### B.3 Preflight

```bash
ssh -A mike@<ovh-ip>
git clone git@github.com:your-org/operationkit.git ~/cc-migrate   # temporary; the real checkout arrives with presync
bash ~/cc-migrate/scripts/migrate/preflight.sh --src mike@<do-ip> --sizes
```

It checks both hosts: SSH and sudo, versions, disk, RAID sync, free-space headroom, matching UID and timezone, ufw rules, ports, toolchain, containers, Docker volume, and that every required file exists. **Existence only. Secret contents are never read.** It also counts leftover worktrees and lists containers that are not in compose.

### B.4 Services the repo defines (moved by the scripts)

`docker-compose.yml`: `command-center` (127.0.0.1:3002), `litellm` (127.0.0.1:4000), `litellm-db` (postgres:16, volume `litellm_postgres_data`). Caddy fronts `cc.example.com` (→3002), `llm.mikeluka.com` (→4000) and `import /etc/caddy/sites-enabled/*.caddy` (PR previews). The one systemd pair is `cc-preview-spool.{path,service}`.

### B.5 Inside-container daemons

`host-boot.d` hooks run **inside the CC container**, not from host systemd. `services/host-boot-daemons.ts` executes `/home/operator/ai-workspace/host-boot.d/run-all.sh` at boot and every 5 min. They move with `ai-workspace/` and need no install step. The repo copy `scripts/host-boot.d/40-disk-hygiene.sh` is the source for one of those hooks. **VERIFY ON HOST**: run `ls -l /home/operator/ai-workspace/host-boot.d/` on DO to see whether it is a symlink or a copy; recreate it the same way if it is not under `ai-workspace`.

### B.6 Services on the droplet that are NOT in compose (VERIFY ON HOST)

The Caddyfile proxies two hosts that compose does not define:

- `n8n.example.com` → `localhost:5678`. The Caddyfile comment says it carries the Wrong-Time → n8n → GHL webhook and all other n8n inbound webhooks. **If n8n runs on this droplet, destroying the droplet kills it.** Decide before cutover: move it (stop container, copy its data dir/volume, `docker run` with the same flags, flip its A record) or keep it running elsewhere. Find it with `docker ps -a`, `docker inspect n8n --format '{{json .Mounts}}'` and `systemctl list-units | grep -i n8n`. `preflight.sh` lists every extra container.
- `oh.mikeluka.com` → `localhost:3000` (OpenHands). `scripts/bootstrap.sh` mentions it but compose does not. It is probably retired; confirm before dropping it.
- Anything in **root's** crontab: preflight counts its entries; port them by hand.

---

## C. Secrets transfer (no values printed, ever)

`presync.sh --only secrets` asks you to type `COPY-SECRETS`, then copies each item with `rsync -a --chmod=F600` (directories `D700`) over the SSH session. It compares a SHA-256 of each file or tree on both sides and prints only `MATCH`, `MISMATCH` or `absent`. Neither the contents nor the hashes are shown. `cutover.sh` repeats it during the final delta in case anything rotated.

| Path | What it is | What breaks if it is missing or wrong |
|---|---|---|
| `/home/operator/projects/operationkit/.env` | compose interpolation: `CC_JWT_SECRET`, `POSTGRES_PASSWORD`, `LITELLM_MASTER_KEY`, `LITELLM_SALT_KEY`, provider keys, webhook secrets | **CC refuses to boot** (empty `JWT_SECRET` fails boot, see SECURITY.md). LiteLLM cannot reach its DB. A *different* `CC_JWT_SECRET` logs everyone out and invalidates `CC_SERVICE_TOKEN` in cron.env. A different `LITELLM_SALT_KEY` makes LiteLLM unable to decrypt the model credentials stored in its DB (`STORE_MODEL_IN_DB`). |
| `/home/operator/projects/.secrets-master-key` (or `SECRETS_MASTER_KEY` in env) | AES-256-GCM key for **Settings → Secrets** in SQLite (`services/secrets-crypto.ts`) | Every stored secret is unreadable. Sessions spawn without their env secrets, and integrations fail. **Not recoverable without the key.** |
| `/home/operator/projects/.test-cred-encryption-key` (or `TEST_CRED_ENCRYPTION_KEY`) | key for per-user Google/GitHub connections and test credentials (`services/crypto.ts`) | Sessions get `GOOGLE_WORKSPACE_CONNECTION=absent` and no `GH_TOKEN`: the same failure fixed in obj 716719 (commit 3b743f7). |
| `/home/operator/projects/.doppler-admin-token` | Doppler personal token (`DOPPLER_TOKEN_PATH`, `config.ts`) | Doppler fallbacks, `scripts/fix-vps-cron.sh` secret resolution, and sessions that read Doppler. |
| `/home/operator/.doppler/` | Doppler service-token config, mounted `:ro` at `/root/.doppler` | Same as above for the service-token path. |
| `/home/operator/.config/command-center/cron.env` | `CC_SERVICE_TOKEN`, Supabase/example cron secrets | Every host cron fails to authenticate. |
| `/home/operator/.ssh/` (minus `authorized_keys`) | `id_ed25519` used by `GIT_SSH_COMMAND`, plus known_hosts | Sessions cannot `git push`, and `preview-deploy.sh` cannot fetch. |
| `/home/operator/.config/gh/` | gh CLI auth, mounted `:ro` at `/etc/gh` | PR creation from sessions fails. |

`preflight.sh` also checks **by name** (`grep -q '^NAME='`, values never read) that `.env` defines `SECRETS_MASTER_KEY`, `TEST_CRED_ENCRYPTION_KEY`, `CC_JWT_SECRET`, `LITELLM_SALT_KEY` and `POSTGRES_PASSWORD`. That tells you whether each encryption key comes from the file or from env.

The `.doppler-admin-token` is still inside the projects bind mount (obj-2202 gate B3). This migration keeps that layout byte-identical and does not do the relocation. That stays a separate cutover (`app/server/SPAWN-ENV-SCOPING-CUTOVER.md`).

---

## D. Data in three phases

### D.1 Pre-sync (live, no downtime): `presync.sh`

```bash
bash ~/cc-migrate/scripts/migrate/presync.sh --src mike@<do-ip> --dry-run
bash ~/cc-migrate/scripts/migrate/presync.sh --src mike@<do-ip>          # first run: hours
bash ~/cc-migrate/scripts/migrate/presync.sh --src mike@<do-ip>          # again the day before: minutes
```

Order: `projects`, `second-brain`, `ai-workspace`, `transcripts`, `assistant`, `data`, `ssh`, `gh`, `secrets`, then a snapshot of `/etc/caddy` and the crontab into `~/.cc-migrate/src-etc/` for review. `--only NAME` reruns one tree.

Excluded from `projects/`:
- **stale card worktrees**: `/*-wt-*`, `/.cc-worktree-*`, `/cc-wt-*`, and each repo's `.git/worktrees/` admin dirs (followed by `git worktree prune`). These caused the DO ENOSPC outages (§J).
- `node_modules/`, `.next/`, `.turbo/`, `.vite/`, `.cache/`, `coverage/`, `dist/`, `build/`, `out/`, `*.tsbuildinfo`
- **except** `operationkit/app/client/dist/`. Compose bind-mounts it, and an empty one means a blank board.
- the secret files (copied by the `secrets` step instead) and `.preview-spool/` (in-flight jobs belong to the old host)

Excluded from `data/command-center/`: the live `command-center.db{,-wal,-shm}` (a hot copy would be torn), `cc-accounts/` (§D.3) and `backups/`.

All copies run `sudo rsync -aHAX --numeric-ids` on both ends, so ccuser- and root-owned files keep their owners. Presync **never passes `--delete`**.

### D.2 Cutover: `cutover.sh` (run inside tmux)

```bash
tmux new -s cutover
bash ~/projects/operationkit/scripts/migrate/cutover.sh --src mike@<do-ip> --new-ip <ovh-ip> --dry-run
bash ~/projects/operationkit/scripts/migrate/cutover.sh --src mike@<do-ip> --new-ip <ovh-ip>
```

Each step writes `~/.cc-migrate/cutover.<step>.done`. Re-running resumes after the last finished step, and `--redo <step>` repeats one.

1. **prebuild**: `docker compose build command-center` + `pull` on the new host while DO is still live, so the build does not count as downtime.
2. **drain**: polls the old DB read-only (`better-sqlite3 {readonly:true}` inside the container) every 60 s until `working=0 ai_review=0 planning=0`. **The app has no queue-pause switch**, so do not start or queue cards during the window. Queued cards stay `queue` in the DB and start on the new host. Times out after `--drain-timeout` (default 60 min). Continuing past the timeout requires typing `FORCE-STOP`.
3. **stop-old** (type `STOP-OLD`; **downtime starts**): `docker compose stop command-center`. Then the old crontab is saved to `~/.cc-migrate/crontab.before-cutover` and commented out (`#MIGRATED `), so old jobs cannot fork the vault. `cc-preview-spool.path` is stopped. LiteLLM stays up for its dump.
4. **dump**: `sqlite3 command-center.db ".backup '…/migrate/command-center.cutover.db'"` (falls back to better-sqlite3 in the stopped image if the host has no `sqlite3`), `PRAGMA integrity_check`, `docker exec litellm-db pg_dump -U llmproxy -d litellm -Fc`, then stop LiteLLM.
5. **final-sync** (type `FINAL-SYNC`): re-runs every presync tree with `--delete`, so removals on the source carry over. Excluded paths stay protected because `--delete-excluded` is never used. Then the data dir, which brings the two dump files.
6. **accounts**: §D.3.
7. **restore** (type `RESTORE`): integrity_check must be `ok`, install the snapshot as `command-center.db`, start `litellm-db`, then `pg_restore --clean --if-exists --no-owner`.
8. **host-config**: install the repo `Caddyfile` (it prints a diff if DO's live file differs; port any live-only block into the repo first), copy the preview `sites-enabled/*.caddy`, `caddy validate`, then `scripts/install-preview-spool.sh` and `install-backup-timer.sh` (§I).
9. **start** (type `START`): `docker compose up -d`, wait for `/api/health`, then reinstall crons (§E).
10. **dns**: prints the A records for you to change (§G), waits until `dig @1.1.1.1` returns the new IP, reloads Caddy so ACME retries immediately, and checks `https://cc.example.com/api/health`.

### D.3 Claude account folders

Copied **only at cutover, after the old CC is stopped**. Claude/Codex OAuth refresh tokens rotate. If the old host keeps refreshing after the copy, the new host's copy is revoked.

| Slot | Host path | In-container HOME |
|---|---|---|
| a–e | `/home/operator/.ccuser-{a..e}` | `/home/ccuser-{a..e}` |
| f, g, grok | `/home/operator/data/command-center/cc-accounts/{f,g,grok}` | `/app/data/cc-accounts/…` |
| codex | `/home/operator/.ccuser-codex` | `/home/ccuser-codex` |
| root CLI auth | `/home/operator/.claude-auth` | `/root/.claude` |

Each tree is checksum-compared after the copy. `verify.sh` then probes **every slot a–g** with a one-line `claude -p` as `ccuser`, with `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` stripped, so it only passes on the subscription login and never bills the metered key. Codex is checked with `codex login status`.

**Re-login for a failed slot** (subscription only):

```bash
docker exec -it -u ccuser -e HOME=/home/ccuser-<slot> command-center env -u ANTHROPIC_API_KEY claude
#   slots f/g: HOME=/app/data/cc-accounts/<slot>
# in the CLI: /login -> "Claude account with subscription" -> sign in as that slot's account -> /exit
docker exec -it -u ccuser -e HOME=/home/ccuser-codex command-center codex login     # codex
```

Then check the slot on the board's accounts view. If a seat shows "org disabled subscription access", that is a billing state (past-due) and not a migration problem.

---

## E. Reinstall systemd units, crons and hooks

`cutover.sh` does all of this. To redo by hand:

```bash
sudo bash scripts/install-preview-spool.sh          # cc-preview-spool.{path,service}
sudo bash scripts/migrate/install-backup-timer.sh   # cc-backup.{service,timer}
bash scripts/install-daily-log-cron.sh              # update-active-state (hourly), generate-daily-digest (23:00)
bash scripts/install-campaign-audit-cron.sh         # 08:00
bash scripts/install-reconcile-clients-cron.sh      # 00:05 (skips itself if the endpoint is absent)
bash scripts/install-cron-health-cron.sh            # 09:30
bash scripts/install-dream-cycle-cron.sh            # 02:30
bash scripts/install-disk-cleanup-cron.sh           # every 6h at :25
```

`cron.env` comes over with the secrets, and its `CC_SERVICE_TOKEN` is signed with the same `CC_JWT_SECRET`, so the installers are enough. `scripts/fix-vps-cron.sh` also re-mints the token, but it **runs every job once**, which would fire the daily audit and digest mid-cutover. Use it only if a cron fails verification.

`host-boot.d` hooks need no install step (§B.5).

---

## F. Verification checklist: `verify.sh`

```bash
bash scripts/migrate/verify.sh --new-ip <ovh-ip> --test-card
```

It asks for a `cc_live_` key with input hidden (create one in **Settings → You → API key**). The key reaches curl through a 600 temp file, never argv or the log.

- [ ] `command-center`, `litellm`, `litellm-db` running/healthy; local `/api/health`; LiteLLM liveliness
- [ ] **Board loads**: the HTTPS `/` returns the SPA shell, and `app/client/dist/index.html` is present
- [ ] **Settings → API key page loads**: the `/settings/you` route is served, and `GET /api/auth/api-key` (that page's data call) returns 200
- [ ] **MCP**: `POST /api/mcp` `tools/list` with the `cc_live_` key returns `tools`
- [ ] **Test card reaches `working`** (`--test-card`, type `TEST-CARD`): creates a throwaway card, PATCHes it to working, waits for a session, then cancels it
- [ ] **Account slots a–g + codex** logged in (§D.3)
- [ ] **OSS sync**: gitleaks 8.21.2 is installed, and `scripts/oss-gate-roster-test.sh` (the real gate, run against clean and dirty fixtures) passes. The publish job itself runs in GitHub Actions and is host-independent; `verify.sh` prints the last `oss-sync.yml` run. Mike's call: trigger a `workflow_dispatch` once afterwards. It opens or updates the public sync PR, so it is not automated here.
- [ ] **Crons** (update-active-state, generate-daily-digest, campaign-audit, cron-health-check, dream-cycle, disk-cleanup, reconcile-clients) and **timers** (`cc-backup.timer`, `cc-preview-spool.path`)
- [ ] **host-boot.d** and the **disk watchdog** logging in the container
- [ ] **Disk/RAID**: ≥15% free, `/proc/mdstat` all `[UUUU]`, each `md` array clean/active, `smartctl -H` PASSED on every NVMe
- [ ] DNS resolves to the new IP and the TLS cert has been issued

---

## G. DNS cutover + rollback

**Cutover.** TTL must already be 300 s (§A, set ≥24 h earlier). At the `dns` step, change the A records to the OVH IP:

- `cc.example.com` (required)
- `llm.mikeluka.com` (LiteLLM admin; moves with compose)
- `*.cc.example.com` / `pr-N.cc.example.com`, if previews use a wildcard record (**VERIFY** in the DNS zone)
- `n8n.example.com` **only** if n8n was moved (§B.6)

Leave mail records (MX/SPF/DKIM) alone; nothing here touches mail. Inbound webhooks (GitHub, Supabase, Example Project) follow the hostname and need no change.

**Keep the droplet powered for 48 h**, with services stopped, data intact and crontab commented. Do not snapshot-and-destroy early.

**Rollback** (any time in the 48 h):
1. On OVH, stop first so two hosts never run the same accounts and crons: `cd ~/projects/operationkit && docker compose stop && crontab -r` (the installers can restore it). Also `sudo systemctl stop cc-backup.timer cc-preview-spool.path`.
2. Point the A records back to the DO IP.
3. On DO: `crontab ~/.cc-migrate/crontab.before-cutover && cd ~/projects/operationkit && docker compose up -d && sudo systemctl start cc-preview-spool.path`.
4. Anything done on OVH after cutover (cards, vault edits) only exists there. To keep it, stop OVH and reverse the copy *before* step 3: on OVH `sqlite3 command-center.db ".backup …"`, then rsync that file and `second-brain/` back to DO. The scripts are not wired for the reverse direction on purpose; do it deliberately.
5. **Only Mike destroys the droplet**, after 48 h healthy on OVH and one successful `restore-test.sh`.

---

## H. Downtime estimate + prep timeline

**Downtime window: about 45–90 min. Book 2 h, worst case 3 h.**

| Step | Est. | Why |
|---|---|---|
| drain | 0 (board still up) | Waits for in-flight cards; not downtime. Up to 60 min if a long card is running. |
| stop-old | 1 min | `compose stop` |
| dump | 2–5 min | SQLite `.backup` is a page copy, roughly a minute per few GB on NVMe. LiteLLM `pg_dump -Fc` is small (spend logs). |
| final-sync | **15–40 min** | The long pole. rsync must *walk* every file in projects/vault/ai-workspace even when few changed. Presync the day before keeps the delta small; the file count sets the time. |
| accounts | 2–5 min | Small trees; the checksums add a little. |
| restore | 3–5 min | DB install + integrity_check + pg_restore |
| host-config + start | 3–5 min | Image already prebuilt; `/api/health` within ~30 s |
| DNS | 5–10 min | TTL 300 + resolver lag. Caddy gets the cert seconds after the records resolve. |
| verify | 10–15 min | Includes the test card and 7 account probes |

**Prep timeline**

| When | Who | What |
|---|---|---|
| T-7d | Mike | Order Rise-4 (§A). Create the B2 bucket + key + restic password. |
| T-5d | script | `bootstrap-host.sh`, `preflight.sh --sizes`; fix every FAIL. Decide n8n (§B.6). |
| T-4d | script | First `presync.sh` (hours; DO stays live). `docker compose build` on OVH to prove the build. |
| T-2d | script | `presync.sh` again; `cutover.sh --dry-run`; `install-backup-timer.sh` + manual backup + `restore-test.sh` against a presynced copy |
| T-1d (≥24 h before) | Mike | Lower TTLs to 300. Approve the window. Final `presync.sh`. |
| T-0 | Mike + script | `cutover.sh` in tmux; flip DNS when prompted; `verify.sh --test-card` |
| T+1d | script | First nightly backup ran (`journalctl -u cc-backup`), then `restore-test.sh` |
| T+48h | Mike | All green, so destroy the droplet. Raise TTLs back. |

---

## I. Backups (bare metal has no snapshots)

### I.1 Provider: **Backblaze B2** (recommended)

Prices checked 2026-10-23 on each provider's pricing page:

| | Storage | Egress | Notes |
|---|---|---|---|
| **Backblaze B2** | **$6.95 / TB-mo**, first 10 GB free | free up to 3× stored, then $0.01/GB | No minimum duration. **A separate company and network from OVH.** |
| Cloudflare R2 | $15 / TB-mo (standard), 10 GB free | free | Class A $4.50/M, Class B $0.36/M operations |
| OVH Object Storage (US) | ~$0.0081 / GiB-mo (~$8.30/TB) | free | Cheap, but **same provider as the server**. An account suspension, billing lock or datacenter incident (OVH SBG, 2021) takes out the host and its backups together. |

Expected size: SQLite + pg_dump + vault + ai-workspace + configs is tens of GB. Restic dedupes, so 14/8/12 retention adds little, and the cost is **well under $1/mo**. B2 wins on price and on keeping backups away from the host's provider. R2 is the pick only if fast full restores turn out to matter more than cost.

### I.2 Credentials (root-only, never committed, never printed)

```bash
sudo install -d -m 700 /root/.config/cc-backup
sudo install -m 600 /dev/null /root/.config/cc-backup/restic.env
sudo nano /root/.config/cc-backup/restic.env
#   RESTIC_REPOSITORY=s3:https://s3.<b2-region>.backblazeb2.com/<bucket>/command-center
#   AWS_ACCESS_KEY_ID=<B2 keyID>
#   AWS_SECRET_ACCESS_KEY=<B2 applicationKey>
sudo install -m 600 /dev/null /root/.config/cc-backup/restic-password
sudo nano /root/.config/cc-backup/restic-password     # paste the password from your password manager
sudo bash scripts/migrate/install-backup-timer.sh     # type INIT-REPO once
sudo systemctl start cc-backup.service && journalctl -u cc-backup -f
```

If the restic password is lost, every snapshot is unreadable. Keep it in the password manager, not on the host only. The scripts check the files exist with mode 600 and never read the values out loud.

### I.3 What, when, how long

- `cc-backup.timer`: daily 03:15 host time (±15 min), `Persistent=true` (runs at boot if missed). Runs `cc-backup.sh --scheduled` as root at idle I/O priority.
- Each snapshot: SQLite `.backup` (+ `integrity_check` before it is accepted), LiteLLM `pg_dump -Fc`, `second-brain/`, `ai-workspace/` (minus node_modules/.cache/.next), `/etc/caddy`, mike's crontab, and every secret path from §C. Restic encrypts client-side, so B2 only ever sees ciphertext.
- Not backed up: account OAuth homes (recovery is re-login, §D.3), `projects/` (lives on GitHub), transcripts (logs).
- Retention: **14 daily, 8 weekly, 12 monthly** (`forget --prune`). An interactive run asks before pruning (`PRUNE`); the timer's `--scheduled` flag is the standing approval. Every Sunday: `restic check --read-data-subset=5%`.

### I.4 Restore test (monthly + right after the first backup)

```bash
sudo bash scripts/migrate/restore-test.sh --dry-run
sudo bash scripts/migrate/restore-test.sh            # latest snapshot; --snapshot ID, --keep
```

It restores into `/var/tmp/cc-restore-test-<ts>` and checks: SQLite `integrity_check = ok` with `objectives` rows > 0; `pg_restore` into a throwaway `postgres:16` container (no published ports, removed afterwards) with tables present; vault file count ≥95% of live; every §C path present in the snapshot. Nothing live is touched. The scratch dir is removed unless you pass `--keep`.

**Full disaster restore** (box lost): bootstrap a new host (§B), `restic restore latest --target /`, then `git clone` projects, start compose, re-login the accounts (§D.3), and flip DNS.

---

## J. Disk hygiene on the new host

**Why.** The DO host hit ENOSPC repeatedly; on 2026-08-25 it reached 100% / 0 bytes and `POST /message` hung. The driver was **90–150 leftover card worktrees** registered against `/home/operator/projects/example-platform` (plus `<repo>-wt-*` siblings), each with its own `node_modules`. Cleanup only happened on one code path (the human PATCH to `done`, as an unconditional `rm -rf`), so cards finished by pollers, AI-review verdicts or cancel cascades left their trees behind.

**What this PR adds** (`app/server`):

- `services/worktree-reaper.ts`: removes a card's git worktree **only when the card is exactly `done` or `cancelled`**. It never touches worktrees for `planning`, `queue`, `working`, `ai_review` or `review`, or any unknown status, missing card, main checkout or unrecognised path. It recognises `/tmp/cc-worktree-<id>`, `projects/.cc-worktree-<id>` and `projects/<name>-wt-<id>[-…]`. Before removing, it re-reads the card status from the DB and **keeps** the worktree if:
  - any file is uncommitted, tracked or untracked (ignored output like `node_modules` does not count),
  - HEAD has commits on no remote,
  - the worktree is locked,
  - a running process has its cwd inside it,
  - a git probe fails.

  Removal uses `git worktree remove --force` + `prune`, with argv arrays and no shell. A local branch is deleted only once every commit on it is on a remote.
- **Hooks**: the human status PATCH, the internal status PATCH, `runMachineStatusUpdate` (the shared path for pollers and AI-review verdicts), poller-hygiene auto-accept and review hard-expiry, and the orphaned-children cancel cascade. Plus a **sweep every 30 min** over every repo in `projects/`, and an extra sweep when the disk is low. `CC_WORKTREE_REAPER=false` disables it; `CC_WORKTREE_REAPER_DRY_RUN=true` only logs.
- **Low-disk alert**: `lib/host-disk.ts` `DISK_LOW_FREE_PCT = 15` / `isLowDisk()`. The disk watchdog fires a high-severity alert under 15% free (deduped per 3 h); the existing 85% / 90% / <2 GiB tiers are unchanged. **Dashboard**: `GET /api/system/disk` (auth required) returns `{usedPct, freePct, availBytes, totalBytes, low, action, checkedAt}`, and a `DiskLowBanner` on the board shows when disk is low or below the 2 GiB write floor.
- The host-side net is unchanged: `scripts/disk-cleanup.sh` (cron every 6 h + `host-boot.d/40-disk-hygiene.sh`) still prunes Docker build cache, journals, package caches and idle pushed worktrees.

On a 1.9 TB RAID10 volume, 15% free is ~290 GB. That leaves room to react, compared with the 2 GiB margin that was left on DO.
