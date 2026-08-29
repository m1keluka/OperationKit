# Strategy Governance — Stage-0 Human-Confirm Gate (obj 2385)

The **first built slice** of the Strategy Layer's progressive-trust governance
(designed in obj 2197). It makes the dark-launched Strategy Tier *safe to turn
on* by putting a human in the loop on every strategic decision before any
autonomy is granted.

Implements the Stage-0 ("full-gate") rung of the trust ladder from
`second-brain/workspaces/personal/architecture/strategy-layer-gating-review-framework.md`
and the decision `.../decisions/2026-06-27-strategy-layer-autonomy.md`.
Reuse-first: the human gate is the existing `review` status, the resume is the
existing `POST /objectives/:id/message → sendFollowUp`, and decisions are stored
as `objective_reviews` rows. No new scheduler, no parallel decision table.

## ⚠️ Flag prerequisite — READ THIS

`CC_STRATEGY_TIER` (the dark-launch flag that enables nested strategy→project
delegation + the P3 continuation wake) **MUST stay OFF (unset / not `1`) until
this Stage-0 gate has been verified end-to-end in this environment.**

The gate is the control that makes the tier safe: with the flag on but no gate,
a strategy could spawn projects unattended with no human confirmation and no
spend/branch ceiling. Flipping `CC_STRATEGY_TIER=1` is therefore **gated on**:

1. `POST /api/internal/objectives/:id/decision` parks a strategy in `review`
   with a pending Decision Request (verified).
2. The Strategy Governance UI panel shows children + the pending decision +
   budget usage, and Approve/Deny resumes the strategy (verified in a browser).
3. The kill-switch refuses a project spawn once a ceiling is crossed (verified
   via the API — see below).

Only after all three are confirmed working should `CC_STRATEGY_TIER=1` be set,
and even then on **one trial strategy** with the gate armed (Stage 0 = every
decision gated). Promotion up the trust ladder (Stages 1–3) is out of scope here
and remains unbuilt by design.

## What ships in this slice

| Piece | Where |
|-------|-------|
| `objective_reviews.mode='decision'` + `verdict='pending'` (schema broadened via detect-and-rebuild) | `app/server/src/db/index.ts` |
| Decision-Request validator, kill-switch math, decision CRUD | `app/server/src/services/strategy-governance.ts` |
| Strategy posts a Decision Request + parks in `review` | `POST /api/internal/objectives/:id/decision` (localhost + secret) |
| Kill-switch enforced on project spawn | `POST /api/internal/objectives` create guard |
| Governance read surface | `GET /api/objectives/:id/governance` (JWT) |
| Human confirm/deny → resume strategy | `POST /api/objectives/:id/decisions/:reviewId/resolve` (JWT) |
| Governance UI panel (children, pending decision, budget meters) | `app/client/src/components/StrategyGovernance.tsx` + a Governance button on strategy cards |

A "strategy" = a **top-level delegator** (`delegate_mode=1 AND parent_id IS NULL`).

## The gated loop (Stage 0 = full-gate)

```
strategy reaches a decision point (spawn-next | pivot | stop | re-scope)
  → POST /api/internal/objectives/:id/decision  {kind, decision, evidence[], options[], recommendation}
  → row written: objective_reviews(mode='decision', verdict='pending'); status → 'review'
  → strategy ends its turn  (fireWake's review-park guard keeps child-completions from stampeding past it)
The owner sees it in the Governance panel (children, pending decision, budget)
The operator sees it in the Governance panel (children, pending decision, budget)
  → Approve(optionId) / Deny(note)
  → POST /api/objectives/:id/decisions/:reviewId/resolve
  → verdict → 'pass'/'fail'; sendFollowUp injects "[decision …] APPROVED/DENIED …"; status → 'working'
strategy wakes, reads the verdict, acts (or re-plans), continues to the next gate
```

A malformed Decision Request (missing decision / empty evidence / no options /
no recommendation) is rejected at submit time — a strategy can never park on an
empty ask.

## Kill-switch (enforced in code, not just designed)

Hard ceilings halt a runaway strategy. Defaults are env-overridable:

| Ceiling | Env | Default |
|---------|-----|---------|
| Max projects per strategy (direct children, cumulative) | `STRATEGY_MAX_PROJECTS` | 12 |
| Cumulative subtree spend — normal | `STRATEGY_CEILING_NORMAL_USD` | $1000 |
| — high | `STRATEGY_CEILING_HIGH_USD` | $2000 |
| — ultracode | `STRATEGY_CEILING_ULTRACODE_USD` | $4000 |

When a ceiling is reached, the create-objective path **refuses the project
spawn** (HTTP 409 with the reason + a `kill_switch` payload) and forces the
strategy to `review` so the halt is a visible human event. A zero/negative
ceiling disables that arm.

### Verify the kill-switch via API

```bash
SECRET="$INTERNAL_API_SECRET"   # or the dev fallback
# Force the project ceiling to 0 so any spawn trips it:
STRATEGY_MAX_PROJECTS=0 <server running with that env>
curl -s -X POST http://localhost:3002/api/internal/objectives \
  -H "Content-Type: application/json" -H "x-internal-secret: $SECRET" \
  -d '[{"title":"p","parent_id":<STRATEGY_ID>,"delegate_mode":true}]'
# → 409 { "error": "...kill-switch tripped — project ceiling reached...", "kill_switch": {...} }
# and GET /api/objectives/<STRATEGY_ID>/governance → budget.killSwitchTripped = true
```

## Reversibility / no-dup

- Builds on the already-merged flag (`CC_STRATEGY_TIER`, obj 2286) and P3
  continuation wake (`isStrategyNode`/`buildWakeMessage`, merged). Does **not**
  re-implement the nesting guard or the wake — it only adds the gate on top.
- Additive + flag-respecting: with `CC_STRATEGY_TIER` off, no strategy/project
  nesting is allowed, so the gate paths are inert. The `objective_reviews`
  schema broadening and the new endpoints are harmless when unused.
