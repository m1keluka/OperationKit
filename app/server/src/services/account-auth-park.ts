/**
 * Auth-failure parking for cards and dashboard alerts (obj 717767).
 *
 * When a seat's org disables Claude subscription access (403, usually a past-due
 * sub) or its OAuth dies, every session routed to it exits instantly with 0 tool
 * calls. The old path treated that as a limit → rotate/respawn, and the no-op
 * guard respawned it again, so each card burned 2-3 empty sessions and then
 * landed in review looking like a work failure. Here a 0-tool-call auth death
 * STOPS: the card is marked blocked (review + verdict 'blocked', never
 * ai_review) with the account LABEL named, and a dashboard alert is raised.
 * A mid-run auth death (tool calls > 0) still rotates — the work in flight is
 * worth resuming on a healthy seat.
 */
import type { Objective } from '@operationkit/shared'
import { getDb } from '../db/index.js'
import { broadcast } from '../ws/index.js'
import { runMachineStatusUpdate } from '../lib/status-lock.js'
import { getAccountLabel, type AuthParkReason } from './account-router.js'
import { insertAlert } from './notifier.js'
import { releaseBranchLease } from './branch-lease.js'
import { releaseSessionLeasesForObjective } from './session-lease.js'
import { deriveBranchName } from './branch-scope.js'

export type AuthDeathAction = 'block' | 'rotate' | 'none'

/**
 * Pure: what to do with a session death. Auth failure with 0 tool calls → block
 * (no respawn); auth failure after real work → rotate to a healthy seat; not an
 * auth failure → none (caller's normal limit/overload/review handling).
 */
export function decideAuthDeath(death: { authFailed: boolean; toolCalls: number }): AuthDeathAction {
  if (!death.authFailed) return 'none'
  return death.toolCalls === 0 ? 'block' : 'rotate'
}

export function authParkHeadline(reason: AuthParkReason): string {
  return reason === 'needs_admin' ? 'account needs admin' : 'account needs reconnect'
}

/** Card/alert text. Names the account LABEL only — never a credential, email or home dir. */
export function authParkMessage(label: string, reason: AuthParkReason): string {
  return reason === 'needs_admin'
    ? `Claude account "${label}" was rejected: its organization has disabled Claude subscription access (usually a past-due subscription). An admin must re-enable access; the slot is parked until a health check passes.`
    : `Claude account "${label}" failed to authenticate (OAuth expired or revoked). Reconnect it in System Dashboard → Accounts; the slot is parked until then.`
}

/**
 * Raise (dedup'd) a dashboard alert that a slot was parked. Shared by session
 * death and the slot health check. Never throws.
 */
export function raiseAccountParkedAlert(accountId: string, reason: AuthParkReason, context?: string): void {
  try {
    const label = getAccountLabel(accountId)
    const alert = insertAlert({
      severity: 'high',
      source: 'account-router',
      title: `Claude ${authParkHeadline(reason)}: ${label}`,
      message: authParkMessage(label, reason) + (context ? ` ${context}` : ''),
      dedup_key: `account-parked:${accountId}:${reason}`,
    })
    if (alert) broadcast({ type: 'alert', payload: alert })
  } catch (err) {
    console.warn('[account-auth-park] failed to raise alert:', err instanceof Error ? err.message : err)
  }
}

/**
 * Block a card whose session died on an auth failure before doing any work.
 * review + ai_review_verdict='blocked' is the codebase's existing "blocked"
 * card state (no-op guard, reviewer-no-verdict); session_id is cleared so the
 * poller stops re-handling the dead session, and leases are released so a
 * human reopen does a fresh spawn on a healthy seat. No respawn, no enqueue.
 */
export function blockObjectiveForAccountAuth(objective: Objective, accountId: string, reason: AuthParkReason): void {
  const db = getDb()
  const label = getAccountLabel(accountId)
  const findings = `BLOCKED — ${authParkHeadline(reason)}. ${authParkMessage(label, reason)} Session ended with 0 tool calls; not re-spawned and not reviewed.`

  const branch = deriveBranchName(objective)
  if (branch) {
    try { releaseBranchLease(db, branch) } catch { /* non-fatal */ }
  }
  try { releaseSessionLeasesForObjective(db, objective.id) } catch { /* non-fatal */ }

  runMachineStatusUpdate(
    db,
    "UPDATE objectives SET status = 'review', session_id = NULL, ai_review_verdict = 'blocked', ai_review_findings = ?, updated_at = datetime('now') WHERE id = ?",
    findings,
    objective.id,
  )
  try {
    db.prepare(
      `INSERT INTO activity_log (project, workspace, objective_id, session_id, event_type, title, detail)
       VALUES (?, ?, ?, ?, 'milestone', 'account_auth_blocked', ?)`
    ).run(objective.project || 'unknown', objective.workspace, objective.id, objective.session_id, findings)
  } catch (err) {
    console.error(`[account-auth-park] failed to log account_auth_blocked for obj ${objective.id}:`, err)
  }
  raiseAccountParkedAlert(accountId, reason, `Card #${objective.id} ("${objective.title}") was blocked.`)

  const updated = db.prepare('SELECT * FROM objectives WHERE id = ?').get(objective.id) as Objective | undefined
  if (updated) broadcast({ type: 'objective_updated', payload: updated })
  console.warn(`[account-auth-park] Objective ${objective.id} blocked (${reason}) on account ${accountId} — no respawn.`)
}
