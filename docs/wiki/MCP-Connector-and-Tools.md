# MCP Connector & Tools

OperationKit exposes its board and knowledge base over [MCP](https://modelcontextprotocol.io) (Model Context Protocol), so any MCP-capable agent — a Grok Bot, a Claude Project, a custom assistant you run elsewhere — reads the same live data OperationKit itself reads, with no copy, no export, and no separate sync job to maintain.

This is the concrete form of the "bring your own agent" claim (see [Why Own Your AI Infrastructure](./Why-Own-Your-AI-Infrastructure)): the knowledge base and board don't live inside one vendor's product, so any agent that speaks MCP can read them directly, over your own server, under your own API key.

## What it is

A single MCP server at `POST /api/mcp` on your OperationKit instance: knowledge base **and** board, one connector.
Every call authenticates with a `cc_live_…` key. Use a **named agent key** (Settings → You → Agent keys), one per
agent. Its scopes and workspace allowlist bind every tool exactly as they bind the REST API, because each tool call
is re-issued to the REST route it wraps with the same key. On the legacy full-access key the connector is
read-only. Write tools need a named key, so one connector shared by several agents can't hand all of them full
access.

## Tools exposed

| Tool | What it does | Scope |
| --- | --- | --- |
| `search` | Search the knowledge base for a topic | vault:read |
| `search_files` | Search non-markdown files (PDFs, slides, images, etc.) | vault:read |
| `list_folders` | Browse the knowledge base (one tree, no source to pick) | vault:read |
| `read_file` | Read one file's contents | vault:read |
| `file_info` | Size / type / dates of one file without downloading it | vault:read |
| `write_doc` | Create or overwrite one markdown file in the vault | vault:write |
| `get_card` / `get_objective` | Read a single board card (objective) by ID | board:read |
| `search_cards` / `search_objectives` | Search board cards, including finished ones | board:read |
| `whoami` | The key's label, scopes and workspaces | any |
| `get_attention` · `get_changes` · `board_briefing` | What needs a decision · what moved since the last poll · wider snapshot | board:read |
| `get_seat_pool` | Which subscription seats can take work now and when the next one resets (no secrets) — see [Accounts, Subscriptions & Seats](./Accounts-Subscriptions-and-Seats) | board:read |
| `list_objectives` · `get_progress` · `get_output` · `get_artifacts` | List cards · how a running card is going · its thread · its deliverables | board:read |
| `list_workspaces` · `list_agents` | Valid workspace slugs and agent slugs | board:read |
| `create_objective` | Create a card in an explicit workspace (optionally start it) | board:write (+ board:start) |
| `update_objective` | Edit a card's title / brief / goal | board:write |
| `start_objective` | Start or restart a card's session | board:start |
| `update_status` | Park, cancel (board:cancel) or sign off (board:done) a card | per status |
| `send_message` · `stop_objective` | Follow up in a card's thread · stop a stuck worker | board:write |

There is no merge, deploy, delete, secrets or admin tool, and no scope unlocks one. An agent only sees the tools
its key's scopes allow. Every write answers with a one-line confirmation plus the card's id and link.

## Adding the connector

1. In your MCP-capable agent's connector/tool settings, add a custom MCP connector:
   - **URL:** `https://<your-domain>/api/mcp`
   - **Header:** `Authorization: Bearer <your cc_live_… key>`
2. Save, then open a fresh chat/session with that agent and ask what MCP tools it has — it should list the tools above that its key's scopes allow.
3. Smoke-test with a real query: ask it to search the vault for something you know is there, or get a real card by ID.

If the agent reports zero tools from the connector, the most common cause is the custom `Authorization` header not saving, or the agent not being reopened in a fresh session after the connector was added. If a call 403s, the key's workspace scope doesn't include the content being asked for — that's the connector correctly inheriting the same scoping the REST API would enforce, not a bug.

**Never share one key across two agents or paste a key into an agent's instruction text** — each key already carries its own workspace scope, and a leaked key is a workspace-wide read exposure until it's revoked.

## What this is not

- **Not a copy.** Every call hits the live server over HTTPS at request time — no sync job, no cache, no staleness window beyond normal request latency.
- **Not system files or secrets.** File reads are scoped to the same knowledge-base/upload roots the REST file-search API uses — credential files, `.env`, `.git`, and database files are blocked at that layer, and no secret value is ever returned through this connector.
- **Not the whole API surface.** Admin, secrets, shell, and deploy endpoints are out of scope for both this connector and the REST agent API — see [External Agents](./External-Agents).
- **Not a way around the human sign-off.** Marking a card done needs the `board:done` scope, which agent keys don't get by default.

## Where to go next

- [Knowledge Base & Context Loading](./Knowledge-Base-and-Context-Loading) — what's actually in the vault this connector reads
- [External Agents](./External-Agents) — the read/write REST surface for board management
- [Accounts, Subscriptions & Seats](./Accounts-Subscriptions-and-Seats) — how the API key used here relates to seat pooling (it doesn't — keys are per-person/per-agent, seats are the model-routing layer)
