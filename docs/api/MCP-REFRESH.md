# MCP refresh runbook: seeing new tool schemas after a release

MCP clients read `tools/list` when they connect and usually keep that answer. After a release
adds or changes a tool field (for example `owner_bot` on `create_objective` / `update_objective`,
obj 900270 / PR #649), a client that is still connected keeps showing the **old** schema until it
reconnects. Only refresh or restart a client **after an approved release is live**. Refreshing
before that changes nothing, and restarting a shared connector mid-release interrupts every bot on it.

## 1. Is the install actually on the release?

A client can only show what the server it talks to serves. Check that server first (no key needed):

```bash
BASE=https://<your install>            # the host your MCP connector points at
curl -s "$BASE/api/health"             # newer builds include "commit"; compare with the release
curl -s "$BASE/api/openapi.json" | grep -o owner_bot | wc -l   # 0 = this install predates #649
```

If `owner_bot` is missing here, the install has not been updated. Reconnecting the client will not
help. The fix is an approved update of **that** install (`install/update.sh` or the operator's
deploy), not a client change.

## 2. What does the server's `tools/list` say?

Ask the MCP endpoint directly with the same key the connector uses. Read the key from where your
connector keeps it; never paste it into a card or chat.

```bash
curl -s -X POST "$BASE/api/mcp" \
  -H "Authorization: Bearer $CC_TOKEN" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' |
  jq '.result.tools[] | select(.name=="create_objective" or .name=="update_objective")
      | {name, owner_bot: .inputSchema.properties.owner_bot.description}'
```

Expected after #649 plus this docs PR: both tools are listed, and `owner_bot` starts with
`Optional. Set to your own exact Grok bot name`. `null` there means the key cannot see the tool
(it lacks `board:write`) or the install predates the release. The server-side version of this
check is the test `tools/list: create_objective AND update_objective expose optional owner_bot…`
in `app/server/src/routes/agent-mcp.test.ts`.

## 3. Refresh the client

| Client | How to refresh |
| --- | --- |
| Claude Code | `/mcp` → the server → Reconnect (or restart the session) |
| Claude Desktop / any `mcp-remote` stdio bridge | Fully quit and reopen the app. The bridge is a child process that only re-lists tools when it starts |
| Grok Bot custom connector | Remove and re-add the connector, or toggle it off and on, so the tool list is fetched again |
| xAI API / Responses API remote MCP | Nothing to do. Each request lists tools again |

Then run the check from step 2 **through the client** (ask it to show the `create_objective`
schema) and compare it with the server's answer.

## 4. Still stale after a reconnect? Check the boundary

A **stdio** connector (a local process the client launches, such as `mcp-remote` or a wrapper
script) is **not part of this repo**. This repo only controls the server side: `POST /api/mcp`
in `app/server/src/routes/agent-mcp.ts`. The stdio side lives in the client host's MCP config.
If a stdio connector still shows the old schema after a full restart, it is either:

1. **Pointing at an install that is not on the release.** Find the URL in the connector's
   config and run step 1 against that host. For example, on 2026-11-07, `https://cc.example.com`
   served an OpenAPI with no `owner_bot`, `needs_agent` or `duplicate_24h`, and `/api/health` had no
   `commit` field. That means it was on a build from before 2026-11-01, even though another install
   was already on #649. Fixing this means an **approved** update of that install, or an approved
   change to the URL the connector points at.
2. **A wrapper with its own copy of the tool list.** Some wrappers ship their own copy of the tool
   list instead of proxying `tools/list`. That copy has to be updated where it is installed.
   Count the tools to tell the two apart: the server lists 34 tools for a full-scope key. A
   wrapper with its own list drifts from the server whenever a release changes a schema.

Changing a shared connector's config, URL or key is an install change. It needs the owner's
approval, the same as a deploy. A worker card documents it and stops there.

## Until the client is refreshed

REST always reflects the running server: `POST /api/objectives {"owner_bot": "<your exact Grok
bot name>"}` or `PUT /api/objectives/{id} {"owner_bot": …}`. Use it for anything the cached MCP
schema cannot express yet.
