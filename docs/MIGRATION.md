# Migration: from hardcoded workspaces and agents to config-driven seeds

Command Center used to ship a hardcoded list of workspaces (and their vault paths)
baked into `app/server/src/db/index.ts`. Those are now loaded from a config file
at seed time. This note explains what to do after the change merges so your
**running system is unaffected**.

## What changed

- `db/index.ts` no longer contains a hardcoded `seedWorkspaces` array. It calls
  `loadSeedWorkspaces()`, which reads (in order):
  1. `$CC_WORKSPACES_SEED` (if set),
  2. a **gitignored** `seed.workspaces.json` (your real workspaces),
  3. the committed `seed.workspaces.example.json` (generic `acme` + `personal` demo).
- The seed loop is **unchanged**: it is still `INSERT OR IGNORE`, so it only ever
  *adds* missing workspace rows. It never updates or deletes an existing row.
- Path tokens `${SECOND_BRAIN_DIR}` / `${AI_WORKSPACE_DIR}` in the seed file are
  expanded from the environment at load.

## What an existing (production) host should do

1. Drop a gitignored `seed.workspaces.json` next to the server package
   (`app/server/seed.workspaces.json`) describing your real workspaces. Use the
   same shape as `seed.workspaces.example.json`. Example row:

   ```json
   {
     "slug": "myteam",
     "name": "My Team",
     "short_label": "MT",
     "badge_color": "bg-blue-500/20 text-blue-400",
     "vault_path": "${SECOND_BRAIN_DIR}/workspaces/myteam",
     "doc_read_roots": ["${SECOND_BRAIN_DIR}/workspaces/myteam", "${SECOND_BRAIN_DIR}/shared"],
     "doc_write_roots": ["${SECOND_BRAIN_DIR}/workspaces/myteam"],
     "default_agent_pool": ["engineer", "ops", "general"],
     "sort_order": 1
   }
   ```

2. That's it. **Your existing database rows are untouched.** Because the seed is
   `INSERT OR IGNORE`, re-running it against a DB that already has your
   workspaces is a no-op for those rows. The config file only matters for a
   **fresh** database (or for adding a brand-new workspace).

## Fresh install

A brand-new database with no `seed.workspaces.json` seeds the two demo
workspaces from `seed.workspaces.example.json` (`acme`, `personal`) plus one
admin user (see `.env.example` → `CC_BOOTSTRAP_ADMIN` / `CC_BOOTSTRAP_PASSWORD`).

## Related changes shipped alongside

- **Auth**: `JWT_SECRET` is now **required** (≥ 32 bytes). There is no fallback
  secret — the server refuses to start without it. Set `CC_JWT_SECRET`.
- **Seed users**: the old static demo accounts (with a shared default password) are gone. The seed creates
  exactly one admin from `CC_BOOTSTRAP_PASSWORD`, or generates and prints a random
  password once on first boot.
- **Loops UI**: project chips are now data-driven from `GET /api/workspaces`
  rather than a hardcoded list.

---

# Migration: from a hardcoded agent roster to a config-driven `agents` table

Shipped across obj 709939 (the registry) and obj 709956 (assistant decoupling +
publish-gate enforcement). Same shape as the workspaces migration above.

## What changed

- The persona roster used to be a **closed TypeScript union** — `AgentContext`
  in `app/shared/types-core.ts`, duplicated as `AGENT_META`, `AGENT_CONTEXTS`,
  and as `AGENT_MAP` / `WORKDIR_MAP` in `services/prompt-builder-workdir.ts`.
  **All four constants are deleted.** `AgentContext` is now `string`.
- The roster lives in an `agents` table, seeded (in order) from:
  1. `$SEED_AGENTS_PATH` (if set),
  2. a **gitignored** `app/server/seed.agents.json` (your real roster),
  3. the committed `app/server/seed.agents.example.json` (five generic
     executives: `cto`, `cmo`, `coo`, `cfo`, `general`).
  If none is readable, `DEFAULT_AGENT_SEED` in `db/schema/agents.ts` supplies
  the same five rows.
- The seed loop is `INSERT OR IGNORE` — it only ever *adds* missing rows, and
  never updates or deletes one you have edited.
- The `objectives.agent_context` CHECK constraint is **dropped**. It enumerated
  only eight slugs, so nine of the personas the UI offered were not actually
  insertable. The registry table is the source of truth; validation happens at
  the API boundary, exactly as `objectives.workspace` has worked since
  workspaces became a table.
- Read paths: `GET /api/agents` (server: `services/agent-registry.ts`; client:
  `hooks/useAgents.ts`). Admin CRUD: `/api/admin/agents-registry`.

## How a self-hoster adds their own agents

Two routes; both end up in the same table.

**A. Before first boot — seed file (recommended for a fresh install).**

```bash
cp app/server/seed.agents.example.json app/server/seed.agents.json
$EDITOR app/server/seed.agents.json      # add / rename / reorder your personas
```

`app/server/seed.agents.json` is **gitignored**, is on
`scripts/oss-strip-paths.txt`, and its absence from the published tree is
asserted by `scripts/oss-sync-gate.sh` — so your real roster can never reach a
public mirror. One row looks like:

```json
{
  "slug": "growth",
  "label": "Growth",
  "kind": "executive",
  "assignable": true,
  "prompt_file": null,
  "workdir_kind": "workspace",
  "workdir_path": null,
  "mono": "GR",
  "badge_hex": "#6F9AD8",
  "badge_tw": "bg-agent-cto",
  "sort_order": 6
}
```

- `kind`: `executive` (a full role) or `routing-only` (a helper persona).
- `workdir_kind`: `projects` | `workspace` | `home` | `custom`. `custom` uses
  `workdir_path`. This replaces the deleted `WORKDIR_MAP`.
- `prompt_file`: normally `null` — the slug is the persona filename under
  `AGENTS_DIR`, so `growth` inlines `<AI_WORKSPACE_DIR>/agents/growth.md`. Set
  it only when the file name differs from the slug (an absolute path is used
  verbatim). This replaces the deleted `AGENT_MAP`.
- `mono` / `badge_hex` / `badge_tw`: UI monogram and colour. Omit them and the
  client derives a deterministic monogram and a neutral colour.

**B. On a running install — admin API.**

```bash
curl -X POST https://<host>/api/admin/agents-registry \
  -H 'Authorization: Bearer <cc_live_…>' -H 'Content-Type: application/json' \
  -d '{"slug":"growth","label":"Growth","kind":"executive","workdir_kind":"workspace","sort_order":6}'
```

`PATCH /api/admin/agents-registry/:slug` edits a row; `DELETE` **archives**
rather than hard-deletes, and refuses while that persona still owns
non-terminal objectives, so no board card is ever orphaned.

## The assistant / mentor persona

The mentor subsystem no longer hardcodes an `assistant` slug or an
`<ai-workspace>/agents/assistant.md` path. It resolves its persona from the
registry via `services/assistant-persona.ts`, keyed by one setting:

| Env | Meaning |
|---|---|
| `ASSISTANT_AGENT_SLUG` | Slug of a row in `agents` to use as the assistant persona. **Unset by default.** |
| `ASSISTANT_OWNER_WORKSPACE` | Workspace for the one-time owner `assistant_configs` seed (default `example`). |
| `ASSISTANT_OWNER_GOOGLE_EMAIL` | Google identity for the seeded config's `google-workspace` connector. Omit and no connector is bound. |
| `ASSISTANT_DISPLAY_NAME` / `ASSISTANT_TAGLINE` | Cosmetic overrides for the seeded config. |
| `MENTOR_TELEGRAM_OWNER_USERNAME` | Username the one-time owner seed applies to. **Unset by default** — the seed is opt-in. |
| `ROLODEX_SIBLING_ENTRY` | Optional override for the Telegram sibling entrypoint (defaults under `CC_REPO_DIR`). |

**Leave `ASSISTANT_AGENT_SLUG` unset and everything still works.** No owner
config is seeded, mentor threads fall back to the generic create-on-read
`defaultAssistantConfig`, and the assistant-ingest prompt uses generic wording
instead of pointing at a persona file that does not exist. Nothing crashes.

Existing hosts: your `assistant_configs` rows are untouched (the seed only ever
fires for a user that has **no** row). To keep the seeded-config behaviour on a
*future* fresh DB, set `ASSISTANT_AGENT_SLUG` to a slug present in your
`seed.agents.json`.

## What an existing (production) host should do

1. Drop a gitignored `app/server/seed.agents.json` with your real roster before
   the first restart after this merges. Without it a **fresh** DB seeds the five
   generic executives; an **existing** DB is unaffected either way, because the
   seed is `INSERT OR IGNORE` and no row is ever removed.
2. If you had the out-of-band `agents` table from the OperationKit authoring
   subsystem, the migration renames it aside to `agents_legacy_okit` (rows
   preserved verbatim, no `DELETE`) and folds its slugs into the registry.
3. Optionally set `ASSISTANT_AGENT_SLUG` per the table above.

## Publish-time enforcement

`scripts/oss-sync-gate.sh` now fails the public sync closed when the roster
drifts (obj 709956):

- **check 0** runs the denylist against the assembled tree *before*
  `oss-genericize.sh` rewrites it, so a private persona slug cannot be laundered
  into a generic alias by the genericizer's business-identity prefix rewrite.
- **check 4** asserts every slug the published tree would seed is on
  `scripts/oss-agent-allowlist.txt`. Adding a persona to the public default
  roster is therefore a reviewable one-line diff, not an accident.
- **check 3** asserts `seed.agents.json` is absent from the published tree and
  `seed.agents.example.json` is present.

`scripts/oss-gate-roster-test.sh` exercises all three on a throwaway fixture.
