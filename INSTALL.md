# Installing Operation Kit on a client's server

This guide turns a brand-new server into a working Operation Kit site at the
client's own web address, for example `https://ops.clientfirm.com`, in about
30 minutes.

**You do not need to type the commands yourself.** Open Claude Code on your
laptop and tell it:

> Install Operation Kit on my server by following INSTALL.md in this repository.
> The server is `<IP address>`, I log in as `root` (or: as `ubuntu`, with sudo).
> My Cloudflare API token is in the environment variable `CF_API_TOKEN`.

Starting from nothing (no server, no domain yet)? Follow
[docs/RECOMMENDED-STACK.md](docs/RECOMMENDED-STACK.md) first: how big a server to get, ordering it at
OVHcloud, SSH keys, putting the domain on Cloudflare, off-site backups on Backblaze B2, seats, GitHub
and updates. It comes back here for the install itself.

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
| 1 | A fresh **Ubuntu 24.04** server sized for how many AI sessions run at once: at least **8 CPU threads, 16 GB memory, 150 GB disk** for 1-2 sessions; more for a team ([sizing table](docs/RECOMMENDED-STACK.md#1-choose-a-server-size)) | Where Operation Kit runs. Any provider works; we run and test on an [OVHcloud Rise](docs/RECOMMENDED-STACK.md) dedicated server. One AI session can use up to about 3.6 GB of memory, and the images with their rollback copies need about 40 GB of disk. |
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

It must say **Ubuntu 24.04**, with at least 8 CPU threads (`nproc`), 16 GB of
memory and 150 GB of free disk: the smallest size in the
[sizing table](docs/RECOMMENDED-STACK.md#1-choose-a-server-size), enough for one or two
sessions at once. If it doesn't, stop and tell the person what is missing and
which size the table recommends for them.

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
   | Zone | Config Rules | Edit |

   Under *Zone Resources*, pick the client's domain. Under *Account
   Resources*, pick the client's account. Copy the token and give it to Claude
   Code as an environment variable (`export CF_API_TOKEN=...` in the terminal
   where Claude Code runs). Do not paste it into the chat.

   All seven lines matter. The one most often missed is **Access: Organizations,
   Identity Providers, and Groups**: without it the installer stops with
   *"the Cloudflare API token cannot read the Zero Trust organization"*. Edit
   the token, add it, re-run. **Zone → Config Rules → Edit** is the newest one:
   without it the browser-integrity step stops (and changes nothing) with
   *"the Cloudflare API token cannot write Configuration Rules"*. See
   [Browser Integrity Check](#and-not-getting-turned-away-by-browser-integrity-check-error-1010).

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
- **Bots and AI tools:** the installer also makes a second, path-limited Access
  application so a bot can reach the API with its Operation Kit key. Nothing to
  click — see [Letting bots reach the API with their key](#letting-bots-reach-the-api-with-their-key).
- **Bots and error 1010:** the installer also adds one narrow Configuration Rule
  so Cloudflare's Browser Integrity Check stops refusing your own API callers.
  Nothing to click — see [Browser Integrity Check](#and-not-getting-turned-away-by-browser-integrity-check-error-1010).

If they chose **Google** or **Microsoft** sign-in (step 4), they also need an
OAuth app from Google Cloud or Microsoft Entra. Cloudflare's guide covers it:
*Zero Trust → Settings → Authentication → Add new*. The **one-time email
code** option needs none of this. Use it unless the client asks otherwise.

### Step 3: Put the code on the server

```bash
ssh SERVER 'sudo apt-get update -qq && sudo apt-get install -y -qq git && \
  sudo git clone https://github.com/m1keluka/OperationKit.git /opt/operationkit-src'
```

(As `root`, the `sudo`s are harmless.) Keep the code in `/opt/operationkit-src`:
updates are pulled from the same repository into the same folder (see [Updating](#updating)).
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
| `BACKUP_TARGET` | Should nightly backups also go off the server, to Backblaze B2? If **yes**, leave it empty here: after the install the person runs `install/b2-setup.sh` in their own terminal (step 10 and [Backups](#backups-and-restore)), which fills it in. If they already use another S3 bucket, write its address. | empty, or `s3:https://s3.us-west-004.backblazeb2.com/clientfirm-ok/operationkit` |

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
   *names* of the secrets, never the values. The key that encrypts the app's
   stored secrets also gets its own file, `secrets/secrets-kek` (root, mode
   400). Only the app reads it, mounted read-only, and AI sessions never see it
   ([docs/security.md](docs/security.md#encryption-key)).
3. **Builds the app image and the sandbox image.**
4. **Sets up Cloudflare:** the tunnel, the web address and the Access sign-in.
   It also stores the Zero Trust team domain and the Access app's AUD tag
   (`OK_CF_ACCESS_TEAM`, `OK_CF_ACCESS_AUD` in `secrets/stack.env`), which
   switches on one login.
5. **Starts the app**, then creates the client's workspace and the first admin,
   linked to `ADMIN_EMAIL`, with a one-time setup password. With one login on,
   that password is **break-glass only** and the admin is never asked to change
   it — they sign in through the Access door. Without one login (or with no
   admin email to match on) they must replace it at first sign-in. Either way
   it expires.
6. **Switches on the starter packs** in `STARTER_PACKS` (by default the
   knowledge base import). If one cannot be switched on, the install **stops**
   with the reason; fix it and re-run.
7. **Schedules the nightly backup** (see [Backups and restore](#backups-and-restore)).
   Run by a person in a terminal with `BACKUP_TARGET` empty, it then asks whether
   to set up off-site backups to Backblaze B2 (Enter skips). Over plain `ssh`
   from Claude Code there is no terminal, so it never asks.
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

If the code is not accepted, the script says which of these happened: Claude
refused the code, the server could not reach Claude, or Claude was busy. It also
prints the other way in: run `claude setup-token` on any computer with Claude
Code, then rerun the script with `--token` and paste that token. See
[When something goes wrong](#when-something-goes-wrong).

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
- **bots can reach the API with just their key**: a call to `/api/objectives`
  with no key comes back `401` **as JSON from the app** — that proves the app
  saw it and turned it away, rather than Cloudflare bouncing it to a sign-in page
- **the operator API is still shut**: `/api/internal`, `/api/admin`,
  `/api/secrets` and `/api/auth/token` with no key still get the Cloudflare
  sign-in. A bypass list that grew too wide fails here
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

The test card is a **throw-away**: its title carries a per-run marker (so the
board's duplicate-title guard never refuses it on a second run) and verify
deletes the card again on its way out, pass or fail. It should leave nothing
behind on the client's board.

If a line says FAIL, the message says what to look at. Fix it, then re-run
verify.

### Step 9: First sign-in (👤 You)

1. The person opens `https://<DOMAIN>` and enters **the admin email**
   (`ADMIN_EMAIL`, or the first address in `ACCESS_ALLOWED_EMAILS`).
   Cloudflare sends a code (or they sign in with Google or Microsoft).
2. That is it: the app opens, signed in as the admin. There is no second
   sign-in page.

**The app never asks them for a password.** Cloudflare is what verifies them,
so there is no password page and no "choose a new password" step — including
for someone who used the break-glass password earlier, and including their API
keys and the live board. If a person is ever shown a password page on a one-login
install, the app could not verify Cloudflare's token on that request: see
[When something goes wrong](#when-something-goes-wrong).

The one-time setup password is only needed for the break-glass path below. If
they want to use it, they read it in their own terminal
(`ssh -t root@<IP address> cat /opt/operationkit/secrets/first-admin-setup-password`)
and sign in with the admin username and it. **It stops working after 72 hours**,
whether or not anybody used it. To issue a new one:
`bash install/admin-password.sh --config client.conf`. On an install *without*
one login, the same password must be replaced with a real one (12+ characters)
before anything else in the app works.

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
  so they never sign anyone in. The first admin's break-glass password expires
  on its own schedule even though no change is forced.
- **No password prompts, ever.** A person Cloudflare verified is never asked to
  set or change a password, and the stored "must change password" marker never
  blocks their API keys or their live board. This is decided per request from
  Cloudflare's signed token: it has to verify (signature, AUD tag, issuer,
  expiry) *and* its email has to belong to exactly one user — the same one the
  request is already acting as. A token that fails any of those changes
  nothing, so the ordinary password rules still apply underneath.
- **Off switch.** `--skip-cloudflare` (local / SSH-tunnel installs) leaves both
  settings empty, so the app keeps its own password sign-in.
  `cloudflare.sh down` empties them too. After changing them by hand, restart
  the app.

### Letting bots reach the API with their key

**The problem.** Cloudflare Access sits in front of the **whole** site. That is
what keeps strangers out — but a bot calling the board API sends exactly one
thing, its Operation Kit key (`cc_live_…`), and Cloudflare does not know what
that is. It answers with its HTML sign-in page and the key is never even looked
at. Before this, every install had to be patched by hand in the Cloudflare
dashboard.

**What the installer does.** Step 8 of `cloudflare.sh up` creates a **second**
Access application called **"Operation Kit API (key auth)"** with one policy:
**Bypass / Everyone**. It is limited to the bot-facing API routes and nothing
else. Cloudflare matches the most specific application first, so those paths go
straight to the app and everything else still hits the host-wide application
and its sign-in. It is idempotent: re-running finds the app by name and updates
it in place, it never makes a second one.

**Why that is safe.** The lock does not disappear, it moves:

- **The Operation Kit key is the check.** Those routes all require a valid
  `cc_live_` agent key or a signed-in session. Anyone on the internet can now
  *reach* `/api/objectives`; without a key they get `401`. A key is scoped to
  chosen workspaces and chosen abilities (see [Connect your
  AI](docs/CONNECT-YOUR-AGENT.md)), so it is a narrower credential than a sign-in.
- **The operator surface keeps both locks.** `/api/internal`, `/api/admin`,
  `/api/secrets`, `/api/secret-upload`, `/api/webhooks`, `/api/public`,
  `/api/llm`, `/api/alerts`, `/api/costs`, `/api/intel`, `/api/status` and all
  of `/api/auth` except the exact `/api/auth/me` are **never** in the list, and
  the installer refuses to add them (see below).
- **`/api/internal` is not reachable from outside anyway.** Since #625 it is
  localhost-only *and* needs `X-Internal-Secret`, and that check no longer
  trusts an `X-Forwarded-For` header. Keeping it behind Access as well is the
  belt to that pair of braces.
- **No blanket `/api/*`.** Every path is listed one by one, so a route added by
  a future release is behind Access until someone deliberately lists it.

**The route list lives in one file**, [`install/api-bypass-paths.conf`](install/api-bypass-paths.conf):
`prefix /api/objectives` opens `/api/objectives` **and** `/api/objectives/*`;
`exact /api/health` opens only that one address. Today it covers `/api/mcp`,
`/api/agent`, `/api/agents`, `/api/agent-chat/agents`, `/api/objectives`,
`/api/projects`, `/api/workspaces`, `/api/feed`, `/api/briefing`, `/api/docs`,
`/api/kb-wiki`, `/api/files` and `/api/models` as prefixes, plus the exact
`/api/health`, `/api/openapi.json` and `/api/auth/me`.

**To add a route a bot needs** — add one line to that file and re-run the step
on the server (no re-install, nothing else changes):

```bash
ssh SERVER 'sudo bash /opt/operationkit-src/install/cloudflare.sh api-bypass \
  --config /opt/operationkit-src/client.conf'
ssh SERVER 'sudo bash /opt/operationkit-src/install/verify.sh --config /opt/operationkit-src/client.conf'
```

Keep each line as narrow as it can be: use `exact` when the bot calls one
address.

**You cannot open an operator route by mistake.** `install/api-bypass-lib.sh`
refuses any path under `/api/internal`, `/api/admin`, `/api/secrets`,
`/api/secret-upload`, `/api/webhooks`, `/api/auth` (except the exact
`/api/auth/me`), `/api/public`, `/api/llm`, `/api/alerts`, `/api/costs`,
`/api/intel` and `/api/status`, and any blanket `/api` or wildcard. The step
stops with the reason and changes nothing in Cloudflare.
`install/test/api-bypass-paths-test.sh` proves it on every pull request.

**If another Access app already owns one of those paths.** Some installs were
patched by hand before this step existed, and already have a separate Access
application covering, say, `/api/mcp`. Cloudflare will not let two applications
claim the same destination ("the destination … belongs to another
application", error code `12132`), so that one path used to stop the whole
Cloudflare step — and with it `update.sh`. Now the step looks the account's
Access applications up first and:

- if the other application is itself a **bypass / key-auth** app (it has a
  `Bypass` policy), the path is **skipped with a warning naming the app** and
  the rest of the list is applied. A bot already gets through on that path, so
  the end result is the same. **The other application is never edited or
  deleted** — if you want it folded in, remove it in the Cloudflare dashboard
  and re-run `cloudflare.sh api-bypass`.
- if the other application is **not** a bypass app, those paths would stay
  behind the sign-in, so the step **stops and names the application** rather
  than shipping a half-open install. Either make that app a bypass app, remove
  the path from it, or drop the route from `install/api-bypass-paths.conf`.

The Bypass policy on our own app is also matched by **what it does** (decision
`bypass`, include *Everyone*), not only by its name, so an install whose policy
was renamed in the dashboard gets it reused rather than a second one added.

**Rollback.** To put every API route back behind the Cloudflare sign-in:

```bash
ssh SERVER 'sudo bash /opt/operationkit-src/install/cloudflare.sh api-bypass remove \
  --config /opt/operationkit-src/client.conf'
```

It deletes that one application and its policy and touches nothing else —
effective immediately, and bots go back to getting the sign-in page.
`cloudflare.sh down` removes it too. To stop the installer creating it at all,
set `API_KEY_AUTH_BYPASS="off"` in `client.conf`; `cloudflare.sh status` shows
whether it is present.

**Checking it by hand:**

```bash
curl -si https://<DOMAIN>/api/objectives | head -1     # HTTP/2 401  + JSON body  ✅
curl -si https://<DOMAIN>/api/internal/objectives | head -1   # 302 to …cloudflareaccess.com ✅
curl -si https://<DOMAIN>/ | head -1                   # 302 to …cloudflareaccess.com ✅
```


### …and not getting turned away by Browser Integrity Check (error 1010)

**A second, separate problem.** Suppose you did everything above and the bypass
app is in place. A bot calling the API can still get this:

```
HTTP/2 403
<html>… error code: 1010 … the owner of this website has banned your access
based on your browser's signature …</html>
```

That is **not** Access. It is **Browser Integrity Check**, a different Cloudflare
layer that inspects how the request was made and refuses anything that does not
look like a browser. A script holding a perfectly valid Operation Kit key is
exactly what it refuses. Telling the two apart is the whole trick:

| What the bot gets back | Who said no | What to do |
|---|---|---|
| `302` to `<team>.cloudflareaccess.com`, or an HTML sign-in page | **Cloudflare Access** | `cloudflare.sh api-bypass` |
| `403` + HTML saying **error 1010** / "browser's signature" | **Cloudflare Browser Integrity Check** | `cloudflare.sh api-bic` |
| `401` + **JSON** `{"error":…}` | **Operation Kit** — the key is missing, wrong or expired | issue a key in *Settings → You* |
| `403` + **JSON** | **Operation Kit** — the key is real but lacks that ability or workspace | widen the key's scopes |

The rule of thumb: **Operation Kit always answers JSON. Cloudflare never does.**

**What the installer does.** Step 10 of `cloudflare.sh up` adds **one**
Cloudflare *Configuration Rule* in this zone's `http_config_settings` phase:

- action `set_config`, with **exactly one** action parameter — `bic: false`;
- expression `(http.host eq "<your DOMAIN>" and starts_with(http.request.uri.path, "/api/"))`.

So the check is switched off for **this install's own hostname, under `/api/`
only**. Everything else is deliberately left alone: your **zone-wide Browser
Integrity Check setting**, every **WAF rule** and **rate limit**, the **Access
applications** and the sign-in UI, every **other Configuration Rule** in the
same phase, and **every other hostname in the zone**. The rule is added,
corrected and deleted by its own id, so the rest of the list is never rewritten.

**Why that is safe.** Browser Integrity Check is a heuristic about the *shape*
of the request, not a credential. Switching it off on `/api/` does not open
anything: those routes still need an Operation Kit key or a signed-in session,
and every operator route (`/api/internal`, `/api/admin`, `/api/secrets`, …) is
*also* still behind the Access sign-in, because it was never in the bypass list.
The sign-in UI itself — which is where a browser goes, and where the check is
actually worth having — keeps it.

**The extra token permission.** Configuration Rules need **Zone → Config Rules →
Edit** on top of the five permissions in [Step 2](#step-2-cloudflare--you-about-5-minutes-one-time-per-client).
Without it the step stops and says exactly that; it changes nothing.

**Before it changes anything** it writes the phase's current contents to
`/opt/operationkit/backups/cloudflare-bic-<UTC time>.json` (mode 600), and after
the change it re-reads the phase and refuses to report success unless the rule
reads back exactly right *and* every rule that was not ours is unchanged.

**Run it on its own** (no re-install; nothing else is touched):

```bash
ssh SERVER 'sudo bash /opt/operationkit-src/install/cloudflare.sh api-bic \
  --config /opt/operationkit-src/client.conf --dry-run'   # see the plan first
ssh SERVER 'sudo bash /opt/operationkit-src/install/cloudflare.sh api-bic \
  --config /opt/operationkit-src/client.conf'
```

Re-running is free: a rule that is already right costs no change at all.

**Rollback** — deletes that one rule by id and leaves the phase and every other
rule in it alone:

```bash
ssh SERVER 'sudo bash /opt/operationkit-src/install/cloudflare.sh api-bic remove \
  --config /opt/operationkit-src/client.conf'
```

`cloudflare.sh down` removes it too, and `cloudflare.sh status` shows whether it
is present. To stop the installer adding it at all, set
`API_BROWSER_INTEGRITY_EXCEPTION="off"` in `client.conf` — then switch Browser
Integrity Check off for the zone by hand, or accept that bots get 1010.

**Existing installs:** pulling new code does **not** change anything in your
Cloudflare account. See [Reconciling an existing install](docs/CLOUDFLARE-API-ACCESS.md#reconciling-an-existing-install).

**Checking it by hand:**

```bash
curl -si https://<DOMAIN>/api/objectives | head -1                    # 401 + JSON   ✅ (the APP refused)
curl -si -H "Authorization: Bearer cc_live_…" https://<DOMAIN>/api/objectives | head -1   # 200 + JSON ✅
curl -si https://<DOMAIN>/ | head -1                                  # 302 to …cloudflareaccess.com ✅ (UI still protected)
```

If the first line comes back `403` with HTML, Browser Integrity Check is still
on for that path — run `cloudflare.sh api-bic`.

### Step 10: Report

Tell the person, in a few sentences:

- the site address and that verify passed (paste the PASS/FAIL count)
- the build: the `Build:` line the installer printed (the same commit shows at
  the bottom of **Settings** and in `/api/health`)
- whether backups go off the server (`BACKUP_TARGET`) or only to this server. If
  only to this server and they want Backblaze B2, give them the command to run
  in **their own terminal** (it asks for the key):
  `ssh -t SERVER sudo bash /opt/operationkit-src/install/b2-setup.sh --config /opt/operationkit-src/client.conf`
- the next steps that are theirs: more Claude seats ([Seats](#connect-subscription-seats)),
  and for cards that work on code, GitHub tokens and repositories
  ([Cards that work on code](#cards-that-work-on-code-github-and-repositories))
- the total install time from `/opt/operationkit/install-timing.log`
- anything you skipped and why

---

## Connect subscription seats

A **seat** is one AI account the sessions sign in with. Seats are in **Settings → Seats**
(admins only): **Add Claude seat** (sign in with Claude, or paste a `claude setup-token`
token), and optionally **Add Codex seat** / **Add Grok seat**.

- **How many.** The app has no fixed number of sessions per Claude seat: each new session goes to
  the healthy seat with the fewest sessions running. Each plan's own usage allowance is the limit.
  Start with one and add seats when cards wait for one. A Codex or Grok login runs one sandboxed
  session at a time.
- **At the limit.** A rate-limited seat cools down until the provider's reset time (or 15 minutes,
  doubling on repeats, at most 5 hours) and comes back by itself. A seat out of credits, or showing
  **Reconnect**, waits for you.
- **No seat free.** The card is queued (*"All Claude seats are unavailable … queued for
  auto-retry"*), and every 30 seconds the app starts as many queued cards as there are free seats.

Details: [RECOMMENDED-STACK step 7](docs/RECOMMENDED-STACK.md#7-connect-subscription-seats-).

## Cards that work on code (GitHub and repositories)

A card that edits a repository or opens a pull request needs three things. Step by step, with the
exact commands: [RECOMMENDED-STACK step 8](docs/RECOMMENDED-STACK.md#8-github-tokens-and-repositories).

1. **The person's GitHub token.** Each person links their own in **Settings → Connectors → GitHub**
   (or `POST /api/user/github-token` with `{"token": "…"}`). Sessions push as the card's assigned
   user, or its creator if nobody is assigned. Use a fine-grained token limited to the repositories,
   with *Contents* and *Pull requests* read and write.
2. **A checkout on the server** at `/opt/operationkit/state/home/projects/<name>` (inside the app:
   `/home/operator/projects/<name>`). Nothing clones it for you. Clone it with the token passed
   through `GIT_ASKPASS`, never in the URL.
3. **The repository registered with its path** by an admin:
   `POST /api/admin/workspaces/<workspace>/repos` with `name`, `github`, `stack` (a list of strings)
   and `repo_path` (the in-app path above). That adds the project to the app's
   `ai-workspace/workspaces.json` (the installer creates the file) and sets the checkout's
   `!gh auth git-credential` helper. The **Settings → Org → Organizations → Repos & projects** screen
   does not ask for the path yet: add it with `PATCH …/repos/<id>`. Without a path, a project card
   fails with *"resolveWorkdir: … no workspace in workspaces.json maps it to an existing checkout"*.

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

**Updates are manual: nothing pulls new Operation Kit code by itself.** The automatic updates the
installer switches on are Ubuntu's security patches for the operating system only. To hear about new
versions, watch <https://github.com/m1keluka/OperationKit> on GitHub and read
[CHANGELOG.md](CHANGELOG.md). To see what is waiting:
`ssh SERVER 'cd /opt/operationkit-src && sudo git -c safe.directory="*" fetch -q origin main && git -c safe.directory="*" log --oneline HEAD..origin/main'`.

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
   `ok-jail:pre-update-<time>` (the newest 3 are kept, about 8 GB per version: plan about
   32 GB of disk for images plus about 8 GB of Docker build cache).
3. **Fetches and checks out** `--ref` (default `main`) from the repository the code
   was cloned from (`origin`: the public repository). git runs as the owner of
   the code folder, with `safe.directory` allowed, so a folder cloned as
   `ubuntu` never ends up owned by root.
4. **Re-runs `./install.sh --config client.conf`** (it lives at the top of the
   repository, not under `install/`), with `--skip-cloudflare` again for a
   local-only install. Secrets and data are kept.
5. **Prints the rollback steps**: check out the old commit, re-tag the
   `pre-update-<time>` images as `:local`, optionally restore the pre-update
   backup, start the app. They are printed again if the install fails.

Do it **when no cards are running**: the app restarts and running sessions are cut off. The first time, on an
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
| `secrets.tar.gz` | `secrets/`: `secrets-kek` (and its copy in `stack.env`) is the key that decrypts the secrets stored in the database, so a restore needs both. Keep one more copy of `secrets-kek` somewhere you control, for example a password manager: without it no backup of the database can be read |
| `client.conf`, `install.env`, `MANIFEST` | settings, and the commit + checksums of this backup |

The newest `BACKUP_KEEP_LOCAL` (default 7) stay on the server. Log:
`/opt/operationkit/logs/backup.log`.

**Off the server (recommended).** A backup on the same disk does not survive
losing the server. Set `BACKUP_TARGET` in `client.conf` and every nightly folder
is also sent, encrypted, to an S3-compatible bucket with
[restic](https://restic.net) (installed by the installer). It is the **same one
nightly job**: there is no separate off-site timer. restic keeps one copy per day
for `BACKUP_KEEP_DAILY` days, one per week for `BACKUP_KEEP_WEEKLY` weeks and one
per month for `BACKUP_KEEP_MONTHLY` months (defaults **7 / 4 / 6**, at most 17
snapshots). Pruning old data runs on Sundays.

**What it costs on Backblaze B2:** $6.95 per TB per month, the first 10 GB free,
downloads free up to three times what you store
([pricing](https://www.backblaze.com/cloud-storage/pricing)). Estimated storage
after about 6 months, as an upper bound (nightly size x about 34 snapshots, no
de-duplication assumed; nightly size 10-30 MB solo, 50-150 MB small team,
150-500 MB heavy): **under 1 GB** solo, **1.7-5 GB** small team (both free),
**5-17 GB** heavy ($0 to about $0.05 a month).

**The easy way (Backblaze B2):**

1. **👤 You:** in Backblaze, *Buckets → Create a Bucket* (**Private**), then
   *Application Keys → Add a New Application Key*: *Allow access to Bucket(s)*:
   **only that bucket**; *Type of Access*: **Read and Write**. restic must list
   the bucket and list, read, write and delete files (deleting removes old
   snapshots): the key needs `listBuckets`, `listFiles`, `readFiles`,
   `writeFiles` and `deleteFiles`, which *Read and Write* gives.
2. **👤 You, in your own terminal** (it asks for the key, so never through a chat):

   ```bash
   ssh -t SERVER sudo bash /opt/operationkit-src/install/b2-setup.sh --config /opt/operationkit-src/client.conf
   ```

   It reads the applicationKey hidden, checks the key with Backblaze (accepted,
   limited to the bucket, the five permissions above), writes `BACKUP_TARGET`
   into `client.conf` and the two keys into `secrets/stack.env` (mode 600),
   keeps the one nightly job, sends the first snapshot, runs the restore test
   and prints one line ending in `restore test PASS`. Re-running it is safe.
3. Save the backup password (point 5 below).

**By hand, or another S3-compatible store:**

1. Create a private bucket and a key limited to it, with read and write.
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
   then `… backup.sh list --config …` shows the off-server copy, and
   `… backup.sh verify --config …` runs the restore test.
5. **👤 You: save the backup password somewhere safe, off the server** (a
   password manager). The off-server copies are encrypted with it, and if the
   server is lost so is the copy in `stack.env`. Read it in your own terminal,
   never in a chat:
   `ssh -t SERVER sudo grep ^OK_BACKUP_PASSWORD= /opt/operationkit/secrets/stack.env`

**Restore test (do it after the first backup, then monthly).**

```bash
ssh SERVER 'sudo bash /opt/operationkit-src/install/backup.sh verify --config /opt/operationkit-src/client.conf'
```

It downloads the newest off-server snapshot (with no `BACKUP_TARGET`: takes the
newest backup folder on the server) into a scratch folder, checks every file
against the backup's `MANIFEST` checksums, opens every archive, runs SQLite's
`PRAGMA integrity_check` and counts the rows of the main tables, then prints
`RESTORE TEST: PASS` or `RESTORE TEST: FAIL` (exit code 1), and deletes the
scratch copy. It changes nothing. `--snapshot <id>` tests an older one.

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
4. Run verify (step 8), then the restore test (`backup.sh verify`) so the new
   server's own off-site backups are known to work.

If the backup password is lost, these steps cannot work: the off-site copies
cannot be decrypted by anyone. That is why point 5 above says to keep it in a
password manager.

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
| claude-login: `Claude did not accept that code …` | Each code works once and expires within minutes. Open the **same link** again (good for 10 minutes), sign in, and paste the **new** code. Paste junk from the terminal (CR, bracketed-paste `ESC[200~`, spaces, quotes) is removed automatically. The reason in `[…]` is Claude's own. |
| claude-login: `… does not belong to the link printed above` | The code came from an older link (another run of the script, or a browser tab left open). Open the link printed in **this** run. The `[…]` shows the end of both states, so you can compare. |
| claude-login: `that code was already tried` | Pasting the same code twice is caught before it is sent. Get a new code from the link. |
| claude-login: `Claude's sign-in service answered with an error [HTTP 429 …]` / `[HTTP 5xx …]` | Claude is busy or rate limiting. Wait a minute, then get a new code. `[HTTP 403, not a Claude reply …]` means a proxy or firewall answered instead of Claude. |
| claude-login: `could not reach Claude's sign-in service` | A real network failure: the server got no answer from `platform.claude.com` (the reason, e.g. `Could not resolve host`, is in `[…]`). Check DNS, outbound HTTPS and the firewall. |
| claude-login: the code still will not go through | Use a setup token instead (the script prints this on every failure): on any computer with Claude Code run `claude setup-token`, sign in with the client's account, then on the server `sudo bash /opt/operationkit-src/install/claude-login.sh --config /opt/operationkit-src/client.conf --token` and paste the `sk-ant-oat…` token. |
| `the Cloudflare API token cannot read the Zero Trust organization` | The token lacks **Access: Organizations, Identity Providers, and Groups → Edit** (step 2). Edit the token, re-run. |
| `starter pack '…' could not be switched on` | The message above it says why. Fix it and re-run `./install.sh`; to install without packs set `STARTER_PACKS=""`. |
| `apt-get … failed 3 times` | The server cannot reach the Ubuntu package mirror. Check its network, then re-run. Short mirror hiccups are retried automatically. |
| `the image build failed` | The last 40 build lines are printed; the whole log is in `/opt/operationkit/logs/build-<time>.log`. |
| `detected dubious ownership in repository` | See step 3: `git config --global --add safe.directory /opt/operationkit-src`. |
| `This setup password has expired` | `bash install/admin-password.sh --config client.conf` |
| verify: `this admin was created before one login was switched on` | The admin row predates one login. `bash install/admin-password.sh --config client.conf` issues a fresh break-glass password and clears the forced change. Their sign-in through Access already works. |
| On a one-login install, someone is shown **"choose a new password"** | The app could not verify Cloudflare's token on that request. Check `OK_CF_ACCESS_TEAM` and `OK_CF_ACCESS_AUD` in `secrets/stack.env` and restart the app, then confirm the person's **Sign-in email** in *Settings → Users* matches the address Cloudflare verified, exactly and on only one user. `install/verify.sh` checks both. |
| `resolveWorkdir: … no workspace in workspaces.json maps it to an existing checkout` | The card's project is not registered with a `repo_path`, or that folder does not exist: [Cards that work on code](#cards-that-work-on-code-github-and-repositories), points 2-3. |
| `All Claude seats are unavailable … queued for auto-retry` | Every seat is cooling down or parked. The card starts by itself when one frees up; add a seat in **Settings → Seats** if it happens often ([Seats](#connect-subscription-seats)). |
| A card looks stuck, or (on installs before the 2026-11-01 update) shows **review** with no session while work continues | Its sandbox may still be working: `docker ps \| grep ok-jail` shows it. Wait for it before restarting anything; update older installs. |
| A card cannot push or open a PR | The card's person has no GitHub token linked, or the repository is not checked out: [Cards that work on code](#cards-that-work-on-code-github-and-repositories). |
| b2-setup: `Backblaze did not accept this keyID / applicationKey` | Typo, or the key was deleted. The applicationKey is shown only once; make a new key and re-run. |
| b2-setup: `this key cannot deleteFiles` (or another permission) | The key is read-only or too narrow. Make a new key with **Read and Write** for the bucket. |
| `RESTORE TEST: FAIL` | The FAIL lines say which check. Wrong password or keys: compare with your password manager. Damaged snapshot: run the test again with `--snapshot <older id>` (ids: `backup.sh list`). |

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
