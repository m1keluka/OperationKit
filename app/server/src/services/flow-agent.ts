/**
 * The `agent` node's child card (obj 900645, card B9 of docs/design/WORKFLOWS.md §4.4).
 *
 * An `agent` node hands a sub-goal to a FULL agent session: it files a normal
 * board card (origin `workflow`, a child of the workflow's home card) carrying the
 * resolved brief, parks the run on a `flow_wait_tokens` row (reason `agent`) and
 * resumes when the card reaches its disposition. All the existing card machinery
 * (worktree, ceilings, review, stall watchdog) applies unchanged.
 *
 * Split in two on purpose:
 *
 *  - `createFlowAgentCard()` is pure, synchronous DB work. The engine calls it
 *    INSIDE its fenced transaction together with the step row and the wait token,
 *    so a crash can never leave a card without the token that waits on it, or a
 *    token without its card (no duplicate child on resume).
 *  - `startFlowAgentCard()` runs after that commit: broadcast + the same internal
 *    status PATCH a routine uses to spawn a session. It never throws; a card it
 *    could not start stays in `queue` and the engine re-kicks it (see
 *    STRANDED_AGENT_KICK_MS in flow-engine.ts).
 *
 * When does the node resume? `agentCardOutcome()` is the one rule:
 *
 *   card status                         node
 *   done                                succeeded, disposition = job_disposition ?? 'complete'
 *   review + job_disposition set        succeeded with that disposition (the worker declared its outcome)
 *   cancelled                           failed `agent_cancelled` (not retried)
 *   deleted                             failed `agent_card_missing`
 *   anything else                       still waiting (`queue` with no session = stranded)
 *
 * The output the next node reads is `steps.<id>.output`:
 *   { objective_id, status, disposition, note, summary, pr_url, cost_usd }
 * `summary` is the card's `last_session_summary` — the deliverable statement.
 */
import type Database from 'better-sqlite3'
import { depthForParent } from '../lib/objective-depth.js'
import { getSpend, setObjectiveCeiling } from './job-accounting.js'

export interface FlowAgentCardRequest {
  runId: number
  flowId: number
  flowName: string
  nodeId: string
  nodeLabel: string | null
  /** Loop index; null outside a loop. */
  iteration: number | null
  workspace: string
  brief: string
  agent: string | null
  /** Cost ceiling pinned on the child card (the node's budget_usd, capped by what the run has left). */
  budgetUsd: number | null
  /** The workflow's home card: the child is filed under it. */
  homeObjectiveId: number | null
}

/** How the engine files and starts an agent node's child card. Injected so the engine stays DB-only in tests. */
export interface FlowAgentHost {
  /** Synchronous DB work only — runs inside the engine's fenced transaction. Returns the new objective id. */
  createCard(db: Database.Database, req: FlowAgentCardRequest): number
  /** After commit: make the card visible and start its session. Must not throw. */
  startCard?(objectiveId: number): void | Promise<void>
}

export interface FlowAgentOutput {
  objective_id: number
  status: string
  disposition: string
  note: string | null
  summary: string | null
  pr_url: string | null
  cost_usd: number
}

export type FlowAgentOutcome =
  | { state: 'pending'; stranded: boolean; status: string }
  | { state: 'done'; output: FlowAgentOutput; costUsd: number }
  | { state: 'failed'; type: 'agent_cancelled' | 'agent_card_missing'; title: string }

const TITLE_MAX = 200

export function flowAgentCardTitle(req: Pick<FlowAgentCardRequest, 'flowName' | 'nodeId' | 'nodeLabel' | 'iteration' | 'runId'>): string {
  const item = req.iteration === null ? '' : ` [item ${req.iteration}]`
  return `${req.flowName} · ${req.nodeLabel || req.nodeId}${item} (run #${req.runId})`.slice(0, TITLE_MAX)
}

export function flowAgentCardDescription(req: FlowAgentCardRequest): string {
  const where = req.iteration === null ? '' : `, loop item ${req.iteration}`
  const lines = [
    req.brief.trim(),
    '',
    '---',
    `Filed by step \`${req.nodeId}\` of the workflow **${req.flowName}** (run #${req.runId}${where}).`,
    'The workflow is paused until this card is done. Your final session summary is handed to the next step',
    `as \`steps.${req.nodeId}.output.summary\`, so make it the deliverable itself, not a narration of the work.`,
  ]
  if (req.budgetUsd !== null) lines.push(`Cost ceiling for this card: $${req.budgetUsd.toFixed(2)}.`)
  return lines.join('\n')
}

/** Insert the child card (status `queue`, origin `workflow`). Synchronous; the caller owns the transaction. */
export function createFlowAgentCard(db: Database.Database, req: FlowAgentCardRequest): number {
  let parentId: number | null = null
  let createdBy: number | null = null
  if (req.homeObjectiveId !== null) {
    const home = db.prepare('SELECT id, created_by FROM objectives WHERE id = ?').get(req.homeObjectiveId) as
      | { id: number; created_by: number | null }
      | undefined
    if (home) {
      parentId = home.id
      createdBy = home.created_by ?? null
    }
  }
  const r = db.prepare(
    `INSERT INTO objectives (title, description, agent_context, workspace, category, type, status, origin, parent_id, depth, created_by)
     VALUES (?, ?, ?, ?, 'general', 'task', 'queue', 'workflow', ?, ?, ?)`,
  ).run(
    flowAgentCardTitle(req),
    flowAgentCardDescription(req),
    req.agent || 'general',
    req.workspace,
    parentId,
    depthForParent(db, parentId),
    createdBy,
  )
  const id = Number(r.lastInsertRowid)
  if (req.budgetUsd !== null && req.budgetUsd > 0) {
    setObjectiveCeiling(db, id, { costUsd: req.budgetUsd, source: `flow_agent:run${req.runId}:${req.nodeId}` })
  }
  return id
}

/** Has the child card reached its disposition? */
export function agentCardOutcome(db: Database.Database, objectiveId: number): FlowAgentOutcome {
  const row = db.prepare(
    'SELECT id, status, session_id, job_disposition, job_review_note, last_session_summary, pr_url FROM objectives WHERE id = ?',
  ).get(objectiveId) as
    | {
        id: number; status: string; session_id: string | null; job_disposition: string | null
        job_review_note: string | null; last_session_summary: string | null; pr_url: string | null
      }
    | undefined
  if (!row) return { state: 'failed', type: 'agent_card_missing', title: `child card #${objectiveId} no longer exists` }
  if (row.status === 'cancelled') return { state: 'failed', type: 'agent_cancelled', title: `child card #${objectiveId} was cancelled` }
  const resolved = row.status === 'done' || (row.status === 'review' && !!row.job_disposition)
  if (!resolved) return { state: 'pending', stranded: row.status === 'queue' && !row.session_id, status: row.status }
  let costUsd = 0
  try { costUsd = getSpend(db, objectiveId).spentUsd } catch { /* no ledger row */ }
  return {
    state: 'done',
    costUsd,
    output: {
      objective_id: row.id,
      status: row.status,
      disposition: row.job_disposition ?? 'complete',
      note: row.job_review_note ?? null,
      summary: row.last_session_summary ?? null,
      pr_url: row.pr_url ?? null,
      cost_usd: costUsd,
    },
  }
}

/**
 * Host wiring: broadcast the new card and move it to `working` through the same
 * internal status PATCH a routine uses (session cap, duplicate guard and spawn
 * behave exactly as for any other card). Never throws.
 */
export async function startFlowAgentCard(objectiveId: number, reason = 'workflow_agent_node'): Promise<void> {
  try {
    const [{ getDb }, { broadcast }, { noteStartReason }, { internalApiHeaders }] = await Promise.all([
      import('../db/index.js'),
      import('../ws/index.js'),
      import('./session-start-reasons.js'),
      import('../lib/internal-api-headers.js'),
    ])
    const obj = getDb().prepare('SELECT * FROM objectives WHERE id = ?').get(objectiveId)
    if (obj) broadcast({ type: 'objective_updated', payload: obj as never })
    noteStartReason(objectiveId, reason, 'flow-engine')
    const port = parseInt(process.env.PORT || '3002', 10)
    const resp = await fetch(`http://127.0.0.1:${port}/api/internal/objectives/${objectiveId}/status`, {
      method: 'PATCH',
      headers: internalApiHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ status: 'working', reason: 'workflow', actor: 'flow-engine' }),
    })
    if (!resp.ok) {
      console.warn(`[flows] agent card #${objectiveId} created but not started: ${resp.status} ${(await resp.text()).slice(0, 200)}`)
    }
  } catch (err) {
    console.warn(`[flows] agent card #${objectiveId} start errored:`, err instanceof Error ? err.message : err)
  }
}

export const hostFlowAgentHost: FlowAgentHost = { createCard: createFlowAgentCard, startCard: (id) => startFlowAgentCard(id) }
