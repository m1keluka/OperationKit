# API & MCP / Secrets cleanup (obj 900681)

Source: Operator's *Operation Kit Feedback* walkthrough, 7:21–8:36
(https://supercut.ai/share/operator/zGQMHobrhxbzxMcfCw5jGt):

> "Agent Webhooks, good. Yep, and then remove the GitHub and Google Workspace from here. … I don't
> really know the My Secrets. I feel like My Secrets go within Secrets, TBH, but I'm not sure. What do
> you think works? And then this should have really simple LLM copy-paste to get set up … like
> getleaves.io … you go in and there's just this copy-paste in Claude Code."

Follows the sprint 4b reorg (obj 900496, [SPRINT-4B-REORG.md](./SPRINT-4B-REORG.md)).

## What changed

| Where | Before | After |
|---|---|---|
| Settings → API & MCP | "GitHub and Google Workspace" pointer card + "Open Integrations" link | Removed. GitHub and Google Workspace stay where they actually work: **Settings → Integrations**, which is the next tab over. Connector logic is untouched. |
| Settings → API & MCP | "My Secrets" card at the bottom | Moved to **Settings → Secrets → Mine**. Same component, same `/api/secrets?scopeType=user` calls. |
| Settings → API & MCP | Setup prompt buried at the bottom of the API docs card | New **Connect a coding agent** card at the top: pick Claude Code / Cursor / Codex / Other, press **Copy prompt**, paste into the agent. |
| Settings → Secrets | Admin-only tab, sub-tabs Keys / Test credentials | Everyone gets the tab. Admins: **Shared / Mine / Test credentials** (land on Shared). Members: just **Mine**. `?view=mine\|shared\|test` deep-links a sub-tab. |

## Recommended structure (the "what do you think works?" answer)

**One Secrets tab, split by who owns the secret.** API & MCP is about *reaching the board from outside*
(keys, MCP, webhooks). A personal secret is something the board *uses* — the same kind of thing as an
organization secret, just with a narrower owner. Splitting secrets across two tabs made people check
two places for the same answer, and made API & MCP look like a junk drawer.

```
Settings
├─ API & MCP        how outside agents reach the board
│   ├─ Connect a coding agent   (copy-paste prompt)
│   ├─ API key                  (full access, acts as you)
│   ├─ Agent keys               (MCP, scoped per agent)
│   ├─ Agent webhooks
│   └─ API docs                 (OpenAPI, MCP JSON, curl)
├─ Integrations     accounts agents work IN (GitHub, Google Workspace, MCP servers, …)
└─ Secrets          values agents USE
    ├─ Shared            organization + Command Center + per-user rows (admins)
    ├─ Mine              your own secrets (everyone)
    └─ Test credentials  reviewer login bundles (admins)
```

Why sub-tabs and not one merged table: the Shared table is the cross-scope admin store (all orgs, all
users, move/rollback/history). Dropping a member into that UI would show them filters and scopes they
cannot use. "Mine" stays the simple add/edit/delete list it already was. Admins still see their own
user-scoped rows inside Shared too, because Shared is the everything-view.

Gate unchanged: who may see Shared / Test credentials is the same rule that used to gate the whole tab
(global admin, or admin of any workspace) — now `canManageSharedSecrets()` in `app/client/src/lib/secretsAccess.ts`.
The server enforces scope on every `/api/secrets` call regardless.

## The coding-agent setup prompt

Modelled on getleaves.io's integrations page: two steps on screen (make an agent key, copy one prompt),
and the agent does the config editing. The prompt:

1. checks `CC_AGENT_KEY` is set **without printing it**, and if not, sends you to Agent keys — it never
   asks you to paste the key into chat, and the key value is never in the prompt;
2. installs the server in the agent's own format —
   `claude mcp add --transport http --scope user command-center <host>/api/mcp --header "Authorization: Bearer $CC_AGENT_KEY"`
   for Claude Code, `~/.cursor/mcp.json` (`${env:CC_AGENT_KEY}`) for Cursor,
   `~/.codex/config.toml` (`bearer_token_env_var`) for Codex, and a plain spec + `mcp-remote` bridge
   for anything else;
3. verifies by calling `whoami`, then `get_attention`.

`/api/mcp` speaks Streamable HTTP (stateless JSON), so the HTTP transport works directly; no bridge
needed for the three named clients.

## Not done here (Integrations feedback, 8:36–9:48)

Operator's Integrations ideas — show only connected integrations, a **New Integration** button that browses
setup guides, and an "integrations bot" that builds a custom integration from API docs — are a separate
piece of work and are not in this PR.
