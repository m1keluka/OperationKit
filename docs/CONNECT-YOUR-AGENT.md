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

## Step 0 (administrator, once per install): let AI apps through the Cloudflare door

On a standard install, Cloudflare Access sits in front of the **whole** site. That is what keeps
strangers out, but it also stops an AI app: the app gets Cloudflare's sign-in page instead of an
answer. Pick one of these two ways to let AI apps reach `/api/mcp`. Both keep the agent key as the
lock on what the AI can do.

**Option A: an agent pass (recommended; the door stays shut to everyone else).**
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
xAI (Grok) API, Codex, Cursor and any app that lets you set extra headers. It does **not** work
with the "add connector" screens in the claude.ai, ChatGPT and Grok apps (they only offer a
sign-in flow), or with the Claude API's MCP connector (see Option B).

**Option B: open just the MCP address (for apps that can send only one key).**
The Claude API's MCP connector sends only the key and no other headers, so it cannot pass Option
A's headers.

1. **Zero Trust → Access → Applications → Add an application → Self-hosted.** Name it
   `Operation Kit MCP`, domain = your Operation Kit address, **path = `api/mcp`**.
2. Add a policy with action **Bypass**, include **Everyone**. Save.

Cloudflare then lets requests to `/api/mcp` straight through, and Operation Kit's agent key is the
only check on that one address. The rest of the site stays behind the Cloudflare sign-in. Anyone
on the internet can now *reach* `/api/mcp`, but without a valid key they get `401`.

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
Lines marked *Option A* are only needed if your administrator chose Option A in Step 0; leave them
out for Option B.

### Claude Code (terminal)

```bash
claude mcp add --transport http operation-kit https://<address>/api/mcp \
  --header "Authorization: Bearer <key>" \
  --header "CF-Access-Client-Id: <client id>" \
  --header "CF-Access-Client-Secret: <client secret>"
```

(The two `CF-Access-…` lines are *Option A*.)

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
   For *Option B*, drop the two `CF-Access-…` header lines and the `CF_ID` / `CF_SECRET` values.
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
authorization="Bearer <key>", extra_headers={...})` with the same two *Option A* headers.

### Claude API (your own scripts)

Needs *Option B* in Step 0 (the connector sends only the key).

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
# Option A only:
env_http_headers = { "CF-Access-Client-Id" = "OK_CF_ID", "CF-Access-Client-Secret" = "OK_CF_SECRET" }
```

Then set `OPERATION_KIT_KEY` (and, for Option A, `OK_CF_ID` / `OK_CF_SECRET`) in the terminal
where you run `codex`.

### Cursor, Windsurf and other MCP apps

Any app that can add a "remote", "HTTP" or "streamable HTTP" MCP server works. Give it:

| Setting | Value |
|---|---|
| URL | `https://<address>/api/mcp` |
| Header | `Authorization: Bearer <key>` |
| Option A headers | `CF-Access-Client-Id: <client id>` and `CF-Access-Client-Secret: <client secret>` |

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
