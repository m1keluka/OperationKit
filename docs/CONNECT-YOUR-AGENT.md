# Connect your AI to Operation Kit

This guide connects an AI you already use (Claude, ChatGPT, Grok, Codex, Cursor or any other app
that speaks **MCP**) to your Operation Kit install. Once connected, that AI can search and update
your knowledge base, use your agents, and hand work to the board, all under a key you control.

It takes about 5 minutes. You need to be signed in to Operation Kit.

> **MCP** (Model Context Protocol) is the standard way AI apps plug into other tools. Operation Kit
> runs one MCP server. Everything goes through one address:
>
> ```
> https://<your Operation Kit address>/api/mcp
> ```
>
> For example `https://ops.example-capital.com/api/mcp`.

---

## Step 0 (administrator): the API door is already open — check it

Cloudflare Access sits in front of the **whole** site, which is what keeps strangers out. On its
own that also stops an AI app: it gets Cloudflare's sign-in page instead of an answer, and the key
it sent is never looked at.

**The installer already handles this.** `install/cloudflare.sh` creates a second,
path-limited Cloudflare Access application — **"Operation Kit API (key auth)"** — that steps aside
on the bot-facing API routes only, including `/api/mcp`. Your agent key is then the single check on
those routes. Everything else on the site, and every operator route (`/api/internal`, `/api/admin`,
`/api/secrets`, `/api/secret-upload`, `/api/webhooks`, the rest of `/api/auth`), still needs the
Cloudflare sign-in. Anyone can now *reach* `/api/mcp`; without a valid key they get `401`.

So on a current install there is **nothing to do here**. Confirm it in one command — a `401` with a
JSON body means the app saw the request and turned it away, which is what you want:

```bash
curl -si https://<your Operation Kit address>/api/objectives | head -1
# HTTP/2 401   ← good: the app answered, your key is what decides
# HTTP/2 302 … cloudflareaccess.com  ← the bypass is missing, see below
```

**If it is missing** (an install made before this, or `API_KEY_AUTH_BYPASS="off"`), whoever runs the
server adds it with one command — it is idempotent, so re-running is safe:

```bash
sudo bash /opt/operationkit-src/install/cloudflare.sh api-bypass \
  --config /opt/operationkit-src/client.conf
```

**If your bot needs a route that is not open yet** (you get the Cloudflare sign-in page on some
other `/api/…` address): add one line to `install/api-bypass-paths.conf` on the server —
`prefix /api/<thing>` for a whole route, `exact /api/<thing>` for a single address — then re-run
the command above and `install/verify.sh`. The installer **refuses** to add an operator route, so a
mistake there stops the step instead of opening anything. Full explanation, including why this is
safe and how to roll it back:
[INSTALL.md → Letting bots reach the API with their key](../INSTALL.md#letting-bots-reach-the-api-with-their-key).

### If you want the door shut to everyone but one tool

The bypass above is per-route, not per-tool: any AI app with a valid key can use those routes. If
you would rather Cloudflare itself only admit one named tool, use an **agent pass** instead, and
turn the bypass off (`API_KEY_AUTH_BYPASS="off"`, then `cloudflare.sh api-bypass remove`).

**An agent pass** is the alternative.
An agent pass is a Cloudflare service token for one AI app. The app sends two extra headers that
Cloudflare recognises; everyone else still gets the sign-in page.

1. Whoever installed the server runs, on the server (one pass per app, named after it):

   ```bash
   sudo bash /opt/operationkit-src/install/cloudflare.sh agent-pass add claude-code \
     --config /opt/operationkit-src/client.conf
   ```

   It creates the pass and saves its two values to
   `/opt/operationkit/secrets/agent-pass-claude-code.env` (readable by root only). It never prints
   them. Passes last one year.
2. The person setting up the app reads the two values **in their own terminal**, never in a chat:

   ```bash
   ssh -t root@<server> cat /opt/operationkit/secrets/agent-pass-claude-code.env
   ```

   `CF_ACCESS_CLIENT_ID` is the `<client id>` below and `CF_ACCESS_CLIENT_SECRET` is the
   `<client secret>`.
3. When you connect the app below, add two headers next to the key:
   `CF-Access-Client-Id: <client id>` and `CF-Access-Client-Secret: <client secret>`.

See all passes with `agent-pass list`; cut one app off with `agent-pass remove <name>` (same
command, same `--config`). No server access? The same thing can be made by hand in the Cloudflare
dashboard: **Zero Trust → Access → Service auth → Create service token**, then add a **Service
Auth** policy for that token on the Operation Kit application.

This works with Claude Code, Claude Desktop (through `mcp-remote`), the OpenAI Responses API, the
xAI (Grok) API, Codex, Cursor and any app that lets you set extra headers.

Note that an agent pass only opens the Cloudflare door; the app still needs an Operation Kit agent
key on top. It does **not** work with the "add connector" screens in the claude.ai, ChatGPT and
Grok apps (they only offer a sign-in flow), or with the Claude API's MCP connector — those send
only the key and no extra headers, which is exactly the case the built-in bypass covers.

## Step 1: Make an agent key

1. Open **Settings → You**, scroll to **Agent keys**, press **New agent key**.
2. **Name** it after the app and the person, so you can tell keys apart later:
   `Claude: Jordan`, `ChatGPT: Office`, `Grok: Research bot`.
3. **Tick only what it needs:**

   | Tick | Lets the AI… |
   |---|---|
   | `vault:read` | search and read the knowledge base |
   | `vault:write` | save and update notes |
   | `board:read` | see cards, their progress and their results |
   | `board:write` | create cards and send them messages |
   | `board:start` | start a card straight away instead of leaving it in the queue |
   | `board:cancel` | cancel a card |
   | `board:done` | sign a card off as done (leave this off: that is your signature) |
   | `board:delete` | delete a card (leave this off) |

   A new key starts with everything ticked except `board:done` and `board:delete`. For a personal
   assistant, `vault:read`, `vault:write`, `board:read` and `board:write` are enough.
4. **Pick the workspace(s)** it may touch. A key limited to one workspace cannot see any other.
5. Press **Create key** and **copy the key**. It starts with `cc_live_` and is shown **once**.

Treat the key like a password. Paste it only into the app's connection settings (below), never into
a chat message, an email or a shared document.

## Step 2: Connect your app

Pick your app. Replace `<address>` with your Operation Kit address and `<key>` with the key.
On a current install you only need the key. The `CF-Access-…` lines below are only for an install
that uses an **agent pass** instead (Step 0) — leave them out otherwise.

### Claude Code (terminal)

```bash
claude mcp add --transport http operation-kit https://<address>/api/mcp \
  --header "Authorization: Bearer <key>" \
  --header "CF-Access-Client-Id: <client id>" \
  --header "CF-Access-Client-Secret: <client secret>"
```

(The two `CF-Access-…` lines are only for an agent-pass install; drop them otherwise.)

Then start `claude` and type `/mcp`. You should see `operation-kit` as connected.

### Claude Desktop (Mac or Windows app)

Claude Desktop's **Add custom connector** screen expects a sign-in flow (OAuth). Operation Kit
connects with a key instead, so that screen does not work yet. Use the configuration file:

1. In Claude Desktop open **Settings → Developer → Edit Config**. This opens
   `claude_desktop_config.json`.
2. Add this (you need [Node.js](https://nodejs.org) installed; `mcp-remote` is a small open-source
   bridge that adds the key to each request):

   ```json
   {
     "mcpServers": {
       "operation-kit": {
         "command": "npx",
         "args": ["-y", "mcp-remote", "https://<address>/api/mcp",
                  "--header", "Authorization:${OK_AUTH}",
                  "--header", "CF-Access-Client-Id:${CF_ID}",
                  "--header", "CF-Access-Client-Secret:${CF_SECRET}"],
         "env": { "OK_AUTH": "Bearer <key>",
                  "CF_ID": "<client id>", "CF_SECRET": "<client secret>" }
       }
     }
   }
   ```
   Unless your install uses an agent pass, drop the two `CF-Access-…` header lines and the
   `CF_ID` / `CF_SECRET` values.
3. Save and restart Claude Desktop. Operation Kit's tools appear under the tools icon in a new chat.

### ChatGPT

The ChatGPT app's connector screen also expects a sign-in flow, so use the OpenAI API (your own
scripts, or an internal tool your consultant builds). Add Operation Kit as an MCP tool in the
Responses API:

```json
{
  "model": "gpt-5",
  "input": "What needs my attention on the board?",
  "tools": [{
    "type": "mcp",
    "server_label": "operation_kit",
    "server_url": "https://<address>/api/mcp",
    "headers": {
      "Authorization": "Bearer <key>",
      "CF-Access-Client-Id": "<client id>",
      "CF-Access-Client-Secret": "<client secret>"
    },
    "require_approval": "never"
  }]
}
```

### Grok (xAI API and Grok bots)

```json
{
  "model": "grok-4",
  "input": "What needs my attention on the board?",
  "tools": [{
    "type": "mcp",
    "server_url": "https://<address>/api/mcp",
    "server_label": "operation_kit",
    "authorization": "Bearer <key>",
    "headers": {
      "CF-Access-Client-Id": "<client id>",
      "CF-Access-Client-Secret": "<client secret>"
    }
  }]
}
```

In the xAI Python SDK: `mcp(server_url="https://<address>/api/mcp", server_label="operation_kit",
authorization="Bearer <key>")` — plus the same two `CF-Access-…` headers on an agent-pass install.

### Claude API (your own scripts)

The connector sends only the key and no other headers, so this one needs the built-in key-auth
bypass from Step 0 (it cannot use an agent pass).

```json
{
  "model": "claude-opus-5-5",
  "max_tokens": 16000,
  "mcp_servers": [{
    "type": "url",
    "url": "https://<address>/api/mcp",
    "name": "operation-kit",
    "authorization_token": "<key>"
  }],
  "tools": [{ "type": "mcp_toolset", "mcp_server_name": "operation-kit" }],
  "messages": [{ "role": "user", "content": "Brief me on the board." }]
}
```

This uses the Messages API MCP connector (beta header `anthropic-beta: mcp-client-2025-11-20`).

### Codex CLI (OpenAI)

In `~/.codex/config.toml`:

```toml
[mcp_servers.operation-kit]
url = "https://<address>/api/mcp"
bearer_token_env_var = "OPERATION_KIT_KEY"
# Agent-pass installs only:
env_http_headers = { "CF-Access-Client-Id" = "OK_CF_ID", "CF-Access-Client-Secret" = "OK_CF_SECRET" }
```

Then set `OPERATION_KIT_KEY` (and, on an agent-pass install, `OK_CF_ID` / `OK_CF_SECRET`) in the terminal
where you run `codex`.

### Cursor, Windsurf and other MCP apps

Any app that can add a "remote", "HTTP" or "streamable HTTP" MCP server works. Give it:

| Setting | Value |
|---|---|
| URL | `https://<address>/api/mcp` |
| Header | `Authorization: Bearer <key>` |
| Agent-pass installs only | `CF-Access-Client-Id: <client id>` and `CF-Access-Client-Secret: <client secret>` |

For example, Cursor's `.cursor/mcp.json`:

```json
{ "mcpServers": { "operation-kit": { "url": "https://<address>/api/mcp",
  "headers": { "Authorization": "Bearer <key>",
    "CF-Access-Client-Id": "<client id>", "CF-Access-Client-Secret": "<client secret>" } } } }
```

If the app only offers OAuth sign-in and no header setting, use the `mcp-remote` bridge shown under
Claude Desktop.

## Step 3: Check it works

Ask the AI:

> *"Using Operation Kit, list my chat agents."*

It should answer with the agents on your install (for example *Personal assistant*, *Knowledge librarian*, *Operator*).
Then try:

> *"Act as my Personal assistant from Operation Kit. What does my knowledge base say about our
> cancellation policy?"*
>
> *"Create an Operation Kit card: draft a one-page price sheet from the knowledge base."*

The card appears on your board, labelled with the key's name, so you always know which AI made it.

## What the AI can do once connected

| You ask for… | Tool the AI uses | Key needs |
|---|---|---|
| Your agents and their instructions | `list_chat_agents`, `get_chat_agent` | any key |
| Something from your notes | `search`, `read_file`, `list_folders` | `vault:read` |
| A saved or updated note | `write_doc` | `vault:write` |
| What needs your attention | `get_attention`, `get_changes` | `board:read` |
| A job handed to the board | `create_objective` | `board:write` |
| How a job is going, and its result | `get_objective`, `get_progress`, `get_output` | `board:read` |
| A message to a running job | `send_message` | `board:write` |

There is no tool to merge code, deploy, delete files or read secret values. Every tool call is
checked against the key's ticks and workspaces on the server, whatever the AI app asks for.

More detail, including the full tool list: [Use your agents from Claude, ChatGPT or
Grok](./product/10-agents-from-other-ai.md) and the [Agent API reference](./api/README.md#mcp-server).

## If something goes wrong

| What you see | What to do |
|---|---|
| `401` or "unauthorized" | The key is wrong, revoked, or missing `Bearer ` in front of it. Make a new key. |
| `403` with `missing_scope` | The key lacks a tick. The error names it (for example `board:write`). Make a new key with it. |
| `403` with `workspace` | The key is not allowed in that workspace. |
| The app's "add connector" screen fails | It needs OAuth. Use the configuration-file method or the `mcp-remote` bridge above. |
| A Cloudflare sign-in page, a redirect, or HTML instead of a reply | Cloudflare Access stopped the request. Do Step 0, or check the two `CF-Access-…` headers are spelled exactly. |
| Tools appear but every write fails | The key is the older full-access **API key**, which is read-only over MCP. Use an **agent key**. |

## Good habits

- One key per app and per person. If a laptop is lost, revoke just that key (Settings → You →
  Agent keys → **Revoke**). Other keys keep working.
- Check **Last used** on the key list now and then. Revoke keys nobody uses.
- Chat history stays in the AI app you used. Only Operation Kit's built-in **Chat** keeps
  conversations on your own server.
