/**
 * Bulk POST /objectives — extracted from internal.ts (behavior frozen).
 * Localhost-or-bearer auth and SQL unchanged.
 */
import { Router } from 'express'
import { getDb, resolveStrategyId } from '../db/index.js'
import { broadcast } from '../ws/index.js'
import { logActivity } from './feed.js'
import { getWorkspace } from '../services/workspaces.js'
import { defaultAgentForWorkspace } from './objectives-helpers.js'
import { resolveObjectiveModel } from '../services/model-registry.js'
import type { Objective } from '@operationkit/shared'
import { hasValidObjectivesToken } from '../middleware/objectives-token.js'
import { depthForParent } from '../lib/objective-depth.js'
import { getEffectiveGateMode, isRegisteredFrontendRepo, criteriaHaveUiBar, buildDsConformanceCriteria, repoHasE2eSuite, criteriaHaveQaBar, buildQaConformanceCriteria } from '../services/design-context.js'
import { isBlockedRegistryEnabled, isBlockedRegistryKilled, findBlockingRule } from '../services/governance.js'
import {
  isStrategyObjective,
  isStrategyTierEnabled,
  evaluateKillSwitch,
  decideTrustStageAction,
  listApprovedUnconsumedDecisions,
  consumeDecision,
} from '../services/strategy-governance.js'
import { isLocalhost } from '../lib/is-localhost.js'
import { startSession } from '../services/session-manager.js'
import { MAX_CONCURRENT_SESSIONS } from '@operationkit/shared'
import { childCapPerParent } from '../lib/hygiene-config.js'

// Strategy Layer (P0) — bounded delegation-nesting controls.
//   Canonical hierarchy (see docs/terminology-glossary.md):
//     Strategy (tier 0) → Objective (tier 1) → Sub-objective (tier 2, leaf).
//   These are TIERS (a row's level), orthogonal to `type` (project/bug/task),
//   which is a kind-of-work tag, not a tier. A Strategy carries the stored
//   is_strategy marker (obj 2383); the tiers below it are tracked by `depth`.
//   MAX_DELEGATION_DEPTH: hard ceiling on tree depth — a leaf must have
//     depth < MAX_DELEGATION_DEPTH (i.e. childDepth may never reach 3).
//   Strategy tier flag: the shared isStrategyTierEnabled() helper (env
//     CC_STRATEGY_TIER OR settings.strategy_tier_enabled). Read at the POINT OF
//     USE (not cached at import) so the flag can flip without a restart and so
//     tests can exercise both flag states in one process. With the flag OFF the
//     nesting guard rejects EXACTLY the same inputs as the pre-Strategy-Layer code.
const MAX_DELEGATION_DEPTH = 3

export function registerInternalCreateRoutes(router: Router): void {
// Bulk create objectives from a session (top-level board cards only).
//
// Auth (obj 702304): on-box first-party callers (kitchen-loop, meeting-queue,
// planner sessions) reach this via localhost with no token and keep working.
// Cross-host callers — the Cattle AI thread scanner on the example2-ops droplet —
// must present a valid `Authorization: Bearer <OBJECTIVES_API_TOKEN>`. Anything
// that is neither localhost nor a valid token is rejected with 401. The token is
// scoped to objective-create ONLY (deploy/restart stay behind INTERNAL_API_SECRET).
router.post('/objectives', async (req, res) => {
  if (!hasValidObjectivesToken(req) && !isLocalhost(req)) {
    res.status(401).json({ error: 'Unauthorized: valid Authorization: Bearer <OBJECTIVES_API_TOKEN> required for cross-host objective creation' })
    return
  }

  const items = req.body as Array<{
    title: string
    description?: string
    agent_context?: string
    workspace?: string
    project?: string
    category?: string
    parent_id?: number
    completion_goal?: string
    workflow_hint?: string
    effort?: string
    model?: string
    type?: 'project' | 'bug' | 'task'
    delegate_mode?: boolean
    /** obj 706230: PERSISTED since W7. Both this and `delegate_mode` were
     *  previously declared/read but omitted from the INSERT column list, so a
     *  delegator's `create_pr: true` returned 201 and stored 0 — a silent drop
     *  that strands a finished worker's branch with no PR. */
    create_pr?: boolean
    /** Board-Project association (obj 708808). When omitted and parent_id is set,
     *  the parent's project_id is inherited. Rejected with 400 on workspace mismatch. */
    project_id?: number | null
    acceptance_criteria?: Array<{ id: string; criterion: string; type?: string; method?: string }>
    /** Backlink to the job (routine-spawned objective) that produced this one,
     *  set when a job creates an objective in response to an in-thread reply.
     *  Surfaces as "spawned objective #N" on the Jobs board card. */
    source_job_id?: number
    /** Provenance override, WHITELISTED to 'retro' (obj 705052). `origin` is
     *  otherwise server-computed; the Daily Session Retrospective needs its rows
     *  exactly queryable (its own WIP brake and its precision metric both select
     *  on origin='retro'), and a title-prefix match would be a second, drifting
     *  source of truth. Any other value is ignored and the computed origin
     *  stands, so this cannot forge 'strategy'/'manual'/'job_reply' provenance. */
    origin?: string
  }>

  if (!Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: 'Expected array of objectives' })
    return
  }

  // ── obj 706230 (W7): no silent drops ──────────────────────────────────────
  // This handler used to read the fields it understood off the caller's object
  // and ignore everything else. That is what let `create_pr: true` return 201
  // and store 0, and it is the same reason `"agent"` (a typo for
  // `agent_context`) quietly became the 'cto' default and `"status":"queued"`
  // quietly became 'queue'. A caller cannot tell an honoured field from a
  // discarded one, so every unsupported key is now a 400 that names it.
  //
  // Fields deliberately NOT settable here are rejected rather than ignored:
  //   status / depth / origin(≠retro) / is_strategy — server-computed provenance
  //   and state. Rejecting is safe: no in-repo caller posts any of these (the
  //   producers are kitchen-loop.ts, daily-retro.ts, weekly-security-review.sh
  //   and the prompt-builder curl template, all of which post accepted keys only).
  //
  // Any column added to the INSERT below must also be added here.
  const ACCEPTED_ITEM_KEYS = new Set([
    'title', 'description', 'agent_context', 'workspace', 'project', 'category',
    'parent_id', 'completion_goal', 'workflow_hint', 'effort', 'model', 'type',
    'delegate_mode', 'create_pr', 'acceptance_criteria', 'source_job_id', 'origin',
  ])
  // Near-miss hints for the names ad-hoc curl callers actually reach for. The
  // `agent` / `agent_context` confusion is not hypothetical — it is what the
  // reproduction for this very bug tripped over.
  const KEY_HINTS: Record<string, string> = {
    agent: 'agent_context',
    agent_name: 'agent_context',
    org: 'workspace',
    repo: 'project',
    goal: 'completion_goal',
    criteria: 'acceptance_criteria',
    priority: 'effort',
  }
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (item == null || typeof item !== 'object' || Array.isArray(item)) {
      res.status(400).json({ error: `Item ${i}: expected an object` })
      return
    }
    const unknown = Object.keys(item).filter((k) => !ACCEPTED_ITEM_KEYS.has(k))
    if (unknown.length > 0) {
      const hints = unknown
        .filter((k) => KEY_HINTS[k])
        .map((k) => `Did you mean '${KEY_HINTS[k]}' for '${k}'? `)
        .join('')
      res.status(400).json({
        error:
          `Item ${i}: unsupported field(s) ${unknown.map((k) => `'${k}'`).join(', ')}. ` +
          `This route no longer ignores fields it cannot honour — a dropped flag is invisible to the caller. ` +
          hints +
          `Accepted: ${[...ACCEPTED_ITEM_KEYS].sort().join(', ')}.`,
        // Machine-readable so a caller can react without parsing prose.
        unsupported_fields: unknown,
      })
      return
    }
    // `type` used to fall back to 'task' for any unrecognized value — the same
    // silent-coercion class as create_pr, so it is rejected too.
    if (item.type !== undefined && item.type !== 'project' && item.type !== 'bug' && item.type !== 'task') {
      res.status(400).json({ error: `Item ${i}: invalid type '${item.type}' (expected 'project', 'bug' or 'task')` })
      return
    }
    // `origin` is server-computed; 'retro' is the ONLY client-settable value
    // (see the whitelist note on the request type). Any other value used to be
    // silently overwritten by the computed origin — now it is refused.
    if (item.origin !== undefined && item.origin !== 'retro') {
      res.status(400).json({
        error: `Item ${i}: origin '${item.origin}' is not client-settable — origin is server-computed and only 'retro' may be requested.`,
      })
      return
    }
  }

  // Phase-3 gate: each item's agent must be in the target workspace's pool.
  // Reject the whole batch if any item violates — sessions calling this should
  // get clear feedback instead of partial inserts.
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (!item.title?.trim()) continue
    const ws = getWorkspace(item.workspace || 'example')
    if (!ws) continue
    const pool = ws.default_agent_pool
    if (!pool || pool.length === 0) continue
    // obj 708817: absent agent_context resolves through the SAME helper the
    // human route uses (workspace pool[0], else 'general'), reconciling the
    // old 'general' vs 'cto' divergence. Explicit agent_context is unchanged.
    const agent = item.agent_context || defaultAgentForWorkspace(item.workspace || 'example')
    if (!pool.includes(agent)) {
      res.status(400).json({
        error: `Item ${i} ('${item.title.trim()}'): agent '${agent}' not in workspace '${ws.slug}' pool (allowed: ${pool.join(', ')})`,
      })
      return
    }
  }

  const db = getDb()

  // Safety rails for delegator orchestration — only apply to items with a
  // parent_id (top-level bulk creation is unaffected):
  //   1. Nested delegation (a delegate_mode child) is allowed ONLY when the
  //      Strategy Layer flag is on, the parent is itself a delegator, and the
  //      resulting depth still leaves room for a Sub-objective tier below it.
  //   2. A hard depth ceiling (MAX_DELEGATION_DEPTH) replaces the old
  //      "parent must be top-level" rule.
  //   3. Per-parent cap on non-done children to prevent runaway spawning.
  //
  // FLAG-OFF EQUIVALENCE INVARIANT: with CC_STRATEGY_TIER unset this guard
  // rejects exactly the inputs the pre-change code did. CHECK 1 rejects every
  // delegate_mode child (flag off → first branch fires, same message as before).
  // CHECK 2 falls back to the EXACT legacy `parent.parent_id != null` rule when
  // the flag is off, so any grandchild is rejected regardless of stored depth.
  // See the tests for the proof that flag-off behavior is identical to today.
  const CHILD_CAP_PER_PARENT = 20
  const parentChildCounts = new Map<number, number>()
  // Resolved once in this loop, reused by the INSERT below to derive each
  // child's depth as parent.depth + 1 (never trust a client-supplied depth).
  const parentDepthById = new Map<number, number>()
  // obj 700030 Part B — Decision Requests RESERVED to authorize a spawn in THIS
  // batch. Reserved during validation (so two projects under one strategy can't
  // share one approval), CONSUMED only after the insert transaction succeeds (so a
  // batch that is rejected later never burns an owner approval).
  const reservedDecisionIds = new Set<number>()
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (!item.title?.trim() || item.parent_id == null) continue
    const parent = db.prepare('SELECT id, parent_id, depth, delegate_mode FROM objectives WHERE id = ?').get(item.parent_id) as { id: number; parent_id: number | null; depth: number; delegate_mode: number } | undefined
    if (!parent) {
      res.status(400).json({ error: `Item ${i}: parent_id ${item.parent_id} does not exist` })
      return
    }
    parentDepthById.set(item.parent_id, parent.depth)
    const childDepth = parent.depth + 1

    // CHECK 1 — nested delegation. A delegate_mode child (a mid-tier Objective
    // that itself delegates) is permitted only when the flag is on, its parent
    // is a delegator (a Strategy), and it leaves room for a Sub-objective tier
    // below it. (Tier names per docs/terminology-glossary.md.)
    if (item.delegate_mode) {
      if (!isStrategyTierEnabled(db)) {
        res.status(400).json({ error: `Item ${i}: a sub-objective (parent_id set) cannot itself run in delegator mode (no nested delegation)` })
        return
      }
      if (!parent.delegate_mode) {
        res.status(400).json({ error: `Item ${i}: a delegator child (mid-tier Objective) may only be created under a delegator parent (Strategy)` })
        return
      }
      if (childDepth > MAX_DELEGATION_DEPTH - 1) {
        res.status(400).json({ error: `Item ${i}: Objective tier would exceed depth budget (childDepth ${childDepth})` })
        return
      }
      // Strategy kill-switch (obj 2385). A strategy is a top-level delegator;
      // spawning a project under it is the gated act the ceilings guard. If the
      // strategy has hit its $ or project-count ceiling, refuse the spawn AND
      // force it to `review` with a STOP note so the runaway is a visible human
      // event (the existing review-park + fireWake guard then hold it).
      if (parent.parent_id == null) {
        const strat = db.prepare('SELECT * FROM objectives WHERE id = ?').get(item.parent_id) as Objective | undefined
        if (strat && isStrategyObjective(strat)) {
          const ks = evaluateKillSwitch(db, strat)
          if (ks.tripped) {
            if (strat.status !== 'review') {
              db.prepare("UPDATE objectives SET status = 'review', updated_at = datetime('now') WHERE id = ?").run(strat.id)
              const updated = db.prepare('SELECT * FROM objectives WHERE id = ?').get(strat.id) as Objective
              broadcast({ type: 'objective_updated', payload: updated })
              logActivity({
                project: strat.project || strat.workspace,
                title: `Strategy #${strat.id} kill-switch tripped`,
                detail: ks.reasons.join('; '),
                event_type: 'blocker',
              })
            }
            res.status(409).json({
              error: `Item ${i}: strategy #${strat.id} kill-switch tripped — ${ks.reasons.join('; ')}. Spawn refused; strategy halted to review.`,
              kill_switch: ks,
            })
            return
          }
        }
      }
    }

    // CHECK 1.5 — HARD stage-0 human gate (obj 700030, Part B). When the tier is
    // ON and this child is spawned DIRECTLY under a strategy (a top-level
    // delegator), the strategy's trust stage governs whether the spawn may run
    // unattended. decideTrustStageAction returns 'gate' at trust_stage<=0
    // (full-gate, the safe default), so the spawn is REFUSED unless an owner has
    // APPROVED a not-yet-consumed Decision Request for that strategy. Each approval
    // authorizes exactly ONE spawn (reserved here, consumed after insert). This is
    // what makes it structurally impossible for a stage-0 strategy to create a
    // project without explicit human sign-off.
    //
    // SCOPE: only fires when `parent` is an explicitly-marked STRATEGY (is_strategy=1
    // — the canonical marker; trust_stage is only meaningful there). This is exactly
    // what separates a strategy from an ORDINARY top-level delegator (is_strategy=0),
    // so ordinary (non-strategy) delegators and plain workers are NEVER gated.
    // FLAG-OFF EQUIVALENCE: isStrategyTierEnabled(db) is false when the env var is
    // unset AND the setting is absent/!= '1' → the whole block is skipped → the
    // spawn path is byte-identical to today.
    if (isStrategyTierEnabled(db) && parent.parent_id == null) {
      const strat = db.prepare('SELECT * FROM objectives WHERE id = ?').get(item.parent_id) as Objective | undefined
      if (strat && Number(strat.is_strategy) === 1 && isStrategyObjective(strat)) {
        const action = decideTrustStageAction(strat.trust_stage ?? 0, 'spawn-next', {})
        if (action === 'gate') {
          const approval = listApprovedUnconsumedDecisions(db, strat.id).find((d) => !reservedDecisionIds.has(d.id))
          if (!approval) {
            res.status(409).json({
              error:
                `Item ${i}: strategy #${strat.id} is human-gated at trust stage ${strat.trust_stage ?? 0} — every project spawn must be authorized by an owner-approved Decision Request. ` +
                `Park one via POST /api/internal/objectives/${strat.id}/decision and await approval, then retry the spawn.`,
              human_gate: { strategy_id: strat.id, trust_stage: strat.trust_stage ?? 0, action },
            })
            return
          }
          reservedDecisionIds.add(approval.id)
        }
      }
    }

    // CHECK 2 — nesting ceiling. FLAG-BRANCHED to guarantee flag-off equivalence.
    //
    // Flag OFF: reproduce the EXACT legacy rule (reject any parent that is itself
    //   a child). This is byte-equivalent to the pre-change code and is robust to
    //   the depth backfill — normal one-level workers are backfilled to depth 1,
    //   so a pure `childDepth >= MAX_DELEGATION_DEPTH` ceiling would let a
    //   grandchild (childDepth 2) slip through; the legacy parent_id check does
    //   not. (This is a deliberate, safer deviation from design-doc §2.2, which
    //   assumed the deepest legal parent stayed at depth 0.)
    // Flag ON: use the depth ceiling so the Strategy → Objective → Sub-objective
    //   tiers are allowed up to (but not at/through) MAX_DELEGATION_DEPTH.
    if (!isStrategyTierEnabled(db)) {
      if (parent.parent_id != null) {
        res.status(400).json({ error: `Item ${i}: cannot nest workers more than one level deep (parent ${item.parent_id} is itself a child)` })
        return
      }
    } else if (childDepth >= MAX_DELEGATION_DEPTH) {
      res.status(400).json({ error: `Item ${i}: cannot nest workers beyond depth ${MAX_DELEGATION_DEPTH - 1} (childDepth ${childDepth})` })
      return
    }

    if (!parentChildCounts.has(item.parent_id)) {
      const existing = db.prepare("SELECT COUNT(*) as n FROM objectives WHERE parent_id = ? AND status != 'done'").get(item.parent_id) as { n: number }
      parentChildCounts.set(item.parent_id, existing.n)
    }
    const next = (parentChildCounts.get(item.parent_id) || 0) + 1
    if (next > CHILD_CAP_PER_PARENT) {
      res.status(400).json({ error: `Item ${i}: parent ${item.parent_id} would exceed the ${CHILD_CAP_PER_PARENT}-child cap (has ${next - 1} non-done children)` })
      return
    }
    parentChildCounts.set(item.parent_id, next)
  }

  const insert = db.prepare(
    // obj 706230 (W7) — ROOT CAUSE OF THE SILENT DROP WAS HERE: `create_pr` and
    // `delegate_mode` were absent from this column list (and from the bind list
    // below), so both fell through to their `NOT NULL DEFAULT 0` column
    // definitions no matter what the caller posted. Boolean->integer coercion
    // mirrors the authenticated sibling route (objectives.ts `create_pr ? 1 : 0`).
    `INSERT INTO objectives (title, description, agent_context, workspace, project, project_id, category, parent_id, depth, completion_goal, workflow_hint, effort, model, type, acceptance_criteria, source_job_id, origin, strategy_id, create_pr, delegate_mode)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )

  // ── KL-11 blocked-combos registry (obj-2509) ─────────────────────────────
  // Skip generating objectives whose title matches a known-blocked rule (work
  // blocked on an external dependency — this objective's second named active
  // blocker: re-spawning work that cannot make progress). Flag-gated (default
  // OFF) + kill switch: while off, blockRegistryOn is false and EVERY item is
  // created exactly as before (byte-identical). Active rules auto-expire (time- or
  // ticket-based) inside findBlockingRule's read filter, so a resolved block stops
  // skipping with no code change. Failing to create a blocked item is NOT an error
  // (we don't 4xx the whole batch) — it is reported in the response `blocked` list.
  const blockRegistryOn = isBlockedRegistryEnabled(db) && !isBlockedRegistryKilled(db)
  const blocked: Array<{ title: string; reason: string; pattern: string; unblock_ticket: string | null }> = []

  const created: Array<{ id: number; title: string }> = []
  const insertAll = db.transaction(() => {
    for (const item of items) {
      if (!item.title?.trim()) continue
      if (blockRegistryOn) {
        const rule = findBlockingRule(db, item.title)
        if (rule) {
          blocked.push({ title: item.title.trim(), reason: rule.reason, pattern: rule.objective_pattern, unblock_ticket: rule.unblock_ticket })
          console.log(`[internal] KL-11 blocked-registry: skipped objective "${item.title.trim()}" — matches "${rule.objective_pattern}" (${rule.reason})`)
          continue
        }
      }
      const type = item.type === 'project' || item.type === 'bug' || item.type === 'task' ? item.type : 'task'
      // Delegator-supplied acceptance criteria pre-lock the review rubric so the
      // independent reviewer grades against intended scope, not a reverse-engineered one.
      const suppliedCriteria = Array.isArray(item.acceptance_criteria) ? item.acceptance_criteria : []
      // Defense-in-depth (Wave B, task 3b): if a worker targets a registered
      // frontend repo and the delegator forgot to attach a taste bar, auto-append
      // the 5-criterion ds-conformance block. Gated on the FILE-backed, per-platform
      // resolver `getEffectiveGateMode(item.project) !== 'off'` so this is a no-op
      // (byte-identical) while the project's effective mode is off — i.e. `.ui-gate.json`
      // absent + env unset, mode 'off', or this project outside a non-empty allowlist.
      // (This route works on a bare project string, not a full Objective, so it can't
      // use isUiInjectionActive; the resolver is the same control-plane the spawn path
      // and reviewer use.) Skipped for delegators (they orchestrate, they don't build
      // UI) and never double-appended when a visual/static/browser (or ds-*) criterion
      // is already present.
      //
      // NOTE (obj 1453): this append is keyed on the PROJECT, decided BEFORE any file is
      // written — so a backend-only objective on a registered frontend repo still gets the
      // ds-* block here. The per-PR correction happens at REVIEW time, where the changed
      // files ARE known: GET /api/internal/reviews/:id/criteria (reviews.ts) strips the
      // visual/ds-* criteria when the PR touches no UI file, so a backend PR is graded on
      // correctness/tsc/tests and has a reachable green path. Frontend PRs keep the full
      // rubric. We intentionally keep appending here (the safety net) and let the
      // file-aware reviewer gate be the place that down-scopes it.
      const gateOn = getEffectiveGateMode(item.project) !== 'off' && !item.delegate_mode
      // ds-conformance (taste) auto-append — registered frontend repo, no UI bar yet.
      const dsAppend =
        gateOn && isRegisteredFrontendRepo(item.project) && !criteriaHaveUiBar(suppliedCriteria)
          ? buildDsConformanceCriteria(item.project!)
          : []
      // qa-conformance (production-worthy) auto-append (obj 2390) — sibling safety net for
      // repos with a Playwright/E2E suite that lack a qa-* bar. Both checks key on the
      // ORIGINAL suppliedCriteria so neither append suppresses the other, and both are
      // byte-identical no-ops while the project's effective gate mode is 'off'.
      const qaAppend =
        gateOn && repoHasE2eSuite(item.project) && !criteriaHaveQaBar(suppliedCriteria)
          ? buildQaConformanceCriteria()
          : []
      const effectiveCriteria = [...suppliedCriteria, ...dsAppend, ...qaAppend]
      const criteria = effectiveCriteria.length > 0
        ? JSON.stringify(effectiveCriteria)
        : null
      // depth is DERIVED, never client-supplied: a child is parent.depth + 1
      // (parent depth resolved in the guard loop above), a top-level row is 0.
      const depth = item.parent_id != null ? (parentDepthById.get(item.parent_id) ?? 0) + 1 : 0
      // Provenance (obj 2386): this batch route is the delegator/strategy
      // decomposition path. A row spawned from a job's in-thread reply carries
      // source_job_id => 'job_reply'; otherwise it's a strategy-decomposed
      // sub-objective => 'strategy'. strategy_id inherits from the parent chain.
      const itemSourceJobId = typeof item.source_job_id === 'number' ? item.source_job_id : null
      // 'retro' is the ONLY client-settable origin (obj 705052) — see the
      // whitelist note on the request type above.
      const origin = item.origin === 'retro' ? 'retro' : itemSourceJobId != null ? 'job_reply' : 'strategy'
      const itemStrategyId = resolveStrategyId(db, null, item.parent_id ?? null)
      // project_id (obj 708808): explicit value → validate workspace; omitted + has parent → inherit.
      const itemWorkspace = item.workspace || 'example'
      let itemProjectId: number | null = null
      if (item.project_id !== undefined && item.project_id !== null) {
        const prow = db.prepare('SELECT workspace FROM projects WHERE id = ?').get(item.project_id) as { workspace: string } | undefined
        if (prow && prow.workspace === itemWorkspace) {
          itemProjectId = item.project_id
        }
        // silently drop cross-workspace project_id (internal route; no 400)
      } else if (item.project_id === null) {
        itemProjectId = null // explicit detach
      } else if (item.parent_id) {
        const parentRow = db.prepare('SELECT project_id FROM objectives WHERE id = ?').get(item.parent_id) as { project_id: number | null } | undefined
        itemProjectId = parentRow?.project_id ?? null
      }
      const result = insert.run(
        item.title.trim(),
        item.description || '',
        item.agent_context || defaultAgentForWorkspace(itemWorkspace),
        itemWorkspace,
        item.project || null,
        itemProjectId,
        item.category || 'general',
        item.parent_id || null,
        depth,
        item.completion_goal || null,
        item.workflow_hint || null,
        item.effort || 'normal',
        resolveObjectiveModel({
          model: item.model,
          type,
          create_pr: item.create_pr,
          delegate_mode: item.delegate_mode,
        }),
        type,
        criteria,
        itemSourceJobId,
        origin,
        itemStrategyId,
        item.create_pr ? 1 : 0,
        // Safe to persist: a delegate_mode CHILD is already fully adjudicated by
        // CHECK 1 above (nested-delegation flag, delegator parent, depth budget,
        // strategy kill-switch) and 400s before reaching this insert. A top-level
        // delegator is legitimate and ungated. Until now the guard ran, allowed
        // the row, and then threw the value away.
        item.delegate_mode ? 1 : 0,
      )
      created.push({ id: result.lastInsertRowid as number, title: item.title.trim() })
    }
  })
  insertAll()

  // obj 700030 Part B — the batch passed validation and the rows are committed,
  // so consume each owner approval that authorized a spawn in this batch. Done
  // here (not in the guard loop) so a batch rejected mid-validation never burns an
  // approval. One approval = one spawn: a consumed decision can't authorize again.
  for (const reviewId of reservedDecisionIds) {
    consumeDecision(db, reviewId)
  }

  // Broadcast updates so the board refreshes live
  for (const { id } of created) {
    const obj = db.prepare('SELECT * FROM objectives WHERE id = ?').get(id) as Objective
    if (obj) broadcast({ type: 'objective_updated', payload: obj })
  }

  // Auto-start children of a live delegator. The parent used to POST then
  // PATCH working; forgetting the PATCH left kids in queue forever. Start
  // under the session cap and per-parent in-flight cap; leftovers stay queue.
  const started: number[] = []
  const cap = childCapPerParent()
  for (const { id } of created) {
    const obj = db.prepare('SELECT * FROM objectives WHERE id = ?').get(id) as Objective | undefined
    if (!obj?.parent_id) continue
    const parent = db.prepare('SELECT * FROM objectives WHERE id = ?').get(obj.parent_id) as Objective | undefined
    if (!parent || parent.status !== 'working' || !parent.delegate_mode) continue
    const active = (
      db.prepare("SELECT COUNT(*) as n FROM objectives WHERE status IN ('working', 'ai_review')").get() as { n: number }
    ).n
    if (active >= MAX_CONCURRENT_SESSIONS) break
    const inFlight = (
      db.prepare("SELECT COUNT(*) as n FROM objectives WHERE parent_id = ? AND status IN ('working', 'ai_review')").get(parent.id) as { n: number }
    ).n
    if (inFlight >= cap) continue
    try {
      const sessionId = await startSession(obj)
      db.prepare(
        "UPDATE objectives SET status = 'working', session_id = ?, updated_at = datetime('now') WHERE id = ?",
      ).run(sessionId, obj.id)
      started.push(obj.id)
      const updated = db.prepare('SELECT * FROM objectives WHERE id = ?').get(obj.id) as Objective
      broadcast({ type: 'objective_updated', payload: updated })
    } catch (err) {
      console.warn(`[internal] auto-start child ${obj.id} failed (left in queue):`, (err as Error).message)
    }
  }

  console.log(`[internal] Created ${created.length} objectives from session` + (blocked.length ? `; ${blocked.length} skipped by blocked-registry` : '') + (started.length ? `; auto-started ${started.length}` : ''))
  res.status(201).json({ created: created.length, objectives: created, blocked: blocked.length, blocked_details: blocked, started: started.length })
})


}
