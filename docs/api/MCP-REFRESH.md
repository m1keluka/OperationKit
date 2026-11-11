# MCP refresh runbook: seeing new tool schemas after a release

MCP clients read `tools/list` when they connect and usually keep that answer. After a release
adds or changes a tool field (for example `owner_bot` on `create_objective` / `update_objective`,
obj 900270 / PR #649), a client that is still connected keeps showing the **old** schema until it
reconnects. Only refresh or restart a client **after an approved release is live**. Refreshing
before that changes nothing, and restarting a shared connector mid-release interrupts every bot on it.

## 1. Is the install actually on the release?

A client can only show what the server it talks to serves. Check that server first (no key needed):

```bash
BASE=https://<your-install-host>      # the host your MCP connector points at
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
in `app/server/src/routes/agent-mcp.ts`. No tracked repo ships a stdio adapter, proxy package or
static tool manifest for it. The stdio side is whatever package the client host's MCP config
launches.

### 4a. Descriptors stale, but data calls return the new field: the wrapper serves static descriptors

The signature is: after a **full** client restart, the client's `create_objective` /
`update_objective` descriptors still have no `owner_bot` (and the `update_objective` description
still lists only title, description, completion goal, agent, project, model and effort), **but**
data calls through the same connector already return the new field. For example,
`get_objective` comes back with `"owner_bot": null` and today's cards. The data comes from the
current server, so the server is fine. The descriptors do not come from that server's
`tools/list`. The wrapper (or adapter) ships or caches its own copy of the tool list instead of
passing `tools/list` through.

Check it like this:

1. Run the server's `tools/list` yourself with **your own** agent key (step 2 above), and save
   the `create_objective` and `update_objective` entries.
2. Ask the client to show its `create_objective` and `update_objective` descriptors (or read them
   from its tool-list UI), and compare.
   - The server has `owner_bot` and the client doesn't: the wrapper is serving static
     descriptors. Restarting will never fix it.
   - Both lack it: the server you queried predates the release. Go back to step 1.
3. Fix it through the wrapper's **supported** path: upgrade or reinstall the wrapper package to a
   version that passes `tools/list` through (or that has the current descriptors), then do a full
   client restart and repeat step 2. If the wrapper can't pass `tools/list` through, swap it for a
   pass-through bridge such as `mcp-remote` pointed at `https://<your-install-host>/api/mcp`.

To decide which of these applies to a specific connector, you need its **non-secret** metadata:
the wrapper's package name and version, and its launch command with the key redacted. Only the
connector's owner can supply that. Don't go looking for it by reading other processes'
environments or the connector's secret config.

### 4b. Both server and client lack the field

The install the connector talks to is not on the release. Fixing that means an **approved** update
of that install, or an approved change to the URL the connector points at.

Changing a shared connector's config, URL, key or wrapper package is an install change. It needs
the owner's approval, the same as a deploy. A worker card documents it and stops there.

## Until the client is refreshed

REST always reflects the running server: `POST /api/objectives {"owner_bot": "<your exact Grok
bot name>"}` or `PUT /api/objectives/{id} {"owner_bot": …}`. Use it for anything the cached MCP
schema cannot express yet.
