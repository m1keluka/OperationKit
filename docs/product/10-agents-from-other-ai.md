# Use your agents from Claude, ChatGPT or Grok

**In a sentence:** The built-in [Agent chat](./09-agent-chat.md) is optional — the same agents, the same knowledge base and the same board are reachable from the AI app you already use, through one **MCP connection**.

MCP is the standard way AI apps plug into other tools. Operation Kit runs one MCP server at:

```
https://<your Operation Kit address>/api/mcp
```

Everything goes through that one address: notes, board cards, and the agents themselves.

---

## 1. Make a key for the AI app

Settings → **You** → **Agent keys** → *New agent key*.

- Give it a name you will recognise, e.g. `Claude: Jordan` or `Grok: Office`.
- Tick what it may do. For working with agents and notes: **vault:read** (and **vault:write** if it should save notes). For handing jobs to the board: **board:read** and **board:write**.
- Pick which workspace(s) it may touch.
- Copy the key (it starts with `cc_live_`). It is shown once. Treat it like a password: paste it only into the AI app's connector settings, never into a chat.

Each key only sees the tools its ticks allow, and every card it creates is labelled with the key's name.

## 2. Connect the AI app

| App | How |
|---|---|
| **Claude Code** | `claude mcp add --transport http operation-kit https://<address>/api/mcp --header "Authorization: Bearer <key>"` |
| **Claude API** (your own scripts) | Add the address as an MCP server with the key as its authorization token — example in [the Agent API guide](../api/README.md#claude). |
| **Grok** (xAI API and Grok bots) | Add a remote MCP tool with the address and `Bearer <key>` — example in [the Agent API guide](../api/README.md#xai-api-grok--remote-mcp-tool). |
| **ChatGPT / OpenAI API** | In the Responses API, add a tool `{"type": "mcp", "server_url": "https://<address>/api/mcp", "headers": {"Authorization": "Bearer <key>"}}`. |
| **Claude, ChatGPT and Grok phone/desktop apps** | Their "add a connector" screens currently expect a sign-in flow (OAuth). Operation Kit connects with a key instead, so use one of the routes above, or ask your consultant to set it up. |

## 3. Use an agent

Ask the AI app something like:

> *"List my Operation Kit chat agents, then act as the Personal assistant."*

Behind the scenes it uses two tools:

| Tool | What it gives the AI |
|---|---|
| `list_chat_agents` | Every agent on your install: name, what it is for, its knowledge folders and tools. |
| `get_chat_agent` | One agent's full instructions, so the AI can follow them. |

From there the AI works with the same pieces the built-in chat uses:

| What you want | Tool the AI uses |
|---|---|
| Find something in your notes | `search`, then `read_file` |
| Look around the knowledge base | `list_folders` |
| Save or update a note | `write_doc` (needs **vault:write**) |
| Hand a bigger job to the board | `create_objective` (needs **board:write**) |
| Check on a job | `get_objective`, `get_progress` |

So a question asked in Claude, a request typed into Grok and a message in the built-in chat all end up in the same notes and the same board.

## What is different from the built-in chat

- **Your chat history stays in the AI app you used**, not on your Operation Kit server. Only the built-in chat stores conversations on your own server.
- **Email and calendar drafts** (with the Send button) exist only in the built-in chat. An outside AI app uses its own email/calendar connectors, under its own rules.
- **Knowledge folders are followed, not forced.** In the built-in chat the server blocks any note outside the agent's folders. An outside AI reads the agent's folders from `get_chat_agent` and is told to stay inside them, but the hard limit is the key: give each AI app a key limited to the workspace it needs.
- **Which AI answers** is whatever app you are using.

## Good practice

- One key per AI app (and per person), named clearly. You can revoke a key at any time in Settings → You → Agent keys.
- Give a key only the ticks it needs. A key without **board:write** cannot create cards; a key without **vault:write** cannot change notes.
- Never paste a key into a chat message.
