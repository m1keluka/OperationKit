# OSS release manifest — what ships, what is stripped, and why

Companion to `scripts/oss-strip-paths.txt` (the machine-readable source of truth)
and `scripts/oss-sync-gate.sh` (the fail-closed enforcement). This file is the
*reasoning* behind those two; when they disagree, the scripts win and this file
is the bug.

The pipeline is: **assemble** (`git archive HEAD`) → **strip**
(`oss-strip-paths.txt`) → **inject templates** (`oss/templates/`) → **snapshot
the raw tree** → **genericize** (`oss-genericize.sh`) → **gate**
(`oss-sync-gate.sh`, over both the raw snapshot and the genericized tree) →
**mirror**. See `.github/workflows/oss-sync.yml`.

## Classification vocabulary

| Class | Meaning |
|---|---|
| **SHIPS** | Present in the public tree, unmodified or genericized. |
| **STRIPPED** | Removed before publication. Never reaches the mirror. |
| **OPTIONAL** | Ships, but inert unless the operator configures it. Costs a self-hoster nothing if ignored. |

`OPTIONAL` is a claim about *runtime*, not about identity. A subsystem that is
inert-by-default but whose **source names a specific person, client, or private
persona** is not OPTIONAL — it is a leak that happens to be switched off, and it
must be STRIPPED.

## Agent roster

| Path | Class | Notes |
|---|---|---|
| `app/server/seed.agents.example.json` | **SHIPS** | The blank-slate default roster: `cto`, `cmo`, `coo`, `cfo`, `general`. Gate check 3 asserts it is *present*. |
| `app/server/seed.agents.json` | **STRIPPED** | The operator's real roster. Gitignored, on the strip list, and gate check 3 asserts it is absent. |
| `scripts/oss-agent-allowlist.txt` | **STRIPPED** | Upstream-only gate tooling, like the denylist and the gate itself. |
| `app/server/src/db/schema/agents.ts` | **SHIPS** | Includes `DEFAULT_AGENT_SEED`, which gate check 4 scans alongside the example seed. |

Any slug outside `scripts/oss-agent-allowlist.txt` in either seed source fails
the publish (check 4). Adding one is a reviewable one-line diff.

## `app/telegram-rolodex/` — DECISION: **STRIPPED** (obj 709956)

This reverses an earlier `OPTIONAL` reading of the subsystem, and the reversal is
the point of the vocabulary note above.

**What it is.** A single-owner Telegram bot that manages a contacts vault over
chat, running as a sibling process spawned by the main server.

**Why it was called OPTIONAL.** It is genuinely inert without configuration:
`services/rolodex-supervisor.ts` returns immediately unless both
`TELEGRAM_BOT_TOKEN` and `TELEGRAM_ROLODEX_OWNER_ID` are set, and again if the
entry file is missing. A self-hoster who ignores it pays nothing.

**Why that is not sufficient.** Its source is operator identity, not
configuration:

- `app/telegram-rolodex/index.ts:30` defaults its system prompt to
  `<ai-workspace>/agents/rolodex.md` — a persona file the gate already
  hard-blocks from ever shipping, so the published bot points at a file that
  cannot exist.
- `app/telegram-rolodex/README.md` documents the live host, the real webhook
  URL, and a unix socket under the operator's home.
- It is built around one of the operator's **private personas**, which is exactly
  the class of leak the blank-slate work exists to remove. Shipping a whole
  subsystem named after a private persona re-establishes by prose what deleting
  the roster constants removed from the type system.

**Decision.** `prefix:app/telegram-rolodex/` is on `scripts/oss-strip-paths.txt`.

**What still ships, and why that is safe:**

| Kept | Reason |
|---|---|
| `app/server/src/services/rolodex-supervisor.ts` | `app/server/src/index.ts` imports it, so stripping it would break the published tree's typecheck. It is generic infrastructure — spawn-a-child-with-backoff — and its one identity leak (a hardcoded `/home/<operator>/projects/command-center-infra/...` path, which also leaked the **private upstream repo name**) is fixed: the entry now resolves from `CC_REPO_DIR`, overridable via `ROLODEX_SIBLING_ENTRY`. With the sibling stripped the path does not exist, and the existing `fs.existsSync` guard skips with a log line. |
| `rolodex_threads` table, `/api/internal/rolodex/history` | Generic per-chat history storage for any sibling that wants it. Dropping the table would be a destructive migration on live data for no safety gain. |

**Why `rolodex` is not on the denylist.** After the strip, the surviving
occurrences are a common noun used as a subsystem name (a supervisor, a table, a
route). Denylisting it would fail the publish on those legitimate hits. The
enforcement that actually matters is check 4: `rolodex` is deliberately **not**
on `scripts/oss-agent-allowlist.txt`, so it can never re-enter the shipped agent
roster — which is where it did damage.

**Explicitly out of scope here** (noted, not done): removing the subsystem from
the private repo, and dropping `rolodex_threads`. Both are separate decisions
with their own blast radius.

## Other stripped classes

Summarised; `scripts/oss-strip-paths.txt` carries the per-path reasoning.

| Class | Examples |
|---|---|
| Real config / seeds / registries | `.env`, `seed.workspaces.json`, `seed.agents.json`, `.supabase-registry.json` |
| Upstream-only sync tooling | `scripts/oss-*.{sh,txt}`, `docs/OSS-SYNC*.md`, `.github/workflows/oss-sync.yml` |
| Real personas / vault content | `ai-workspace/`, `second-brain/` (also a hard path-absence gate check) |
| Operator-specific ops scripts and docs | host deploy/cron scripts, internal runbooks, PR-triage records |
| Internal design + evidence | `design/`, `config/`, `.evidence/`, `CLAUDE.md` |

## Known gap (pre-existing, not introduced here)

`oss-genericize.sh` deliberately does **not** rewrite the bare workspace slug
`example` ("too common a substring, false-positive risk" — its own header). It is on
the denylist, so a full-tree gate run currently reports denylist hits in ~81
files, mostly test fixtures using `example` as a workspace slug. Closing that needs
a separate `example` → `example` pass over the private source; it is out of scope
for the roster work and is unchanged by it.
