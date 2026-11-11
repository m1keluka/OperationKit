/**
 * May this bot job start by itself, and may it keep running? (obj 900323, G1/G12.)
 *
 * Two separate questions, deliberately not merged:
 *
 *  - **Start** (`decideBotJobStart`) — an AUTOMATIC start needs an explicitly
 *    configured, finite ceiling. This reuses `guardAutoStartCeiling` from obj
 *    900322 on the existing `bounded` path rather than inventing a second
 *    policy, so the one honest distinction that round established is preserved
 *    verbatim: the **wall-clock** ceiling is ENFORCED by the runner, and the
 *    **cost** ceiling is ADVISORY — no measured provider spend is collected, so
 *    it is not a billing cap and this module never claims it is.
 *    No ceiling configured → the job is FILED and left for a person to start.
 *    It is never started on a guessed budget: this module contains no numbers.
 *
 *  - **Worker singularity** (`claimBotJobSession`) — one live worker per card,
 *    via the existing `obj:<id>` identity lease. A follow-up on a running job
 *    ATTACHES to the live session; it never spawns a second worker and never
 *    opens a second card. Crash/cancel then resume takes the lease back because
 *    the dead holder fails `isAlive`.
 */
import type { Database } from 'better-sqlite3'
import { guardAutoStartCeiling, type AutoStartGuardVerdict } from '../job-accounting.js'
import { claimObjectiveSession, type ClaimOutcome } from '../objective-session-claim.js'

export interface StartDecision {
  allowed: boolean
  mode: 'auto' | 'manual'
  /** `ok` | `auto_start_no_ceiling` | `auto_start_ceiling_exceeded` | `replay` */
  code: string
  reason: string
  ceiling?: AutoStartGuardVerdict['ceiling']
  /** Honest split from obj 900322 / PR 657. Never conflated. */
  enforcement?: { wallclock: 'enforced' | 'unset'; cost: 'advisory' | 'unset' }
}

export function decideBotJobStart(
  db: Database,
  job: { objectiveId: number; workspace: string | null },
): StartDecision {
  const verdict = guardAutoStartCeiling(db, { id: job.objectiveId, workspace: job.workspace }, { path: 'bounded' })
  const enforcement = {
    wallclock: verdict.ceiling.wallclockMs === null ? ('unset' as const) : ('enforced' as const),
    cost: verdict.ceiling.costUsd === null ? ('unset' as const) : ('advisory' as const),
  }
  if (!verdict.allowed) {
    return {
      allowed: false,
      mode: 'manual',
      code: verdict.code ?? 'auto_start_refused',
      reason: verdict.reason ?? 'Auto-start refused.',
      ceiling: verdict.ceiling,
      enforcement,
    }
  }
  return {
    allowed: true,
    mode: 'auto',
    code: 'ok',
    reason:
      `Bounded auto-start allowed (ceiling source ${verdict.ceiling.source}). ` +
      `Wall-clock ceiling ${enforcement.wallclock}; cost ceiling ${enforcement.cost} ` +
      '(advisory means reported, not a billing hard stop — no measured provider spend is collected).',
    ceiling: verdict.ceiling,
    enforcement,
  }
}

/**
 * Take (or attach to) the card's single-worker lease. A thin pass-through so
 * every bot-job start path goes through the SAME lease as every other spawn
 * path — a second mechanism here would be a second way to get two workers.
 */
export function claimBotJobSession(
  db: Database,
  objectiveId: number,
  sessionId: string,
  isAlive: (sessionId: string) => boolean,
): ClaimOutcome {
  return claimObjectiveSession(db, objectiveId, sessionId, isAlive)
}
