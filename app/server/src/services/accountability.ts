/**
 * Writers for the accountability record (obj 900367, Stage 1) — §3.2/§3.3 of
 * `architecture/2026-11-08-accountable-leads-and-decision-queue.md`.
 *
 * The columns themselves are plain text; this module is the sanctioned path
 * that keeps the design's central rule true: **the accountability record is
 * written by the worker, the lead or the server — never inferred by a chat
 * model.** Concretely that means
 *
 *   - `next_action` / `next_check_at` / `waiting_on` are DECLARED by whoever
 *     caused the state, through `setAccountability`. Nothing in the server reads
 *     a transcript and guesses them.
 *   - `last_meaningful_progress_at` is written ONLY by the server, and only for
 *     an event class on the allowlist below. No caller can set it to an
 *     arbitrary time, because a card that can claim its own freshness can never
 *     be found stalled.
 *
 * The classifier that reads all of this is `lib/accountability.ts` — pure, no DB.
 */
import type Database from 'better-sqlite3'
import { initAccountabilitySchema } from '../db/schema/accountability.js'
import {
  classifyAccountability,
  formatWaitingOn,
  isValidTerminalReason,
  parseWaitingOn,
  type AccountabilityVerdict,
  type WaitingOn,
} from '../lib/accountability.js'

export class AccountabilityError extends Error {}

/**
 * The ONLY event classes that move `last_meaningful_progress_at` (§3.2).
 *
 * `updated_at` moves on status flicker, summary writes and PR-link edits, which
 * is exactly why it cannot answer "has anything actually happened". This
 * allowlist is the definition of "actually happened": a progress snapshot whose
 * step ADVANCED, a commit, a PR state change, an artifact write, a review
 * verdict, or a recorded decision.
 *
 * It is an allowlist rather than a denylist on purpose — a new event kind added
 * by a later migration defaults to NOT meaningful, so the staleness signal can
 * only be degraded deliberately, never by accident.
 */
export const MEANINGFUL_EVENT_CLASSES = [
  'progress_step',
  'commit',
  'pr_state',
  'artifact',
  'review_verdict',
  'decision',
] as const
export type MeaningfulEventClass = (typeof MEANINGFUL_EVENT_CLASSES)[number]

const ready = new WeakSet<object>()
function ensure(db: Database.Database): void {
  if (ready.has(db)) return
  initAccountabilitySchema(db)
  ready.add(db)
}

function hasObjectives(db: Database.Database): boolean {
  return (db.prepare('PRAGMA table_info(objectives)').all() as unknown[]).length > 0
}

export interface AccountabilityRecord {
  next_action: string | null
  next_check_at: string | null
  waiting_on: string | null
  last_meaningful_progress_at: string | null
  terminal_reason: string | null
}

export interface SetAccountabilityInput {
  next_action?: string | null
  next_check_at?: string | null
  /** Either the raw typed string (`human:operator`) or the parsed form. */
  waiting_on?: string | Pick<WaitingOn, 'party' | 'name'> | null
  terminal_reason?: string | null
}

function optText(v: unknown, field: string, max: number): string | null {
  if (v === undefined || v === null) return null
  if (typeof v !== 'string') throw new AccountabilityError(`${field} must be a string`)
  const t = v.trim()
  if (!t) return null
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

function optIso(v: unknown, field: string): string | null {
  const t = optText(v, field, 40)
  if (t === null) return null
  const ms = Date.parse(t)
  if (!Number.isFinite(ms)) throw new AccountabilityError(`${field} must be an ISO timestamp`)
  return new Date(ms).toISOString()
}

/**
 * Write the DECLARED part of the record. Only the keys present in `input` are
 * touched, so a worker updating `next_action` does not silently clear a lead's
 * `waiting_on`. Pass an explicit `null` to clear a field.
 *
 * `last_meaningful_progress_at` is deliberately NOT settable here — see
 * `recordMeaningfulProgress`.
 */
export function setAccountability(
  db: Database.Database,
  objectiveId: number,
  input: SetAccountabilityInput,
): AccountabilityRecord | null {
  ensure(db)
  if (!hasObjectives(db)) return null
  const sets: string[] = []
  const params: unknown[] = []

  if ('next_action' in input) {
    sets.push('next_action = ?')
    params.push(optText(input.next_action, 'next_action', 400))
  }
  if ('next_check_at' in input) {
    sets.push('next_check_at = ?')
    params.push(optIso(input.next_check_at, 'next_check_at'))
  }
  if ('waiting_on' in input) {
    const raw = input.waiting_on
    let value: string | null = null
    if (raw && typeof raw === 'object') value = formatWaitingOn(raw)
    else if (typeof raw === 'string') value = formatWaitingOn(parseWaitingOn(raw))
    sets.push('waiting_on = ?')
    params.push(value)
  }
  if ('terminal_reason' in input) {
    const reason = optText(input.terminal_reason, 'terminal_reason', 200)
    // A typo'd terminal reason is worse than none: it reads as "somebody said
    // why" while carrying no usable meaning, which is precisely the state §3.3
    // wants to make impossible. Refuse it instead.
    if (reason !== null && !isValidTerminalReason(reason)) {
      throw new AccountabilityError(`terminal_reason is not one of the typed reasons (§3.3): ${reason}`)
    }
    sets.push('terminal_reason = ?')
    params.push(reason)
  }
  if (!sets.length) return getAccountability(db, objectiveId)

  params.push(objectiveId)
  db.prepare(`UPDATE objectives SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  return getAccountability(db, objectiveId)
}

export function getAccountability(db: Database.Database, objectiveId: number): AccountabilityRecord | null {
  ensure(db)
  if (!hasObjectives(db)) return null
  const row = db.prepare(
    `SELECT next_action, next_check_at, waiting_on, last_meaningful_progress_at, terminal_reason
     FROM objectives WHERE id = ?`,
  ).get(objectiveId) as AccountabilityRecord | undefined
  return row ?? null
}

/**
 * Stamp `last_meaningful_progress_at` — the server's own write.
 *
 * `at` exists for replay/backfill callers, but it is clamped: a caller may not
 * stamp the FUTURE. A future timestamp would make the card permanently fresh and
 * therefore permanently un-stallable, which turns the one honest staleness
 * signal into a way to hide. Clamping to `now` keeps the column monotone and
 * truthful without rejecting a slightly-skewed clock.
 *
 * Returns the stamp written, or null when the class is not meaningful (a no-op
 * by design — the caller does not have to know the allowlist).
 */
export function recordMeaningfulProgress(
  db: Database.Database,
  objectiveId: number,
  eventClass: string,
  at: Date = new Date(),
  now: Date = new Date(),
): string | null {
  ensure(db)
  if (!(MEANINGFUL_EVENT_CLASSES as readonly string[]).includes(eventClass)) return null
  if (!hasObjectives(db)) return null
  const stampMs = Math.min(at.getTime(), now.getTime())
  const stamp = new Date(stampMs).toISOString()
  // Never move the column BACKWARDS. An out-of-order event (a retried webhook, a
  // replayed commit hook) must not make a card look staler than it is.
  db.prepare(
    `UPDATE objectives SET last_meaningful_progress_at = ?
     WHERE id = ? AND (last_meaningful_progress_at IS NULL OR last_meaningful_progress_at < ?)`,
  ).run(stamp, objectiveId, stamp)
  const row = db.prepare('SELECT last_meaningful_progress_at AS v FROM objectives WHERE id = ?').get(objectiveId) as { v: string | null } | undefined
  return row?.v ?? null
}

/**
 * Did this progress snapshot ADVANCE the step? Only then is it meaningful.
 *
 * A worker re-posting "step 2 of 5" with a new note is a status update, not
 * progress — counting it would let a card look alive forever by narrating. The
 * first snapshot on a card counts (there was nothing before it).
 */
export function isStepAdvance(previousStep: number | null | undefined, nextStep: number | null | undefined): boolean {
  if (nextStep == null) return false
  if (previousStep == null) return true
  return nextStep > previousStep
}

/** How long with no meaningful progress before the server will say `stalled`. */
export function stalledWindowMinutes(db: Database.Database): number | null {
  // No default, on purpose (design §10 M3): the expectation window is Operator's
  // tolerance call, not an engineering constant. Until `settings
  // .accountability_stalled_after_minutes` is set, the server never infers
  // `stalled` at all — the inference ships default-OFF rather than paging on a
  // number nobody chose.
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'accountability_stalled_after_minutes'").get() as { value?: string } | undefined
    const n = Number(row?.value)
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

export interface ObjectiveAccountabilityView extends AccountabilityRecord {
  objective_id: number
  verdict: AccountabilityVerdict
}

/** Classify one card from its stored row. The read side of the record. */
export function classifyObjective(
  db: Database.Database,
  objectiveId: number,
  now: Date = new Date(),
): ObjectiveAccountabilityView | null {
  ensure(db)
  if (!hasObjectives(db)) return null
  const row = db.prepare(
    `SELECT id, status, has_blockers, blocked_reason, ai_review_verdict, needs_secret, session_id,
            waiting_on, next_check_at, last_meaningful_progress_at, next_action, terminal_reason, updated_at
     FROM objectives WHERE id = ?`,
  ).get(objectiveId) as (Record<string, unknown> & { id: number }) | undefined
  if (!row) return null
  const verdict = classifyAccountability(row as never, now, { stalledAfterMinutes: stalledWindowMinutes(db) })
  return {
    objective_id: row.id,
    next_action: (row.next_action as string | null) ?? null,
    next_check_at: (row.next_check_at as string | null) ?? null,
    waiting_on: (row.waiting_on as string | null) ?? null,
    last_meaningful_progress_at: (row.last_meaningful_progress_at as string | null) ?? null,
    terminal_reason: (row.terminal_reason as string | null) ?? null,
    verdict,
  }
}

/**
 * Like `services/review-items.ts`, every function above takes the `Database`
 * handle explicitly and this module does not import `getDb`. Callers resolve the
 * process DB themselves; see the note in that module for why.
 */
