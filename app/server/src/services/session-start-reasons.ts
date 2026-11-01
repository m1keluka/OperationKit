/**
 * Restart reasons (obj 715699) — record WHO or WHAT flipped a card to working on
 * every session spawn / resume / attach / refusal.
 *
 * The spawn chokepoints (startSession, sendFollowUp's respawn, reopenObjective) are
 * reached from a dozen wake sources that don't share a call signature. Rather than
 * threading a `reason` argument through every one of them, a wake source calls
 * `noteStartReason(objectiveId, reason)` just before it triggers the start, and the
 * chokepoint `takeStartReason`s it when it records the session. A start nobody
 * attributed is recorded as `unattributed` — visible, so the gap can be closed.
 */
import type { Database } from 'better-sqlite3'
import { initLiveProgressSchema } from '../db/schema/live-progress.js'

/** Canonical reasons. Free-form strings are accepted too; these are the documented set. */
export const START_REASONS = [
  'board',               // a human clicked Start / moved the card on the board
  'agent',               // an API-key bot or a session via the internal API
  'follow_up',           // a message into the card thread (human or agent)
  'delegator_wake',      // [child-complete] wake of a parent
  'merge_lane',          // end-of-session merge lane: floor / oracle / outcome gate RED bounced the worker
  'ci_failure_followup', // "your PR's CI failed" automatic follow-up
  'resume_after_limit',  // account rate-limit auto-resume
  'resume_after_overload',
  'turns_continue',      // max-turns auto-continue
  'queue_drain',         // the account-pool queue drained
  'routine',             // a routine fired
  'fanout',              // parent fan-out tick started a queued child
  'reopen',              // done → working
  'ai_review_fail',      // adversarial reviewer FAIL bounced the card back to its worker
  'completion_gate',     // a done PATCH hit a floor / oracle / outcome gate and bounced the card back
  'plan_approved',       // planning → working on plan approval
  'decision_resolved',   // an owner resolved a decision request
  'noop_respawn',        // a no-op worker spawn was re-spawned
  'fresh_seeded_after_cap', // obj 64: resume skipped (chain over token/round cap) — fresh session seeded from a DB summary
  'unattributed',
] as const

export type SessionStartKind = 'spawn' | 'resume' | 'attach' | 'rejected'

export interface PendingStartReason {
  reason: string
  actor?: string | null
  detail?: string | null
}

const PENDING_TTL_MS = 2 * 60_000
const pending = new Map<number, PendingStartReason & { at: number }>()

/** Attribute the NEXT session start for `objectiveId`. Later notes overwrite earlier ones. */
export function noteStartReason(objectiveId: number, reason: string, actor?: string | null, detail?: string | null): void {
  if (!Number.isFinite(objectiveId)) return
  pending.set(objectiveId, { reason, actor: actor ?? null, detail: detail ?? null, at: Date.now() })
}

/** Consume the pending attribution (or `unattributed`). Peek with `consume=false`. */
export function takeStartReason(objectiveId: number, consume = true): PendingStartReason {
  const p = pending.get(objectiveId)
  if (!p || Date.now() - p.at > PENDING_TTL_MS) {
    if (p) pending.delete(objectiveId)
    return { reason: 'unattributed', actor: null, detail: null }
  }
  if (consume) pending.delete(objectiveId)
  return { reason: p.reason, actor: p.actor ?? null, detail: p.detail ?? null }
}

export function __resetPendingStartReasons(): void {
  pending.clear()
}

export interface SessionStartRow {
  id: number
  objective_id: number
  session_id: string | null
  kind: SessionStartKind
  reason: string
  actor: string | null
  detail: string | null
  created_at: string
}

let schemaReady = new WeakSet<object>()

function ensure(db: Database): void {
  if (schemaReady.has(db)) return
  initLiveProgressSchema(db as never)
  schemaReady.add(db)
}

export function __resetSessionStartSchemaCache(): void {
  schemaReady = new WeakSet<object>()
}

/**
 * Record a session start. Consumes the pending reason for the objective unless an
 * explicit one is passed. Never throws — attribution must not break a spawn.
 */
export function logSessionStart(
  db: Database,
  args: { objectiveId: number; sessionId: string | null; kind: SessionStartKind; reason?: PendingStartReason },
): SessionStartRow | null {
  try {
    ensure(db)
    // A refused/attached start keeps the pending note for the real spawn that may follow.
    const r = args.reason ?? takeStartReason(args.objectiveId, args.kind === 'spawn' || args.kind === 'resume')
    const info = db
      .prepare(
        `INSERT INTO session_starts (objective_id, session_id, kind, reason, actor, detail)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(args.objectiveId, args.sessionId, args.kind, r.reason, r.actor ?? null, r.detail ? String(r.detail).slice(0, 500) : null)
    // obj 64 — mirror the newest real start onto the card so the board can show it.
    if (args.kind === 'spawn' || args.kind === 'resume') {
      try {
        db.prepare("UPDATE objectives SET last_start_reason = ?, last_start_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?")
          .run(r.reason, args.objectiveId)
      } catch {}
    }
    return db.prepare('SELECT * FROM session_starts WHERE id = ?').get(info.lastInsertRowid) as SessionStartRow
  } catch (err) {
    console.warn(`[session-starts] failed to record start for obj ${args.objectiveId}:`, (err as Error).message)
    return null
  }
}

export function listSessionStarts(db: Database, objectiveId: number, limit = 20): SessionStartRow[] {
  ensure(db)
  return db
    .prepare('SELECT * FROM session_starts WHERE objective_id = ? ORDER BY id DESC LIMIT ?')
    .all(objectiveId, Math.max(1, Math.min(limit, 200))) as SessionStartRow[]
}
