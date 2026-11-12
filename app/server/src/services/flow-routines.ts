/**
 * Workflows ↔ routines + home cards (obj 900640, card B4 of docs/design/WORKFLOWS.md).
 *
 * §7.1: a routine gains a third kind, `kind='flow'`, with a `flow_id`. A flow's
 * `trigger.on='schedule'` IS that routine row — one source of truth for the cron —
 * created/updated when the flow is published. The existing scheduler (`tick()` in
 * routine-scheduler.ts) fires it; a fire queues a flow run instead of a card, and
 * the run is executed by the flow engine's own tick. Run-now, the over-fire guard
 * and the K-failure auto-pause come for free from the routine machinery.
 *
 * §7.2: every workflow has a HOME CARD (an objective with origin 'workflow',
 * linked by flow_definitions.objective_id). Runs do not create cards. The home
 * card is filed in status `done` so no sweep (queue auto-start, hygiene) ever
 * starts a session on it; later cards (B6 builder, B8 repair) move it.
 *
 * Everything here is DB-injected so it is testable on a temp DB.
 */
import type Database from 'better-sqlite3'
import type { FlowDefinition, TriggerNode } from '../../../shared/flow/types.js'
import { validateFlow } from '../../../shared/flow/validate.js'
import { initFlowSchema } from '../db/schema/flow.js'
import {
  FlowEngine, defaultFlowToolRegistry, flowsEnabled, getHostFlowEngine, recordedFlowApprovals, withRecordedApprovals,
} from './flow-engine.js'
import { validateCronExpr } from './routine-scheduler.js'
import { isDefinitionRot } from '../../../shared/flow/repair.js'

export interface FlowRow {
  id: number
  slug: string
  workspace: string
  name: string
  status: 'draft' | 'active' | 'paused' | 'archived'
  published_version: number | null
  objective_id: number | null
  created_by: string
  created_at: string
  updated_at: string
}

/** Routine name for a flow. `routines.name` is UNIQUE, so it embeds workspace + slug. */
export function flowRoutineName(workspace: string, slug: string): string {
  return `flow:${workspace}/${slug}`
}

export function getFlowRow(db: Database.Database, flowId: number): FlowRow | null {
  initFlowSchema(db)
  return (db.prepare('SELECT * FROM flow_definitions WHERE id = ?').get(flowId) as FlowRow | undefined) ?? null
}

export function loadFlowVersion(db: Database.Database, flowId: number, version: number): FlowDefinition | null {
  const row = db.prepare('SELECT definition_json FROM flow_versions WHERE flow_id = ? AND version = ?').get(flowId, version) as
    | { definition_json: string }
    | undefined
  if (!row) return null
  try {
    return JSON.parse(row.definition_json) as FlowDefinition
  } catch {
    return null
  }
}

export function latestFlowVersion(db: Database.Database, flowId: number): number | null {
  const r = db.prepare('SELECT MAX(version) v FROM flow_versions WHERE flow_id = ?').get(flowId) as { v: number | null }
  return r.v ?? null
}

export function triggerOf(def: FlowDefinition | null): TriggerNode | null {
  if (!def || !Array.isArray(def.nodes)) return null
  return (def.nodes.find((n) => n && n.kind === 'trigger') as TriggerNode | undefined) ?? null
}

/**
 * An engine to QUEUE runs with. `startRun` only inserts a `flow_runs` row; the
 * host engine's tick executes it. Prefer the host engine; otherwise (tests, a
 * scratch instance, the engine not armed yet) build a write-only one on `db`.
 */
const writeEngines = new WeakMap<Database.Database, FlowEngine>()
export function flowEngineFor(db: Database.Database): FlowEngine {
  const host = getHostFlowEngine()
  if (host && host.db === db) return host
  let e = writeEngines.get(db)
  if (!e) {
    e = new FlowEngine({ db, tools: defaultFlowToolRegistry })
    writeEngines.set(db, e)
  }
  return e
}

// ── Home card (§7.2) ────────────────────────────────────────────────────────

export function homeCardDescription(flow: Pick<FlowRow, 'id' | 'slug' | 'workspace' | 'name'>): string {
  return [
    `Home card of the workflow **${flow.name}** (\`${flow.slug}\`, workspace \`${flow.workspace}\`).`,
    '',
    `Diagram, versions and runs: [Jobs → Workflows](/jobs?view=workflows&flow=${flow.id}).`,
    '',
    'Individual runs do not create cards. Repair proposals and approvals for this workflow land here (later cards).',
  ].join('\n')
}

/**
 * Ensure the flow has a home card; returns its objective id. Idempotent: an
 * existing link is kept when the objective still exists.
 */
export function ensureFlowHomeCard(db: Database.Database, flowId: number, createdByUserId: number | null): number | null {
  const flow = getFlowRow(db, flowId)
  if (!flow) return null
  if (flow.objective_id != null) {
    const exists = db.prepare('SELECT id FROM objectives WHERE id = ?').get(flow.objective_id) as { id: number } | undefined
    if (exists) return exists.id
  }
  const r = db.prepare(
    `INSERT INTO objectives (title, description, agent_context, workspace, category, type, status, origin, created_by)
     VALUES (?, ?, 'general', ?, 'general', 'task', 'done', 'workflow', ?)`,
  ).run(`Workflow: ${flow.name}`, homeCardDescription(flow), flow.workspace, createdByUserId && createdByUserId > 0 ? createdByUserId : null)
  const objectiveId = Number(r.lastInsertRowid)
  db.prepare("UPDATE flow_definitions SET objective_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?")
    .run(objectiveId, flowId)
  return objectiveId
}

// ── Publish + routine sync (§7.1) ───────────────────────────────────────────

export type PublishResult =
  | { ok: true; flowId: number; version: number; routineId: number | null }
  | { ok: false; status: number; reason: string; detail?: unknown }

/**
 * Make `version` the published one, mark the flow active and sync its routine.
 * The route gates WHO may call this (cookie owner/admin, §5.4) and, since card
 * B5, runs the publish gate (services/flow-self-test.ts: green self-test + the
 * owner's approval of the send/spend nodes) and records that approval first —
 * the definition is validated here against the RECORDED approval only.
 */
export function publishFlowVersion(
  db: Database.Database,
  args: { flowId: number; version: number },
): PublishResult {
  const flow = getFlowRow(db, args.flowId)
  if (!flow) return { ok: false, status: 404, reason: 'flow_not_found' }
  if (flow.status === 'archived') return { ok: false, status: 409, reason: 'flow_archived' }
  const def = loadFlowVersion(db, flow.id, args.version)
  if (!def) return { ok: false, status: 404, reason: 'version_not_found' }
  const v = validateFlow(withRecordedApprovals(def, recordedFlowApprovals(db, flow.id, args.version)))
  if (!v.ok) return { ok: false, status: 409, reason: 'invalid_definition', detail: v.errors }
  const trig = triggerOf(def)
  if (trig?.on === 'schedule') {
    const cronErr = validateCronExpr(trig.schedule?.cron ?? '')
    if (cronErr) return { ok: false, status: 409, reason: 'invalid_cron', detail: cronErr }
  }
  db.prepare(
    `UPDATE flow_definitions SET published_version = ?, status = 'active', name = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
  ).run(args.version, def.name || flow.name, flow.id)
  const routineId = syncFlowRoutine(db, flow.id)
  return { ok: true, flowId: flow.id, version: args.version, routineId }
}

export function flowRoutineId(db: Database.Database, flowId: number): number | null {
  const r = db.prepare("SELECT id FROM routines WHERE kind = 'flow' AND flow_id = ? ORDER BY id LIMIT 1").get(flowId) as
    | { id: number }
    | undefined
  return r?.id ?? null
}

/**
 * Bring the flow's `kind='flow'` routine in line with its PUBLISHED version:
 * a schedule trigger on an active flow ⇒ the routine exists with that cron and is
 * enabled (unless it is auto-paused — that stays paused until Resume); anything
 * else ⇒ an existing routine is disabled (kept, so its history stays). Returns
 * the routine id, or null when the flow has no routine.
 */
export function syncFlowRoutine(db: Database.Database, flowId: number): number | null {
  const flow = getFlowRow(db, flowId)
  if (!flow) return null
  const def = flow.published_version != null ? loadFlowVersion(db, flow.id, flow.published_version) : null
  const trig = triggerOf(def)
  const cron = trig?.on === 'schedule' ? trig.schedule?.cron ?? '' : ''
  const scheduled = flow.status === 'active' && !!cron && validateCronExpr(cron) === null
  const existing = flowRoutineId(db, flow.id)
  const template = JSON.stringify({ title: flow.name, workspace: flow.workspace, flow_id: flow.id, flow_slug: flow.slug })
  const name = flowRoutineName(flow.workspace, flow.slug)

  if (scheduled) {
    if (existing != null) {
      db.prepare(
        `UPDATE routines SET name = ?, cron_expr = ?, objective_template = ?,
                enabled = CASE WHEN auto_paused_at IS NULL THEN 1 ELSE enabled END
          WHERE id = ?`,
      ).run(name, cron, template, existing)
      return existing
    }
    const r = db.prepare(
      `INSERT INTO routines (name, cron_expr, objective_template, enabled, max_queue_depth, kind, flow_id, last_accounted_flow_run_id)
       VALUES (?, ?, ?, 1, 1, 'flow', ?, (SELECT MAX(id) FROM flow_runs WHERE flow_id = ?))`,
    ).run(name, cron, template, flow.id, flow.id)
    return Number(r.lastInsertRowid)
  }
  if (existing != null) db.prepare('UPDATE routines SET enabled = 0, objective_template = ? WHERE id = ?').run(template, existing)
  return existing
}

// ── Firing (called by routine-scheduler.fireRoutine for kind='flow') ────────

export interface FlowFireResult {
  ok: boolean
  reason?: string
  flow_run_id?: number
}


/**
 * Queue one run of the routine's flow (pinned to the published version). Guards:
 * the kill switch, the flow being active, and the routine's queue depth over the
 * flow's in-flight runs (so a slow schedule never piles up — §4.3.5). The caller
 * owns the over-fire guard and the `last_run_at` stamp.
 */
export function startFlowRunForRoutine(
  db: Database.Database,
  routine: { id: number; flow_id?: number | null; max_queue_depth?: number | null },
  source: 'cron' | 'run-now',
): FlowFireResult {
  if (!flowsEnabled(db)) return { ok: false, reason: 'flows disabled: settings.flows_enabled is not 1' }
  if (routine.flow_id == null) return { ok: false, reason: 'flow routine has no flow_id' }
  const flow = getFlowRow(db, routine.flow_id)
  if (!flow) return { ok: false, reason: `flow ${routine.flow_id} not found` }
  if (flow.status !== 'active') return { ok: false, reason: `flow inactive: workflow '${flow.slug}' is ${flow.status}` }
  const depth = Math.max(1, Number(routine.max_queue_depth) || 1)
  const inFlight = (db.prepare(
    // Live runs only: a self-test (dry/test) in flight never blocks the schedule (B5).
    "SELECT COUNT(*) n FROM flow_runs WHERE flow_id = ? AND mode = 'live' AND status IN ('queued', 'running', 'waiting', 'repairing')",
  ).get(flow.id) as { n: number }).n
  if (inFlight >= depth) {
    return { ok: false, reason: `queue depth guard: ${inFlight} flow run(s) in flight >= max_queue_depth ${depth}` }
  }
  const r = flowEngineFor(db).startRun({
    flowId: flow.id,
    trigger: { source: source === 'cron' ? 'schedule' : 'manual', payload: { routine_id: routine.id, fired_at: new Date().toISOString() } },
    objectiveId: flow.objective_id,
  })
  if (!r.ok) return { ok: false, reason: `flow run not started: ${r.reason}` }
  return { ok: true, flow_run_id: r.runId }
}

/**
 * Terminal outcome of one flow run for the auto-pause streak. `waiting` (an
 * approval / unknown-outcome confirm), `repairing` (B8) and the other active
 * states are pending. A run that succeeded but did not meet its goal
 * (`goal_met = 0`, B5) is a failure.
 *
 * B8 (§5.3): a failed run whose error is DEFINITION ROT (a `127` / `ENOENT` from a
 * script Tool) is `neutral`: it neither counts toward the K consecutive failures
 * nor resets the streak — the repair watcher opens a repair for it immediately.
 */
export function classifyFlowRun(run: { status: string; goal_met?: number | null; error_json?: string | null }): 'success' | 'failure' | 'pending' | 'neutral' {
  if (run.status === 'succeeded') return run.goal_met === 0 ? 'failure' : 'success'
  if (run.status === 'failed') {
    let err: unknown = null
    try { err = run.error_json ? JSON.parse(run.error_json) : null } catch { err = null }
    return isDefinitionRot(err as Parameters<typeof isDefinitionRot>[0]) ? 'neutral' : 'failure'
  }
  if (run.status === 'cancelled') return 'failure'
  return 'pending'
}
