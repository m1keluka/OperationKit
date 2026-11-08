/**
 * Durable approval/block before anything consequential (obj 900323, G-approval).
 *
 * The read-only MVP executes NO consequential action. That is the point, and it
 * is why this module's main export is a REFUSAL rather than an executor:
 * `requestApproval` records what was asked for and stops. Nothing in this
 * repository consumes an approval to then go and send, post, buy or delete —
 * wiring that is deliberately out of scope, and a later round that adds it must
 * add it HERE, against a record that already exists, rather than inventing a
 * second path.
 *
 * What "durable" has to mean, and each clause is a failure we are preventing:
 *
 *  - **Survives a restart.** It is a SQLite row, not a Map. Every in-memory
 *    approval is re-armed by a deploy, and self-deploy is an in-session action.
 *  - **Names the action AND its inputs.** `action_fingerprint` is SHA-256 over
 *    the kind plus the CANONICAL (key-sorted) inputs, so approving "email
 *    dana@example.com" cannot be replayed to authorise emailing someone else,
 *    and approving a $10 purchase cannot authorise a $1,000 one.
 *  - **Single use.** An approval moves to `consumed` under a conditional UPDATE.
 *    Two concurrent attempts race on the DB, and exactly one wins.
 *  - **Block is durable too, and it wins.** A blocked fingerprint stays blocked;
 *    `decide` refuses to turn a block into an approval, so an agent cannot
 *    re-ask until it gets the answer it wants. A new decision needs a new
 *    request, which is visible as a new row.
 */
import crypto from 'crypto'
import type { Database } from 'better-sqlite3'

/** Action kinds the MVP recognises. All of them are REFUSED at runtime. */
export const CONSEQUENTIAL_KINDS = ['send_email', 'post_message', 'purchase', 'destructive_write', 'external_call'] as const
export type ConsequentialKind = (typeof CONSEQUENTIAL_KINDS)[number]

export interface ApprovalRow {
  id: number
  objective_id: number | null
  thread_user_id: number
  thread_agent_slug: string
  action_kind: string
  action_fingerprint: string
  inputs_json: string
  state: 'pending' | 'approved' | 'blocked' | 'consumed'
  decided_by: number | null
  decided_at: string | null
  consumed_at: string | null
  note: string | null
  created_at: string
}

/** Stable JSON: object keys sorted at every depth, so key order cannot change the hash. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
}

export function actionFingerprint(kind: string, inputs: unknown): string {
  return crypto.createHash('sha256').update(`${kind}\u0000${canonicalJson(inputs)}`).digest('hex')
}

export interface RequestApprovalInput {
  db: Database
  objectiveId: number | null
  threadUserId: number
  threadAgentSlug: string
  kind: string
  inputs: unknown
}

export interface ApprovalDecision {
  /** Always false in the MVP: a read-only job never executes a consequential action. */
  executed: false
  state: ApprovalRow['state']
  fingerprint: string
  approvalId: number
  reason: string
}

/**
 * Record a request for a consequential action and REFUSE to perform it.
 *
 * Idempotent on the fingerprint while a decision is outstanding: asking twice
 * for the identical action returns the same pending row rather than stacking
 * requests. An already-blocked fingerprint short-circuits to `blocked`.
 */
export function requestApproval(input: RequestApprovalInput): ApprovalDecision {
  const { db } = input
  const fingerprint = actionFingerprint(input.kind, input.inputs)
  const existing = db
    .prepare("SELECT * FROM bot_action_approvals WHERE action_fingerprint = ? AND state IN ('pending', 'approved', 'blocked') ORDER BY id DESC LIMIT 1")
    .get(fingerprint) as ApprovalRow | undefined
  if (existing) {
    return {
      executed: false,
      state: existing.state,
      fingerprint,
      approvalId: existing.id,
      reason:
        existing.state === 'blocked'
          ? `This exact action is BLOCKED (approval #${existing.id}). It will not run, and asking again does not change that.`
          : existing.state === 'approved'
            ? `This exact action is approved (approval #${existing.id}) but the read-only MVP still does not execute it — no external action path exists.`
            : `Recorded; waiting for a person to approve or block (approval #${existing.id}). Nothing has been sent, posted, bought or deleted.`,
    }
  }
  const info = db
    .prepare(
      `INSERT INTO bot_action_approvals (objective_id, thread_user_id, thread_agent_slug, action_kind, action_fingerprint, inputs_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(input.objectiveId, input.threadUserId, input.threadAgentSlug, input.kind, fingerprint, canonicalJson(input.inputs))
  return {
    executed: false,
    state: 'pending',
    fingerprint,
    approvalId: Number(info.lastInsertRowid),
    reason: `Recorded; waiting for a person to approve or block (approval #${Number(info.lastInsertRowid)}). Nothing has been sent, posted, bought or deleted.`,
  }
}

export type DecideResult = { ok: true; row: ApprovalRow } | { ok: false; error: string }

/** A person decides. A block is final for that fingerprint. */
export function decideApproval(db: Database, id: number, decision: 'approved' | 'blocked', userId: number, note?: string): DecideResult {
  const row = db.prepare('SELECT * FROM bot_action_approvals WHERE id = ?').get(id) as ApprovalRow | undefined
  if (!row) return { ok: false, error: `No approval #${id}.` }
  if (row.state === 'consumed') return { ok: false, error: `Approval #${id} was already used.` }
  if (row.state === 'blocked') return { ok: false, error: `Approval #${id} is blocked. A block is durable: file a NEW request rather than re-deciding this one.` }
  db.prepare("UPDATE bot_action_approvals SET state = ?, decided_by = ?, decided_at = datetime('now'), note = ? WHERE id = ?").run(decision, userId, note ?? null, id)
  return { ok: true, row: db.prepare('SELECT * FROM bot_action_approvals WHERE id = ?').get(id) as ApprovalRow }
}

export type ConsumeResult =
  | { ok: true; approvalId: number }
  | { ok: false; code: 'no_approval' | 'blocked' | 'already_used' | 'pending'; error: string }

/**
 * Claim an approval for one execution attempt. The conditional UPDATE is the
 * single-use guarantee: a race resolves in the database, not in the caller.
 * Callers must treat `ok: false` as "do not act" for every code, including
 * `no_approval` — this is a fail-CLOSED gate.
 */
export function consumeApproval(db: Database, kind: string, inputs: unknown): ConsumeResult {
  const fingerprint = actionFingerprint(kind, inputs)
  const row = db
    .prepare('SELECT * FROM bot_action_approvals WHERE action_fingerprint = ? ORDER BY id DESC LIMIT 1')
    .get(fingerprint) as ApprovalRow | undefined
  if (!row) return { ok: false, code: 'no_approval', error: 'No approval exists for this exact action and its inputs.' }
  if (row.state === 'blocked') return { ok: false, code: 'blocked', error: `Blocked by approval #${row.id}.` }
  if (row.state === 'consumed') return { ok: false, code: 'already_used', error: `Approval #${row.id} has already been used once.` }
  if (row.state === 'pending') return { ok: false, code: 'pending', error: `Approval #${row.id} has not been decided yet.` }
  const claimed = db
    .prepare("UPDATE bot_action_approvals SET state = 'consumed', consumed_at = datetime('now') WHERE id = ? AND state = 'approved'")
    .run(row.id)
  if (claimed.changes !== 1) return { ok: false, code: 'already_used', error: `Approval #${row.id} was claimed by another attempt.` }
  return { ok: true, approvalId: row.id }
}

export function listApprovals(db: Database, objectiveId: number): ApprovalRow[] {
  return db.prepare('SELECT * FROM bot_action_approvals WHERE objective_id = ? ORDER BY id DESC').all(objectiveId) as ApprovalRow[]
}
