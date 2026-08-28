# Powering OperationKit with a Claude Code subscription

**This is the recommended primary way to power agent sessions in OperationKit.**

OperationKit runs its agents by spawning the real
[Claude Code](https://www.npmjs.com/package/@anthropic-ai/claude-code) CLI, one process
per session. Those sessions authenticate with a **Claude Code subscription** (Claude
**Pro** or **Max**) via OAuth — *not* with an `ANTHROPIC_API_KEY`. A subscription lets you
run heavy, long-running agent volume under your plan's usage allowance instead of paying
per-token API billing.

If you only read one thing: **authenticate at least one Claude subscription into account
`a`** (see [Quickstart](#quickstart--one-subscription)) and you can run the whole platform.
`ANTHROPIC_API_KEY` is *optional* and only powers a small server-side summarizer — see
[API key vs. subscription](#api-key-vs-subscription).

---

## How the auth model works

Every agent session runs as one of a set of **accounts** (`a`, `b`, `c`, …). Each account
is just a home directory holding that account's Claude OAuth credentials:

| Piece | Where | Source of truth |
|---|---|---|
| Credential file | `<accountHome>/.claude/.credentials.json` | [`account-router.ts`](../app/server/src/services/account-router.ts) |
| Account `a`..`e` home (in container) | `/home/ccuser-a` … `/home/ccuser-e` | `ACCOUNT_HOME_BASE = '/home/ccuser'` |
| Account `f`,`g` home (in container) | `/app/data/cc-accounts/f`, `…/g` | dynamic slots |
| Host → container mount | `/opt/operationkit/.ccuser-a` → `/home/ccuser-a` (and `-b`..`-e`) | [`docker-compose.yml`](../docker-compose.yml) |

An account is considered **available** the moment its credential file exists. From
[`account-router.ts`](../app/server/src/services/account-router.ts):

```ts
// Check if the account home dir exists and has claude auth
const claudeJson = path.join(account.homeDir, '.claude', '.credentials.json')
if (!fs.existsSync(claudeJson)) {
  return false // account not set up
}
```

So "adding a subscription" means nothing more than **placing a valid
`.credentials.json` under that account's `.claude/` directory.** The three methods below
are just three ways to produce that file.

Because host `/opt/operationkit/.ccuser-a` is bind-mounted to the container's
`/home/ccuser-a`, you can create the credentials **either** on the host (point `HOME` at
`/opt/operationkit/.ccuser-a`) **or** inside the container (point `HOME` at
`/home/ccuser-a`). Both write to the same file.

### Sessions never use your API key

The session wrapper explicitly strips API keys before launching Claude Code
([`session-manager.ts`](../app/server/src/services/session-manager.ts)):

```bash
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN OPENAI_API_KEY GEMINI_API_KEY GOOGLE_API_KEY
```

With those unset, Claude Code falls back to the subscription OAuth credentials in the
account's mounted `HOME`. This is intentional — it is what makes subscription-powered
sessions the whole point.

---

## Verified CLI commands

These were verified against the installed CLI (`@anthropic-ai/claude-code`,
**v2.1.175**). Do not substitute flags from memory — earlier Claude Code versions used a
bare `claude login`, which **does not exist** in this version.

```
$ claude auth --help
Usage: claude auth [options] [command]
Manage authentication
Commands:
  login [options]   Sign in to your Anthropic account
  logout            Log out from your Anthropic account
  status [options]  Show authentication status

$ claude auth login --help
Usage: claude auth login [options]
Sign in to your Anthropic account
Options:
  --claudeai       Use Claude subscription (default)
  --console        Use Anthropic Console (API usage billing) instead of Claude subscription
  --email <email>  Pre-populate email address on the login page
  --sso            Force SSO login flow

$ claude setup-token --help
Usage: claude setup-token [options]
Set up a long-lived authentication token (requires Claude subscription)
```

- **`claude auth login --claudeai`** — interactive subscription sign-in (the default). Use
  for a workstation or any host where you can open the printed URL in a browser.
- **`claude setup-token`** — mints a long-lived subscription token; the headless-friendly
  path.
- **`claude auth status`** — confirms whether the current `HOME` is authenticated.
- Always use `--claudeai` (or `setup-token`), **never `--console`**: `--console` switches
  to API-usage billing, defeating the purpose.

---

## Quickstart — one subscription

Authenticate a single Claude Pro/Max subscription into **account `a`** and you have a
working platform. Pick whichever method fits your host.

> Prerequisite: the Claude Code CLI. Inside the OperationKit container it is already
> installed. On a host, install it with `npm install -g @anthropic-ai/claude-code`.

### Method (i) — interactive `claude auth login` (workstation / browser available)

Run the CLI with `HOME` pointed at the account directory so the credentials land in the
right place:

```bash
# On the host (writes to the bind-mounted account dir):
sudo mkdir -p /opt/operationkit/.ccuser-a
sudo HOME=/opt/operationkit/.ccuser-a claude auth login --claudeai
# → opens/prints an OAuth URL; approve in your browser, paste the code back.

# Fix ownership so the containerized session user can read it:
sudo chown -R "$(id -u):$(id -g)" /opt/operationkit/.ccuser-a/.claude
```

Or run it **inside the container**, where the account home is `/home/ccuser-a`:

```bash
docker compose exec app bash -lc 'HOME=/home/ccuser-a claude auth login --claudeai'
```

Verify:

```bash
HOME=/opt/operationkit/.ccuser-a claude auth status
ls -l /opt/operationkit/.ccuser-a/.claude/.credentials.json   # file exists ⇒ account available
```

### Method (ii) — `claude setup-token` (headless droplet)

On a server with no local browser, `setup-token` still runs an OAuth flow (it prints a URL
you open on any device) and stores a long-lived subscription credential under the `HOME`
you set:

```bash
sudo mkdir -p /opt/operationkit/.ccuser-a
sudo HOME=/opt/operationkit/.ccuser-a claude setup-token
sudo chown -R "$(id -u):$(id -g)" /opt/operationkit/.ccuser-a/.claude
```

### Method (iii) — copy an existing `.credentials.json` (most reliable headless)

If you have already run `claude auth login` on another machine (e.g. your laptop), just
copy that machine's credential file up to the droplet:

```bash
# From the machine already logged in:
scp ~/.claude/.credentials.json you@your-droplet:/tmp/creds.json

# On the droplet:
sudo mkdir -p /opt/operationkit/.ccuser-a/.claude
sudo mv /tmp/creds.json /opt/operationkit/.ccuser-a/.claude/.credentials.json
sudo chmod 600 /opt/operationkit/.ccuser-a/.claude/.credentials.json
```

There is a helper that wraps method (i)/(ii) for you:
[`scripts/claude-auth.sh`](../scripts/claude-auth.sh) — see below.

Once the credential file exists, no restart is needed: `account-router` re-checks the path
each time it picks an account, so the next session can use it.

---

## Scaling — more subscriptions for throughput & rate-limit rotation

One subscription works, but a single Pro/Max plan has usage limits (a rolling 5-hour
session window and a weekly window). To run more concurrent agents or ride through
rate-limit windows, authenticate **additional** subscriptions into accounts `b`, `c`, `d`,
`e` — repeat the Quickstart with a different account home each time:

```bash
sudo HOME=/opt/operationkit/.ccuser-b claude setup-token   # then chown, as above
sudo HOME=/opt/operationkit/.ccuser-c claude setup-token
# … d, e
```

The router (`pickAccount` in
[`account-router.ts`](../app/server/src/services/account-router.ts)) picks among the
available accounts like this:

1. **Lowest priority number first.** Accounts `b`..`g` default to `priority: 0` and are
   reached first. Account `a` defaults to `priority: 10` — it is the "personal" slot and is
   only reached when every `priority: 0` account is unavailable (rate-limited or not set
   up).
2. Tie-break: fewest **active** sessions, then fewest **sessions today**, then fewest
   **tokens** today.

> **Practical implication:** if you are only running ONE subscription, account `a` is fine
> for the Quickstart — with nothing else set up it is the only available account and will be
> used. But if you intend to add more, put your **primary shared** subscription in `b` (or
> `c`..`e`) and reserve `a` for a personal account you don't want drained first. When an
> account hits a rate limit, the router benches it until its reset time and rotates to the
> next available one automatically.

### Beyond account `e`

Accounts `f` and `g` are pre-defined dynamic slots whose homes live under the
already-mounted `/app/data` (`/app/data/cc-accounts/f`, `…/g`) — so you can add them
**without** editing `docker-compose.yml` or recreating the container. Authenticate them the
same way (e.g. on the host: `HOME=/opt/operationkit/data/command-center/cc-accounts/f`,
which is the host side of the `/app/data` mount). To go beyond `g`, add more `AccountSlot`
entries to `DEFAULT_ACCOUNTS` in `account-router.ts` (dynamic-home slots need no compose
change; fixed `/home/ccuser-*` slots would need a new bind-mount).

---

## API key vs. subscription

| | Powers what | Required? |
|---|---|---|
| **Claude subscription** (this doc) | Every **agent session** — the heavy, long-running work the platform exists to do. | **Yes** — the recommended primary path. |
| **`ANTHROPIC_API_KEY`** | A small server-side **session-intel summarizer** that calls the Anthropic Messages API directly to summarize finished sessions (and the legacy LiteLLM proxy groups, if you enable it). | **Optional.** Leave it as the placeholder and the summarizer is simply inactive; sessions are unaffected. |

The two are independent. Agent sessions **cannot** use `ANTHROPIC_API_KEY` even if you set
it — the session wrapper unsets it (see above). You can run the entire platform on just a
subscription. See [CREDENTIALS.md](CREDENTIALS.md) and [`.env.example`](../.env.example) for
the (optional) `ANTHROPIC_API_KEY` entry.

---

## Verifying an account is authenticated

Three ways, cheapest first:

1. **Credential file present** — the exact check the router does:
   ```bash
   ls -l /opt/operationkit/.ccuser-a/.claude/.credentials.json
   ```
   If the file exists (and is readable by the session user), the account is available.

2. **CLI status** — point `HOME` at the account and ask Claude Code:
   ```bash
   HOME=/opt/operationkit/.ccuser-a claude auth status --text
   ```

3. **Admin Accounts view** — the server exposes account state at the admin-only endpoint
   `GET /api/admin/accounts`
   ([`routes/admin.ts`](../app/server/src/routes/admin.ts) →
   `getAccountRouterStatus()`), and the Dashboard renders it as per-account cards with an
   **available / rate-limited** badge
   ([`Dashboard.tsx`](../app/client/src/components/Dashboard.tsx), `AccountCard`). An
   authenticated account shows as available there.

---

## Troubleshooting

- **Account shows "not set up" / unavailable.** The credential file is missing or
  unreadable by the session user. Re-check the path and `chown` it to the user that runs
  sessions.
- **`--console` by mistake.** If you signed in with `--console`, you are on API billing.
  Run `claude auth logout` for that `HOME`, then `claude auth login --claudeai`.
- **Everything is rate-limited.** Add another subscription (accounts `b`..`e`); the router
  rotates automatically and benches limited accounts until their reset window passes.

## See also

- [SETUP.md](SETUP.md) — full give-keys → running walkthrough.
- [DIGITALOCEAN.md](DIGITALOCEAN.md) — one-command droplet install.
- [CREDENTIALS.md](CREDENTIALS.md) — every credential, required vs. optional.
