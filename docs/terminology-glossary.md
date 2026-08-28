# Command Center — Canonical Hierarchy Terminology

> Ratified glossary (obj 2383, 2026-06-28). One vocabulary across schema, server,
> and UI. Before this, "strategy" was inferred (`depth-0 + delegate_mode=1`) and
> collided with the orthogonal `type` tag, while delegator children were labeled
> both "Workers" and "sub-objective". This document is the single source of truth.

## The two axes

Two **independent** axes describe every objective. Do not conflate them.

1. **Tier** — *where a row sits in the hierarchy.* `Strategy > Objective > Sub-objective`.
2. **Type** — *what kind of work it is.* `project | bug | task`. Orthogonal to tier; a
   classification that drives the workflow (planning/review gates), **not** a level.

A Strategy can contain `project`-type and `task`-type objectives alike; `type` says
nothing about tier and tier says nothing about `type`.

## The hierarchy (tier axis)

```
Strategy            ← top tier. Persistent top-level delegator. Stored: is_strategy = 1
  └─ Objective      ← the atomic card; any row in the objectives table
       └─ Sub-objective   ← a delegator's child (UI synonym while running: "Worker")
```

| Canonical term      | Definition                                                                                                   | How it is represented                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| **Objective**       | The atomic unit; every row in the `objectives` table. The universal noun.                                    | A row in `objectives`.                                                                 |
| **Strategy**        | A persistent, **top-level** delegator that owns sub-objectives + jobs and re-wakes to decide next steps.      | **Stored marker** `objectives.is_strategy = 1` (a top-level `delegate_mode` row). Tier badge: `STRATEGY`. |
| **Sub-objective**   | A child objective spawned by a delegator. The canonical noun for a delegator child.                          | A row with `parent_id` set under a `delegate_mode` parent.                             |
| **Worker**          | The **delegator-mode synonym** for a Sub-objective *while it is being executed by a worker session.* Not a separate entity. | UI label "Workers" in the rollup under an active delegator.                            |
| **Job**             | A recurring Objective produced by a Routine on a cron schedule.                                              | A row with `routine_id` set (Jobs surface).                                            |
| **Routine**         | The cron schedule definition that produces Jobs.                                                             | A row in `routines`.                                                                   |
| **Type** (`project`/`bug`/`task`) | Orthogonal **kind-of-work** tag on an objective, independent of tier.                          | `objectives.type`. See `app/shared/workflow.ts` `TYPE_LABELS`.                         |

## Strategy — the stored marker (obj 2383)

A **Strategy** is now an explicit stored marker, not an inferred state:

- Column: `objectives.is_strategy INTEGER NOT NULL DEFAULT 0`.
- Written at creation: a top-level (`parent_id IS NULL`) objective created in
  `delegate_mode` is stamped `is_strategy = 1` (`routes/objectives.ts`). Toggling
  `delegate_mode` or re-parenting recomputes it on update.
- Backfill (idempotent): existing rows matching the old inference rule
  (`delegate_mode = 1 AND parent_id IS NULL`) were stamped once (`db/index.ts`).
- **Why a flag, not `type='strategy'`:** `type` is the orthogonal kind-of-work
  axis. Adding `strategy` to it would re-introduce the exact tier/type collision
  this work removes. The tier lives on its own marker.

### Selecting all strategies — one query, no derivation

```sql
SELECT * FROM objectives WHERE is_strategy = 1;
```

Endpoint: `GET /api/internal/strategies` (optional `?workspace=`). No
`depth + delegate_mode` join required.

## UI label reconciliation

- **Strategy** renders a `STRATEGY` tier badge (`STRATEGY_BADGE` in
  `app/shared/workflow.ts`), on a separate visual axis from the `type` badge.
- A delegator's children render under the **"Workers"** header while the delegator
  is active (the running synonym); other (manual) children render under
  **"Sub-objectives"** — the canonical noun. Neither label is an orphan: both map
  to *Sub-objective* here.

## Back-compatibility

Additive and back-compatible. Absence of the marker (`is_strategy = 0`) preserves
prior behavior; no existing flow changes. The flag-gated nesting guard
(`CC_STRATEGY_TIER`, obj 2286) and the depth model are unchanged — `is_strategy`
is a parallel, additive marker.
