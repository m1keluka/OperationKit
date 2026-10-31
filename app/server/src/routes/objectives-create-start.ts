/**
 * Create-and-start for POST /api/objectives {start: true} (obj 714091).
 *
 * Runs the queue → working leg of PATCH /:id/status on a card that was just
 * inserted, under the same cap and lease gates, so an orchestrator can create
 * and dispatch in one call. The card is ALREADY committed when this runs, so no
 * outcome here may look like "nothing happened" — every response carries the
 * card (`objective`) and a `start` block saying whether it started and why not.
 *
 *   started            → 201 { ...objective, start: { started: true } }
 *   session cap        → 409 { error, objective, start: { started: false, reason: 'session_cap' } }
 *   lease conflict     → 409 { error, objective, start: { started: false, reason: 'lease_conflict' } }
 *   not startable      → 201 { ...objective, start: { started: false, reason: 'not_startable' } }
 *   spawn failure      → 201 { ...objective, start: { started: false, reason: 'start_failed' } }
 *
 * The non-started cases leave the card in its initial status (queue/planning),
 * where PATCH status=working can start it later. A spawn failure is a 201, not a
 * 5xx: the create succeeded, and a 5xx would invite a retry that duplicates the
 * card (and would not be stored under the Idempotency-Key).
 */
import type Database from 'better-sqlite3'
import type { Objective } from '@operationkit/shared'
import {
  startSession,
  BranchLeaseConflictError,
  SessionLeaseConflictError,
} from '../services/session-manager.js'
import { logObjectiveAudit } from '../services/objective-audit.js'
import { broadcast } from '../ws/index.js'
import { mapObjective } from './objectives-helpers.js'
import { sessionCapReached, SESSION_CAP_ERROR } from '../lib/session-cap.js'

export type StartReason = 'session_cap' | 'lease_conflict' | 'not_startable' | 'start_failed'

export interface StartOutcome {
  httpStatus: number
  body: Record<string, unknown>
}

function load(db: Database.Database, id: number): Objective {
  return db.prepare('SELECT * FROM objectives WHERE id = ?').get(id) as Objective
}

export async function startCreatedObjective(db: Database.Database, id: number): Promise<StartOutcome> {
  const created = load(db, id)
  const notStarted = (httpStatus: number, reason: StartReason, detail: string, error?: string): StartOutcome => {
    const objective = mapObjective(load(db, id))
    const start = { requested: true, started: false, status: objective.status, reason, detail }
    return {
      httpStatus,
      body: error ? { error, objective, start } : { ...objective, start },
    }
  }

  // Only a queued card has a session-starting transition. A project begins in
  // `planning` and must have its plan approved before it runs.
  if (created.status !== 'queue') {
    return notStarted(
      201,
      'not_startable',
      `Created in '${created.status}'; only queued cards can start on create. Approve the plan, then PATCH status=working.`,
    )
  }

  if (sessionCapReached(db)) {
    return notStarted(
      409,
      'session_cap',
      'Card created and left in queue. PATCH /api/objectives/{id}/status {"status":"working"} once a slot frees.',
      `${SESSION_CAP_ERROR} — card #${id} created but left in queue`,
    )
  }

  try {
    const sessionId = await startSession(created)
    db.prepare(
      "UPDATE objectives SET status = 'working', session_id = ?, terminal_by_human = 0, updated_at = datetime('now') WHERE id = ?",
    ).run(sessionId, id)
  } catch (err) {
    if (err instanceof BranchLeaseConflictError || err instanceof SessionLeaseConflictError) {
      return notStarted(409, 'lease_conflict', err.message, `${err.message} — card #${id} created but left in queue`)
    }
    const message = err instanceof Error ? err.message : 'Session start failed'
    console.error(`[objectives] create+start: session start failed for #${id}:`, message)
    return notStarted(201, 'start_failed', message)
  }

  logObjectiveAudit(db, {
    objectiveId: id,
    eventType: 'status_change',
    fromStatus: 'queue',
    toStatus: 'working',
    actor: 'user',
    pathway: 'public-create-start',
    sessionId: null,
    titleSnapshot: created.title,
    workspace: created.workspace,
  })

  const updated = mapObjective(load(db, id))
  broadcast({ type: 'objective_updated', payload: updated })
  return { httpStatus: 201, body: { ...updated, start: { requested: true, started: true, status: 'working' } } }
}
