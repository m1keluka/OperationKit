# Trial Bots roster: General, CFO, CTO — example agent files

Three example chat bots (obj 900371) — General, CFO, CTO — scoped to
ONE workspace of an install. They are **examples, not installed by default.**

Since obj 900430 the files here are deliberately **generic**: the knowledge
folder is the placeholder `workspaces/your-org`, the display name is "Your
Org", and the slug is a `your-org-…` placeholder. An install registers them
under **its own** slugs at import time — the org's slugs and folder live in
that install's data, never in this repo's source.

## What's here

| File | Bot | Purpose |
|---|---|---|
| `cos.agent.yaml` | General | Coordination/routing, read + write KB, no board cards |
| `cfo.agent.yaml` | CFO | Read-only finance KB, no write, no board, no connectors |
| `cto.agent.yaml` | CTO | Board ops/PR triage/CI, files cards, no merge/deploy |

Each is a standard [agent file](../agent-file-format.md) and imports as-is
under its placeholder slug. To register them under this install's own slugs,
use the localize path below.

## Register them under this install's slugs (supported path)

Run on the server host (or inside the app container), from a checkout of this
repo. The script reads the internal API secret inside the container and never
prints it. Pick slugs that are namespaced with your org (e.g. `acme-cfo`) so
they cannot collide with the bare executive-roster slugs (see below).

```bash
# 1. Map each chat slug to its bot in this install's registry
#    (writes one settings row, settings.bot_agent_slugs; additive only).
scripts/agent-template.sh bot-slugs add cos <org>-<cos-slug>
scripts/agent-template.sh bot-slugs add cfo <org>-cfo
scripts/agent-template.sh bot-slugs add cto <org>-cto

# 2. Import the three example files under those slugs, pointed at the
#    install's real knowledge folder.
for pair in cos:<org>-<cos-slug> cfo:<org>-cfo cto:<org>-cto; do
  scripts/agent-template.sh import "docs/bots/trial-roster/${pair%%:*}.agent.yaml" \
    --slug "${pair#*:}" \
    --knowledge-folder workspaces/<org> \
    --display-name "<Org name>"
done

# 3. Confirm: each bot lists its new slug, and the agents are on the roster.
scripts/agent-template.sh bot-slugs
scripts/agent-template.sh list
```

The bot argument resolves like an `owner_bot` value (id, name or alias). Use
the short aliases `cos` / `cfo` / `cto`: they are the same on every build,
whereas a bot's display name can differ between the private and the public
build.

What `--slug` does on import (`localize` in
`POST /api/internal/agent-templates/import`): it replaces
`workspaces/your-org` with `--knowledge-folder`, "Your Org" with
`--display-name` (default: the folder's last segment), and the whole
`slug:` line with `--slug`, then runs the normal agent-file validation on
the result. It **refuses** with nothing changed when the slug does not belong
to a bot yet (409 — do step 1 first), or when a `your-org` placeholder would
survive the rewrite (400).

Nothing else changes: tools, model and provider come from the file exactly as
shipped, a bot's job budget is the install's default ceiling, and
`bot-slugs add` writes only `settings.bot_agent_slugs` — it can add a slug
to an existing bot, never create a bot, rename one, or take a slug another bot
already owns. Pick a `--knowledge-folder` that exists in your knowledge base:
the bot can only read and write inside it.

## Why namespaced slugs, not the bare role names

The chat-"Bots" feature and the **session-worker executive roster** (the
personas assigned to board cards — `cto`, `cmo`, `coo`, `cfo`, `general`, …,
and the operator's full private roster in a gitignored `seed.agents.json`)
**share one registry table**: `agents` (`app/server/src/db/schema/agents.ts`).
`installAgentDef` (`app/server/src/services/agent-templates.ts`) writes a chat
bot's slug into that SAME table via `createAgent(...)` / `updateAgent(...)`.

`cfo` and `cto` are in `DEFAULT_AGENT_SEED` on every install. Importing a
chat-bot agent file with slug `cto` would therefore either:

- **409 "already exists"** on a plain import (safe, but blocks installation), or
- **silently overwrite** the live session-worker registry row for `cto` — label,
  badge, `workdir_kind`, `kind` — if `overwrite: true` is passed. That row is
  what `defaultAgentForWorkspace()` and every "assign to CTO" card action use
  for routing, across **every** workspace.

So chat slugs are always namespaced. The bot registry
(`app/server/src/services/bots/bot-registry.ts`) maps a chat slug to a bot
identity — built-in placeholder slugs from source, plus the install's own from
`settings.bot_agent_slugs`. That is what makes the General / CFO / CTO
**identities** (`owner_bot` on a filed card, ceiling/idempotency/dup-guard
enforcement) resolve for the install's slugs.

## Why not hardcode an org's slugs, or stop scrubbing them

The OSS public sync name-scrubs business identity and private persona slugs
out of the public tree, and the publish gate (`scripts/oss-sync-gate.sh`,
denylist `scripts/oss-denylist.txt`) fails closed on them. Slugs hardcoded in
source therefore reach a public install rewritten into placeholders that no
real install can register — the break obj 900430 fixed. Moving the slugs and
folder into install data removes the conflict instead of carving an exception
into the denylist.

## Known limitation: board-card workspace is the CHATTING PERSON's, not the bot's

`create_objective` (used by the CTO bot to file cards) files the card into
`workspaceFor(userId)` — the chatting person's own first/default workspace
membership (`app/server/src/services/agent-chat/engine.ts`) — **not** a
workspace pinned to the bot. An `admin` role additionally bypasses the
workspace-membership check in `personMayUseWorkspace`
(`bot-authorization.ts`), so a card would still be "authorized" even if it
landed outside the bot's workspace.

Mitigations in the files:

- `knowledge_folders: [<the install folder>]` on all three files is a HARD
  boundary (enforced by path-containment checks) — none of the three bots can
  read or write another workspace's knowledge base.
- The CTO bot is the only one of the three given `create_objective` ("files
  cards, NO merges/deploys"); General and CFO have no board-write tool
  at all.
- **Before trusting the CTO bot's filed cards**, confirm the acting person's
  own first/default workspace membership is the bot's workspace (or check the
  `workspace` column on the first few cards it files).

None of the three bots gets email/calendar/send, a custom model/provider, a
custom budget, or merge/deploy rights. There is no merge/deploy TOOL in the
chat-agent tool set at all (`KNOWN_AGENT_TOOLS` has no such name).

## Evidence

- `app/server/src/services/bots/bot-registry.test.ts` — install-local slugs:
  an unconfigured install recognises none, a configured one routes all three,
  built-in slugs are never moved, malformed settings are ignored.
- `app/server/src/services/bots/install-slugs.test.ts` — localize option
  validation and text rewrite; the three files in this folder localize to a
  valid agent file whose slug belongs to the right bot and whose only
  knowledge folder is the configured one, with the template's tools unchanged.
- `app/server/src/routes/agent-templates.test.ts` — the internal
  `bot-slugs` + `import … localize` routes end-to-end, including the 409
  refusal before a slug is mapped.
