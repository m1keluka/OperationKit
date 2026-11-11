import type { Objective } from '@operationkit/shared'

export interface GroupedObjectives {
  /** parent objective id → its child objectives (sorted by id ascending). */
  childrenByParent: Map<number, Objective[]>
  /** objectives that render as their own cards (everything not nested). */
  topLevel: Objective[]
}

/**
 * Nest any child whose parent is ALSO present in the list, pulling it out of the
 * top-level set so it renders inside the parent's card (WorkerRollup) instead of
 * floating as a duplicate top-level card.
 *
 * This covers both delegator workers (parent runs delegate_mode) AND auto-created
 * PR `[Review]`/adversarial children (parent is a normal objective). Operator's board
 * should show one card per piece of work, not a separate review card per objective.
 *
 * Guard: a child is only nested when its parent is in view. Orphaned children
 * (parent deleted, filtered to another workspace, etc.) stay top-level so they
 * never silently disappear from the board.
 *
 * Strategy exclusion (UI-B / obj 700134): strategies (is_strategy=1) and any
 * objective a strategy manages (strategy_id -> a real, present is_strategy=1 row)
 * live on the dedicated /strategies + /strategy/:id surfaces, NOT the flat board
 * — so they are dropped from `topLevel` entirely. The per-parent nesting map is
 * still computed across everything (it feeds in-card rollups), but a strategy's
 * own children never surface as cards because their strategy parent is gone from
 * topLevel.
 *
 * Deadzone guard (obj 700347): a strategy-member is excluded ONLY when its
 * managing strategy is actually reachable on the /strategies surface (an
 * is_strategy=1 row present in this dataset). The /strategies query only returns
 * is_strategy=1 rows, so an objective with strategy_id set but pointing at itself
 * (self-referencing delegator, e.g. obj 1684) or at a strategy that is NOT present
 * (orphan, e.g. obj 1814) would otherwise appear on NEITHER surface and silently
 * vanish. Mirroring the orphaned-child guard above, those objectives MUST stay
 * top-level — visible beats invisible.
 */
function belongsToStrategy(o: Objective, strategyIds: Set<number>): boolean {
  // A genuine strategy always lives on /strategies, never the flat board.
  if (o.is_strategy) return true
  // A managed member is excluded only when its strategy is real and present,
  // and it is not self-referencing.
  return (
    o.strategy_id != null &&
    o.strategy_id !== o.id &&
    strategyIds.has(o.strategy_id)
  )
}

export function groupObjectives(objectives: Objective[]): GroupedObjectives {
  const parentIds = new Set(objectives.map(o => o.id))
  const strategyIds = new Set(objectives.filter(o => o.is_strategy).map(o => o.id))
  const byParent = new Map<number, Objective[]>()
  const nestedIds = new Set<number>()
  for (const o of objectives) {
    if (o.parent_id != null && parentIds.has(o.parent_id)) {
      nestedIds.add(o.id)
      const arr = byParent.get(o.parent_id) || []
      arr.push(o)
      byParent.set(o.parent_id, arr)
    }
  }
  for (const arr of byParent.values()) arr.sort((a, b) => a.id - b.id)
  return {
    childrenByParent: byParent,
    topLevel: objectives.filter(o => !nestedIds.has(o.id) && !belongsToStrategy(o, strategyIds)),
  }
}
