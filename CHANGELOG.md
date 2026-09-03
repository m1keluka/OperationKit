# Changelog

Notable operator-facing changes. Newest first.

> Not a release log — this repo deploys from `main`. Entries here are the changes
> that need an operator to *do* or *know* something. Day-to-day product changes are
> tracked in the board's own changelog (`GET /api/changelog`, Development → Changelog).

## Unreleased

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

The `app/telegram-rolodex/` sibling process is now stripped from the public cut
— see [`docs/oss/RELEASE-MANIFEST.md`](docs/oss/RELEASE-MANIFEST.md).
