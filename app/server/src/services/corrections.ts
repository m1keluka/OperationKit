import { getDb } from '../db/index.js'
import type { Correction } from '@command-center/shared'

/**
 * Human mistake-labeling surface (ST5).
 *
 * A `correction` is a structured human label — "this session got X wrong" —
 * tied to an objective. Each active correction is injected as a HIGH-PRIORITY
 * gotcha into the next spawn's context (see `context-builder.ts`), closing the
 * Karpathy-style loop where a human finding a mistake compounds into future
 * spawns instead of being lost.
 */

interface CorrectionRow {
  id: number
  objective_id: number
  session_id: string | null
  workspace: string | null
  agent_context: string | null
  label: string
  created_by: number | null
  active: number
  created_at: string
}

function mapRow(r: CorrectionRow): Correction {
  return {
    id: r.id,
    objective_id: r.objective_id,
    session_id: r.session_id,
    workspace: r.workspace,
    agent_context: r.agent_context,
    label: r.label,
    created_by: r.created_by,
    active: r.active === 1,
    created_at: r.created_at,
  }
}

/**
 * Record a human correction against an objective. workspace/agent_context/
 * session_id are snapshotted from the objective at insert time so the gotcha
 * can also warn sibling objectives of the same agent role in the workspace.
 * Returns the created row.
 */
export function recordCorrection(opts: {
  objectiveId: number
  label: string
  createdBy?: number | null
}): Correction {
  const db = getDb()
  const obj = db
    .prepare('SELECT id, workspace, agent_context, session_id FROM objectives WHERE id = ?')
    .get(opts.objectiveId) as
    | { id: number; workspace: string | null; agent_context: string | null; session_id: string | null }
    | undefined
  if (!obj) {
    throw new Error(`Objective ${opts.objectiveId} not found`)
  }

  const info = db
    .prepare(
      `INSERT INTO session_corrections
         (objective_id, session_id, workspace, agent_context, label, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      obj.id,
      obj.session_id,
      obj.workspace,
      obj.agent_context,
      opts.label,
      opts.createdBy ?? null,
    )

  const row = db
    .prepare('SELECT * FROM session_corrections WHERE id = ?')
    .get(info.lastInsertRowid) as CorrectionRow
  return mapRow(row)
}

/** List corrections for one objective, newest first. */
export function listCorrections(objectiveId: number): Correction[] {
  const db = getDb()
  const rows = db
    .prepare('SELECT * FROM session_corrections WHERE objective_id = ? ORDER BY created_at DESC, id DESC')
    .all(objectiveId) as CorrectionRow[]
  return rows.map(mapRow)
}

/**
 * Corrections relevant to a spawn for this objective, ranked so the
 * objective's own corrections come first, then recent same-workspace/same-agent
 * corrections. Used by the context-builder to inject high-priority gotchas.
 */
export function getCorrectionsForContext(opts: {
  objectiveId: number
  workspace: string | null
  agentContext: string | null
  limit?: number
}): Correction[] {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT * FROM session_corrections
       WHERE active = 1 AND (
         objective_id = ?
         OR (
           workspace = ? AND agent_context = ?
           AND workspace IS NOT NULL AND agent_context IS NOT NULL
           AND created_at > datetime('now', '-30 days')
         )
       )
       ORDER BY (objective_id = ?) DESC, created_at DESC, id DESC
       LIMIT ?`
    )
    .all(
      opts.objectiveId,
      opts.workspace,
      opts.agentContext,
      opts.objectiveId,
      opts.limit ?? 5,
    ) as CorrectionRow[]
  return rows.map(mapRow)
}
