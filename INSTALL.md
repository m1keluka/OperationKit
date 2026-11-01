# Installing Operation Kit on a client's server

This guide turns a brand-new server into a working Operation Kit site at the
client's own web address, for example `https://ops.clientfirm.com`, in about
30 minutes.

**You do not need to type the commands yourself.** Open Claude Code on your
laptop and tell it:

> Install Operation Kit on my server by following INSTALL.md in this repository.
> The server is `<IP address>`, I log in as `root` (or: as `ubuntu`, with sudo).
> My Cloudflare API token is in the environment variable `CF_API_TOKEN`.

No domain yet, or just trying it out? See
[Test install without a domain](#test-install-without-a-domain-ip-only-ssh-tunnel):
same installer, no Cloudflare, reached over an SSH tunnel.

Claude Code reads the rest of this file and does the work. It stops only when it
needs you to click something or choose something. Those moments are marked
**👤 You**.

---

## What you need before starting

| | What | Why |
|---|---|---|
| 1 | A fresh **Ubuntu 24.04** server: 4 CPU cores, 8 GB memory, 80 GB disk or more | Where Operation Kit runs. Any provider works (DigitalOcean, Hetzner, AWS, OVH…). |
| 2 | **SSH access** to it as `root`, or as a user with `sudo` (OVH and AWS images log in as `ubuntu`), with an SSH key | Claude Code uses it to install everything. |
| 3 | The client's domain on **Cloudflare** (for example `clientfirm.com`) | The site gets its own address, e.g. `ops.clientfirm.com`. |
| 4 | A **Cloudflare API token** (how to make one: step 2 below) | Lets the installer set up the address and the sign-in screen. |
| 5 | A **Claude subscription** (Pro, Max or Team) **or** an Anthropic API key | Powers the AI workers on the server. |
| 6 | **Claude Code** on your laptop | It runs this guide. |

Nothing here needs a public web port on the server. Visitors reach it through
Cloudflare, and the server's firewall only lets SSH in.

---

## How the pieces fit

```
 Visitor ──► Cloudflare Access ──► Cloudflare Tunnel ──► the server (no open web ports)
             "who are you?"         private connection     ├─ Operation Kit app
             one-time email code    the server dials out    └─ one sandbox per AI session
             or Google / Microsoft
```

1. **Cloudflare Access** is the front door. Only email addresses or domains on the
   client's list get past it. People prove who they are with a code sent to
   their email, or with their Google or Microsoft account.
2. **Cloudflare Tunnel** carries the traffic. The server opens a private
   connection *out* to Cloudflare, so it never has to accept connections from
   the internet.
3. **One login.** Cloudflare passes the app a signed note saying who the person
   is. The app checks the signature and, when that email belongs to an
   Operation Kit user, signs them straight in: no second username and password.
   An email with no account gets a "no account for this email" page, never a
   new account. The username and password still work as a break-glass way in
   (see "One login" below).
4. **Sandboxes.** Every AI session runs in its own locked-down container that
   can only see its own work folder.

---

## Instructions for Claude Code

Follow these steps in order. Rules for the whole install:

- **Never print, echo, `cat` or paste a secret value**: API tokens, keys,
  passwords or the setup password. Move secrets with pipes and files, and
  refer to them by name only. If a command would show a secret, do not run it.
- Use **fake sample data only** in anything you create for testing.
- Each script is safe to run again. If a step fails, fix the cause and re-run
  the same command.
- Record the time when you start step 3. You will report the total at the end.

Throughout, `SERVER` means `root@<IP address>`.

**Logging in as a sudo user instead of root** (OVH, AWS and others give you
`ubuntu`, not `root`): use `SERVER` = `ubuntu@<IP address>` and put `sudo` in front
of every command that runs on the server, e.g.
`ssh SERVER 'cd /opt/operationkit-src && sudo ./install.sh --config client.conf'`.
Commands that only need to *read* a root-only file (the setup password, agent
passes) become `ssh -t SERVER sudo cat <file>`. The installer itself refuses to
run without root, so a missing `sudo` stops it straight away; nothing is half
done.

### Step 1: Check the server

```bash
ssh -o StrictHostKeyChecking=accept-new SERVER 'grep PRETTY_NAME /etc/os-release; nproc; free -g | head -2; df -h / | tail -1'
```

It must say **Ubuntu 24.04**, with at least 4 cores, 8 GB of memory and 60 GB
or more of free disk. If it doesn't, stop and tell the person what is missing.

### Step 2: Cloudflare (👤 You, about 5 minutes, one time per client)

Ask the person to do these clicks in the Cloudflare dashboard. You cannot do
them.

1. **The domain is on Cloudflare.** `clientfirm.com` appears under *Websites*.
2. **Zero Trust is switched on.** Open *Zero Trust* from the left menu. The
   first time, Cloudflare asks for a *team name* (any name, e.g. `clientfirm`)
   and a plan. Pick **Free**. Cloudflare may ask for a card even for the Free
   plan.
3. **Create the API token.** Go to *My Profile → API Tokens → Create Token →
   Custom token* and add these permissions:

   | Type | Permission | Access |
   |---|---|---|
   | Zone | Zone | Read |
   | Zone | DNS | Edit |
   | Account | Cloudflare Tunnel | Edit |
   | Account | Access: Apps and Policies | Edit |
   | Account | Access: Organizations, Identity Providers, and Groups | Edit |
   | Account | Access: Service Tokens | Edit |

   Under *Zone Resources*, pick the client's domain. Under *Account
   Resources*, pick the client's account. Copy the token and give it to Claude
   Code as an environment variable (`export CF_API_TOKEN=...` in the terminal
   where Claude Code runs). Do not paste it into the chat.

   All six lines matter. The one most often missed is **Access: Organizations,
   Identity Providers, and Groups**: without it the installer stops with
   *"the Cloudflare API token cannot read the Zero Trust organization"*. Edit
   the token, add it, re-run.

Nothing else needs copying out of Cloudflare:

- **Account id:** the installer reads it from the zone
  (`GET /zones?name=<ZONE>` → `result[0].account.id`). Do not ask for it.
- **Sign-in method:** the default, `ACCESS_LOGIN_METHOD="otp"`, uses Cloudflare's
  **One-time PIN**: Cloudflare emails a code to an allowed address. It works on
  every install with no Google or Microsoft app to register. The Access app is
  created with that method as its *only* allowed login (no provider picker),
  auto-redirect on, and a 24-hour session (`ACCESS_SESSION_DURATION`).
- **One login:** the installer stores the Zero Trust team domain
  (`OK_CF_ACCESS_TEAM`, e.g. `clientfirm.cloudflareaccess.com`) and the Access
  app's AUD tag (`OK_CF_ACCESS_AUD`) in `secrets/stack.env` itself.

If they chose **Google** or **Microsoft** sign-in (step 4), they also need an
OAuth app from Google Cloud or Microsoft Entra. Cloudflare's guide covers it:
*Zero Trust → Settings → Authentication → Add new*. The **one-time email
code** option needs none of this. Use it unless the client asks otherwise.

### Step 3: Put the code on the server

```bash
ssh SERVER 'sudo apt-get update -qq && sudo apt-get install -y -qq git && \
  sudo git clone <the Operation Kit repository URL> /opt/operationkit-src'
```

(As `root`, the `sudo`s are harmless.) Keep the code in `/opt/operationkit-src`.
The install itself goes in `/opt/operationkit`, and the uninstall script deletes
that folder.

**Git "dubious ownership".** If the folder was cloned by one user and git is
later run by another (cloned as `root`, then `git pull` as `ubuntu`, or the
other way round), git refuses with *"detected dubious ownership in repository"*.
The installer and `install/update.sh` already allow it for their own git calls.
For your own commands, allow the folder once for that user:

```bash
ssh SERVER 'sudo git config --global --add safe.directory /opt/operationkit-src'   # for root
ssh SERVER 'git config --global --add safe.directory /opt/operationkit-src'        # for ubuntu
```

### Step 4: Write the client config (👤 You answer, Claude Code writes)

Ask the person for these answers, then write them into
`/opt/operationkit-src/client.conf`. Start from `install/client.conf.example`:
every setting is explained there in plain words.

| Setting | Question to ask | Example |
|---|---|---|
| `CLIENT_NAME` | What is the client firm called? | `Example Capital Partners` |
| `CLIENT_SLUG` | (make it from the name: lowercase, dashes) | `example-capital` |
| `DOMAIN` / `ZONE` | What web address should it live at? | `ops.example-capital.com` / `example-capital.com` |
| `BRAND_NAME` / `BRAND_LOGO` | What name (and logo file) should people see? | `Example Capital OS` |
| `ADMIN_USERNAME` | Username for the first admin? | `admin` |
| `ADMIN_EMAIL` | The first admin's email (signs them in through Cloudflare). Empty = the first address in `ACCESS_ALLOWED_EMAILS` | `alex.partner@example-capital.com` |
| `ACCESS_ALLOWED_EMAILS` / `ACCESS_ALLOWED_EMAIL_DOMAIN` | Who may open the site? | `alex.partner@example-capital.com` |
| `ACCESS_LOGIN_METHOD` | Email code, Google or Microsoft? | `otp` |
| `CLAUDE_AUTH` | Claude subscription (`login`) or API key (`api-key`)? | `login` |
| `AGENTS_ENABLED` | Which AI agents? | `general,coo,cfo` |
| `TIMEZONE` | Which time zone are they in? | `America/New_York` |
| `BACKUP_TARGET` | Where should backups be copied off the server? (empty = this server only; see [Backups](#backups-and-restore)) | `s3:https://s3.us-west-004.backblazeb2.com/clientfirm-ok/operationkit` |

Write it with a heredoc over SSH. The file holds no secrets.

### Step 5: Hand over the Cloudflare token (and API key, if used)

Secrets travel in a separate **hand-over file**. The installer moves each value
into its locked secrets folder and then deletes the file. Build it from
environment variables so nothing is printed:

```bash
{ printf 'CLOUDFLARE_API_TOKEN=%s\n' "$CF_API_TOKEN"
  # only if CLAUDE_AUTH="api-key" and the person gave you ANTHROPIC_API_KEY in the env:
  # printf 'ANTHROPIC_API_KEY=%s\n' "$ANTHROPIC_API_KEY"
} | ssh SERVER 'umask 077; cat > /root/ok-handover.env'
```

Other names the installer accepts in this file: `OPENAI_API_KEY`,
`GEMINI_API_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `AZURE_CLIENT_ID`,
`AZURE_CLIENT_SECRET`, `AZURE_DIRECTORY_ID`, `CLAUDE_CODE_OAUTH_TOKEN`, and for
off-server backups `BACKUP_ACCESS_KEY_ID`, `BACKUP_SECRET_ACCESS_KEY` (and
`BACKUP_PASSWORD` only when recovering onto a new server, see
[Backups and restore](#backups-and-restore)).

With `sudo` (not root), write the file somewhere your user can, and point the
installer at it: `… | ssh SERVER 'umask 077; cat > ~/ok-handover.env'`, then
`--secrets-file /home/ubuntu/ok-handover.env`. The installer deletes it.

### Step 6: Install

First a dry run. It changes nothing and should end with `Done`:

```bash
ssh SERVER 'cd /opt/operationkit-src && ./install.sh --config client.conf --dry-run'
```

Then the real install. It takes 10 to 20 minutes, mostly building the app.
The full build output goes to `/opt/operationkit/logs/build-<time>.log`; the
terminal only shows its last lines (the last 40 if the build fails):

```bash
ssh SERVER 'cd /opt/operationkit-src && ./install.sh --config client.conf --secrets-file /root/ok-handover.env'
```

The installer:

1. **Prepares the server.** It installs Docker and turns on the firewall
   (SSH only), automatic security updates and fail2ban. SSH is switched to
   key-only logins, but only if a key is already installed.
2. **Generates every secret on the server** into
   `/opt/operationkit/secrets/stack.env` (only root can read it). It prints the
   *names* of the secrets, never the values.
3. **Builds the app image and the sandbox image.**
4. **Sets up Cloudflare:** the tunnel, the web address and the Access sign-in.
   It also stores the Zero Trust team domain and the Access app's AUD tag
   (`OK_CF_ACCESS_TEAM`, `OK_CF_ACCESS_AUD` in `secrets/stack.env`), which
   switches on one login.
5. **Starts the app**, then creates the client's workspace and the first admin
   with a one-time setup password, linked to `ADMIN_EMAIL`.
6. **Switches on the starter packs** in `STARTER_PACKS` (by default the
   knowledge base import). If one cannot be switched on, the install **stops**
   with the reason; fix it and re-run.
7. **Schedules the nightly backup** (see [Backups and restore](#backups-and-restore)).
8. **Runs the checks** in step 8 (the test card waits until Claude is
   connected).

At the end it prints a time for each step and the total. Keep them for the
report.

### Step 7: Connect Claude for the AI workers (👤 You, 2 minutes)

*Skip this step if the client uses an API key that you handed over in step 5.*

The Claude sign-in produces a long-lived token. It must appear **only on the
person's own screen**, never in this chat. Ask the person to open their own
terminal (not Claude Code) and run:

```bash
ssh -t root@<IP address> bash /opt/operationkit-src/install/claude-login.sh --config /opt/operationkit-src/client.conf
# logging in as ubuntu:  ssh -t ubuntu@<IP address> sudo bash /opt/operationkit-src/install/claude-login.sh --config …
```

The script prints a **Sign in with Claude** link. They open it in any browser,
sign in with **the client's** Claude account, and Claude shows an
**Authentication code**. They paste that code back into the terminal. Typing is
hidden. The script swaps the code for a one-year subscription token (the same
thing `claude setup-token` makes, so nothing needs installing on their laptop),
checks that Claude answers `CLAUDE-OK` from inside a sandbox before it saves
anything, then restarts the app.

Already have a token from `claude setup-token` (it starts with `sk-ant-oat`)?
Paste it at the same prompt instead.

After the install, more Claude subscriptions are added in the app with no
terminal at all: **Settings → Seats → Add Claude seat → Sign in with Claude**.

> Why not let Claude Code do this? The token is a password to the client's
> Claude account. Keeping it out of this chat means it is never stored in a
> transcript.

### Step 8: Verify

```bash
ssh SERVER 'bash /opt/operationkit-src/install/verify.sh --config /opt/operationkit-src/client.conf'
```

Every line must say **PASS**. It checks that:

- the app and the Cloudflare connector are running
- the firewall is on and no web port is open
- a stranger who opens the site gets the **Cloudflare sign-in**, not the app
- the site loads through Cloudflare and shows the client's name
- **one login is on**: the app checks Cloudflare's signed identity token itself (team keys, AUD tag, issuer, expiry)
- password sign-in works (it uses a temporary `ok-verify` account and removes it afterwards)
- the first admin is still forced to choose a new password
- **a test card runs end to end**: it is created, a sandboxed AI worker answers
  it, and the sandbox could only see its own two folders. Before creating it,
  verify asks the app whether any Claude seat can run a sandboxed session. If
  none can, it fails at once with *"no Claude seat can run a sandboxed
  session"* instead of waiting 10 minutes for a card that will never start. The
  usual cause: the only seat was made by signing in to the Claude CLI on the
  server, which the sandbox cannot use. Connect Claude with step 7 (or
  **Settings → Seats → Add Claude seat**) and re-run verify.

If a line says FAIL, the message says what to look at. Fix it, then re-run
verify.

### Step 9: First sign-in (👤 You)

1. The person opens `https://<DOMAIN>` and enters **the admin email**
   (`ADMIN_EMAIL`, or the first address in `ACCESS_ALLOWED_EMAILS`).
   Cloudflare sends a code (or they sign in with Google or Microsoft).
2. That is it: the app opens, signed in as the admin. There is no second
   sign-in page.

The one-time setup password is only needed for the break-glass path below. If
they want to use it, they read it in their own terminal
(`ssh -t root@<IP address> cat /opt/operationkit/secrets/first-admin-setup-password`),
sign in with the admin username and it, and choose a new password (12+
characters). It stops working after 72 hours. To issue a new one:
`bash install/admin-password.sh --config client.conf`.

### One login: how it works and what to tell the client

- **How the app knows who it is.** After someone passes Cloudflare Access,
  Cloudflare adds a signed token to every request (`Cf-Access-Jwt-Assertion`).
  The app checks it against the team's public keys at
  `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, and checks that it
  was issued for **this** Access app (the AUD tag), by **this** team, and has
  not expired. Only then does it read the email. A token that fails any check is
  ignored and the password page shows instead. The keys are cached and
  re-fetched when Cloudflare rotates them.
- **Who gets in.** The email must belong to exactly one Operation Kit user. The
  installer links the first admin. For everyone else: add their email to the
  Cloudflare Access list, then in **Settings → Users** create them (or open
  their row) and fill in **Sign-in email**. An allowed email with no user gets a
  plain "No account for this email" page. Nobody is ever created automatically.
- **Sign out** clears the app session and then signs the person out of
  Cloudflare Access too (`/cdn-cgi/access/logout`), so the next visit asks for
  the email again.
- **Break-glass.** The username + password sign-in still works. It shows when
  the Cloudflare token cannot be checked, and from the "No account" page
  ("Sign in with a username and password"). API keys and agent keys work
  exactly as before; agent passes (Cloudflare service tokens) carry no email,
  so they never sign anyone in.
- **Off switch.** `--skip-cloudflare` (local / SSH-tunnel installs) leaves both
  settings empty, so the app keeps its own password sign-in.
  `cloudflare.sh down` empties them too. After changing them by hand, restart
  the app.

### Step 10: Report

Tell the person, in a few sentences:

- the site address and that verify passed (paste the PASS/FAIL count)
- the build: the `Build:` line the installer printed (the same commit shows at
  the bottom of **Settings** and in `/api/health`)
- whether backups go off the server (`BACKUP_TARGET`) or only to this server
- the total install time from `/opt/operationkit/install-timing.log`
- anything you skipped and why

---

## Test install without a domain (IP only, SSH tunnel)

For a first look, a demo on a spare server, or before the client's Cloudflare is
ready. Nothing is opened to the internet: the app listens on the server's
`127.0.0.1:3002` only, and you reach it through SSH.

1. In `client.conf`, `DOMAIN`, `ZONE`, `ACCESS_ALLOWED_EMAILS` and
   `ACCESS_ALLOWED_EMAIL_DOMAIN` may stay empty (fill them in later to switch
   Cloudflare on).
2. Install with `--skip-cloudflare`. No Cloudflare token is needed:

   ```bash
   ssh SERVER 'cd /opt/operationkit-src && sudo ./install.sh --config client.conf --skip-cloudflare'
   ```

3. On **your laptop**, open a tunnel and leave it running:

   ```bash
   ssh -N -L 3002:127.0.0.1:3002 root@<IP address>     # or ubuntu@<IP address>
   ```

4. Browse to **http://localhost:3002** and sign in with the admin username and
   the one-time setup password (`ssh -t SERVER sudo cat /opt/operationkit/secrets/first-admin-setup-password`,
   in your own terminal). There is no one login without Cloudflare Access.
5. Verify works the same; it notices the install is local-only:
   `ssh SERVER 'sudo bash /opt/operationkit-src/install/verify.sh --config /opt/operationkit-src/client.conf'`.

To move it to a real address later: fill in `DOMAIN`, `ZONE` and the `ACCESS_*`
settings, hand over the Cloudflare token (step 5), and re-run `./install.sh
--config client.conf --secrets-file …` **without** `--skip-cloudflare`. Data is
kept.

## Updating

```bash
ssh SERVER 'sudo bash /opt/operationkit-src/install/update.sh --config /opt/operationkit-src/client.conf'
# a specific version:  … update.sh --config … --ref v1.4.0     (a tag, branch or commit)
```

`install/update.sh`:

1. **Backs up first** into `/opt/operationkit/backups/pre-update-<time>/`: the
   database (SQLite online backup, then `PRAGMA integrity_check`), the seat
   logins (`cc-accounts`), `secrets/stack.env` and the rest of `secrets/`, and
   `client.conf`.
2. **Keeps the running images** as `operationkit-app:pre-update-<time>` and
   `ok-jail:pre-update-<time>` (the newest 3 are kept).
3. **Fetches and checks out** `--ref` (default `main`). git runs as the owner of
   the code folder, with `safe.directory` allowed, so a folder cloned as
   `ubuntu` never ends up owned by root.
4. **Re-runs `./install.sh --config client.conf`** (it lives at the top of the
   repository, not under `install/`), with `--skip-cloudflare` again for a
   local-only install. Secrets and data are kept.
5. **Prints the rollback steps**: check out the old commit, re-tag the
   `pre-update-<time>` images as `:local`, optionally restore the pre-update
   backup, start the app. They are printed again if the install fails.

Do it when no cards are running: the app restarts. The first time, on an
install older than this script, get it with
`sudo git -c safe.directory='*' -C /opt/operationkit-src pull` and then run it.

## Backups and restore

**What runs.** Every night at `BACKUP_TIME` (default 03:30, server time zone)
`/etc/cron.d/operationkit-backup` runs `install/backup.sh run --label nightly`.
It writes one folder, `/opt/operationkit/backups/nightly-<time>/` (root only):

| File | What |
|---|---|
| `command-center.db` | the database, copied with SQLite's online backup while the app runs, then integrity-checked |
| `data.tar.gz` | seat logins (`cc-accounts`), uploads, branding |
| `home.tar.gz` | projects, notes, agent memory, the knowledge base |
| `secrets.tar.gz` | `secrets/`: `stack.env` holds the key that decrypts the secrets stored in the database, so a restore needs both |
| `client.conf`, `install.env`, `MANIFEST` | settings, and the commit + checksums of this backup |

The newest `BACKUP_KEEP_LOCAL` (default 7) stay on the server. Log:
`/opt/operationkit/logs/backup.log`.

**Off the server (recommended).** A backup on the same disk does not survive
losing the server. Set `BACKUP_TARGET` in `client.conf` and every nightly folder
is also sent, encrypted, to an S3-compatible bucket with
[restic](https://restic.net) (installed by the installer), keeping 14 daily,
8 weekly and 12 monthly copies.

1. **👤 You:** create a private bucket and an application key limited to it.
   Backblaze B2: *Buckets → Create a Bucket* (private), then *Application Keys →
   Add a New Application Key* for that bucket only, with read and write.
2. In `client.conf`:
   `BACKUP_TARGET="s3:https://s3.<region>.backblazeb2.com/<bucket>/operationkit"`
   (the endpoint is shown on the bucket page). Any S3-compatible store works the
   same way (`s3:https://<endpoint>/<bucket>/<folder>`); native B2 is
   `b2:<bucket>:<folder>`.
3. Hand the key over like the Cloudflare token (step 5), as
   `BACKUP_ACCESS_KEY_ID` (B2 *keyID*) and `BACKUP_SECRET_ACCESS_KEY` (B2
   *applicationKey*), and re-run `./install.sh --config client.conf
   --secrets-file …`.
4. Test it now instead of waiting for the night:
   `ssh SERVER 'sudo bash /opt/operationkit-src/install/backup.sh run --label nightly --config /opt/operationkit-src/client.conf'`,
   then `… backup.sh list --config …` shows the off-server copy.
5. **👤 You: save the backup password somewhere safe, off the server** (a
   password manager). The off-server copies are encrypted with it, and if the
   server is lost so is the copy in `stack.env`. Read it in your own terminal,
   never in a chat:
   `ssh -t SERVER sudo grep ^OK_BACKUP_PASSWORD= /opt/operationkit/secrets/stack.env`

**By hand:** `sudo bash install/backup.sh run --config client.conf` (label
`manual`, kept until you delete it). `list` shows what exists, here and off the
server.

**Restore on the same server** (e.g. after a bad change):

```bash
sudo bash install/backup.sh list --config client.conf
sudo bash install/backup.sh restore /opt/operationkit/backups/nightly-<time> --config client.conf --yes
```

It checks the folder against its `MANIFEST`, stops the app, moves the current
database, data, home and secrets aside to `backups/pre-restore-<time>/`, puts the
backup's back, and starts the app. A `pre-update-…` folder restores the
database, seat logins and secrets but leaves home as it is.

**Recover onto a new server** (the old one is gone):

1. Steps 1, 3 and 4 as for a new install, with the **same** `client.conf`
   (same `CLIENT_SLUG` and `BACKUP_TARGET`).
2. Hand over the Cloudflare token, the two bucket keys **and the saved
   password** as `BACKUP_PASSWORD` (step 5), and install (step 6). This gives a
   fresh, empty site.
3. Download the newest off-server backup and put it back:

   ```bash
   ssh SERVER 'sudo bash /opt/operationkit-src/install/backup.sh fetch --config /opt/operationkit-src/client.conf'
   # prints: sudo bash …/backup.sh restore /opt/operationkit/backups/restored-…/… --config … --yes
   ```

   Run the printed `restore` command. The restored `secrets/` includes the old
   tunnel token, so the site comes back on the same address.
4. Run verify (step 8).

## After the install

1. **Add agents.** Sign in as the admin, open **Agents → Templates** and press **Add agent** on
   the starter templates the client wants (Personal assistant, Knowledge librarian, Operator).
   Each agent is one file; see [docs/agents/agent-file-format.md](docs/agents/agent-file-format.md).
2. **Load the client's files.** **Knowledge base → Import files.** Excel, CSV, PDF and Word files
   become linked notes you can ask questions of. There is one knowledge base per install (no
   source to pick): on a standard install it is `data/knowledge-base/` in the install folder, one
   folder per workspace, and it is included in backups of `data/`. Search, agents and the MCP
   connector all read and write that same place.
3. **Connect the AI apps people already use** (Claude, ChatGPT, Grok…):
   [docs/CONNECT-YOUR-AGENT.md](docs/CONNECT-YOUR-AGENT.md). This includes a one-time Cloudflare
   step, because the sign-in door blocks AI apps by default.
4. **Hand the client the security overview:**
   [docs/SECURITY-OVERVIEW.md](docs/SECURITY-OVERVIEW.md).
5. **Day-to-day running** (updates, backups, settings changes):
   [docs/product/06-operating.md](docs/product/06-operating.md).

## Re-running a demo (reset)

```bash
# Remove everything (containers, sandboxes, Cloudflare setup, data, secrets):
bash install/uninstall.sh --config client.conf --yes

# Faster reset for demos: keep the built images and the Cloudflare setup
bash install/uninstall.sh --config client.conf --yes --keep-images --keep-cloudflare
./install.sh --config client.conf --secrets-file /root/ok-handover.env
```

The uninstall leaves Docker, the firewall and the update settings in place.
They are harmless, and they make the next install faster.

## When something goes wrong

| Message | What to do |
|---|---|
| `Zero Trust is not switched on for this account yet` | Step 2.2: open Zero Trust once, pick a team name and the Free plan. |
| `the zone '…' is not on this Cloudflare account` | Wrong `ZONE`, or the token's *Zone Resources* do not include it. |
| `… already has a A record pointing somewhere else` | The address is in use. Pick another `DOMAIN`, or re-run `install/cloudflare.sh up --config client.conf --replace-dns` once the client confirms. |
| `the app did not become healthy` | `docker logs --tail 100 command-center` |
| verify: `test card … no answer` | Claude is not connected (step 7), or the account is out of usage. |
| verify: `no Claude seat can run a sandboxed session` | The only Claude seat cannot be used inside the sandbox (a CLI login made on the server), or none exists. Step 7, or **Settings → Seats → Add Claude seat**. |
| `the Cloudflare API token cannot read the Zero Trust organization` | The token lacks **Access: Organizations, Identity Providers, and Groups → Edit** (step 2). Edit the token, re-run. |
| `starter pack '…' could not be switched on` | The message above it says why. Fix it and re-run `./install.sh`; to install without packs set `STARTER_PACKS=""`. |
| `apt-get … failed 3 times` | The server cannot reach the Ubuntu package mirror. Check its network, then re-run. Short mirror hiccups are retried automatically. |
| `the image build failed` | The last 40 build lines are printed; the whole log is in `/opt/operationkit/logs/build-<time>.log`. |
| `detected dubious ownership in repository` | See step 3: `git config --global --add safe.directory /opt/operationkit-src`. |
| `This setup password has expired` | `bash install/admin-password.sh --config client.conf` |

## What is stored where

| Path on the server | What | Who can read it |
|---|---|---|
| `/opt/operationkit-src/` | the code + `client.conf` (no secrets) | root |
| `/opt/operationkit/secrets/` | generated secrets, Cloudflare token, setup password | root only (mode 700/600) |
| `/opt/operationkit/state/` | database, files, session work folders | the app |
| `/opt/operationkit/backups/` | nightly, pre-update and manual backups | root only (mode 700) |
| `/opt/operationkit/logs/` | build logs, `backup.log` | root |
| `/opt/operationkit/install-timing.log` | how long each install took | root |

Everything that matters is in `/opt/operationkit/`; see
[Backups and restore](#backups-and-restore). Change the folder with
`INSTALL_DIR` in `client.conf`.
