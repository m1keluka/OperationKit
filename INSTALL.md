# Installing Operation Kit on a client's server

This guide turns a brand-new server into a working Operation Kit site at the
client's own web address, for example `https://ops.clientfirm.com`, in about
30 minutes.

**You do not need to type the commands yourself.** Open Claude Code on your
laptop and tell it:

> Install Operation Kit on my server by following INSTALL.md in this repository.
> The server is `<IP address>`, I log in as `root`. My Cloudflare API token is in
> the environment variable `CF_API_TOKEN`.

Claude Code reads the rest of this file and does the work. It stops only when it
needs you to click something or choose something. Those moments are marked
**👤 You**.

---

## What you need before starting

| | What | Why |
|---|---|---|
| 1 | A fresh **Ubuntu 24.04** server: 4 CPU cores, 8 GB memory, 80 GB disk or more | Where Operation Kit runs. Any provider works (DigitalOcean, Hetzner, AWS, OVH…). |
| 2 | **SSH access** to it as `root` (or a user with `sudo`), with an SSH key | Claude Code uses it to install everything. |
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
3. **Operation Kit sign-in** is the second lock: a username and password. The
   first admin gets a one-time password and must choose their own on first
   sign-in.
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

If they chose **Google** or **Microsoft** sign-in (step 4), they also need an
OAuth app from Google Cloud or Microsoft Entra. Cloudflare's guide covers it:
*Zero Trust → Settings → Authentication → Add new*. The **one-time email
code** option needs none of this. Use it unless the client asks otherwise.

### Step 3: Put the code on the server

```bash
ssh SERVER 'apt-get update -qq && apt-get install -y -qq git && \
  git clone --depth 1 <the Operation Kit repository URL> /opt/operationkit-src'
```

Keep the code in `/opt/operationkit-src`. The install itself goes in
`/opt/operationkit`, and the uninstall script deletes that folder.

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
| `ACCESS_ALLOWED_EMAILS` / `ACCESS_ALLOWED_EMAIL_DOMAIN` | Who may open the site? | `alex.partner@example-capital.com` |
| `ACCESS_LOGIN_METHOD` | Email code, Google or Microsoft? | `otp` |
| `CLAUDE_AUTH` | Claude subscription (`login`) or API key (`api-key`)? | `login` |
| `AGENTS_ENABLED` | Which AI agents? | `general,coo,cfo` |
| `TIMEZONE` | Which time zone are they in? | `America/New_York` |

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
`AZURE_CLIENT_SECRET`, `AZURE_DIRECTORY_ID`, `CLAUDE_CODE_OAUTH_TOKEN`.

### Step 6: Install

First a dry run. It changes nothing and should end with `Done`:

```bash
ssh SERVER 'cd /opt/operationkit-src && ./install.sh --config client.conf --dry-run'
```

Then the real install. It takes 10 to 20 minutes, mostly building the app:

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
5. **Starts the app**, then creates the client's workspace and the first admin
   with a one-time setup password.
6. **Runs the checks** in step 8 (the test card waits until Claude is
   connected).

At the end it prints a time for each step and the total. Keep them for the
report.

### Step 7: Connect Claude for the AI workers (👤 You, 2 minutes)

*Skip this step if the client uses an API key that you handed over in step 5.*

The Claude sign-in produces a long-lived token. It must appear **only on the
person's own screen**, never in this chat. Ask the person to open their own
terminal (not Claude Code) and run:

```bash
claude setup-token
```

A browser opens. They sign in with **the client's** Claude account and copy the
token it prints (it starts with `sk-ant-oat`). Then, still in their own
terminal:

```bash
ssh -t root@<IP address> bash /opt/operationkit-src/install/claude-login.sh --config /opt/operationkit-src/client.conf
```

They paste the token when asked. Typing is hidden. The script checks that
Claude answers from inside a sandbox before it saves anything, then restarts
the app.

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
- password sign-in works (it uses a temporary `ok-verify` account and removes it afterwards)
- the first admin is still forced to choose a new password
- **a test card runs end to end**: it is created, a sandboxed AI worker answers
  it, and the sandbox could only see its own two folders

If a line says FAIL, the message says what to look at. Fix it, then re-run
verify.

### Step 9: First sign-in (👤 You)

1. In their own terminal, the person reads the one-time setup password:
   ```bash
   ssh -t root@<IP address> cat /opt/operationkit/secrets/first-admin-setup-password
   ```
2. They open `https://<DOMAIN>` and enter their email. Cloudflare sends a code
   (or they sign in with Google or Microsoft).
3. They sign in to Operation Kit with the admin username and the setup
   password.
4. Operation Kit asks for a new password (12+ characters). Nothing else works
   until they set one.

The setup password stops working after 72 hours. To issue a new one:
`bash install/admin-password.sh --config client.conf`.

### Step 10: Report

Tell the person, in a few sentences:

- the site address and that verify passed (paste the PASS/FAIL count)
- the total install time from `/opt/operationkit/install-timing.log`
- anything you skipped and why

---

## After the install

1. **Add agents.** Sign in as the admin, open **Agents → Templates** and press **Add agent** on
   the starter templates the client wants (Personal assistant, Knowledge librarian, Operator).
   Each agent is one file; see [docs/agents/agent-file-format.md](docs/agents/agent-file-format.md).
2. **Load the client's files.** **Knowledge base → Import files.** Excel, CSV, PDF and Word files
   become linked notes you can ask questions of.
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
| `This setup password has expired` | `bash install/admin-password.sh --config client.conf` |

## What is stored where

| Path on the server | What | Who can read it |
|---|---|---|
| `/opt/operationkit-src/` | the code + `client.conf` (no secrets) | root |
| `/opt/operationkit/secrets/` | generated secrets, Cloudflare token, setup password | root only (mode 700/600) |
| `/opt/operationkit/state/` | database, files, session work folders | the app |
| `/opt/operationkit/install-timing.log` | how long each install took | root |

Back up `/opt/operationkit/` to keep everything. Change the folder with
`INSTALL_DIR` in `client.conf`.
