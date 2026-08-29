# Deploying OperationKit on DigitalOcean

A step-by-step walkthrough to get OperationKit running on a fresh DigitalOcean
droplet with automatic HTTPS. Aimed at self-hosters — no prior OperationKit
knowledge assumed. Budget ~30 minutes.

The end state: one Ubuntu 24.04 droplet running the stack in Docker, with
[Caddy](https://caddyserver.com) terminating TLS on ports 80/443 and reverse-
proxying to the app. **Only SSH (22), HTTP (80), and HTTPS (443) are exposed;**
the app and the LiteLLM gateway stay bound to `127.0.0.1` and are never reachable
from the public internet.

---

## Before you start — credentials you'll need

Have these ready. Full detail and where-to-get-each is in
[`docs/CREDENTIALS.md`](./CREDENTIALS.md).

| Credential | Required? | Why |
|---|---|---|
| A **Claude Code subscription** (Pro or Max) | **Yes** | **How agent sessions are powered — the primary path.** You authenticate it into an account home via OAuth *after* the droplet is up (Step 6); the installer does not need it. See [`docs/CLAUDE-CODE-AUTH.md`](./CLAUDE-CODE-AUTH.md). |
| A **domain name** you control | **Yes** | Needed for a DNS A record so Caddy can issue a real TLS cert. |
| An **email address** | **Yes** | Let's Encrypt cert-expiry notices. |
| SSH key on your laptop | **Yes** | To log into the droplet. `ssh-keygen -t ed25519` if you don't have one. |
| Anthropic API key (`sk-ant-…`) | Optional | **Not** used by agent sessions (they unset it). Powers only a server-side summarizer; leave blank to skip. Get one at <https://console.anthropic.com>. |
| OpenAI / Google Gemini API key | Optional | Additional server-side provider keys; not required. |

Everything else (database passwords, JWT/encryption keys, the LiteLLM master key,
the internal API secret) is **generated for you** by the installer — you never
type or invent those.

Rough cost: the recommended droplet is **~$24/month** (see sizing below), plus
your Claude Pro/Max subscription. A domain is ~$12/year. TLS certificates are
free (Let's Encrypt).

---

## Step 1 — Create the droplet

1. In the DigitalOcean control panel: **Create → Droplets**.
2. **Region:** pick one close to you / your users (e.g. `NYC3`, `FRA1`). Latency
   to the Anthropic API is not region-critical, so optimize for your own access.
3. **Image:** Ubuntu **24.04 (LTS) x64**. The installer targets this release.
4. **Size** — choose by how much concurrent AI work you'll run:
   | Plan | Specs | ~Price | Good for |
   |---|---|---|---|
   | Basic Regular | 2 GB / 1 vCPU | ~$12/mo | Kicking the tires; expect swapping under load. |
   | **Basic Premium (recommended)** | **4 GB / 2 vCPU** | **~$24/mo** | Comfortable for the Postgres + LiteLLM + app stack with a few sessions. |
   | CPU-Optimized | 8 GB / 4 vCPU | ~$56/mo | Heavier concurrent session workloads. |

   Start at 4 GB / 2 vCPU; you can resize later. Below 2 GB the build/boot will
   struggle.
5. **Authentication:** choose **SSH Key** and add your public key (paste
   `~/.ssh/id_ed25519.pub`). Avoid password auth.
6. **Hostname:** e.g. `operationkit`. Create the droplet and note its **public
   IPv4 address**.

---

## Step 2 — Point your domain at the droplet (DNS A record)

Caddy needs a real hostname resolving to the droplet before it can issue a TLS
certificate.

1. At your DNS provider (or DigitalOcean's **Networking → Domains**), create an
   **A record**:
   - **Host/name:** the subdomain you want, e.g. `cc` (for `cc.example.com`) — or
     `@` for the apex domain.
   - **Value:** the droplet's public IPv4 address.
   - **TTL:** low (e.g. 300s) while you set things up.
2. Verify it has propagated before continuing:
   ```bash
   dig +short cc.example.com    # should print your droplet's IP
   ```
   Propagation is usually seconds-to-minutes. **Don't run the installer until
   this resolves** — Let's Encrypt will fail the challenge otherwise.

---

## Step 3 — First SSH in + create a non-root user

Log in as root using the IP:

```bash
ssh root@<DROPLET_IP>
```

Create a sudo-capable non-root user (you'll do day-to-day work as this user):

```bash
adduser --disabled-password --gecos "" deploy
usermod -aG sudo deploy
# copy your SSH key so you can log in directly as 'deploy'
mkdir -p /home/deploy/.ssh
cp /root/.ssh/authorized_keys /home/deploy/.ssh/authorized_keys
chown -R deploy:deploy /home/deploy/.ssh
chmod 700 /home/deploy/.ssh && chmod 600 /home/deploy/.ssh/authorized_keys
```

> This walkthrough does these steps explicitly so you understand each one. The installer (`sudo ./install.sh`) handles Docker and Caddy (Steps 4–6), but it does not create the non-root user — do that first.

---

## Step 4 — Harden SSH

Still as root, tighten the SSH daemon so only key auth is allowed:

```bash
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart ssh
```

**Before closing this session**, open a *second* terminal and confirm you can log
in as the new user — `ssh deploy@<DROPLET_IP>` — so you don't lock yourself out.

---

## Step 5 — Firewall: open only 22, 80, 443

As `deploy` (or root):

```bash
sudo apt-get update && sudo apt-get install -y ufw
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp     # SSH
sudo ufw allow 80/tcp     # HTTP (Caddy; redirects to 443 + ACME challenge)
sudo ufw allow 443/tcp    # HTTPS (Caddy)
sudo ufw --force enable
sudo ufw status
```

No other ports are opened. The app (`3002`) and LiteLLM (`4000`) listen only on
`127.0.0.1` inside the droplet — the firewall is a second layer, not the only one.

For extra credit, also enable DigitalOcean's **Cloud Firewall** on the droplet
with the same three inbound rules.

---

## Step 6 — Get the code + run the installer

Clone the repository (as `deploy`) and run the installer:

```bash
cd ~
git clone <YOUR_OPERATIONKIT_REPO_URL> operationkit
cd operationkit

# Interactive: the installer prompts for a domain (and, optionally, an Anthropic
# key), generates every other secret, installs Docker/Caddy if missing, and brings
# the stack up. The Anthropic key is OPTIONAL — agent sessions use your Claude
# subscription (authenticated in Step 6.5 below), not this key.
sudo ./install.sh
```

Or fully hands-off (no prompts), passing the values as flags. `--anthropic-key` is
optional (summarizer only) and can be omitted:

```bash
sudo ./install.sh --non-interactive \
  --domain cc.example.com \
  --acme-email you@example.com \
  --anthropic-key sk-ant-xxxxxxxx   # optional; omit to skip the summarizer
```

You can also pass secrets via environment variables instead of flags
(`ANTHROPIC_API_KEY`, `CC_DOMAIN`, `CADDY_ACME_EMAIL`, `OPENAI_API_KEY`,
`GEMINI_API_KEY`) — handy for CI or a secrets manager.

### What the installer does

1. Verifies the OS and that Docker + the compose plugin are present (installs
   Docker from the official repo if not).
2. Creates `.env` from `.env.example` (mode `600`) if it doesn't exist.
3. **Generates strong random secrets** for anything still empty/placeholder:
   `LITELLM_MASTER_KEY`, `LITELLM_SALT_KEY`, `POSTGRES_PASSWORD`, `CC_JWT_SECRET`,
   `INTERNAL_API_SECRET`, and the two 32-byte base64 encryption keys
   (`SECRETS_MASTER_KEY`, `TEST_CRED_ENCRYPTION_KEY`). Existing values are kept.
4. Prompts only for the **Anthropic key** and **domain** (unless supplied).
5. Generates a single-site **Caddyfile** for your domain with auto-TLS and
   installs it (`/etc/caddy/Caddyfile`).
6. Brings up the stack with `docker compose up -d`.
7. Runs a **health-check loop** against LiteLLM (`/health/liveliness`) and the app
   (`/api/health`), then prints your URL.

It is **idempotent** — safe to re-run. Re-running never regenerates existing
secrets and never overwrites values you set by hand.

**Useful flags:** `--core-only` (bring up just LiteLLM + its DB), `--no-up`
(write `.env` + Caddyfile but don't start containers), `--help`.

---

## Step 6.5 — Authenticate a Claude subscription (required)

The stack is up, but **no agent session can run until at least one account is
authenticated** with a Claude Pro/Max subscription. On the droplet:

```bash
cd ~/operationkit
# Pass --home to match the bind-mount path in docker-compose.yml
sudo ./scripts/claude-auth.sh a --setup-token --home /home/operator/.ccuser-a
```

Open the printed OAuth URL on any device, approve, and the helper writes the credential to
`/home/operator/.ccuser-a/.claude/.credentials.json` — the path the container mounts.
The router picks the account up on the next session with no restart. To run more concurrent
agents or survive rate-limit windows, authenticate additional accounts (`b`..`e`) the same way
(replacing `a` and `.ccuser-a` accordingly).
Full model, methods, and scaling: **[CLAUDE-CODE-AUTH.md](./CLAUDE-CODE-AUTH.md)**.

---

## Step 7 — Verify

```bash
# Containers healthy?
docker compose ps

# App reachable locally (inside the droplet):
curl -s http://127.0.0.1:3002/api/health

# LiteLLM gateway (loopback only):
curl -s http://127.0.0.1:4000/health/liveliness
```

Then open **`https://cc.example.com`** in your browser. The first request may take
a few seconds while Caddy obtains the certificate. A valid padlock means TLS is
working.

If the site doesn't come up:
- `dig +short cc.example.com` — is DNS still pointing at the droplet?
- `docker compose logs --tail=100 command-center` — app errors.
- `sudo journalctl -u caddy --no-pager | tail -50` — TLS/ACME errors (usually DNS
  not yet resolving, or ports 80/443 blocked).

---

## Day-2 operations

- **Update:** `git pull && sudo ./install.sh` (re-run is safe; then
  `docker compose up -d --build` to rebuild the app image).
- **Logs:** `docker compose logs -f command-center`.
- **Restart:** `docker compose restart`.
- **Backups:** `.env` (your secrets — keep a copy in a password manager) and the
  `litellm_postgres_data` Docker volume. See `scripts/backup-db.sh`.
- **Rotate a secret:** edit `.env`, then `docker compose up -d`. Rotating
  `SECRETS_MASTER_KEY` or `TEST_CRED_ENCRYPTION_KEY` invalidates data encrypted
  with the old key — only do it deliberately.

---

## Security notes

- Never expose ports `3002` (app) or `4000` (LiteLLM) publicly. The compose file
  binds them to `127.0.0.1`; keep it that way. Caddy is the only public entry.
- Keep `.env` at mode `600` and out of git (it's gitignored).
- The installer-generated secrets are cryptographically strong (`openssl rand`);
  the base64 encryption keys decode to exactly 32 bytes as the app requires.
- Enable unattended security upgrades on the droplet
  (`sudo apt-get install unattended-upgrades`) for OS patches.
