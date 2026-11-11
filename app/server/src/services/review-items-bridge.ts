/**
 * Where existing signals become queue items / withdrawals (obj 900367, Stage 1).
 *
 * Deliberately a THIN seam, and deliberately fed only from signals that ALREADY
 * EXIST (design §9: "fed only from signals that already exist — no new
 * detectors"). Stage 1 adds no watcher, no poller and no bot that re-reads the
 * board on a timer; it hangs off events the server is already handling.
 *
 * Every function here is defensive to the point of never throwing. These are
 * called from inside webhook and poller paths whose failure modes are already
 * understood, and a queue-bookkeeping error must never fail a PR-merge
 * recording or a status transition — the deliverable is more important than the
 * item about it. Failures are logged, loudly, because a swallowed-and-unlogged
 * failure is what made the obj 900309 defect undiagnosable.
 */
import type Database from 'better-sqlite3'
import { withdrawForTerminal } from './review-items.js'
import { recordMeaningfulProgress, setAccountability } from './accountability.js'

/**
 * A human merged the PR for these cards.
 *
 * This is the WITHDRAWAL half of the queue (§4.1) and the generalised form of
 * queued card 718941: for a PR-carrying card the merge **is** the sign-off, so
 * an open `signoff` item withdraws itself rather than sitting there asking for a
 * decision the human already made with a different gesture. That is the
 * mechanism that stops the review pile growing.
 *
 * Three things are deliberately NOT done here:
 *
 *  - **The card is not closed.** Moving it to `done` is card hygiene that
 *    belongs to 718941's own objective, whose human-sign-off terms this card is
 *    explicitly told not to change. We withdraw the item and stamp the terminal
 *    REASON; the status transition stays where it lives today.
 *  - **Only `signoff` and `approval` items withdraw.** A merge answers "should
 *    this ship" — it does not answer an unrelated `input_needed` or `failure`
 *    item on the same card, and clearing those would silently drop a question
 *    nobody answered.
 *  - **Nothing is merged, deployed, sent or posted.** This observes a merge a
 *    human already performed. It adds zero autonomy (§7.1).
 */
export function onPRMerged(db: Database.Database, objectiveIds: number[], now: Date = new Date()): void {
  for (const id of objectiveIds) {
    try {
      // A PR state change is a meaningful event class (§3.2) — the card
      // genuinely moved, so it is not stale.
      recordMeaningfulProgress(db, id, 'pr_state', now, now)
      setAccountability(db, id, { terminal_reason: 'delivered_merged', waiting_on: 'nobody' })
      withdrawForTerminal(db, id, 'delivered_merged', { kinds: ['signoff', 'approval'], actor: 'server:pr-merge' }, now)
    } catch (err) {
      console.error(`[review-items-bridge] onPRMerged failed for objective ${id}:`, (err as Error).message)
    }
  }
}

/**
 * A card stopped for a reason other than a merge. Stamps the typed terminal
 * reason and withdraws everything still in the queue about it, because nothing
 * about a stopped card is still decidable in the form it was asked.
 *
 * An INVALID reason is rejected by `setAccountability` rather than stored — and
 * the items are then left ALONE on purpose. A card that stopped without a valid
 * typed reason is itself supposed to raise a queue item (§3.3, "this stopped and
 * nobody said why"); silently clearing its queue would erase the only trace.
 */
export function onCardTerminal(db: Database.Database, objectiveId: number, terminalReason: string, now: Date = new Date()): void {
  try {
    setAccountability(db, objectiveId, { terminal_reason: terminalReason })
  } catch (err) {
    console.error(`[review-items-bridge] refusing untyped terminal reason for objective ${objectiveId}:`, (err as Error).message)
    return
  }
  try {
    withdrawForTerminal(db, objectiveId, terminalReason, { actor: 'server:terminal' }, now)
  } catch (err) {
    console.error(`[review-items-bridge] onCardTerminal failed for objective ${objectiveId}:`, (err as Error).message)
  }
}
