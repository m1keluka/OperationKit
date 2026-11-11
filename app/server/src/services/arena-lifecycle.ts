// ─────────────────────────────────────────────────────────────────────────────
// Design Arena lifecycle (obj 594) — the COHORT-COMPLETION half of the loop.
//
// `startArenaSession` (session-manager.ts) spawns N archetype-seeded generator
// sessions and registers the cohort here. On each poll tick the state-poller calls
// `maybePromoteArenaCohort(objective)`; once every variant session has FINISHED this
// module runs the render-and-rank evaluation (`evaluateArena`), picks the winner, and
// PROMOTES it by pointing the objective's `session_id` at the winning variant's
// session — so the EXISTING working→ai_review transition reviews the winner unchanged.
// The arena sits before ai_review, never instead of it.
//
// DORMANCY: the cohort registry is empty unless `startArenaSession` ran (which only
// happens when `shouldRunArena` is true). `maybePromoteArenaCohort` short-circuits in
// O(1) when the objective has no registered cohort, so the poller pays ~nothing when
// the arena is off.
// ─────────────────────────────────────────────────────────────────────────────

import type { Objective } from '@operationkit/shared'
import {
  evaluateArena,
  parseVariantScorecard,
  toRankingArtifact,
  writeRankingArtifact,
  runR9PreFilter,
  type ArenaDeps,
  type ArenaResult,
  type VariantBuild,
} from './design-arena.js'

export interface CohortVariant {
  archetypeKey: string
  archetypeName: string
  sessionId: string
}

// ── In-memory cohort registry (durable manifest lives in the objective memory dir) ──
const arenaCohorts = new Map<number, CohortVariant[]>()

export function registerArenaCohort(objectiveId: number, variants: CohortVariant[]): void {
  arenaCohorts.set(objectiveId, variants)
}
export function getArenaCohort(objectiveId: number): CohortVariant[] | undefined {
  return arenaCohorts.get(objectiveId)
}
export function clearArenaCohort(objectiveId: number): void {
  arenaCohorts.delete(objectiveId)
}
export function hasArenaCohort(objectiveId: number): boolean {
  return arenaCohorts.has(objectiveId)
}

// ── IO seam (injected so the lifecycle is testable without real sessions/DB) ──────
export interface ArenaLifecycleIO {
  /** 'working' ⇒ variant still running; anything else ⇒ finished. */
  getState: (sessionId: string) => string
  /** Concatenated assistant transcript for a variant session (carries its <scorecard>). */
  getTranscript: (sessionId: string) => string
  /** Files the variant touched (for the R9 static pre-filter). Optional. */
  getTouchedFiles?: (sessionId: string) => string[]
  /** Point the objective's session_id at the winning variant (DB update in prod). */
  promote: (objectiveId: number, winnerSessionId: string) => void
  /** Persist the ranking artifact dir (defaults to the objective memory dir). */
  artifactDir?: (objectiveId: number) => string
  /** Optional render override (variants self-screenshot, so default is a no-op). */
  render?: ArenaDeps['render']
  /** Optional single pairwise tiebreak (model comparison) for a clean top-2 tie. */
  pairwise?: ArenaDeps['pairwise']
  /** Optional R9 pre-filter override (defaults to the real `runR9PreFilter`). */
  preFilter?: (files: string[]) => { pass: boolean; output: string }
  log?: (msg: string) => void
}

/**
 * Build the production `evaluateArena` deps from the lifecycle IO. Variants already
 * screenshot themselves (Wave B self-critique mandate) and emit a `<scorecard>`, so:
 *   - render: no-op (returns the shots the variant already captured; [] by default),
 *   - judge:  parse the variant session transcript's `<scorecard>` (no nested grader),
 *   - preFilter: the real static `runR9PreFilter` over the variant's touched files,
 *   - pairwise: optional single model comparison on a clean top-2 tie.
 * An independent-grader upgrade (spawn one reviewer per survivor with Playwright MCP +
 * `buildVariantJudgePrompt`) is a drop-in swap of the `judge`/`render` deps.
 */
export function buildArenaDeps(io: ArenaLifecycleIO): Omit<ArenaDeps, 'generate'> {
  return {
    preFilter: io.preFilter ?? ((files: string[]) => runR9PreFilter(files)),
    render: io.render ?? (async () => []),
    judge: async (build: VariantBuild) =>
      parseVariantScorecard(io.getTranscript(build.handle), {
        name: build.archetypeName,
        file: build.handle,
        archetype: build.archetypeKey,
      }),
    pairwise: io.pairwise,
  }
}

export type ArenaPromotionOutcome =
  | { status: 'no-cohort' }
  | { status: 'waiting'; pending: number }
  | { status: 'promoted'; winnerSessionId: string; result: ArenaResult }
  | { status: 'no-winner'; result: ArenaResult }

/**
 * Evaluate + promote one arena cohort. Returns `waiting` until EVERY variant session
 * has finished; then runs `evaluateArena`, maps the winning archetype back to its
 * session, and calls `io.promote` so the objective's worker output becomes the winner
 * — which the existing poller transition then routes into ai_review unchanged. If no
 * variant passes, the highest-scored variant is still promoted so ai_review catches it
 * (best-of-N with a defect gate; nothing is silently dropped). Testable via injected IO.
 */
export async function evaluateAndPromoteArena(
  objective: Objective,
  cohort: CohortVariant[],
  io: ArenaLifecycleIO,
): Promise<ArenaPromotionOutcome> {
  const pending = cohort.filter((v) => io.getState(v.sessionId) === 'working').length
  if (pending > 0) return { status: 'waiting', pending }

  const builds: VariantBuild[] = cohort.map((v) => ({
    archetypeKey: v.archetypeKey,
    archetypeName: v.archetypeName,
    files: io.getTouchedFiles?.(v.sessionId) ?? [],
    handle: v.sessionId, // the judge dep reads this session's transcript
  }))

  const result = await evaluateArena(objective, builds, buildArenaDeps(io))

  // Persist the audit artifact next to the objective's memory.
  const dir = io.artifactDir?.(objective.id) ?? `/home/operator/ai-workspace/objective-memory/${objective.id}`
  writeRankingArtifact(dir, toRankingArtifact(objective, result))

  // Resolve the winner's session. Prefer the clean PASS winner; if none pass, fall back
  // to the highest-scored variant so the objective still advances into ai_review.
  const chosen = result.winner ?? result.ranking[0] ?? null
  if (!chosen) {
    io.log?.(`[arena] #${objective.id}: no variants to promote`)
    return { status: 'no-winner', result }
  }
  const winnerVariant = cohort.find((v) => v.archetypeKey === chosen.archetype)
  if (!winnerVariant) {
    io.log?.(`[arena] #${objective.id}: winner archetype ${chosen.archetype} not found in cohort`)
    return { status: 'no-winner', result }
  }

  io.promote(objective.id, winnerVariant.sessionId)
  clearArenaCohort(objective.id)
  io.log?.(
    `[arena] #${objective.id}: promoted '${chosen.archetype}' (score ${chosen.score}/14, ${chosen.verdict}) ` +
      `→ session ${winnerVariant.sessionId} enters ai_review`,
  )
  return result.winner
    ? { status: 'promoted', winnerSessionId: winnerVariant.sessionId, result }
    : { status: 'no-winner', result }
}
