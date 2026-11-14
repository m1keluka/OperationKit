# Bot workspace access

Bots are **global**. A bot is defined once for the whole install (its agent file)
and is never created inside a workspace. What is set per bot is **where it may
work**: each bot has a list of the workspaces it may read, write and be woken in.
An admin grants and revokes those workspaces on the bot's settings panel
(**Bots → a bot → Settings → Workspace access**).

## What the list controls

| Surface | With the list |
|---|---|
| Board reads in chat (`list_objectives`, `get_objective`, `board_briefing`, card chips) | Only cards in granted workspaces. Still never more than the person chatting can see. |
| Filing cards from chat (`create_objective`) | The chat's workspace is the person's first workspace that the bot is granted. An optional `workspace` argument must be a workspace the person belongs to **and** the bot is granted. |
| Knowledge base (`search`, `list_folders`, `read_file`, `write_doc`, `file_answer`) | A note inside a workspace the bot is not granted is refused, whatever the bot's `knowledge_folders` say. Shared notes that sit in no workspace are still governed by `knowledge_folders`. Containment is realpath + path-segment based, so `..` and symlinks do not get around it. |
| Secrets broker and workspace MCP servers in chat | Only for the chat's workspace, which is always a granted one. No granted workspace means no secrets and no MCP tools. |
| High Agency wakes | The wake workspace must be granted. Revoking it switches High Agency off and disables the wake routine. A wake that still points at a revoked workspace is refused when it fires (`bot workspace guard: …`, neutral for auto-pause). |
| Cards a High Agency wake files (`POST /api/internal/objectives` with `source_job_id` or `parent_id` = the wake card) | Must land in a granted workspace, else `403`. |

Everything above is **person ∩ bot**: a workspace counts only if the bot is granted it AND the person chatting can reach it (admins reach every workspace). That includes the knowledge-base wall and the workspace names the bot is told about in its system prompt.

Workspace access grants **nothing else**: no new tools, no connector, no secret,
and no right to send, merge or deploy. Those stay where they were.

## The three states

- **Restricted.** The bot may use exactly the granted workspaces. An empty list
  means no workspace at all: the bot can still chat, but board, knowledge-base,
  secrets and MCP tools refuse and High Agency cannot wake.
- **Not restricted yet.** Written only once, by the first boot with this
  feature, for every bot that already existed. Those bots keep their earlier
  behaviour (bounded by the person chatting with them) so nothing breaks on
  upgrade. No workspace is granted for them; the panel flags them in amber.
  Granting the first workspace restricts the bot to its list. There is no way
  back to "not restricted": tightening is one-way.
- **No decision (a bot added later).** A new agent file or template install has
  no row and is treated as restricted with an empty list: **fail-closed** until
  an admin grants a workspace.
- **Deleted bot.** Deleting a bot from the Bots sidebar (obj 900798) also drops
  its access row and grants. If the folder is moved back, or a new bot reuses the
  slug, it starts in "no decision" (fail-closed) rather than inheriting the old
  list or "not restricted".

## Known limits

- The wake-card gate on `POST /api/internal/objectives` relies on the card naming its wake (`source_job_id` / `parent_id`). That route has no caller identity, so like every internal write this holds on the honest path. The wake brief always sends `source_job_id`. Real enforcement needs a per-session principal on internal writes.
- A revoke stops FUTURE wakes. A wake card already queued or running in the revoked workspace keeps its session token for that workspace until it ends; cancel it from the board if needed.
- Cards with `agent_context = <bot slug>` created outside High Agency are not gated: that namespace is shared with the session-worker roster (e.g. `general`).
- An unrestricted bot keeps filing only in the chat workspace (the new `workspace` argument does not widen it).

## API

All under `/api/agent-chat`. Changes need a signed-in admin (browser session);
an API key, including a bot's own, gets `403`.

```
GET    /agents/:slug/workspaces              access (+ workspace_options for admins)
PUT    /agents/:slug/workspaces              {"workspaces": ["ops", "sales"]}   set the whole list
POST   /agents/:slug/workspaces              {"workspace": "ops"}               grant one
DELETE /agents/:slug/workspaces/:workspace                                       revoke one
```

`GET /agents` carries `workspace_access: {mode, workspaces, count}` per bot. A
member only sees the names of workspaces they belong to. Every grant, revoke and
set is written to the activity log (`metadata.kind` = `bot_workspace_granted`,
`bot_workspace_revoked`, `bot_workspace_set`).

## Not the same as bot access levels

This is a **workspace membership list** for a bot: *which* workspaces it may
touch. It is not the planned per-bot access **levels** (none / view / chat /
manage), which describe *how much* a person may do with a bot. The two are
independent.

## Code

- `app/server/src/services/agent-chat/bot-workspaces.ts`: the list, grant/revoke, the one-time seed, the wake fire guard
- `app/server/src/services/agent-chat/tools.ts`: board allowlist (`boardUser`), KB wall (`kbWorkspaceGuard`), card workspace
- `app/server/src/services/agent-chat/engine.ts`: `workspaceFor(user, bot)`
- `app/server/src/services/agent-chat/high-agency.ts`: granted-only wake workspace, `reconcileHighAgencyAccess`
- `app/client/src/components/agent-chat/WorkspaceAccessSection.tsx`: the panel
