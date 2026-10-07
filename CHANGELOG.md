# Changelog

Notable operator-facing changes. Newest first.

> Not a release log — this repo deploys from `main`. Entries here are the changes
> that need an operator to *do* or *know* something. Day-to-day product changes are
> tracked in the board's own changelog (`GET /api/changelog`, Development → Changelog).

## Unreleased

### Board-level Agents tab — the layer a project's sessions actually run on (obj 712044)

**What changed.** A new top-level **Agents** tab (`/agents`) renders the live
OperationKit layer — agent persona → workspace overlay → skills → tools — scoped
to one board project via `?project=<id>`. Server half: `GET /api/agents/board-layer`
and `GET /api/agents/layer-file` (both `requireAuth`, not localhost-only), built on
the existing `services/skill-graph.ts`. Client half reuses the SkillGraph
`GraphCanvas` for the Graph view and `MarkdownEditor` in `readOnly` mode to render
each file in place, so there is no second markdown renderer and no accidental
write surface.

**What an operator needs to know.**

- **Agent usage is derived from objectives, not configured.** `projects` has no
  agent column, so "which agents does project 16 use" is answered by counting
  `objectives.agent_context` in that project. The per-agent badge (`1 objective`,
  `146 objectives`) is that count. An agent that has never been given work in a
  project simply does not appear — that is correct, not a bug.
- **A declared-but-missing file is never silently dropped.** Any edge an agent or
  skill declares whose target has no file on disk still renders as a node, carries
  a red `file missing` chip, and is listed in the alarm banner at the top
  (`N declared files missing`). Clicking it opens a "File missing on disk" panel
  with the resolved path. The live sweep currently surfaces exactly one:
  `skills/supercut` declares `tools/supercut`, which does not exist.
- **The tab needs a single workspace.** The layer is per-workspace, so with the
  board selector on *all* the tab shows "Pick a single workspace" rather than a
  blank page (obj 712134).
- **Deploy note.** The client half is bundled, so merging alone does not make the
  tab appear — the tab requires a `self-deploy.sh both` (frontend rebuild + backend
  restart), since the server half adds routes too.
- **`layer-file` does not use a workspace's `doc_read_roots`.** `~/ai-workspace/tools`
  is in no workspace's document read roots, so routing the file reader through the
  docs route would 404 every tool node — and widening `doc_read_roots` to fix that
  would open the whole tools tree to the generic docs reader for an unrelated
  reason. Instead `GET /api/agents/layer-file` carries its own narrower allowlist
  (the three `~/ai-workspace` layer roots plus `workspaces/<ws>/agent-profiles`)
  with a post-resolve containment assert that also follows `realpath`, so a symlink
  cannot escape. Verified live: `kind=tool&slug=command-center` returns HTTP 200
  with `/home/operator/ai-workspace/tools/command-center/TOOL.md`. If you add a fourth
  layer tier, extend `LAYER_ROOTS` in `app/server/src/services/board-layer.ts` —
  the assert fails closed, so a forgotten root degrades to a 400, not a path escape.

### Agent roster is now data (obj 709939 + 709956)

**What changed.** The 17-persona roster used to be a closed TypeScript union
(`AgentContext`) duplicated across six tracked files. `AGENT_META`,
`AGENT_CONTEXTS`, `AGENT_MAP` and `WORKDIR_MAP` are **deleted**; `AgentContext`
is now `string`, and the roster lives in an `agents` table seeded from a
gitignored `app/server/seed.agents.json`. A fresh install ships five generic
executives — `cto`, `cmo`, `coo`, `cfo`, `general` — and nothing else. The
`objectives.agent_context` CHECK constraint is dropped.

**Operator action.**

- *Adding your own agents:* copy `app/server/seed.agents.example.json` to
  `app/server/seed.agents.json` (gitignored) and edit it before first boot, or
  use `POST /api/admin/agents-registry` on a running install. Full field
  reference and both flows: [`docs/MIGRATION.md`](docs/MIGRATION.md).
- *Existing databases are untouched.* The seed is `INSERT OR IGNORE`; no row is
  updated or deleted. A pre-existing out-of-band `agents` table is renamed to
  `agents_legacy_okit` with its rows preserved.
- *If you use the mentor/assistant surface:* it no longer hardcodes an
  `assistant` slug or an `<ai-workspace>/agents/assistant.md` path. Set
  `ASSISTANT_AGENT_SLUG` to a slug in your registry to keep the persona-backed
  behaviour on a fresh DB. Leaving it unset is fully supported — the assistant
  degrades to generic wording rather than crashing.

**Integrations.** `agent_context` is a free-form string in the OpenAPI schema.
Read the live roster from `GET /api/agents` instead of hardcoding slugs.

### OSS publish gate hardened (obj 709956)

`scripts/oss-sync-gate.sh` gained two checks that close the hole through which
the roster shipped in the first place:

- **check 0 — pre-genericize denylist.** The denylist now also runs against the
  assembled tree *before* `scripts/oss-genericize.sh` rewrites it. The old
  single post-genericize pass could only prove "no raw business string
  survived", never "no business entity was here"; a renamed persona slug
  would pass the post-genericize check green because the genericizer rewrote
  its business-identity prefix. CI sets `PREGEN_DIR`; the gate warns loudly
  when it is unset.
- **check 4 — roster conformance.** Every agent slug the published tree would
  seed must appear in `scripts/oss-agent-allowlist.txt`. Fails closed on
  anything else.
- **check 3** additionally asserts `seed.agents.json` is absent from the
  published tree while `seed.agents.example.json` is present.

`scripts/oss-gate-roster-test.sh` proves all three against a throwaway fixture
(clean → PASS, injected private slug → FAIL).

The `app/telegram-contactbook/` sibling process is now stripped from the public cut
— see [`docs/oss/RELEASE-MANIFEST.md`](docs/oss/RELEASE-MANIFEST.md).
