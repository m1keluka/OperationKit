// ── Objective lifecycle audit + reactivation guard (obj 700415) ──────────────
//
// Two forensic root-causes (deliverables A & B, obj 700411/700413) shared one
// enabler: the board had NO status-transition/reactivation/delete audit trail
// (`activity_log` records decisions/blockers/milestones but never a status
// change or a delete), so a resurrected or vanished objective left no trace of
// who moved it, when, or via which pathway. This module is that trail plus the
// flag readers + the human-terminal reactivation guard that FIX A/B rely on.
//
// Append-only: `objective_audit` rows are INSERTed here and never updated or
// deleted. Every write is best-effort — an audit failure must never break the
// mutation it is recording (fail-open, log to console).

import type { Database } from 'better-sqlite3'

export type AuditEventType =
  | 'status_change'
  | 'reactivate'
  | 'delete_soft'
  | 'delete_hard'
  | 'create'

export interface AuditEntry {
  objectiveId: number
  eventType: AuditEventType
  fromStatus?: string | null
  toStatus?: string | null
  /** 'user' | 'machine' | 'state-poller' | 'queue-drain' | … — free text. */
  actor?: string | null
  /** The code pathway that performed the mutation (for forensics). */
  pathway: string
  sessionId?: string | null
  titleSnapshot?: string | null
  workspace?: string | null
}

/**
 * Append one row to the append-only `objective_audit` trail. Best-effort: a
 * failure (e.g. the table not yet migrated in an old DB) is logged and
 * swallowed so it can never break the mutation being audited.
 */
export function logObjectiveAudit(db: Database, entry: AuditEntry): void {
  try {
    db.prepare(
      `INSERT INTO objective_audit
         (objective_id, event_type, from_status, to_status, actor, pathway, session_id, title_snapshot, workspace)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      entry.objectiveId,
      entry.eventType,
      entry.fromStatus ?? null,
      entry.toStatus ?? null,
      entry.actor ?? null,
      entry.pathway,
      entry.sessionId ?? null,
      entry.titleSnapshot ?? null,
      entry.workspace ?? null,
    )
  } catch (err) {
    console.error('[objective-audit] failed to append audit row:', err)
  }
}

// ── Feature flags ────────────────────────────────────────────────────────────

function envTrue(v: string | undefined): boolean {
  const s = (v || '').toLowerCase()
  return s === '1' || s === 'true' || s === 'yes' || s === 'on'
}
function envFalse(v: string | undefined): boolean {
  const s = (v || '').toLowerCase()
  return s === '0' || s === 'false' || s === 'no' || s === 'off'
}

/**
 * FIX A — kill the MODE-1 dead-session re-park churn. DEFAULT ON. Only OFF when
 * `CC_POLL_CLEAR_DEAD_SESSION` is explicitly set to a falsey value. This is the
 * one flag whose default changes behavior vs. main (it stops the churn).
 */
export function isClearDeadSessionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (envFalse(env.CC_POLL_CLEAR_DEAD_SESSION)) return false
  return true
}

/**
 * FIX B — human-terminal reactivation guard. DEFAULT OFF (dry-run: log
 * "WOULD block" and proceed). ON via env `CC_HUMAN_TERMINAL_GUARD` or a
 * `human_terminal_guard_enabled` settings row. When ON, a machine reactivation
 * of a `terminal_by_human` objective is skipped.
 */
export function isHumanTerminalGuardEnabled(
  db: Database,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (envTrue(env.CC_HUMAN_TERMINAL_GUARD)) return true
  try {
    const row = db
      .prepare("SELECT value FROM settings WHERE key = 'human_terminal_guard_enabled'")
      .get() as { value?: string } | undefined
    return row?.value === '1' || row?.value === 'true'
  } catch {
    return false
  }
}

/**
 * Soft-delete. DEFAULT OFF (hard delete preserved). ON via `settings.soft_delete_enabled`
 * (the canonical lever) or env `CC_SOFT_DELETE`.
 */
export function isSoftDeleteEnabled(
  db: Database,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (envTrue(env.CC_SOFT_DELETE)) return true
  try {
    const row = db
      .prepare("SELECT value FROM settings WHERE key = 'soft_delete_enabled'")
      .get() as { value?: string } | undefined
    return row?.value === '1' || row?.value === 'true'
  } catch {
    return false
  }
}

// ── Human-terminal reactivation guard ────────────────────────────────────────

/** Parked / terminal statuses a MACHINE pathway would reactivate FROM. A
 *  `working` row is NOT here on purpose: account-limit/overload/max-turns
 *  auto-resume act on an already-`working` session (same session_id rotate),
 *  never a parked→working reactivation, so keying the guard on this set leaves
 *  those legitimate auto-resumes completely untouched. */
export const PARKED_STATUSES = new Set(['queue', 'review', 'ai_review', 'done', 'planning'])

export interface GuardObjective {
  id: number
  status: string
  terminal_by_human?: number | boolean | null
  session_id?: string | null
  title?: string | null
  workspace?: string | null
}

export interface GuardResult {
  /** True only when the guard is ENFORCING (flag ON) and the reactivation must be skipped. */
  blocked: boolean
}

/**
 * Decide whether a MACHINE pathway may reactivate `obj` into `working`.
 *
 * - Only a parked→working reactivation of a `terminal_by_human` objective is
 *   ever a candidate. An already-`working` row (account-limit auto-resume) and
 *   an explicit human reopen both short-circuit to `{blocked:false}` with NO
 *   audit row — they are legitimate and must be preserved in BOTH flag states.
 * - When it IS a candidate: append a `reactivate` audit row, then either skip
 *   (flag ON) or log "WOULD block" and proceed (flag OFF, the default dry-run).
 */
export function checkHumanTerminalReactivation(
  db: Database,
  obj: GuardObjective,
  pathway: string,
  opts: { explicitHumanReopen?: boolean } = {},
  env: NodeJS.ProcessEnv = process.env,
): GuardResult {
  // Not a parked→working reactivation (e.g. already 'working' auto-resume) → never guarded.
  if (!PARKED_STATUSES.has(obj.status)) return { blocked: false }
  // An explicit human reopen is intentional → always allowed.
  if (opts.explicitHumanReopen) return { blocked: false }
  // Not human-terminated → normal machine reactivation, allowed, nothing to audit.
  if (!obj.terminal_by_human) return { blocked: false }

  logObjectiveAudit(db, {
    objectiveId: obj.id,
    eventType: 'reactivate',
    fromStatus: obj.status,
    toStatus: 'working',
    actor: 'machine',
    pathway,
    sessionId: obj.session_id ?? null,
    titleSnapshot: obj.title ?? null,
    workspace: obj.workspace ?? null,
  })

  if (isHumanTerminalGuardEnabled(db, env)) {
    console.warn(`[terminal-guard] BLOCKED reactivation of #${obj.id} via ${pathway} (terminal_by_human)`)
    return { blocked: true }
  }
  console.warn(`[terminal-guard] WOULD block reactivation of #${obj.id} via ${pathway} (dry-run; terminal_by_human)`)
  return { blocked: false }
}
