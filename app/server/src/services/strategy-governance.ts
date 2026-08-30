// ── Strategy governance (obj 2385) ──────────────────────────────────────────
// The Stage-0 human-confirm decision gate for the Strategy Layer.
//
// A "strategy" is the top tier of the delegation hierarchy: a top-level
// delegator (delegate_mode=1, parent_id IS NULL). It spawns "projects" (its
// direct delegate_mode children) and is re-woken after each completes to decide
// the next step. Per the strategy-layer-autonomy decision + gating framework,
// EVERY strategic decision (spawn-next / pivot / stop / re-scope) is gated at
// Stage 0: the strategy parks in `review` with a structured Decision Request and
// may not act until Operator confirms/denies. This module implements:
//   1. Decision Requests — stored as objective_reviews rows (mode='decision'),
//      reusing the existing review table + human gate rather than a new subsystem.
//   2. A kill-switch — hard $ + project-count ceilings that halt a strategy,
//      enforced in code (the create-objective path refuses further spawns).
//
// Reuse-first: the park itself is the existing `review` status; the resume is the
// existing POST /objectives/:id/message → sendFollowUp. This module only adds the
// decision-record shape, the validator, and the ceiling math.
import type Database from 'better-sqlite3'
import { getDb } from '../db/index.js'
import type { Objective } from '@operationkit/shared'

// ── Strategy-tier dark-launch flag (obj 700030, Part A) ──────────────────────
// The ONE shared definition of "is the Strategy Layer turned on?". Replaces four
// byte-identical local copies that each read only `process.env.CC_STRATEGY_TIER`
// (delegation.ts, state-poller.ts, prompt-builder.ts, routes/internal.ts).
//
// The tier is ON when EITHER the env var is '1' (back-compat — the original
// dark-launch switch, still honored) OR the owner has flipped the runtime
// settings row `strategy_tier_enabled` to '1' (the new in-app toggle, mirroring
// how `auto_merge_enabled` / `auto_remediation_enabled` work). Read at the POINT
// OF USE so the flag can flip live without a restart.
//
// FLAG-OFF EQUIVALENCE: with the env var unset AND the setting absent/!= '1',
// this returns false — byte-identical to the pre-change `=== '1'` checks, so
// every call site behaves exactly as it did before.
const STRATEGY_TIER_SETTING = 'strategy_tier_enabled'

/** Read a settings KV row's truthiness (fail-closed). Mirrors governance.ts. */
function settingTrue(db: Database.Database, key: string): boolean {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value?: string } | undefined
    return row?.value === '1' || row?.value === 'true'
  } catch {
    return false
  }
}

/**
 * Is the Strategy Layer enabled? True when CC_STRATEGY_TIER==='1' (env, back-compat)
 * OR settings.strategy_tier_enabled==='1' (runtime owner toggle). The `db` arg is
 * optional purely so a few env-only callers need not thread a handle; when omitted
 * the shared DB is used. Either source alone is sufficient (OR semantics).
 */
export function isStrategyTierEnabled(db?: Database.Database): boolean {
  if (process.env.CC_STRATEGY_TIER === '1') return true
  try {
    return settingTrue(db ?? getDb(), STRATEGY_TIER_SETTING)
  } catch {
    return false
  }
}

// ── Policy (env-overridable, read at point of use so it can flip live) ───────
function num(v: string | undefined, dflt: number): number {
  const n = parseFloat(v ?? '')
  return Number.isFinite(n) ? n : dflt
}

export interface StrategyPolicy {
  /** Max projects (direct children) a single strategy may spawn before it is
   *  halted for a human check-in. Cumulative, not concurrent. */
  projectCeiling: number
  /** Cumulative subtree-spend ceiling, keyed by the strategy's effort tier.
   *  Mirrors AI_REVIEW_BUDGET_CEILING_USD, lifted to the strategy tier. */
  spendCeilingUsd: Record<string, number>
}

export function getStrategyPolicy(): StrategyPolicy {
  return {
    projectCeiling: num(process.env.STRATEGY_MAX_PROJECTS, 12),
    spendCeilingUsd: {
      normal: num(process.env.STRATEGY_CEILING_NORMAL_USD, 1000),
      high: num(process.env.STRATEGY_CEILING_HIGH_USD, 2000),
      ultracode: num(process.env.STRATEGY_CEILING_ULTRACODE_USD, 4000),
    },
  }
}

export function spendCeilingForEffort(effort: string | null | undefined): number {
  const p = getStrategyPolicy()
  return p.spendCeilingUsd[effort || 'normal'] ?? p.spendCeilingUsd.normal
}

/** A strategy is the top tier: a top-level delegator. */
export function isStrategyObjective(obj: Pick<Objective, 'delegate_mode' | 'parent_id'>): boolean {
  return !!obj.delegate_mode && obj.parent_id == null
}

// ── Kill-switch ──────────────────────────────────────────────────────────────

export interface SubtreeStats {
  /** Cumulative spend across the strategy and ALL descendants. */
  spendUsd: number
  /** Count of the strategy's direct children (its projects), cumulative. */
  projectCount: number
}

/** Sum subtree cost and count direct-child projects for a strategy. */
export function subtreeStats(db: Database.Database, strategyId: number): SubtreeStats {
  const spendRow = db
    .prepare(
      `WITH RECURSIVE subtree(id) AS (
         SELECT id FROM objectives WHERE id = ?
         UNION ALL
         SELECT o.id FROM objectives o JOIN subtree s ON o.parent_id = s.id
       )
       SELECT COALESCE(SUM(total_cost_usd), 0) AS spend
         FROM objectives WHERE id IN (SELECT id FROM subtree)`
    )
    .get(strategyId) as { spend: number }
  const projRow = db
    .prepare('SELECT COUNT(*) AS n FROM objectives WHERE parent_id = ?')
    .get(strategyId) as { n: number }
  return { spendUsd: spendRow.spend ?? 0, projectCount: projRow.n ?? 0 }
}

export interface KillSwitchInput {
  spendUsd: number
  spendCeilingUsd: number
  projectCount: number
  projectCeiling: number
}

export interface KillSwitchVerdict {
  tripped: boolean
  reasons: string[]
}

/** Pure ceiling decision — unit-testable in isolation (mirrors decideRespawnAction). */
export function decideKillSwitch(input: KillSwitchInput): KillSwitchVerdict {
  const reasons: string[] = []
  if (input.spendCeilingUsd > 0 && input.spendUsd >= input.spendCeilingUsd) {
    reasons.push(
      `spend ceiling reached — $${input.spendUsd.toFixed(2)} of $${input.spendCeilingUsd} subtree budget`
    )
  }
  if (input.projectCeiling > 0 && input.projectCount >= input.projectCeiling) {
    reasons.push(
      `project ceiling reached — ${input.projectCount} of ${input.projectCeiling} projects spawned`
    )
  }
  return { tripped: reasons.length > 0, reasons }
}

export interface KillSwitchStatus extends KillSwitchVerdict, SubtreeStats {
  spendCeilingUsd: number
  projectCeiling: number
}

/** Evaluate a live strategy's kill-switch against current telemetry. */
export function evaluateKillSwitch(db: Database.Database, strategy: Objective): KillSwitchStatus {
  const stats = subtreeStats(db, strategy.id)
  const spendCeilingUsd = spendCeilingForEffort(strategy.effort)
  const projectCeiling = getStrategyPolicy().projectCeiling
  const verdict = decideKillSwitch({
    spendUsd: stats.spendUsd,
    spendCeilingUsd,
    projectCount: stats.projectCount,
    projectCeiling,
  })
  return { ...verdict, ...stats, spendCeilingUsd, projectCeiling }
}

// ── Decision Requests ────────────────────────────────────────────────────────

export type DecisionKind = 'spawn-next' | 'pivot' | 'stop' | 're-scope'

export interface DecisionOption {
  id: string
  label: string
  rationale?: string
  est_cost?: string
}

export interface DecisionRequest {
  kind: DecisionKind
  decision: string
  evidence: string[]
  options: DecisionOption[]
  recommendation: string
  recommendation_why?: string
  reversible?: boolean
}

export interface DecisionResolution {
  choice: 'approve' | 'deny'
  option_id?: string
  note?: string
  resolved_by?: string
  resolved_at?: string
}

/** The shape stored as JSON in objective_reviews.markdown_body for a decision row. */
export interface StoredDecision {
  request: DecisionRequest
  resolution?: DecisionResolution
  /** True once this APPROVED decision has authorized a project spawn (obj 700030,
   *  Part B). One approval authorizes exactly ONE spawn; consuming it prevents a
   *  replay of the same approval for a second spawn. */
  consumed?: boolean
}

export interface DecisionRow {
  id: number
  objective_id: number
  iteration: number
  verdict: 'pending' | 'pass' | 'fail'
  created_at: string
  request: DecisionRequest
  resolution?: DecisionResolution
  /** See StoredDecision.consumed. Surfaced so the spawn gate can skip an already-used approval. */
  consumed?: boolean
}

const VALID_KINDS: DecisionKind[] = ['spawn-next', 'pivot', 'stop', 're-scope']

/**
 * Cheap deterministic pre-gate (framework §3.4): reject a malformed Decision
 * Request BEFORE it can park the strategy. A request missing its decision,
 * evidence, options, or recommendation is not a valid gate input.
 */
export function validateDecisionRequest(req: unknown): { ok: true; value: DecisionRequest } | { ok: false; error: string } {
  if (!req || typeof req !== 'object') return { ok: false, error: 'decision request must be an object' }
  const r = req as Record<string, unknown>
  if (!VALID_KINDS.includes(r.kind as DecisionKind)) {
    return { ok: false, error: `kind must be one of ${VALID_KINDS.join(', ')}` }
  }
  if (typeof r.decision !== 'string' || !r.decision.trim()) {
    return { ok: false, error: 'decision (one-sentence action) is required' }
  }
  if (!Array.isArray(r.evidence) || r.evidence.filter((e) => typeof e === 'string' && e.trim()).length === 0) {
    return { ok: false, error: 'evidence must be a non-empty list of concrete signals' }
  }
  if (!Array.isArray(r.options) || r.options.length === 0) {
    return { ok: false, error: 'options must be a non-empty list' }
  }
  for (const o of r.options) {
    if (!o || typeof o !== 'object' || typeof (o as DecisionOption).id !== 'string' || typeof (o as DecisionOption).label !== 'string') {
      return { ok: false, error: 'each option needs an id and a label' }
    }
  }
  if (typeof r.recommendation !== 'string' || !r.recommendation.trim()) {
    return { ok: false, error: 'recommendation is required' }
  }
  return {
    ok: true,
    value: {
      kind: r.kind as DecisionKind,
      decision: (r.decision as string).trim(),
      evidence: (r.evidence as unknown[]).filter((e): e is string => typeof e === 'string' && !!e.trim()),
      options: (r.options as DecisionOption[]).map((o) => ({
        id: String(o.id),
        label: String(o.label),
        rationale: o.rationale ? String(o.rationale) : undefined,
        est_cost: o.est_cost ? String(o.est_cost) : undefined,
      })),
      recommendation: (r.recommendation as string).trim(),
      recommendation_why: typeof r.recommendation_why === 'string' ? r.recommendation_why : undefined,
      reversible: typeof r.reversible === 'boolean' ? r.reversible : undefined,
    },
  }
}

function parseStored(markdownBody: string): StoredDecision | null {
  try {
    const parsed = JSON.parse(markdownBody)
    if (parsed && typeof parsed === 'object' && parsed.request) return parsed as StoredDecision
  } catch {
    /* not a structured decision row */
  }
  return null
}

/**
 * Persist a Decision Request as a pending objective_reviews row (mode='decision').
 * Returns the new row id. Does NOT change objective status — the caller parks
 * the strategy in `review` so the existing human gate + fireWake guard apply.
 */
export function createDecisionRequest(
  db: Database.Database,
  objectiveId: number,
  request: DecisionRequest,
  reviewerSessionId: string
): DecisionRow {
  const next = db
    .prepare('SELECT COALESCE(MAX(iteration), 0) + 1 AS n FROM objective_reviews WHERE objective_id = ?')
    .get(objectiveId) as { n: number }
  const iteration = next.n
  const body: StoredDecision = { request }
  const info = db
    .prepare(
      `INSERT INTO objective_reviews (objective_id, iteration, reviewer_session_id, mode, verdict, markdown_body)
       VALUES (?, ?, ?, 'decision', 'pending', ?)`
    )
    .run(objectiveId, iteration, reviewerSessionId, JSON.stringify(body))
  return {
    id: Number(info.lastInsertRowid),
    objective_id: objectiveId,
    iteration,
    verdict: 'pending',
    created_at: new Date().toISOString(),
    request,
  }
}

function rowToDecision(row: {
  id: number
  objective_id: number
  iteration: number
  verdict: string
  created_at: string
  markdown_body: string
}): DecisionRow | null {
  const stored = parseStored(row.markdown_body)
  if (!stored) return null
  return {
    id: row.id,
    objective_id: row.objective_id,
    iteration: row.iteration,
    verdict: row.verdict as DecisionRow['verdict'],
    created_at: row.created_at,
    request: stored.request,
    resolution: stored.resolution,
    consumed: stored.consumed === true,
  }
}

export function listDecisions(db: Database.Database, objectiveId: number): DecisionRow[] {
  const rows = db
    .prepare(
      `SELECT id, objective_id, iteration, verdict, created_at, markdown_body
         FROM objective_reviews
        WHERE objective_id = ? AND mode = 'decision'
        ORDER BY iteration DESC`
    )
    .all(objectiveId) as Array<{
      id: number; objective_id: number; iteration: number; verdict: string; created_at: string; markdown_body: string
    }>
  return rows.map(rowToDecision).filter((d): d is DecisionRow => d !== null)
}

export function getPendingDecision(db: Database.Database, objectiveId: number): DecisionRow | null {
  return listDecisions(db, objectiveId).find((d) => d.verdict === 'pending') ?? null
}

// ── Per-strategy rollup (obj 700132) ─────────────────────────────────────────
// The single source of truth for the at-a-glance numbers shown next to a strategy
// in BOTH the strategies INDEX list (GET /objectives/strategies) and the strategy
// DETAIL surface (GET /objectives/:id/governance). Anything that needs "how is this
// strategy doing" in one shot calls computeStrategyRollup so the list and detail
// payloads can never drift for the same strategy.

/** Child-objective status counts for a strategy. `total` is every direct child;
 *  the four named buckets map 1:1 to the ObjectiveStatus values that matter at a
 *  glance (the literal `queue` status is surfaced as `queued`). Statuses outside
 *  the four buckets (e.g. planning, ai_review) still count toward `total`. */
export interface StrategyChildCounts {
  total: number
  done: number
  working: number
  queued: number
  review: number
}

/** Compact, list-friendly summary of a strategy. Same numbers the governance
 *  detail endpoint exposes — see computeStrategyRollup. The sibling UI worker
 *  codes the strategies INDEX against this shape. */
export interface StrategyRollup {
  children: StrategyChildCounts
  budget: {
    spendUsd: number
    spendCeilingUsd: number
    projectCount: number
    projectCeiling: number
    killSwitchTripped: boolean
  }
  pendingDecisionId: number | null
}

/**
 * Count a strategy's DIRECT children grouped by status, in a single grouped query
 * (no per-child fan-out). "Direct child" matches governance's own children query
 * (`parent_id = strategyId`) exactly, so projectCount and these counts agree.
 */
export function strategyChildCounts(db: Database.Database, strategyId: number): StrategyChildCounts {
  const rows = db
    .prepare('SELECT status, COUNT(*) AS n FROM objectives WHERE parent_id = ? GROUP BY status')
    .all(strategyId) as Array<{ status: string; n: number }>
  const counts: StrategyChildCounts = { total: 0, done: 0, working: 0, queued: 0, review: 0 }
  for (const r of rows) {
    const n = r.n ?? 0
    counts.total += n
    switch (r.status) {
      case 'done': counts.done += n; break
      case 'working': counts.working += n; break
      case 'queue': counts.queued += n; break
      case 'review': counts.review += n; break
    }
  }
  return counts
}

/**
 * The per-strategy rollup used by both the strategies list and the governance
 * detail endpoint. Budget numbers come from evaluateKillSwitch and the pending
 * decision from getPendingDecision — the SAME functions the governance endpoint
 * already uses — so the two surfaces are guaranteed consistent. Bounded cost:
 * one recursive subtree-spend query + one project-count query (evaluateKillSwitch),
 * one decisions query (getPendingDecision), and one grouped child-count query.
 */
export function computeStrategyRollup(db: Database.Database, strategy: Objective): StrategyRollup {
  const killSwitch = evaluateKillSwitch(db, strategy)
  const pending = getPendingDecision(db, strategy.id)
  return {
    children: strategyChildCounts(db, strategy.id),
    budget: {
      spendUsd: killSwitch.spendUsd,
      spendCeilingUsd: killSwitch.spendCeilingUsd,
      projectCount: killSwitch.projectCount,
      projectCeiling: killSwitch.projectCeiling,
      killSwitchTripped: killSwitch.tripped,
    },
    pendingDecisionId: pending?.id ?? null,
  }
}

/**
 * Approved (verdict='pass', resolution.choice='approve') Decision Requests for a
 * strategy that have NOT yet been consumed by a spawn — oldest first, so the
 * spawn gate consumes approvals in the order they were granted (obj 700030, Part B).
 * Each authorizes exactly ONE project spawn.
 */
export function listApprovedUnconsumedDecisions(db: Database.Database, objectiveId: number): DecisionRow[] {
  return listDecisions(db, objectiveId)
    .filter((d) => d.verdict === 'pass' && d.resolution?.choice === 'approve' && !d.consumed)
    .sort((a, b) => a.iteration - b.iteration)
}

/**
 * Mark an approved decision as consumed so its authorization cannot be replayed
 * for a second spawn. Idempotent; returns false if the row is missing/not a
 * decision. Preserves request + resolution in the stored body.
 */
export function consumeDecision(db: Database.Database, reviewId: number): boolean {
  const existing = getDecisionById(db, reviewId)
  if (!existing) return false
  const body: StoredDecision = { request: existing.request, resolution: existing.resolution, consumed: true }
  db.prepare('UPDATE objective_reviews SET markdown_body = ? WHERE id = ?').run(JSON.stringify(body), reviewId)
  return true
}

export function getDecisionById(db: Database.Database, reviewId: number): DecisionRow | null {
  const row = db
    .prepare(
      `SELECT id, objective_id, iteration, verdict, created_at, markdown_body
         FROM objective_reviews WHERE id = ? AND mode = 'decision'`
    )
    .get(reviewId) as
    | { id: number; objective_id: number; iteration: number; verdict: string; created_at: string; markdown_body: string }
    | undefined
  return row ? rowToDecision(row) : null
}

/**
 * Record Operator's confirm/deny on a pending decision. approve → verdict='pass',
 * deny → verdict='fail'. Appends the resolution into the stored body. Returns
 * the structured `[decision …]` follow-up the caller feeds back to the strategy
 * session via sendFollowUp.
 */
export function resolveDecision(
  db: Database.Database,
  reviewId: number,
  resolution: DecisionResolution
): { decision: DecisionRow; followUp: string } | null {
  const existing = getDecisionById(db, reviewId)
  if (!existing) return null
  const verdict = resolution.choice === 'approve' ? 'pass' : 'fail'
  const body: StoredDecision = { request: existing.request, resolution }
  db.prepare("UPDATE objective_reviews SET verdict = ?, markdown_body = ? WHERE id = ?").run(
    verdict,
    JSON.stringify(body),
    reviewId
  )
  const tag = `[decision d-${existing.objective_id}-${existing.iteration}]`
  let followUp: string
  if (resolution.choice === 'approve') {
    const opt = resolution.option_id ? ` option ${resolution.option_id}` : ''
    followUp = `${tag} APPROVED${opt}. Proceed as recommended.${resolution.note ? ` Note: ${resolution.note}` : ''}\nRead your NOTES.md, execute the approved decision, then continue to your next decision point (park again for the next gate).`
  } else {
    followUp = `${tag} DENIED.${resolution.note ? ` Instead: ${resolution.note}` : ''}\nDo NOT execute the proposed action. Re-plan and present a new Decision Request (park in review) when ready.`
  }
  return { decision: { ...existing, verdict, resolution }, followUp }
}

// ── Progressive-trust ladder (obj 2511) ──────────────────────────────────────
// The 4-rung autonomy ladder from the gating framework §2. Two PURE functions,
// table-driven and unit-testable in isolation (same convention as decideKillSwitch
// above and decideRespawnAction in state-poller):
//   decideTrustStageAction — at a decision point, may this decision run unattended
//                            ('auto-allow') or must it park for a human ('gate')?
//   decideTrustTransition  — should the strategy PROMOTE (slow, metric-driven,
//                            advisory) or DEMOTE (instant, automatic) a stage?
//
// SCAFFOLDING NOTE: this slice (obj 2511) ships these functions + the trust_stage
// column but does NOT wire them into any live gate — Stage-0 (full-gate, the
// current shipped behavior via #160) is what runs. Stage-1+ enforcement that
// actually calls these is a deliberate later slice, so flag-off AND flag-on
// behavior stay byte-identical to today.

/** Ladder bounds. 0 = full-gate (safe default) … 3 = autonomous (final). */
export const TRUST_STAGE_MIN = 0
export const TRUST_STAGE_MAX = 3

export type TrustStageAction = 'auto-allow' | 'gate'

/**
 * Live signals the gate decision consults. Both kill signals force an instant
 * collapse to full-gate regardless of the stored stage — the demotion half of the
 * trust asymmetry (earning trust is slow + human-gated; losing it is instant +
 * machine-enforced; see 2026-06-27-strategy-trust-graduation-asymmetry).
 */
export interface TrustStageMetrics {
  /** Master off-switch (framework §4.2 #3). When explicitly false the whole fleet
   *  drops to Stage-0 full-gate with no per-strategy edit. */
  autonomyEnabled?: boolean
  /** Any guardrail trip — a denial after an auto-executed decision, a false-pass
   *  threshold crossing, or a spend/project ceiling breach (decideKillSwitch).
   *  Forces instant demotion: every decision gates. */
  killSwitchTripped?: boolean
  /** Whether a spawn-next conforms to the human-approved plan-of-record. Stage 1
   *  auto-allows ONLY a conforming spawn; a deviating spawn re-gates (§2.1). */
  conformsToPlanOfRecord?: boolean
  /** Whether the proposed action is reversible. Stages 1–2 auto-allow only
   *  reversible actions; an irreversible one gates (§2.1). Defaults to reversible. */
  reversible?: boolean
}

/**
 * PURE gate decision (framework §2.1): given the strategy's trust stage, the kind
 * of strategic decision, and current metrics, return whether the decision may run
 * unattended ('auto-allow') or must park for a human ('gate').
 *
 * Invariants (all unit-tested):
 *  - Stage 0 (or anything ≤0) gates EVERY decision kind — full-gate default.
 *  - PIVOT and STOP gate until the FINAL stage (3): direction + termination are the
 *    least reversible / least rubric-checkable decisions, so a human owns them longest.
 *  - A tripped kill-switch, or an explicitly disabled master switch, gates everything
 *    regardless of stage (instant demotion).
 *  - Fail-safe: an out-of-range stage or unknown decision kind resolves toward MORE
 *    gating, never less.
 */
export function decideTrustStageAction(
  stage: number,
  decisionType: DecisionKind,
  metrics: TrustStageMetrics = {}
): TrustStageAction {
  // Master off-switch + kill-switch: instant collapse to full-gate.
  if (metrics.autonomyEnabled === false) return 'gate'
  if (metrics.killSwitchTripped) return 'gate'

  const s = Number.isFinite(stage) ? Math.floor(stage) : TRUST_STAGE_MIN
  if (s <= TRUST_STAGE_MIN) return 'gate' // Stage 0 (or below) → full-gate
  const reversible = metrics.reversible !== false // default: treat as reversible

  switch (decisionType) {
    case 'pivot':
    case 'stop':
      // Human-gated until the final stage.
      return s >= TRUST_STAGE_MAX ? 'auto-allow' : 'gate'
    case 're-scope':
      // Reversible re-scope auto-allowed from supervised-autonomy (Stage 2) up.
      return s >= 2 && reversible ? 'auto-allow' : 'gate'
    case 'spawn-next':
      // Stage 2+: any reversible spawn auto-allowed. Stage 1: only a spawn that
      // conforms to the approved plan-of-record (and is reversible).
      if (s >= 2) return reversible ? 'auto-allow' : 'gate'
      return metrics.conformsToPlanOfRecord === true && reversible ? 'auto-allow' : 'gate'
    default:
      return 'gate' // unknown decision kind → safe default
  }
}

/** Metrics that drive promotion eligibility + demotion (framework §2.2, §4). */
export interface TrustPromotionMetrics {
  /** Run length of non-denied decisions (most recent streak). */
  consecutiveApproved: number
  /** Denials in the window. */
  denials: number
  /** approved / (approved + denied) over the window. */
  approvalRate: number
  /** Workspace rolling-30d false-pass rate (getFalsePassRate). */
  falsePassRate: number
  /** Child projects shipped that were NOT later reopened. */
  shippedProjects: number
  /** Strategy-tier ai_review pass rate on auto-executed decisions. */
  strategyReviewPassRate: number
  /** Explicit Operator opt-in — required for 2→3 (never automatic). */
  ownerOptIn: boolean
  /** Any guardrail trip → forces instant demotion (wins over any promotion). */
  killSwitchTripped?: boolean
}

export interface TrustTransitionPolicy {
  promote01: { minConsecutiveApproved: number; maxDenials: number; minApprovalRate: number }
  promote12: { minConsecutiveApproved: number; maxFalsePassRate: number; minShippedProjects: number }
  promote23: { maxFalsePassRate: number; minStrategyReviewPassRate: number; requiresOptIn: boolean }
}

/** Thresholds from framework §2.2 — env-overridable so Operator can tighten/loosen
 *  without a deploy (mirrors getStrategyPolicy). */
export function getTrustTransitionPolicy(): TrustTransitionPolicy {
  return {
    promote01: {
      minConsecutiveApproved: num(process.env.STRATEGY_PROMOTE_01_MIN_APPROVED, 8),
      maxDenials: num(process.env.STRATEGY_PROMOTE_01_MAX_DENIALS, 0),
      minApprovalRate: num(process.env.STRATEGY_PROMOTE_01_MIN_RATE, 0.9),
    },
    promote12: {
      minConsecutiveApproved: num(process.env.STRATEGY_PROMOTE_12_MIN_APPROVED, 15),
      maxFalsePassRate: num(process.env.STRATEGY_PROMOTE_12_MAX_FALSEPASS, 0.1),
      minShippedProjects: num(process.env.STRATEGY_PROMOTE_12_MIN_SHIPPED, 3),
    },
    promote23: {
      maxFalsePassRate: num(process.env.STRATEGY_PROMOTE_23_MAX_FALSEPASS, 0.05),
      minStrategyReviewPassRate: num(process.env.STRATEGY_PROMOTE_23_MIN_REVIEW_RATE, 0.95),
      requiresOptIn: true,
    },
  }
}

export interface TrustTransition {
  /** Stage the strategy is ELIGIBLE to promote to (stage+1), or null. Advisory:
   *  promotion is itself a human-gated decision (§2.2) — never auto-applied. */
  promoteTo: number | null
  /** Stage the strategy is DEMOTED to (one rung down, floored at 0), or null.
   *  Demotion is automatic + immediate the instant a guardrail trips. */
  demoteTo: number | null
  reason: string
}

/**
 * PURE transition decision (framework §2.2): the ASYMMETRIC trust ladder.
 *  - Demotion wins and is automatic: any kill-switch trip immediately demotes one
 *    rung (floored at 0), regardless of any promotion metrics.
 *  - Promotion is slow + metric-driven + advisory: eligibility requires ALL of a
 *    stage's thresholds (and explicit opt-in for 2→3); being eligible does NOT
 *    advance the stage — a human confirms it via the existing decision gate.
 */
export function decideTrustTransition(
  stage: number,
  metrics: TrustPromotionMetrics,
  policy: TrustTransitionPolicy = getTrustTransitionPolicy()
): TrustTransition {
  const s = Number.isFinite(stage) ? Math.floor(stage) : TRUST_STAGE_MIN

  // Demotion is automatic + immediate, and takes precedence over any promotion.
  if (metrics.killSwitchTripped) {
    const demoteTo = Math.max(TRUST_STAGE_MIN, s - 1)
    return { promoteTo: null, demoteTo, reason: `kill-switch tripped — auto-demote ${s}→${demoteTo}` }
  }

  if (s >= TRUST_STAGE_MAX) {
    return { promoteTo: null, demoteTo: null, reason: 'already at max stage' }
  }

  let eligible = false
  let reason = ''
  if (s <= 0) {
    eligible =
      metrics.consecutiveApproved >= policy.promote01.minConsecutiveApproved &&
      metrics.denials <= policy.promote01.maxDenials &&
      metrics.approvalRate >= policy.promote01.minApprovalRate
    reason = eligible ? '0→1: approval thresholds met' : '0→1: approval thresholds not met'
  } else if (s === 1) {
    eligible =
      metrics.consecutiveApproved >= policy.promote12.minConsecutiveApproved &&
      metrics.falsePassRate < policy.promote12.maxFalsePassRate &&
      metrics.shippedProjects >= policy.promote12.minShippedProjects
    reason = eligible ? '1→2: quality + shipped thresholds met' : '1→2: thresholds not met'
  } else if (s === 2) {
    eligible =
      metrics.falsePassRate < policy.promote23.maxFalsePassRate &&
      metrics.strategyReviewPassRate >= policy.promote23.minStrategyReviewPassRate &&
      (!policy.promote23.requiresOptIn || metrics.ownerOptIn === true)
    reason = eligible ? '2→3: quality thresholds + opt-in met' : '2→3: thresholds/opt-in not met'
  }
  return { promoteTo: eligible ? s + 1 : null, demoteTo: null, reason }
}
