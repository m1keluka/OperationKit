/**
 * Auto-resume on limit / overload / max-turns — extracted from session-manager.ts
 * (behavior frozen). Counters live in session-death.ts. sendFollowUp is on the facade.
 */
import type { Objective } from '@operationkit/shared'
import { getDb } from '../db/index.js'
import { pickAccount, enqueueSession } from './account-router.js'
import { MAX_TURNS_AUTO_CONTINUE } from '../config.js'
import { getModelEngine } from './model-registry.js'
import {
  decideTurnsContinue,
  autoResumeCounts,
  overloadRetryCounts,
  overloadRetryPending,
  turnsContinueCounts,
} from './session-death.js'
import { sendFollowUp } from './session-followup.js'

// ── Auto-resume on account limit (objective 337) ──
//
// When a session dies because its Claude account hit a usage/spend limit, rotate
// the objective onto a fresh account and respawn it — completely uninterrupted —
// instead of parking it in `review` for a manual resume. The rotation reuses the
// proven sendFollowUp() respawn path: handleSessionDeath() has already deleted the
// session from activeSessions and cooled down the capped account via
// recordRateLimit(), so sendFollowUp falls through to its history-flattening
// respawn and pickAccount() lands on a fresh account.
//
// Stops (parks in review) only when EVERY Claude account is limited — and even
// then it is enqueued, so the account-router drain timer auto-resumes it the
// moment the earliest cooldown expires (≤5h). Codex (single ChatGPT account) has
// no pool to rotate through, so it is skipped and falls back to normal behavior.
const AUTO_RESUME_MESSAGE =
  'AUTO-RESUME: the account you were running on hit its usage/spend limit, so you have been ' +
  'automatically moved to a fresh account. Continue the work exactly where you left off — pick ' +
  'up from your last action and carry on to completion. No work was lost.'

// Circuit breaker. The PRIMARY terminator is the account cooldown chain
// (pickAccount() returns null once all accounts are limited → enqueue → drain),
// which naturally bounds rotations to the size of the pool. This counter only
// guards against a pathological tight loop (e.g. a non-limit error misclassified
// as a limit that respawns and instantly dies again). Keyed by sessionId, which
// sendFollowUp preserves across respawns, so it counts rotations within one
// logical session; a genuinely new session gets a new id and a fresh count.
const MAX_AUTO_RESUMES = 8

export type AutoResumeOutcome = 'rotated' | 'exhausted' | 'skipped'

/**
 * Attempt to auto-rotate a limit-killed session onto a fresh account.
 * - 'rotated'   → respawned on a fresh account under the same sessionId (caller keeps status 'working')
 * - 'exhausted' → all accounts limited; enqueued for drain auto-resume (caller parks in 'review' + notifies)
 * - 'skipped'   → codex / circuit-breaker tripped (caller falls back to normal review parking)
 */
export function autoResumeOnLimit(sessionId: string, objective: Objective): AutoResumeOutcome {
  if (getModelEngine(objective.model) === 'codex' || getModelEngine(objective.model) === 'grok') return 'skipped'

  const count = autoResumeCounts.get(sessionId) || 0
  if (count >= MAX_AUTO_RESUMES) {
    console.warn(`[session-manager] Auto-resume circuit breaker (${MAX_AUTO_RESUMES}) hit for ${sessionId} — parking for human review`)
    autoResumeCounts.delete(sessionId)
    return 'skipped'
  }

  // Probe availability. pickAccount() is a pure selector (no reservation side
  // effect), so calling it here and again inside sendFollowUp is safe.
  if (!pickAccount()) {
    enqueueSession(objective.id)
    autoResumeCounts.delete(sessionId)
    console.log(`[session-manager] All Claude accounts limited — objective ${objective.id} queued for drain auto-resume`)
    return 'exhausted'
  }

  autoResumeCounts.set(sessionId, count + 1)
  console.log(`[session-manager] Auto-rotating objective ${objective.id} (session ${sessionId}) to a fresh account after limit (attempt ${count + 1}/${MAX_AUTO_RESUMES})`)
  sendFollowUp(sessionId, AUTO_RESUME_MESSAGE, objective)
  return 'rotated'
}

// ── Auto-retry on Anthropic overload (HTTP 529) ──
//
// A 529 "Overloaded" is a GLOBAL Anthropic capacity error: every account talks
// to the same overloaded API, so it hits "all threads" at once and rotating
// accounts is pointless (and would wrongly burn the limit-rotation budget). The
// right response is to wait and retry the SAME session, giving Anthropic time to
// recover. We respawn via the proven sendFollowUp() resume path after an
// exponential backoff, bounded so a sustained outage eventually parks the
// objective for human review instead of looping forever. (2026-06-22)
const OVERLOAD_RESUME_MESSAGE =
  'AUTO-RETRY: the Anthropic API returned an Overloaded (529) error — a transient capacity ' +
  'issue on Anthropic\u2019s side, not a problem with your work or your account. You have been ' +
  'automatically resumed. Continue exactly where you left off and carry on to completion. No work was lost.'

const MAX_OVERLOAD_RETRIES = 4
const OVERLOAD_BACKOFF_MS = [5_000, 15_000, 45_000, 90_000]

/** True while a 529 backoff respawn is scheduled — the poller skips re-handling
 *  the (currently dead) tmux session during the wait so it isn't double-routed. */
export function isOverloadRetryPending(sessionId: string): boolean {
  return overloadRetryPending.has(sessionId)
}

export type OverloadOutcome = 'retrying' | 'skipped'

/**
 * Attempt to ride out an Anthropic 529 by retrying the same session after a
 * backoff.
 * - 'retrying' → a delayed resume is scheduled (caller keeps status 'working')
 * - 'skipped'  → codex (different API) or retry budget exhausted (caller parks in review)
 */
export function autoResumeOnOverload(sessionId: string, objective: Objective): OverloadOutcome {
  // Codex runs on the ChatGPT API, not Anthropic — a 529 here wouldn't originate
  // from the Claude pool, so let the normal review path handle it.
  if (getModelEngine(objective.model) === 'codex' || getModelEngine(objective.model) === 'grok') return 'skipped'

  const count = overloadRetryCounts.get(sessionId) || 0
  if (count >= MAX_OVERLOAD_RETRIES) {
    console.warn(`[session-manager] Overload retry budget (${MAX_OVERLOAD_RETRIES}) exhausted for ${sessionId} — parking for human review`)
    overloadRetryCounts.delete(sessionId)
    return 'skipped'
  }

  const delay = OVERLOAD_BACKOFF_MS[Math.min(count, OVERLOAD_BACKOFF_MS.length - 1)]
  overloadRetryCounts.set(sessionId, count + 1)
  overloadRetryPending.add(sessionId)
  console.log(`[session-manager] Anthropic overloaded (529) — retrying objective ${objective.id} (session ${sessionId}) in ${delay / 1000}s (attempt ${count + 1}/${MAX_OVERLOAD_RETRIES})`)

  setTimeout(() => {
    overloadRetryPending.delete(sessionId)
    try {
      // Re-read the objective: a human may have moved it (done/review/cancelled)
      // during the backoff, in which case we must NOT resurrect it.
      const fresh = getDb().prepare('SELECT * FROM objectives WHERE id = ?').get(objective.id) as Objective | undefined
      const obj = fresh || objective
      if (obj.status !== 'working') {
        console.log(`[session-manager] Overload retry for ${sessionId} aborted — objective ${objective.id} no longer working (status=${obj.status})`)
        return
      }
      sendFollowUp(sessionId, OVERLOAD_RESUME_MESSAGE, obj)
    } catch (err) {
      console.error(`[session-manager] Overload retry respawn failed for ${sessionId}:`, err)
    }
  }, delay)

  return 'retrying'
}

// ── Auto-continue on max-turns exhaustion (obj 1487) ──
//
// The per-spawn `--max-turns` cap (SPAWN_MAX_TURNS) is an ST3 runaway backstop.
// When a PRODUCTIVE worker clips it, the CLI exits with an `error_max_turns`
// result and handleSessionDeath flags turnsExhausted — but the work is healthy
// and merely paused, so we resume the SAME session (claude --resume via the
// proven sendFollowUp path) and let it carry on, instead of dumping it to a
// manual Resume in `review`.
//
// BOUNDED so a genuine runaway is still stopped: each resume gets a fresh
// SPAWN_MAX_TURNS budget, so a true loop keeps re-hitting the cap; once an
// objective has been auto-continued MAX_TURNS_AUTO_CONTINUE times in a row we
// stop and fall through to normal review routing. The cumulative cost/token
// ceilings and the idle/wall-clock watchdog bound runaways independently, so
// this can never spin forever even if mis-tuned. Counter is in-memory (cleared
// on restart and on any non-turns death), mirroring autoResumeCounts.
const TURNS_RESUME_MESSAGE =
  'AUTO-CONTINUE: your previous turn ran out of its per-spawn turn budget (--max-turns) while ' +
  'you were still making progress — this is a safety cap, not a problem with your work or your ' +
  'account. You have been automatically resumed in the SAME session. Continue exactly where you ' +
  'left off and carry on to completion. No work was lost.'


export type TurnsOutcome = 'continued' | 'exhausted' | 'skipped'

/**
 * Attempt to auto-continue a session that died because it exhausted its
 * per-spawn turn budget.
 * - 'continued' → resumed the SAME session (caller keeps status 'working')
 * - 'exhausted' → auto-continue bound reached / disabled (caller routes to review)
 * - 'skipped'   → codex engine (its `--max-turns` equivalent isn't ours to manage)
 */
export function autoResumeOnTurns(sessionId: string, objective: Objective): TurnsOutcome {
  // `--max-turns` is a Claude-CLI flag; the Codex engine carries its own caps,
  // so a turns-exhausted death can't originate from our turn cap there. Let the
  // normal review path handle it.
  if (getModelEngine(objective.model) === 'codex' || getModelEngine(objective.model) === 'grok') return 'skipped'

  const count = turnsContinueCounts.get(sessionId) || 0
  const decision = decideTurnsContinue({ count, max: MAX_TURNS_AUTO_CONTINUE })
  if (!decision.continue) {
    console.warn(`[session-manager] Max-turns auto-continue budget (${MAX_TURNS_AUTO_CONTINUE}) exhausted/disabled for ${sessionId} — parking for human review`)
    turnsContinueCounts.delete(sessionId)
    return 'exhausted'
  }

  turnsContinueCounts.set(sessionId, count + 1)
  console.log(`[session-manager] Auto-continuing objective ${objective.id} (session ${sessionId}) after max_turns (attempt ${count + 1}/${MAX_TURNS_AUTO_CONTINUE})`)
  sendFollowUp(sessionId, TURNS_RESUME_MESSAGE, objective)
  return 'continued'
}
