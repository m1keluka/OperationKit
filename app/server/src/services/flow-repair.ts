/**
 * Auto-debug watcher (obj 900644, card B8 of docs/design/WORKFLOWS.md §5.3).
 *
 *   run error → repair card → JSON Patch draft → validate → replay → classify →
 *   auto-apply (safe class, replay green) | Needs Review (everything else)
 *
 * TRIAGE (each engine tick). A finished LIVE run (never a dry/test/replay run or
 * a self-test) that failed — a node failed after its retries, a `check` with
 * `on_fail: "repair"` failed, or the run ended with its goal not met — becomes
 * a repair INCIDENT (`flow_repairs`, one row per run). Failures a patch cannot
 * fix (a budget stop, a rejected approval, an unknown outcome, a cancelled agent
 * card, a `check` with `on_fail: "fail"`) are marked `skipped` and left alone.
 * Only runs that ended inside `triageWindowMs` are picked up, so switching the
 * watcher on never opens repairs for last month's failures.
 *
 * BREAKERS, in order, before a repair card is filed:
 *   1. `budget.repairs_per_day` (default 3): that many repair cards for this
 *      workflow in the last 24 h ⇒ Needs Review and the workflow is PAUSED.
 *   2. Same failure signature (node id + error type, shared/flow/repair.ts) seen
 *      twice in the last 7 days ⇒ the third goes to Needs Review: a loop that
 *      keeps "fixing" the same thing is a bug in the fix.
 *   3. `budget.repair_usd` (default $2) must be > 0.
 * A `127` / `ENOENT` failure is DEFINITION ROT: it is flagged on the incident and
 * the brief, and (flow-routines.classifyFlowRun) it never counts toward the K
 * consecutive-failure auto-pause — the repair is opened immediately instead.
 *
 * THE REPAIR CARD is a normal objective (origin `workflow`, under the workflow's
 * home card, cost ceiling = `repair_usd`, so the poller's job ceiling stops it).
 * Its brief carries what §5.3 lists — the failing node's input, the error, its
 * attempt history, its upstream outputs, the same node's I/O from the last good
 * run, and the definition — size-capped and redacted. It answers with ONE thing:
 * `POST /api/flows/:id/repairs/:repairId/draft {patch, explanation}`. It never
 * publishes, never gets a credential from this path, and a replay never sends.
 *
 * A DRAFT (`submitDraft`): the patch is applied to the failed run's version;
 * the result is validated and saved as version N+1 with `author = repair:<run>`,
 * `parent_version` and `patch_json`; then the failed run is REPLAYED against it
 * (engine mode `replay`: the failed run's recorded outputs up to the first
 * failed/changed node, then read live and write/send/spend stubbed). The engine
 * evaluates the end condition. Then:
 *
 *   replay green + safe class + send/spend approvals unchanged  → APPLIED:
 *        published (the owner's recorded approval carries over — the approved
 *        nodes are byte-identical), then the failed run is re-run from the
 *        trigger as a new live run unless it already performed a write/send/spend
 *   replay green, not safe class (goal, send node, budget …)  → Needs Review
 *   replay red                                                  → the agent iterates;
 *        after `maxDrafts` (3) drafts → Needs Review
 *   repair spend (card ledger + replay runs) ≥ `repair_usd`     → Needs Review, flow paused
 *
 * NEEDS REVIEW keeps the draft, the diff, the classification and the replay
 * evidence on the incident and on the card (status `review`, disposition
 * `needs_review`). The owner approves (`approve` — cookie owner/admin only, the
 * same rule as publish) or rejects. Nothing here can approve a send/spend node
 * on the owner's behalf: carrying an approval over requires the approved node
 * set AND every approved node to be unchanged.
 *
 * Kill switch: `settings.flow_auto_repair_enabled = '0'` (default on, behind the
 * engine's own `flows_enabled`). DB-injected; the engine is passed in.
 */
import type Database from 'better-sqlite3'
import type { FlowApprovals, FlowDefinition } from '../../../shared/flow/types.js'
import { validateFlow } from '../../../shared/flow/validate.js'
import { analyzeFlow, type RawNode } from '../../../shared/flow/analyze.js'
import { diffFlowNodes } from '../../../shared/flow/diff.js'
import { nodesRequiringApproval } from '../../../shared/flow/self-test.js'
import { applyJsonPatch, isJsonPatch } from '../../../shared/flow/json-patch.js'
import {
  classifyRepairPatch, flowFailureSignature, isDefinitionRot, type RepairClassification,
} from '../../../shared/flow/repair.js'
import { initFlowSchema, type FlowRepairStatus } from '../db/schema/flow.js'
import { initJobAccountingSchema } from '../db/schema/job-accounting.js'
import { getSpend, setObjectiveCeiling } from './job-accounting.js'
import { depthForParent } from '../lib/objective-depth.js'
import { redactLive } from './live-redaction.js'
import {
  flowDefinitionSha256, flowsEnabled, recordedFlowApprovals, saveFlowVersion, type FlowEngine, type FlowProblem,
} from './flow-engine.js'

// ── Settings / defaults ─────────────────────────────────────────────────────

export const REPAIR_DEFAULTS = {
  /** §5.3: `budget.repair_usd` per incident. */
  repairUsd: 2,
  /** §5.3: `budget.repairs_per_day` per workflow. */
  repairsPerDay: 3,
  /** §5.3 "replay fails → iterate (max 3), then Needs Review". */
  maxDrafts: 3,
  signatureWindowMs: 7 * 86_400_000,
  /** Repairs of one signature allowed in the window; the next one goes to Needs Review. */
  signatureMaxRepairs: 2,
  dayMs: 86_400_000,
  /** Only runs that ended this recently are triaged (no backfill of old failures). */
  triageWindowMs: 6 * 3_600_000,
  /** An open repair with no green draft this long after it opened goes to Needs Review (the run stops blocking the schedule). */
  openMaxMs: 6 * 3_600_000,
  briefFieldChars: 4000,
  briefDefinitionChars: 40_000,
}

export const AUTO_REPAIR_SETTING = 'flow_auto_repair_enabled'

/** Failure types no definition patch can fix: they are left to the owner / K auto-pause. */
const NOT_REPAIRABLE = new Set([
  'budget', 'approval_rejected', 'approval_timeout', 'unknown_outcome', 'agent_cancelled', 'agent_card_missing',
  'definition_missing', 'engine_error', 'interrupted', 'aborted', 'flows_disabled',
])

/** Breaker reasons that mean "the owner must look", with the ones that also pause the workflow. */
export const REPAIR_REVIEW_REASONS = [
  'repairs_per_day', 'same_signature', 'repair_usd', 'drafts_exhausted', 'not_safe_class', 'approval_changed',
  'base_moved', 'card_closed', 'replay_failed',
] as const
export type RepairReviewReason = (typeof REPAIR_REVIEW_REASONS)[number]
const PAUSES_FLOW = new Set<RepairReviewReason>(['repairs_per_day', 'repair_usd'])

export function autoRepairEnabled(db: Database.Database): boolean {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(AUTO_REPAIR_SETTING) as { value: string } | undefined
    return row?.value !== '0'
  } catch {
    return false
  }
}

// ── Rows ────────────────────────────────────────────────────────────────────

export interface FlowRepairRow {
  id: number
  flow_id: number
  workspace: string
  run_id: number
  base_version: number
  signature: string
  failed_node_id: string | null
  error_json: string | null
  definition_rot: number
  status: FlowRepairStatus
  reason: string | null
  detail: string | null
  objective_id: number | null
  /** The card the owner reviews: the repair card, or a Needs Review card a breaker filed. */
  review_objective_id: number | null
  repair_usd: number
  drafts: number
  draft_version: number | null
  patch_json: string | null
  explanation: string | null
  classification_json: string | null
  replay_run_id: number | null
  replay_json: string | null
  applied_version: number | null
  rerun_run_id: number | null
  rerun_note: string | null
  resolved_by: string | null
  created_at: string
  updated_at: string
  resolved_at: string | null
}

interface RunRow {
  id: number
  flow_id: number
  version: number
  workspace: string
  mode: string
  status: string
  goal_met: number | null
  goal_json: string | null
  error_json: string | null
  trigger_json: string | null
  spent_usd: number
  objective_id: number | null
  self_test_id: number | null
  ended_at: string | null
}

interface StepRow {
  id: number
  node_id: string
  iteration: number
  attempt: number
  status: string
  effect: string | null
  input_json: string | null
  output_json: string | null
  error_json: string | null
  simulated: string | null
}

/** What the replay of one draft showed (stored as `replay_json`). */
export interface RepairReplaySummary {
  run_id: number
  status: string
  goal_met: number | null
  green: boolean
  seeded: number
  error: { type: string; title: string; node_id?: string } | null
  failing_asserts: { expr: string; why?: string }[]
  /** write/send/spend steps the replay stubbed instead of performing. */
  stubbed: { node_id: string; effect: string | null; simulated: string }[]
  spent_usd: number
}

export interface RepairDraftResponse {
  status: FlowRepairStatus | 'replaying'
  repair_id: number
  draft_version: number | null
  drafts_used: number
  drafts_max: number
  classification: RepairClassification | null
  replay: RepairReplaySummary | null
  applied_version: number | null
  reason: string | null
  message: string
}

export type SubmitDraftResult =
  | { ok: true; result: RepairDraftResponse }
  | { ok: false; status: number; reason: string; error: string; errors?: unknown[]; result?: RepairDraftResponse }

/** How the watcher files its card. Injected so tests stay on a bare DB. */
export interface FlowRepairHost {
  /** Synchronous DB work only (runs in the watcher's transaction). Returns the objective id. */
  createCard(db: Database.Database, req: RepairCardRequest): number
  /** After commit: make the card visible and start its session. Must not throw. */
  startCard?(objectiveId: number): void | Promise<void>
  /** Activity / broadcast hook. Must not throw. */
  notify?(e: RepairEvent): void
  /** Bring the workflow's schedule routine in line after a publish / pause (flow-routines.syncFlowRoutine). */
  syncRoutine?(db: Database.Database, flowId: number): void
}

export interface RepairCardRequest {
  flowId: number
  flowName: string
  workspace: string
  runId: number
  repairId: number
  homeObjectiveId: number | null
  title: string
  description: string
  completionGoal: string | null
  /** `queue` = start a session; `review` = a Needs Review card for the owner, no session. */
  status: 'queue' | 'review'
  ceilingUsd: number | null
  reviewNote: string | null
}

export type RepairEvent =
  | { type: 'opened'; repair: FlowRepairRow }
  | { type: 'applied'; repair: FlowRepairRow }
  | { type: 'needs_review'; repair: FlowRepairRow }
  | { type: 'rejected'; repair: FlowRepairRow }

const parse = <T>(s: string | null | undefined): T | null => {
  if (!s) return null
  try { return JSON.parse(s) as T } catch { return null }
}

function cap(text: string | null | undefined, n: number): string {
  if (text == null) return 'null'
  const red = redactLive(text).text
  return red.length > n ? `${red.slice(0, n)}… [truncated, ${red.length} chars]` : red
}

// ── The watcher ─────────────────────────────────────────────────────────────

export class FlowRepairWatcher {
  readonly db: Database.Database
  private readonly engine: FlowEngine
  private readonly host: FlowRepairHost
  private ticking = false

  constructor(opts: { engine: FlowEngine; host?: FlowRepairHost }) {
    this.engine = opts.engine
    this.db = opts.engine.db
    this.host = opts.host ?? { createCard: createRepairCard }
    initFlowSchema(this.db)
    initJobAccountingSchema(this.db)
  }

  private nowIso(): string { return this.engine.isoAt() }
  private agoIso(ms: number): string { return new Date(this.engine.now() - ms).toISOString() }

  private emit(e: RepairEvent): void {
    try { this.host.notify?.(e) } catch { /* observers never break a repair */ }
  }

  getRepair(id: number): FlowRepairRow | null {
    return (this.db.prepare('SELECT * FROM flow_repairs WHERE id = ?').get(id) as FlowRepairRow | undefined) ?? null
  }

  private loadDef(flowId: number, version: number): FlowDefinition | null {
    const row = this.db.prepare('SELECT definition_json FROM flow_versions WHERE flow_id = ? AND version = ?').get(flowId, version) as
      | { definition_json: string }
      | undefined
    return row ? parse<FlowDefinition>(row.definition_json) : null
  }

  /**
   * One watcher pass: triage newly failed live runs, then supervise open
   * repairs (spend vs `repair_usd`, a closed card, a replay that finished after a
   * backoff) and close the cards of applied repairs. Re-entrancy-safe.
   */
  async tick(): Promise<{ triaged: number; opened: number }> {
    if (this.ticking) return { triaged: 0, opened: 0 }
    this.ticking = true
    try {
      // Supervision always runs (DB only): an open repair must never strand its run in
      // `repairing` — which holds the schedule's queue slot — because a switch went off.
      if (!flowsEnabled(this.db) || !autoRepairEnabled(this.db)) {
        await this.supervise()
        return { triaged: 0, opened: 0 }
      }
      const candidates = this.db.prepare(
        `SELECT id FROM flow_runs
          WHERE mode = 'live' AND self_test_id IS NULL AND repair_state IS NULL
            AND (status = 'failed' OR (status = 'succeeded' AND goal_met = 0))
            AND ended_at >= ?
          ORDER BY id LIMIT 50`,
      ).all(this.agoIso(REPAIR_DEFAULTS.triageWindowMs)) as { id: number }[]
      let opened = 0
      for (const c of candidates) {
        const r = this.triageRun(c.id)
        if (r.kind === 'opened') opened++
      }
      await this.supervise()
      return { triaged: candidates.length, opened }
    } finally {
      this.ticking = false
    }
  }

  /**
   * Decide what to do with one finished live run. Idempotent: a run is
   * triaged once (`flow_runs.repair_state`).
   */
  triageRun(runId: number):
    | { kind: 'skipped'; reason: string }
    | { kind: 'opened'; repairId: number; objectiveId: number }
    | { kind: 'needs_review'; repairId: number; reason: RepairReviewReason } {
    const run = this.db.prepare('SELECT * FROM flow_runs WHERE id = ?').get(runId) as RunRow | undefined
    const skip = (reason: string) => {
      this.db.prepare("UPDATE flow_runs SET repair_state = 'skipped' WHERE id = ? AND repair_state IS NULL").run(runId)
      return { kind: 'skipped' as const, reason }
    }
    if (!run) return { kind: 'skipped', reason: 'run_not_found' }
    if (run.mode !== 'live' || run.self_test_id != null) return skip('not_a_live_run')
    const flow = this.db.prepare('SELECT id, name, status, objective_id FROM flow_definitions WHERE id = ?').get(run.flow_id) as
      | { id: number; name: string; status: string; objective_id: number | null }
      | undefined
    if (!flow || flow.status === 'archived') return skip('flow_archived')
    const def = this.loadDef(run.flow_id, run.version)
    if (!def) return skip('definition_missing')

    let err = parse<FlowProblem>(run.error_json)
    if (run.status === 'succeeded' && run.goal_met === 0) {
      const goal = parse<{ asserts?: { expr: string; why?: string; passed: boolean }[] }>(run.goal_json)
      const failing = (goal?.asserts ?? []).filter((a) => !a.passed)
      err = {
        type: 'goal_not_met',
        title: `end condition not met: ${failing.map((a) => a.why ?? a.expr).join('; ') || 'judge failed'}`,
        detail: JSON.stringify(failing),
      }
    } else if (run.status !== 'failed') {
      return skip('not_failed')
    }
    if (!err) return skip('no_error')
    if (NOT_REPAIRABLE.has(String(err.type))) return skip(`not_repairable:${String(err.type)}`)
    if (err.type === 'check_failed') {
      const node = def.nodes.find((n) => n.id === err!.node_id)
      if (!node || node.kind !== 'check' || node.on_fail !== 'repair') return skip('check_on_fail_fail')
    }

    const signature = flowFailureSignature(err)
    const rot = isDefinitionRot(err)
    const repairUsd = finiteOr(def.budget?.repair_usd, REPAIR_DEFAULTS.repairUsd)
    const perDay = Math.floor(finiteOr(def.budget?.repairs_per_day, REPAIR_DEFAULTS.repairsPerDay))
    const now = this.nowIso()

    const attemptsToday = (this.db.prepare(
      'SELECT COUNT(*) n FROM flow_repairs WHERE flow_id = ? AND objective_id IS NOT NULL AND created_at >= ?',
    ).get(run.flow_id, this.agoIso(REPAIR_DEFAULTS.dayMs)) as { n: number }).n
    const sameSig = (this.db.prepare(
      'SELECT COUNT(*) n FROM flow_repairs WHERE flow_id = ? AND signature = ? AND created_at >= ?',
    ).get(run.flow_id, signature, this.agoIso(REPAIR_DEFAULTS.signatureWindowMs)) as { n: number }).n

    let breaker: { reason: RepairReviewReason; detail: string } | null = null
    if (attemptsToday >= perDay) {
      breaker = {
        reason: 'repairs_per_day',
        detail: `${attemptsToday} repair(s) of this workflow in the last 24 h already reach budget.repairs_per_day = ${perDay}. The workflow is paused until the owner looks.`,
      }
    } else if (sameSig >= REPAIR_DEFAULTS.signatureMaxRepairs) {
      breaker = {
        reason: 'same_signature',
        detail: `The same failure (${signature}) was already repaired ${sameSig} time(s) in the last 7 days. A loop that keeps "fixing" the same thing is a bug in the fix, so this one goes to the owner.`,
      }
    } else if (!(repairUsd > 0)) {
      breaker = { reason: 'repair_usd', detail: `budget.repair_usd is ${repairUsd}: no repair spend is allowed.` }
    }

    const insert = (status: FlowRepairStatus, reason: string | null, detail: string | null): number => Number(this.db.prepare(
      `INSERT INTO flow_repairs (flow_id, workspace, run_id, base_version, signature, failed_node_id, error_json, definition_rot,
                                 status, reason, detail, repair_usd, created_at, updated_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(run.flow_id, run.workspace, run.id, run.version, signature, typeof err!.node_id === 'string' ? err!.node_id : null,
      JSON.stringify(err), rot ? 1 : 0, status, reason, detail, repairUsd, now, now, status === 'open' ? null : now).lastInsertRowid)

    if (breaker) {
      const b = breaker
      const repairId = this.db.transaction(() => {
        const id = insert('needs_review', b.reason, b.detail)
        this.db.prepare("UPDATE flow_runs SET repair_state = 'incident' WHERE id = ?").run(run.id)
        // One Needs Review card per open problem: a workflow that keeps failing the same way
        // (an hourly flow with definition rot) adds to the owner's existing card, not a new one each run.
        const existing = this.db.prepare(
          `SELECT r.review_objective_id AS id FROM flow_repairs r JOIN objectives o ON o.id = r.review_objective_id
            WHERE r.flow_id = ? AND r.id <> ? AND r.status = 'needs_review' AND r.reason = ? AND r.signature = ?
              AND o.status NOT IN ('done', 'cancelled') ORDER BY r.id DESC LIMIT 1`,
        ).get(run.flow_id, id, b.reason, signature) as { id: number } | undefined
        if (existing) {
          this.db.prepare('UPDATE flow_repairs SET review_objective_id = ?, updated_at = ? WHERE id = ?').run(existing.id, now, id)
          this.db.prepare(
            "UPDATE objectives SET description = COALESCE(description, '') || ?, updated_at = datetime('now') WHERE id = ?",
          ).run(`\n\n---\n\nAgain at ${now}: run #${run.id} failed the same way (${signature}); repair #${id}.`, existing.id)
          if (PAUSES_FLOW.has(b.reason)) this.pauseFlow(run.flow_id)
          return id
        }
        const card = this.host.createCard(this.db, {
          flowId: run.flow_id, flowName: flow.name, workspace: run.workspace, runId: run.id, repairId: id,
          homeObjectiveId: flow.objective_id, status: 'review', ceilingUsd: null, completionGoal: null,
          title: repairCardTitle(flow.name, run.id, 'Needs review'),
          description: this.reviewDescription(this.getRepair(id)!, flow.name, b.reason, b.detail),
          reviewNote: `${b.reason}: ${b.detail}`.slice(0, 1000),
        })
        this.db.prepare('UPDATE flow_repairs SET review_objective_id = ?, updated_at = ? WHERE id = ?').run(card, now, id)
        if (PAUSES_FLOW.has(b.reason)) this.pauseFlow(run.flow_id)
        return id
      })()
      this.emit({ type: 'needs_review', repair: this.getRepair(repairId)! })
      return { kind: 'needs_review', repairId, reason: b.reason }
    }

    const opened = this.db.transaction(() => {
      const id = insert('open', null, null)
      const brief = this.repairBrief(id, run, def, err!, rot, repairUsd)
      const objectiveId = this.host.createCard(this.db, {
        flowId: run.flow_id, flowName: flow.name, workspace: run.workspace, runId: run.id, repairId: id,
        homeObjectiveId: flow.objective_id, status: 'queue', ceilingUsd: repairUsd, reviewNote: null,
        title: repairCardTitle(flow.name, run.id, rot ? 'Repair (definition rot)' : 'Repair'),
        description: brief,
        completionGoal: REPAIR_COMPLETION_GOAL,
      })
      this.db.prepare('UPDATE flow_repairs SET objective_id = ?, updated_at = ? WHERE id = ?').run(objectiveId, now, id)
      // §5.3: "run status = repairing" while the incident is open. A run that SUCCEEDED
      // with its goal not met keeps `succeeded` (goal_met = 0 already says what is wrong).
      this.db.prepare(
        "UPDATE flow_runs SET status = CASE WHEN status = 'failed' THEN 'repairing' ELSE status END, repair_state = 'incident', updated_at = ? WHERE id = ?",
      ).run(now, run.id)
      return { id, objectiveId }
    })()
    if (this.host.startCard) {
      try { void Promise.resolve(this.host.startCard(opened.objectiveId)).catch(() => undefined) } catch { /* never throws */ }
    }
    this.emit({ type: 'opened', repair: this.getRepair(opened.id)! })
    return { kind: 'opened', repairId: opened.id, objectiveId: opened.objectiveId }
  }

  // ── Spend ────────────────────────────────────────────────────────────────

  /** Repair spend = the repair card's ledger + every replay run's spend not charged to that card. */
  repairSpend(repair: FlowRepairRow): number {
    let card = 0
    if (repair.objective_id != null) {
      try { card = getSpend(this.db, repair.objective_id).spentUsd } catch { card = 0 }
    }
    // Replay runs carry objective_id = the repair card, so their spend is already on the
    // card's ledger (addRunSpend). Only a replay with no card is added here.
    const loose = (this.db.prepare(
      "SELECT COALESCE(SUM(spent_usd), 0) s FROM flow_runs WHERE mode = 'replay' AND parent_run_id = ? AND objective_id IS NULL",
    ).get(repair.run_id) as { s: number }).s
    return card + loose
  }

  // ── Drafts ───────────────────────────────────────────────────────────────

  /**
   * The repair card's answer: a JSON Patch against the failed run's version plus
   * an explanation. Validates, saves version N+1 (`author = repair:<run>`),
   * replays, classifies, then applies or routes to Needs Review. `actor` is only
   * recorded; the ROUTE checks it is this repair's own card.
   */
  async submitDraft(repairId: number, body: { patch: unknown; explanation?: unknown }): Promise<SubmitDraftResult> {
    const repair = this.getRepair(repairId)
    if (!repair) return { ok: false, status: 404, reason: 'repair_not_found', error: 'repair not found' }
    if (repair.status !== 'open') {
      return { ok: false, status: 409, reason: `repair_${repair.status}`, error: `repair #${repair.id} is ${repair.status}; no more drafts are accepted`, result: this.response(repair, 'This repair is closed.') }
    }
    if (repair.replay_run_id != null && !this.replayTerminal(repair.replay_run_id)) {
      return { ok: false, status: 409, reason: 'replay_in_progress', error: `the replay of draft v${repair.draft_version} is still running`, result: this.response(repair, 'Wait for the replay to finish.') }
    }
    if (!isJsonPatch(body.patch) || (body.patch as unknown[]).length === 0) {
      return { ok: false, status: 400, reason: 'invalid_patch', error: 'patch must be a non-empty RFC 6902 JSON Patch (a list of {op, path, value?, from?})' }
    }
    const explanation = typeof body.explanation === 'string' ? body.explanation.trim().slice(0, 4000) : ''
    if (!explanation) return { ok: false, status: 400, reason: 'explanation_required', error: 'explanation (one paragraph) is required' }

    // Budget first: a repair at its cap gets no more drafts (and no replay spend).
    const spent = this.repairSpend(repair)
    if (spent >= repair.repair_usd) {
      const closed = this.needsReview(repair, 'repair_usd',
        `Repair spend $${spent.toFixed(4)} reached budget.repair_usd $${repair.repair_usd.toFixed(2)}. The repair stopped; the workflow is paused.`)
      return { ok: false, status: 409, reason: 'repair_usd', error: closed.detail ?? 'repair budget exhausted', result: this.response(closed, 'Repair budget exhausted: stop and end your session.') }
    }
    if (repair.drafts >= REPAIR_DEFAULTS.maxDrafts) {
      const closed = this.needsReview(repair, 'drafts_exhausted', `${repair.drafts} drafts did not produce a green replay.`)
      return { ok: false, status: 409, reason: 'drafts_exhausted', error: closed.detail ?? 'drafts exhausted', result: this.response(closed, 'No drafts left: stop and end your session.') }
    }
    const flow = this.db.prepare('SELECT published_version FROM flow_definitions WHERE id = ?').get(repair.flow_id) as { published_version: number | null } | undefined
    if (!flow || flow.published_version !== repair.base_version) {
      const closed = this.needsReview(repair, 'base_moved',
        `The workflow's published version is now v${flow?.published_version ?? '—'}, not v${repair.base_version} (the failed run's version). A person published something else meanwhile.`)
      return { ok: false, status: 409, reason: 'base_moved', error: closed.detail ?? 'base moved', result: this.response(closed, 'The workflow changed under this repair: stop.') }
    }
    const base = this.loadDef(repair.flow_id, repair.base_version)
    if (!base) return { ok: false, status: 409, reason: 'definition_missing', error: `version ${repair.base_version} not found` }

    const applied = applyJsonPatch(base, body.patch)
    if (!applied.ok) {
      this.bumpDrafts(repair.id)
      return { ok: false, status: 400, reason: 'patch_failed', error: `operation ${applied.index}: ${applied.error}`, result: this.response(this.getRepair(repair.id)!, 'Fix the patch and resubmit.') }
    }
    const changedIdentity = (['id', 'workspace', 'apiVersion'] as const).filter((k) => JSON.stringify(applied.doc[k]) !== JSON.stringify(base[k]))
    if (changedIdentity.length) {
      // Saving would file the version under another (or a new) workflow: refuse before writing anything.
      this.bumpDrafts(repair.id)
      return { ok: false, status: 400, reason: 'patch_changes_identity', error: `a repair may not change ${changedIdentity.join(', ')}`, result: this.response(this.getRepair(repair.id)!, 'Do not touch id / workspace / apiVersion.') }
    }
    const latest = (this.db.prepare('SELECT MAX(version) v FROM flow_versions WHERE flow_id = ?').get(repair.flow_id) as { v: number }).v
    const draft: FlowDefinition = { ...applied.doc, version: latest + 1 }
    const author = `repair:${repair.run_id}`
    const saved = saveFlowVersion(this.db, { workspace: repair.workspace, definition: draft, author })
    this.bumpDrafts(repair.id)
    if (!saved.ok) {
      const r = this.getRepair(repair.id)!
      if (r.drafts >= REPAIR_DEFAULTS.maxDrafts) this.needsReview(r, 'drafts_exhausted', `${r.drafts} drafts; the last one was invalid (${saved.reason}).`)
      return {
        ok: false, status: 400, reason: saved.reason, error: `the patched definition is not valid (${saved.reason})`,
        errors: saved.errors ?? [], result: this.response(this.getRepair(repair.id)!, 'Fix every validation error and resubmit.'),
      }
    }
    const classification = classifyRepairPatch(base, draft, { toolEffect: (slug) => this.engine.toolEffect(slug) })
    this.db.prepare(
      `UPDATE flow_versions SET parent_version = ?, patch_json = ? WHERE flow_id = ? AND version = ?`,
    ).run(repair.base_version, JSON.stringify(body.patch), repair.flow_id, saved.version)
    this.db.prepare(
      `UPDATE flow_repairs SET draft_version = ?, patch_json = ?, explanation = ?, classification_json = ?, replay_run_id = NULL,
              replay_json = NULL, updated_at = ? WHERE id = ?`,
    ).run(saved.version, JSON.stringify(body.patch), explanation, JSON.stringify(classification), this.nowIso(), repair.id)

    // Replay the failed run against the draft (§5.2 `replay`). Spend lands on the repair card's ledger.
    const started = this.engine.startRun({
      flowId: repair.flow_id, version: saved.version, mode: 'replay', parentRunId: repair.run_id, objectiveId: repair.objective_id,
    })
    if (!started.ok) {
      return { ok: false, status: 409, reason: `replay_not_started:${started.reason}`, error: `the replay could not start: ${started.reason}`, result: this.response(this.getRepair(repair.id)!, 'The replay could not start.') }
    }
    this.db.prepare('UPDATE flow_repairs SET replay_run_id = ?, updated_at = ? WHERE id = ?').run(started.runId, this.nowIso(), repair.id)
    await this.engine.runNow(started.runId)
    const after = this.getRepair(repair.id)!
    if (!this.replayTerminal(started.runId)) {
      return { ok: true, result: { ...this.response(after, 'The replay is waiting out a retry backoff; it is finished by the engine tick. Poll GET …/repairs/:id.'), status: 'replaying' } }
    }
    const done = this.concludeReplay(after)
    return { ok: true, result: this.response(done, this.messageFor(done)) }
  }

  private bumpDrafts(id: number): void {
    this.db.prepare('UPDATE flow_repairs SET drafts = drafts + 1, updated_at = ? WHERE id = ?').run(this.nowIso(), id)
  }

  private replayTerminal(runId: number): boolean {
    const r = this.db.prepare('SELECT status FROM flow_runs WHERE id = ?').get(runId) as { status: string } | undefined
    return !r || ['succeeded', 'failed', 'cancelled'].includes(r.status)
  }

  private replaySummary(runId: number, seededFallback = 0): RepairReplaySummary {
    const r = this.db.prepare('SELECT * FROM flow_runs WHERE id = ?').get(runId) as RunRow
    const steps = this.db.prepare('SELECT node_id, status, effect, simulated FROM flow_step_runs WHERE run_id = ? ORDER BY id').all(runId) as
      { node_id: string; status: string; effect: string | null; simulated: string | null }[]
    const err = parse<{ type?: string; title?: string; node_id?: string }>(r.error_json)
    const goal = parse<{ asserts?: { expr: string; why?: string; passed: boolean }[] }>(r.goal_json)
    const seeded = steps.filter((s) => s.simulated === 'replay').length || seededFallback
    return {
      run_id: r.id,
      status: r.status,
      goal_met: r.goal_met,
      green: r.status === 'succeeded' && r.goal_met === 1,
      seeded,
      error: err ? { type: err.type ?? 'error', title: err.title ?? '', ...(err.node_id ? { node_id: err.node_id } : {}) } : null,
      failing_asserts: (goal?.asserts ?? []).filter((a) => !a.passed).map((a) => ({ expr: a.expr, ...(a.why ? { why: a.why } : {}) })),
      stubbed: steps.filter((s) => s.simulated?.startsWith('would_')).map((s) => ({ node_id: s.node_id, effect: s.effect, simulated: s.simulated! })),
      spent_usd: Number(r.spent_usd) || 0,
    }
  }

  /** The replay of the current draft is terminal: apply, hand to the owner, or let the agent iterate. */
  private concludeReplay(repair: FlowRepairRow): FlowRepairRow {
    if (repair.status !== 'open' || repair.replay_run_id == null || repair.draft_version == null) return repair
    const replay = this.replaySummary(repair.replay_run_id)
    this.db.prepare('UPDATE flow_repairs SET replay_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(replay), this.nowIso(), repair.id)
    const r = this.getRepair(repair.id)!
    const spent = this.repairSpend(r)
    if (spent >= r.repair_usd) {
      return this.needsReview(r, 'repair_usd',
        `Repair spend ${spent.toFixed(4)} reached budget.repair_usd $${r.repair_usd.toFixed(2)}. The repair stopped; the workflow is paused.`)
    }
    if (!replay.green) {
      if (r.drafts >= REPAIR_DEFAULTS.maxDrafts) {
        return this.needsReview(r, 'replay_failed', `${r.drafts} drafts; the last replay ended ${replay.status}${replay.goal_met === 0 ? ' with its goal not met' : ''}.`)
      }
      return r // the agent iterates
    }
    const cls = parse<RepairClassification>(r.classification_json)
    if (!cls?.safe) {
      const why = cls?.blockers.length ? cls.blockers.map((b) => b.message).join('; ') : 'the patch changes nothing on the safe list'
      return this.needsReview(r, 'not_safe_class', `The replay is green, but the patch is not safe to apply without the owner: ${why}.`)
    }
    const carried = this.carriedApproval(r)
    if (!carried.ok) return this.needsReview(r, 'approval_changed', carried.detail)
    return this.apply(r, carried.approvals, `repair:${r.run_id}`)
  }

  /**
   * The owner's recorded approval of the base version carries to the draft only
   * when the set of send/spend nodes that need approval is the same AND every
   * one of them is byte-identical (§5.4: approval is needed again when the
   * send/spend node set or arguments change).
   */
  private carriedApproval(r: FlowRepairRow): { ok: true; approvals: FlowApprovals | null } | { ok: false; detail: string } {
    const base = this.loadDef(r.flow_id, r.base_version)!
    const draft = this.loadDef(r.flow_id, r.draft_version!)!
    const needBase = nodesRequiringApproval(base)
    const needDraft = nodesRequiringApproval(draft)
    if (needBase.join(',') !== needDraft.join(',')) {
      return { ok: false, detail: `The send/spend nodes that need approval changed (${needBase.join(', ') || 'none'} → ${needDraft.join(', ') || 'none'}).` }
    }
    if (needDraft.length === 0) return { ok: true, approvals: null }
    const changed = new Set([...diffFlowNodes(base, draft).changed])
    const touched = needDraft.filter((id) => changed.has(id))
    if (touched.length) return { ok: false, detail: `Approved send/spend node(s) changed: ${touched.join(', ')}.` }
    const prior = recordedFlowApprovals(this.db, r.flow_id, r.base_version)
    if (!prior || prior.nodes.slice().sort().join(',') !== needDraft.join(',')) {
      return { ok: false, detail: `Version ${r.base_version} has no recorded owner approval of exactly ${needDraft.join(', ')}.` }
    }
    return {
      ok: true,
      approvals: {
        version: r.draft_version!,
        nodes: needDraft,
        by: prior.by, // the owner's approval of these (unchanged) nodes — a repair can never be an approver
        at: this.nowIso(),
        sha256: flowDefinitionSha256(draft),
      },
    }
  }

  /** Publish the draft (version N+1) and re-run the failed run when that is safe. */
  private apply(r: FlowRepairRow, approvals: FlowApprovals | null, by: string, opts: { reactivate?: boolean } = {}): FlowRepairRow {
    const now = this.nowIso()
    const draftVersion = r.draft_version!
    const result = this.db.transaction(() => {
      const flow = this.db.prepare('SELECT published_version, status FROM flow_definitions WHERE id = ?').get(r.flow_id) as
        { published_version: number | null; status: string }
      if (flow.published_version !== r.base_version) return { ok: false as const, detail: `published version moved to v${flow.published_version}` }
      if (approvals) {
        const rec = { ...approvals, carried_from: r.base_version, applied_by: by, replay_run_id: r.replay_run_id }
        this.db.prepare('UPDATE flow_versions SET approvals_json = ? WHERE flow_id = ? AND version = ?').run(JSON.stringify(rec), r.flow_id, draftVersion)
      }
      const def = this.loadDef(r.flow_id, draftVersion)!
      const strict = validateFlow(approvals ? { ...def, approvals: { version: approvals.version, nodes: approvals.nodes, by: approvals.by, at: approvals.at } } : def)
      if (!strict.ok) return { ok: false as const, detail: `the draft does not validate for publish: ${strict.errors.map((e) => e.code).join(', ')}` }
      this.db.prepare(
        `UPDATE flow_definitions SET published_version = ?, updated_at = ? WHERE id = ?`,
      ).run(draftVersion, now, r.flow_id)
      // An owner-approved repair re-activates a workflow a breaker paused.
      if (opts.reactivate) this.db.prepare("UPDATE flow_definitions SET status = 'active' WHERE id = ? AND status = 'paused'").run(r.flow_id)
      this.db.prepare(
        `UPDATE flow_repairs SET status = 'applied', applied_version = ?, resolved_by = ?, resolved_at = ?, updated_at = ? WHERE id = ?`,
      ).run(draftVersion, by, now, now, r.id)
      this.db.prepare("UPDATE flow_runs SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'repairing'").run(now, r.run_id)
      if (r.objective_id != null) {
        this.db.prepare("UPDATE objectives SET job_disposition = 'complete', job_review_note = ?, updated_at = datetime('now') WHERE id = ?")
          .run(`Applied as v${draftVersion} by ${by}.`, r.objective_id)
      }
      return { ok: true as const }
    })()
    if (!result.ok) return this.needsReview(r, 'base_moved', `Could not apply v${draftVersion}: ${result.detail}.`)
    try { this.syncRoutine(r.flow_id) } catch { /* the routine follows on the next publish */ }
    this.rerun(this.getRepair(r.id)!)
    const applied = this.getRepair(r.id)!
    this.emit({ type: 'applied', repair: applied })
    return applied
  }

  /**
   * §5.3 "re-run from the trigger in a new run (default)". A re-run repeats
   * every node, so it is started only when the failed run performed no real
   * write/send/spend — otherwise the owner decides (no double sends).
   */
  private rerun(r: FlowRepairRow): void {
    // Anything that may have had an effect blocks the re-run: a write/send/spend step in ANY
    // state (a failed or timed-out attempt may still have been delivered) and any agent
    // node step (its child card was filed and paid for; agent rows carry no effect).
    const def = this.loadDef(r.flow_id, r.base_version)
    const agentIds = (def?.nodes ?? []).filter((n) => n.kind === 'agent').map((n) => n.id)
    const effects = this.db.prepare(
      `SELECT DISTINCT node_id FROM flow_step_runs
        WHERE run_id = ? AND simulated IS NULL
          AND (effect IN ('write', 'send', 'spend') OR node_id IN (SELECT value FROM json_each(?)))`,
    ).all(r.run_id, JSON.stringify(agentIds)) as { node_id: string }[]
    let note: string
    let rerunId: number | null = null
    const flowStatus = (this.db.prepare('SELECT status FROM flow_definitions WHERE id = ?').get(r.flow_id) as { status: string }).status
    if (flowStatus !== 'active') {
      note = `not re-run: the workflow is ${flowStatus}.`
    } else if (effects.length) {
      note = `not re-run automatically: the failed run already reached ${effects.map((e) => e.node_id).join(', ')} (write/send/spend or agent); a re-run would repeat it.`
    } else {
      const failed = this.db.prepare('SELECT trigger_json, objective_id FROM flow_runs WHERE id = ?').get(r.run_id) as { trigger_json: string | null; objective_id: number | null }
      const trig = parse<{ source?: string; payload?: unknown }>(failed.trigger_json) ?? {}
      const s = this.engine.startRun({
        flowId: r.flow_id, version: r.applied_version!, parentRunId: r.run_id, objectiveId: failed.objective_id,
        trigger: { source: 'repair_rerun', payload: trig.payload ?? {} },
      })
      if (s.ok) { rerunId = s.runId; note = `re-run from the trigger as run #${s.runId} on v${r.applied_version}` }
      else note = `re-run not started: ${s.reason}`
    }
    this.db.prepare('UPDATE flow_repairs SET rerun_run_id = ?, rerun_note = ?, updated_at = ? WHERE id = ?').run(rerunId, note, this.nowIso(), r.id)
  }

  // ── Needs Review / owner decisions ────────────────────────────────────────

  needsReview(r: FlowRepairRow, reason: RepairReviewReason, detail: string): FlowRepairRow {
    const now = this.nowIso()
    const changed = this.db.transaction(() => {
      const u = this.db.prepare(
        `UPDATE flow_repairs SET status = 'needs_review', reason = ?, detail = ?, resolved_at = ?, updated_at = ? WHERE id = ? AND status = 'open'`,
      ).run(reason, detail, now, now, r.id)
      if (u.changes !== 1) return false
      this.db.prepare("UPDATE flow_runs SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'repairing'").run(now, r.run_id)
      if (PAUSES_FLOW.has(reason)) this.pauseFlow(r.flow_id)
      if (r.objective_id != null) {
        this.db.prepare('UPDATE flow_repairs SET review_objective_id = ? WHERE id = ?').run(r.objective_id, r.id)
        const fresh = this.getRepair(r.id)!
        const flow = this.db.prepare('SELECT name FROM flow_definitions WHERE id = ?').get(r.flow_id) as { name: string } | undefined
        const card = this.db.prepare('SELECT status, description FROM objectives WHERE id = ?').get(r.objective_id) as
          | { status: string; description: string | null }
          | undefined
        if (card) {
          const section = `\n\n---\n\n${this.reviewDescription(fresh, flow?.name ?? `flow #${r.flow_id}`, reason, detail)}`
          // A live session keeps running until it reads the 409 and ends; the poller then
          // lands the task in review. A card with no session is moved there now.
          const toReview = ['queue', 'planning', 'done'].includes(card.status)
          this.db.prepare(
            `UPDATE objectives SET job_disposition = 'needs_review', job_review_note = ?, description = ?,
                    status = CASE WHEN ? THEN 'review' ELSE status END, updated_at = datetime('now') WHERE id = ?`,
          ).run(`${reason}: ${detail}`.slice(0, 1000), `${card.description ?? ''}${section}`, toReview ? 1 : 0, r.objective_id)
        }
      }
      return true
    })()
    const out = this.getRepair(r.id)!
    if (changed) this.emit({ type: 'needs_review', repair: out })
    return out
  }

  private pauseFlow(flowId: number): void {
    this.db.prepare("UPDATE flow_definitions SET status = 'paused', updated_at = ? WHERE id = ? AND status = 'active'").run(this.nowIso(), flowId)
    try { this.syncRoutine(flowId) } catch { /* no routines table on a bare DB */ }
  }

  private syncRoutine(flowId: number): void {
    if (this.host.syncRoutine) { this.host.syncRoutine(this.db, flowId); return }
    const hasRoutines = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'routines'").get()
    if (!hasRoutines) return
    const routine = this.db.prepare("SELECT id FROM routines WHERE kind = 'flow' AND flow_id = ?").get(flowId) as { id: number } | undefined
    if (!routine) return
    const flow = this.db.prepare('SELECT status FROM flow_definitions WHERE id = ?').get(flowId) as { status: string }
    // Paused ⇒ the schedule stops firing; active ⇒ it follows the (new) published version.
    if (flow.status !== 'active') this.db.prepare('UPDATE routines SET enabled = 0 WHERE id = ?').run(routine.id)
  }

  /**
   * The owner's one click on a Needs Review repair whose replay was green:
   * publish the draft. `approve` must name EXACTLY the draft's send/spend nodes
   * that need approval (same rule as publish). The ROUTE checks the caller is a
   * cookie owner/admin.
   */
  approve(repairId: number, args: { userId: number; approve: unknown }):
    | { ok: true; repair: FlowRepairRow } | { ok: false; status: number; reason: string; error: string; [k: string]: unknown } {
    const r = this.getRepair(repairId)
    if (!r) return { ok: false, status: 404, reason: 'repair_not_found', error: 'repair not found' }
    if (r.status !== 'needs_review') return { ok: false, status: 409, reason: `repair_${r.status}`, error: `repair #${r.id} is ${r.status}` }
    if (r.draft_version == null) return { ok: false, status: 409, reason: 'no_draft', error: 'this incident has no draft to approve; fix the workflow by hand' }
    const replay = parse<RepairReplaySummary>(r.replay_json)
    if (!replay?.green) return { ok: false, status: 409, reason: 'replay_not_green', error: 'the draft\'s replay was not green; it cannot be approved as is' }
    const draft = this.loadDef(r.flow_id, r.draft_version)
    if (!draft) return { ok: false, status: 409, reason: 'definition_missing', error: 'draft version missing' }
    const need = nodesRequiringApproval(draft)
    let approved: string[] = []
    if (need.length) {
      if (!Array.isArray(args.approve) || !args.approve.every((x) => typeof x === 'string')) {
        return { ok: false, status: 409, reason: 'approval_required', error: `approve must name exactly: ${need.join(', ')}`, nodes_requiring_approval: need }
      }
      approved = [...new Set(args.approve as string[])].sort()
      if (approved.join(',') !== need.join(',')) {
        return { ok: false, status: 409, reason: 'approval_mismatch', error: `approve must name exactly: ${need.join(', ')}`, nodes_requiring_approval: need, approved }
      }
    }
    const by = `user:${args.userId}`
    const approvals: FlowApprovals | null = need.length
      ? { version: r.draft_version, nodes: need, by, at: this.nowIso(), sha256: flowDefinitionSha256(draft) }
      : null
    // Re-open the incident for the shared apply path (base check, publish, re-run).
    this.db.prepare("UPDATE flow_repairs SET status = 'open' WHERE id = ? AND status = 'needs_review'").run(r.id)
    const out = this.apply(this.getRepair(r.id)!, approvals, by, { reactivate: true })
    if (out.status !== 'applied') return { ok: false, status: 409, reason: out.reason ?? 'not_applied', error: out.detail ?? 'not applied' }
    return { ok: true, repair: out }
  }

  reject(repairId: number, args: { userId: number; note?: unknown }):
    | { ok: true; repair: FlowRepairRow } | { ok: false; status: number; reason: string; error: string } {
    const r = this.getRepair(repairId)
    if (!r) return { ok: false, status: 404, reason: 'repair_not_found', error: 'repair not found' }
    if (r.status !== 'needs_review' && r.status !== 'open') return { ok: false, status: 409, reason: `repair_${r.status}`, error: `repair #${r.id} is ${r.status}` }
    const now = this.nowIso()
    const note = typeof args.note === 'string' && args.note.trim() ? args.note.trim().slice(0, 1000) : null
    this.db.prepare(
      `UPDATE flow_repairs SET status = 'rejected', resolved_by = ?, resolved_at = ?, updated_at = ?, detail = COALESCE(?, detail) WHERE id = ?`,
    ).run(`user:${args.userId}`, now, now, note, r.id)
    this.db.prepare("UPDATE flow_runs SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'repairing'").run(now, r.run_id)
    const out = this.getRepair(r.id)!
    this.emit({ type: 'rejected', repair: out })
    return { ok: true, repair: out }
  }

  // ── Supervision ──────────────────────────────────────────────────────────

  /** Spend over the cap, a card closed without a fix, a replay finished after a backoff, applied cards to close. */
  private async supervise(): Promise<void> {
    const open = this.db.prepare("SELECT * FROM flow_repairs WHERE status = 'open' ORDER BY id").all() as FlowRepairRow[]
    for (const r of open) {
      if (r.replay_run_id != null && this.replayTerminal(r.replay_run_id) && r.replay_json == null) {
        const done = this.concludeReplay(r)
        if (done.status !== 'open') continue
      }
      const spent = this.repairSpend(r)
      if (spent >= r.repair_usd) {
        this.needsReview(r, 'repair_usd', `Repair spend $${spent.toFixed(4)} reached budget.repair_usd $${r.repair_usd.toFixed(2)}. The repair stopped; the workflow is paused.`)
        continue
      }
      if (r.created_at <= this.agoIso(REPAIR_DEFAULTS.openMaxMs) && (r.replay_run_id == null || this.replayTerminal(r.replay_run_id))) {
        this.needsReview(r, 'card_closed', `No draft replayed green within ${REPAIR_DEFAULTS.openMaxMs / 3_600_000} h of the failure.`)
        continue
      }
      if (r.objective_id != null) {
        const card = this.db.prepare('SELECT status, session_id FROM objectives WHERE id = ?').get(r.objective_id) as
          | { status: string; session_id: string | null }
          | undefined
        const closed = !card || card.status === 'cancelled' || card.status === 'done' || (card.status === 'review' && !card.session_id)
        if (closed) {
          this.needsReview(r, 'card_closed', card
            ? `Repair card #${r.objective_id} ended (${card.status}) without a draft that replayed green.`
            : `Repair card #${r.objective_id} no longer exists.`)
        }
      }
    }
    // §5.3 "notice on card, no action needed": an applied repair's card is done once its session ends.
    this.db.prepare(
      `UPDATE objectives SET status = 'done', updated_at = datetime('now')
        WHERE id IN (SELECT objective_id FROM flow_repairs WHERE status = 'applied' AND objective_id IS NOT NULL)
          AND status = 'review' AND session_id IS NULL`,
    ).run()
  }

  // ── Responses + brief text ───────────────────────────────────────────────

  response(r: FlowRepairRow, message: string): RepairDraftResponse {
    return {
      status: r.status,
      repair_id: r.id,
      draft_version: r.draft_version,
      drafts_used: r.drafts,
      drafts_max: REPAIR_DEFAULTS.maxDrafts,
      classification: parse<RepairClassification>(r.classification_json),
      replay: parse<RepairReplaySummary>(r.replay_json),
      applied_version: r.applied_version,
      reason: r.reason,
      message,
    }
  }

  private messageFor(r: FlowRepairRow): string {
    if (r.status === 'applied') return `Applied: v${r.applied_version} is published (author ${r.resolved_by}). ${r.rerun_note ?? ''} You are done — write a one-paragraph summary and end the session.`.trim()
    if (r.status === 'needs_review') return `Handed to the owner (${r.reason}): ${r.detail ?? ''} Do not submit more drafts — summarise and end the session.`.trim()
    const replay = parse<RepairReplaySummary>(r.replay_json)
    return `The replay was not green (${replay?.status ?? 'unknown'}${replay?.error ? `: ${replay.error.type} at ${replay.error.node_id ?? '?'} — ${replay.error.title}` : ''}${replay?.failing_asserts.length ? `; failing asserts: ${replay.failing_asserts.map((a) => a.expr).join('; ')}` : ''}). ${REPAIR_DEFAULTS.maxDrafts - r.drafts} draft(s) left.`
  }

  private reviewDescription(r: FlowRepairRow, flowName: string, reason: string, detail: string): string {
    const lines = [
      `## Needs Review — workflow repair #${r.id} (${reason})`,
      '',
      `Workflow **${flowName}** (flow #${r.flow_id}), failed run #${r.run_id} on v${r.base_version}. Failure signature \`${r.signature}\`${r.definition_rot ? ' — **definition rot** (127 / ENOENT)' : ''}.`,
      '',
      detail,
    ]
    if (r.draft_version != null) {
      const base = this.loadDef(r.flow_id, r.base_version)
      const draft = this.loadDef(r.flow_id, r.draft_version)
      const d = base && draft ? diffFlowNodes(base, draft) : null
      const cls = parse<RepairClassification>(r.classification_json)
      const replay = parse<RepairReplaySummary>(r.replay_json)
      lines.push(
        '', `### Draft v${r.draft_version} (author \`repair:${r.run_id}\`)`, '',
        r.explanation ? `> ${r.explanation.replace(/\n/g, '\n> ')}` : '',
        '', 'JSON Patch:', '', '```json', cap(r.patch_json, REPAIR_DEFAULTS.briefFieldChars), '```',
        d ? `Changed nodes: ${d.changed.join(', ') || '—'}; added: ${d.added.join(', ') || '—'}; removed: ${d.removed.join(', ') || '—'}.` : '',
        cls ? `Safe-class: ${cls.safe ? 'yes' : 'no'}${cls.blockers.length ? ` — ${cls.blockers.map((b) => `\`${b.code}\` ${b.message}`).join('; ')}` : ''}.` : '',
        replay ? `Replay run #${replay.run_id}: ${replay.status}, goal_met=${String(replay.goal_met)}, ${replay.seeded} recorded step(s) reused, stubbed: ${replay.stubbed.map((s) => `${s.node_id} (${s.simulated})`).join(', ') || 'none'}.` : 'Replay: none.',
        '',
        replay?.green
          ? `Approve (owner, signed in): \`POST /api/flows/${r.flow_id}/repairs/${r.id}/approve\` with \`{"approve": [<send/spend node ids>]}\`, or reject with \`…/reject\`.`
          : `The replay was not green, so this draft cannot be approved as is. Reject it (\`POST /api/flows/${r.flow_id}/repairs/${r.id}/reject\`) and fix the workflow by hand.`,
      )
    }
    return lines.filter((l) => l !== undefined).join('\n')
  }

  /** The §5.3 brief: everything the repair agent receives, size-capped and redacted. */
  private repairBrief(repairId: number, run: RunRow, def: FlowDefinition, err: FlowProblem, rot: boolean, repairUsd: number): string {
    const F = REPAIR_DEFAULTS.briefFieldChars
    const nodeId = typeof err.node_id === 'string' ? err.node_id : null
    const attempts = nodeId
      ? this.db.prepare('SELECT * FROM flow_step_runs WHERE run_id = ? AND node_id = ? ORDER BY iteration, attempt').all(run.id, nodeId) as StepRow[]
      : []
    const lastAttempt = attempts[attempts.length - 1]
    // Upstream outputs: the nodes whose output the failing node may read (analyzeFlow), latest row each.
    let upstreamIds: string[] = []
    if (nodeId) {
      try {
        const an = analyzeFlow(def.nodes as unknown as RawNode[])
        upstreamIds = [...(an.availableBefore.get(nodeId) ?? [])]
      } catch { upstreamIds = [] }
    } else {
      upstreamIds = def.nodes.map((n) => n.id)
    }
    const upstream = upstreamIds.map((id) => {
      const row = this.db.prepare(
        "SELECT node_id, iteration, output_json FROM flow_step_runs WHERE run_id = ? AND node_id = ? AND status = 'succeeded' ORDER BY iteration DESC, attempt DESC LIMIT 1",
      ).get(run.id, id) as { node_id: string; iteration: number; output_json: string | null } | undefined
      return row ? `- \`${id}\`${row.iteration ? ` (iteration ${row.iteration})` : ''}: \`${cap(row.output_json, Math.floor(F / 2))}\`` : `- \`${id}\`: (no output in this run)`
    })
    // The same node in the last successful live run of this workflow.
    const good = nodeId
      ? this.db.prepare(
        `SELECT s.run_id, s.input_json, s.output_json, r.version FROM flow_step_runs s JOIN flow_runs r ON r.id = s.run_id
          WHERE r.flow_id = ? AND r.mode = 'live' AND r.status = 'succeeded' AND r.id <> ? AND s.node_id = ? AND s.status = 'succeeded'
          ORDER BY s.run_id DESC, s.iteration DESC LIMIT 1`,
      ).get(run.flow_id, run.id, nodeId) as { run_id: number; input_json: string | null; output_json: string | null; version: number } | undefined
      : undefined
    const api = 'http://localhost:3002/api/flows'
    const auth = '-H "X-CC-Session-Token: $CC_SESSION_TOKEN" -H "Content-Type: application/json"'
    const defText = cap(JSON.stringify(def, null, 2), REPAIR_DEFAULTS.briefDefinitionChars)
    const lines = [
      `You are the **repair agent** for the workflow **${def.name}** (\`${def.id}\`, flow #${run.flow_id}, workspace \`${run.workspace}\`).`,
      `Live run #${run.id} on version ${run.version} failed. Find the cause and answer with a **JSON Patch** (RFC 6902) against version ${run.version} plus a one-paragraph explanation. You draft; the engine replays and decides.`,
      '',
      '## The failure',
      '',
      `- Node: \`${nodeId ?? '(end condition)'}\`  ·  error type: \`${String(err.type)}\`  ·  signature \`${flowFailureSignature(err)}\``,
      `- Error: ${cap(String(err.title ?? ''), F)}`,
      err.detail ? `- Detail: ${cap(String(err.detail), F)}` : '',
      rot ? '- **Definition rot** (exit 127 / ENOENT): the definition points at something that no longer exists (a moved script, a renamed Tool). Point it at what exists now.' : '',
      '',
      '## Failing node: input and attempt history',
      '',
      lastAttempt ? `Input of the last attempt:\n\n\`\`\`json\n${cap(lastAttempt.input_json, F)}\n\`\`\`` : 'No step row (the failure is the end condition).',
      ...attempts.map((a) => `- attempt ${a.attempt}${a.iteration ? ` (iteration ${a.iteration})` : ''}: ${a.status}${a.error_json ? ` — \`${cap(a.error_json, 600)}\`` : ''}`),
      '',
      '## Upstream outputs in this run',
      '',
      ...(upstream.length ? upstream : ['(none)']),
      '',
      '## The same node in the last successful run',
      '',
      good
        ? `Run #${good.run_id} (v${good.version}): input \`${cap(good.input_json, Math.floor(F / 2))}\`, output \`${cap(good.output_json, Math.floor(F / 2))}\``
        : 'No successful run of this node on record.',
      '',
      `## Definition (version ${run.version})`,
      '',
      '```json', defText, '```',
      '',
      '## How to answer',
      '',
      `Submit (at most ${REPAIR_DEFAULTS.maxDrafts} drafts in total):`,
      '',
      `\`curl -s -X POST ${api}/${run.flow_id}/repairs/${repairId}/draft ${auth} -d '{"patch": [{"op": "replace", "path": "/nodes/2/input/list", "value": "{{ steps.fetch.output.items }}"}], "explanation": "…"}'\``,
      '',
      `- Paths index the version ${run.version} document above (\`/nodes/<index>/…\`). Do not set \`version\`; the server assigns it.`,
      '- The answer tells you the result: `applied` (done — summarise and end), `needs_review` (handed to the owner — summarise and end), or `open` with the replay\'s error (iterate).',
      '- The engine REPLAYS the failed run against your draft: recorded outputs are reused up to the failing / changed node, then read nodes run live and write/send/spend nodes are stubbed. The end condition is evaluated by the engine, not by you.',
      '- **Auto-applied only** when the replay is green AND every change is safe-class: an `input`/`arguments` mapping, `retry`/`timeout_ms`, a branch `when`, a lower `loop.max_items`, an llm `prompt`/`output_schema`, an added read-only tool/mcp node (a Tool/connector the flow already uses, `effect: "read"`), or an added `check`.',
      '- **Never** edit `goal`, `approvals`, `workspace`, the trigger, a send/spend node, an existing check, or raise a budget — such a patch always goes to the owner. Never weaken the end condition to make the replay pass.',
      '- Do not call any vendor API or send anything yourself; read the evidence above. You have no credentials for the workflow\'s Tools through this card.',
      `- Your repair budget is $${repairUsd.toFixed(2)} (this card\'s cost ceiling, plus replay spend). Over it, the repair stops and goes to the owner.`,
    ]
    return lines.filter((l) => l !== '').join('\n').replace(/\n(#+ )/g, '\n\n$1').replace(/\n{3,}/g, '\n\n')
  }
}

const REPAIR_COMPLETION_GOAL =
  'Submit a JSON Patch to the repair draft endpoint until the server answers `applied` or `needs_review` (or your drafts run out). Then write a one-paragraph summary: the cause, the patch, the replay result.'

function finiteOr(v: unknown, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d
}

export function repairCardTitle(flowName: string, runId: number, what: string): string {
  return `${what}: ${flowName} (run #${runId})`.slice(0, 200)
}

/** Insert the repair card (or a Needs Review card). Synchronous; the caller owns the transaction. */
export function createRepairCard(db: Database.Database, req: RepairCardRequest): number {
  let parentId: number | null = null
  let createdBy: number | null = null
  if (req.homeObjectiveId != null) {
    const home = db.prepare('SELECT id, created_by FROM objectives WHERE id = ?').get(req.homeObjectiveId) as
      | { id: number; created_by: number | null }
      | undefined
    if (home) { parentId = home.id; createdBy = home.created_by ?? null }
  }
  const r = db.prepare(
    `INSERT INTO objectives (title, description, completion_goal, agent_context, workspace, category, type, status, origin, parent_id, depth, created_by,
                             job_disposition, job_review_note)
     VALUES (?, ?, ?, 'general', ?, 'general', 'task', ?, 'workflow', ?, ?, ?, ?, ?)`,
  ).run(req.title, req.description, req.completionGoal, req.workspace, req.status, parentId, depthForParent(db, parentId), createdBy,
    req.status === 'review' ? 'needs_review' : null, req.reviewNote)
  const id = Number(r.lastInsertRowid)
  if (req.ceilingUsd !== null && req.ceilingUsd > 0) {
    setObjectiveCeiling(db, id, { costUsd: req.ceilingUsd, source: `flow_repair:${req.repairId}` })
  }
  return id
}

/** Host wiring: the card host + activity log. */
export async function hostFlowRepairHost(): Promise<FlowRepairHost> {
  const [{ startFlowAgentCard }, { logActivity }, { broadcast }, { getDb }, { syncFlowRoutine }] = await Promise.all([
    import('./flow-agent.js'),
    import('../routes/feed.js'),
    import('../ws/index.js'),
    import('../db/index.js'),
    import('./flow-routines.js'),
  ])
  return {
    createCard: createRepairCard,
    syncRoutine: (db, flowId) => { syncFlowRoutine(db, flowId) },
    startCard: (id) => startFlowAgentCard(id, 'workflow_repair'),
    notify: (e) => {
      const r = e.repair
      if (e.type === 'needs_review' && r.review_objective_id != null) {
        // The card the owner reviews (a breaker files one with no session): make it visible.
        try {
          const card = getDb().prepare('SELECT * FROM objectives WHERE id = ?').get(r.review_objective_id)
          if (card) broadcast({ type: 'objective_updated', payload: card as never })
        } catch { /* best effort */ }
      }
      try {
        logActivity({
          project: 'flows', workspace: r.workspace,
          event_type: e.type === 'needs_review' ? 'blocker' : e.type === 'applied' ? 'milestone' : 'decision',
          title: e.type === 'opened' ? `Flow run ${r.run_id}: repair #${r.id} opened (${r.signature})`
            : e.type === 'applied' ? `Flow ${r.flow_id}: repaired as v${r.applied_version} (${r.resolved_by})`
              : e.type === 'needs_review' ? `Flow run ${r.run_id}: repair #${r.id} needs review (${r.reason})`
                : `Flow run ${r.run_id}: repair #${r.id} rejected`,
          detail: r.detail,
          metadata: {
            kind: e.type === 'applied' ? 'flow_repaired' : `flow_repair_${e.type}`,
            flow_id: r.flow_id, run_id: r.run_id, repair_id: r.id, signature: r.signature, definition_rot: !!r.definition_rot,
          },
        })
      } catch { /* activity is best-effort */ }
    },
  }
}

// ── Host singleton (routes use the same watcher the engine tick drives) ─────

let hostWatcher: FlowRepairWatcher | null = null
export function setHostRepairWatcher(w: FlowRepairWatcher | null): void { hostWatcher = w }
export function getHostRepairWatcher(): FlowRepairWatcher | null { return hostWatcher }

