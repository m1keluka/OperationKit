# Trial Bots roster: General, CFO, CTO (your-org) — obj 900371

**Status: drafted and validated, NOT yet installed on the live roster.** This
folder is the deliverable for obj 900371 (Mike-approved trial, pt460u
10:07AM ET Nov 9 2026): register three trial chat bots — General, CFO,
CTO — on the live Bots roster, scoped to the **your-org** workspace only.

## What's here

| File | Purpose |
|---|---|
| `your-org-general.agent.yaml` | Fresh bot file — coordination/routing, read + write KB, no board cards |
| `your-org-cfo.agent.yaml` | Fresh bot file — read-only finance KB, no write, no board, no connectors |
| `your-org-cto.agent.yaml` | Fresh bot file — board ops/PR triage/CI, files cards, no merge/deploy |

Each is a standard [agent file](../agent-file-format.md) ready to import as-is.
All three were validated against the real `parseAgentFile` schema logic
(`app/server/src/services/agent-file.ts`) with **zero errors, zero warnings**
(see "Evidence" below) — the only edit needed before import is none.

## Why the slugs are `your-org-*`, not bare `general` / `cfo` / `cto`

This is the one finding worth reading before importing anything.

The chat-"Bots" feature and the **session-worker executive roster** (the
personas assigned to board cards — `cto`, `cmo`, `coo`, `cfo`, `general`, …,
and the operator's full private roster in a gitignored `seed.agents.json`)
**share one registry table**: `agents` (`app/server/src/db/schema/agents.ts`).
`installAgentDef` (`app/server/src/services/agent-templates.ts`) writes a chat
bot's slug into that SAME table via `createAgent(...)` / `updateAgent(...)`.

`cfo` and `cto` are in `DEFAULT_AGENT_SEED` on every install, and
`general` is one of Mike's own existing private-roster slugs (per
second-brain decision `2026-09-03-oss-agent-roster-blank-slate.md`). Importing
a chat-bot agent file with slug `cto` would therefore either:

- **409 "already exists"** on a plain import (safe, but blocks installation), or
- **silently overwrite** the live session-worker registry row for `cto` — label,
  badge, `workdir_kind`, `kind` — if `overwrite: true` is passed. That row is
  what `defaultAgentForWorkspace()` and every "assign to CTO" card action use
  for routing, across **every** workspace, not just your-org. This is the
  same class of incident as the obj-1150 `index.ts` crash-loop in `CLAUDE.md`
  — one shared identity used for two different things.

So these three files use **namespaced slugs** (`your-org-general`,
`your-org-cfo`, `your-org-cto`) that cannot collide with the executive
roster. A matching registry change ships in this PR (see below) so the
`General` / `CFO` / `CTO` BOT **identities** (`owner_bot` on a filed
card, ceiling/idempotency/dup-guard enforcement) resolve correctly for the new
slugs too — see `app/server/src/services/bots/bot-registry.ts`.

## Known limitation: board-card workspace is the CHATTING PERSON's, not the bot's

`create_objective` (used by the CTO bot to file cards) files the card into
`workspaceFor(userId)` — the chatting person's own first/default workspace
membership (`app/server/src/services/agent-chat/engine.ts`) — **not** a
workspace pinned to the bot. An `admin` role additionally bypasses the
workspace-membership check in `personMayUseWorkspace`
(`bot-authorization.ts`), so a card would still be "authorized" even if it
landed outside your-org.

**This trial cannot fully close that gap without a deeper `engine.ts` change**
(binding a workspace to the bot identity, not the chatting user), which is out
of scope for a config-only registration. Mitigation shipped instead:

- `knowledge_folders: [workspaces/your-org]` on all three files is a HARD
  boundary (enforced by path-containment checks) — none of the three bots can
  read or write another workspace's knowledge base, full stop.
- The CTO bot is the only one of the three given `create_objective` (per
  Mike's brief: "files cards, NO merges/deploys"); General and CFO have
  no board-write tool at all, so this gap only applies to one bot.
- **Before trusting the CTO bot's filed cards**, confirm the acting person's
  own first/default workspace membership is `your-org` (or just check the
  `workspace` column on cards it files for the first few uses). Flagging this
  as a fast-follow is the honest answer; silently claiming the gap is closed
  would not be.

## What this PR does NOT do

- Does not install the bots on the live roster. Installing requires either the
  admin UI (Bots → Templates → Import, which this trial does not have a
  credential/session for) or `POST /api/internal/agent-templates/import`
  (localhost + `X-Internal-Secret`, gated on `INTERNAL_API_SECRET` — **not** in
  this session's secret set, and deliberately so: it also gates
  deploy/restart/routines-CRUD). No code change is needed for the config part;
  only the **registry collision fix** above is a code change, and it is
  additive-only (a 409 that already exists stays correct for every other slug;
  two brand-new registry entries; one existing bot gains a second
  already-namespaced `agent_slugs` entry).
- Does not touch the operationkit workspace or any other client.
- Does not grant email/calendar/send, custom model/provider, custom budget, or
  merge/deploy rights to any of the three bots. There is no merge/deploy TOOL
  in the chat-agent tool set at all (`KNOWN_AGENT_TOOLS` has no such name), so
  "no merges/deploys" is structurally true regardless of which tools are
  listed.

## To actually install these three bots (run by someone who holds `INTERNAL_API_SECRET`)

From the live install (localhost to the Command Center server), once this PR
is merged and deployed:

```bash
SECRET="$INTERNAL_API_SECRET"   # from Settings → Secrets / env, not this trial's session

for f in your-org-general your-org-cfo your-org-cto; do
  curl -s -X POST http://localhost:3002/api/internal/agent-templates/import \
    -H "X-Internal-Secret: $SECRET" \
    -H 'Content-Type: application/json' \
    -d "$(node -e "const fs=require('fs');process.stdout.write(JSON.stringify({content:fs.readFileSync('docs/bots/trial-your-org/${f}.agent.yaml','utf8'),filename:'${f}.agent.yaml'}))")"
  echo
done

# Confirm all three are on the roster:
curl -s http://localhost:3002/api/internal/agent-templates -H "X-Internal-Secret: $SECRET" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).installed.map(a=>a.slug)'
```

Then verify in the UI (Bots screen) that `your-org-general`,
`your-org-cfo` and `your-org-cto` each appear, and send one test message
to each in its own thread to confirm it answers (per the completion goal's
"answers one chat test in its own thread" requirement). That verification step
could not be completed from this sandboxed session — it has no reachable admin
UI session, no Playwright (plain worker sessions don't get it — only
reviewer/design-arena sessions do, per `CLAUDE.md`), and no
`INTERNAL_API_SECRET` to use the internal API directly.

## Evidence

Local schema validation (real `parseAgentFile` logic from
`app/server/src/services/agent-file.ts`, run against a standalone copy with
only the DB-backed secret-scan sub-check stubbed out — the rest of the
validator, including the slug/tools/knowledge_folders/system_prompt checks, is
untouched):

```
--- your-org-general.agent.yaml ---
{ "ok": true, "errors": [], "warnings": [] }
--- your-org-cfo.agent.yaml ---
{ "ok": true, "errors": [], "warnings": [] }
--- your-org-cto.agent.yaml ---
{ "ok": true, "errors": [], "warnings": [] }

ALL THREE FILES VALID
```

Secret-likeness was checked by hand instead of through the stubbed sub-check:
none of the three files reference any credential value (names only, and none
of the three even reference a connector that needs one).

`app/server/src/services/bots/bot-registry.test.ts` (new, in this PR) asserts
the registry change: CFO/CTO resolve by id/name/alias, the three new chat-agent
slugs map to the right bot, and the pre-existing `general` mapping is
unchanged.
