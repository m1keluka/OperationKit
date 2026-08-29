# Board Hygiene Sweep — daily backlog retirement (active)

Automated cleanup that retires stuck board pollution (never-started `queue` orphans and
stale abandoned `review` items) so the kanban board stays legible. Activated by obj 700851
on 2026-07-06 after PR #205 (obj 700595) added the `cancelled` soft-retire status.

## What it does

- **Retire transition:** each SAFE-CLOSE item is `PATCH`ed to `status=cancelled` through the
  **no-auth localhost internal API** (`PATCH /api/internal/objectives/:id/status`, body
  `{"status":"cancelled"}`). No JWT. `cancelled` is a first-class soft-retire status — distinct
  from `done` (it does not assert completion), reversible (`cancelled -> queue|working`), and
  rendered as a muted sink column so retired items leave the active board. See
  `app/shared/workflow.ts` (`isTransitionAllowed`) and `app/shared/types.ts` (`ObjectiveStatus`).
- **Guardrail (every run):** asserts 0 `working`/protected items in the SAFE-CLOSE set and
  hard-exits on breach. Permanently excluded: **700583** + children **700590/700591/700595**
  and **every `status=working`** objective.
- **Idempotent:** retired rows become `cancelled` (not `queue`/`review`), so a re-run reclassifies
  the shrunken in-scope set and finds nothing new.

## Where the code lives

The sweep tool is operational tooling, kept outside this repo under the objective workspace:

| File | Purpose |
|---|---|
| `~/ai-workspace/objective-memory/700583/hygiene-sweep.mjs` | classifier + rules (single source of truth); dry-run default, `--execute`, `--manifest`, `--json` |
| `~/ai-workspace/objective-memory/700583/daily-sweep.mjs` | cron entrypoint: `--execute` then refresh the digest + logs |
| `~/ai-workspace/objective-memory/700583/w2-sweep-runbook.md` | full operator runbook |
| `~/ai-workspace/objective-memory/700583/cron-snippet.txt` | the installed crontab line (reinstall source) |

## Schedule (VPS)

Installed in the **operator user's crontab** (owner-approved AUTO-DAILY EXECUTE), 07:17 daily (off the :00 mark):
Installed in the **operator user's crontab** (opt-in AUTO-DAILY EXECUTE), 07:17 daily (off the :00 mark):

```cron
17 7 * * * cd /home/operator/ai-workspace/objective-memory/700583 && /usr/bin/node /home/operator/ai-workspace/objective-memory/700583/daily-sweep.mjs >> /home/operator/ai-workspace/objective-memory/700583/logs/cron.log 2>&1
```

- Verify: `crontab -u "${OPERATOR_USER:-operator}" -l | grep board-hygiene`
- Human-facing digest refreshed each run at `/home/operator/ai-workspace/briefings/hygiene-latest.md`
- Logs: `~/ai-workspace/objective-memory/700583/logs/sweep-YYYYMMDD.log` + `cron.log`
- Runs **directly on the host as the operator user** — the VPS host has `/usr/bin/node`, the
- Runs **directly on the host as the operator user** — the host has `/usr/bin/node`, the
  `ai-workspace` tree is on the host filesystem, and the host reaches the API on `localhost:3002`,
  so no `docker exec` indirection is needed. Keep `logs/` owned by that same user; a root-owned
  `sweep-*.log` left by an in-container test will `EACCES` the append.

## Relationship to in-app continuous sweeps (PR #205)

The daily cron clears the **backlog**. PR #205 also shipped **in-app continuous sweeps** in the
state-poller (`app/server/src/services/state-poller.ts`, `app/server/src/lib/cleanup-orphaned-children.ts`)
that prevent new pile-ups event-driven:

- **Orphan auto-start / auto-retire:** a `done`/`review`/`cancelled` parent retires its stranded
  never-started `queue` children to `cancelled`.
- **Auto-accept-on-pass:** finished work with `ai_review_verdict=pass` is accepted rather than
  rotting in `review`.

So in steady state the daily sweep should usually find **SAFE-CLOSE ≈ 0** — it is the safety net
for anything the in-app path misses.

## Recovering a mistaken retire

`cancelled` is reversible — reopen with `PATCH /api/internal/objectives/:id/status`
`{"status":"queue"}` (or `"working"`). No DB surgery.
