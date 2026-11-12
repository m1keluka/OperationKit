/**
 * Workflow run budgets (obj 900639, card B3 of docs/design/WORKFLOWS.md §7.3).
 *
 * Checked BEFORE every spending node (an `llm` or `agent` node, or any node
 * whose effect is `spend`) and again between the model turns of one `llm`
 * node. A run at or over any limit stops there with
 * `status = failed`, `error.type = 'budget'`; the node never runs.
 *
 * Limits, all of which must hold (so the stricter wins):
 *
 *   1. `budget.run_usd` (the flow's own budget) vs `flow_runs.spent_usd`.
 *      ALWAYS enforced — it is part of the definition the owner published.
 *   2. The node's own `budget_usd` (llm / agent) vs what this node has already
 *      cost in this run, across attempts. Always enforced.
 *   3. The job-accounting ceiling (services/job-accounting.ts), with the same
 *      keys every other job uses:
 *        - the home card's own ceiling (`objective_job_accounting` row) vs the
 *          card's CUMULATIVE ledger, which every run's spend is added to;
 *        - else `settings.job_cost_ceiling_usd:<workspace>` /
 *          `settings.job_cost_ceiling_usd`, a per-JOB ceiling, vs THIS run's
 *          spend (a run is the job here).
 *      Gated by the rollout policy `job_ceiling_policy:flow_run[:<workspace>]`
 *      (default `enforce`), exactly like the other auto-start paths:
 *      `enforce` and `observe` both refuse a run that is OVER a configured
 *      ceiling; `observe` only relaxes the "no budget at all" case below; `off`
 *      skips the ceiling and the no-budget rule (never limits 1 and 2).
 *
 *   4. No finite cost limit anywhere (no run_usd, no node budget_usd, no
 *      ceiling): an unattended run would spend without a cap. Under `enforce`
 *      that is refused too — the same "no guessed default, an unbudgeted job is
 *      not started automatically" rule as job-accounting. Under `observe` it
 *      proceeds and the diagnostic is reported.
 *
 * The check is "spent ≥ limit", so one model call can overshoot by its own
 * cost; the overshoot is recorded and stops the run before the NEXT spending
 * node (the card's acceptance wording). The CLI backend's own per-call
 * `--max-budget-usd` bounds a single call.
 */
import type Database from 'better-sqlite3'
import type { FlowBudget, FlowEffect, FlowNode } from '../../../shared/flow/types.js'
import { getSpend, recordSpend, resolveAutoStartPolicy, resolveConfiguredCeiling } from './job-accounting.js'

export interface FlowBudgetProblem {
  [ext: string]: unknown
  type: 'budget'
  title: string
  detail: string
  node_id: string
  retryable: false
  /** Which limit stopped the run: `run_usd` | `node_budget_usd` | `job_ceiling` | `no_budget`. */
  limit: 'run_usd' | 'node_budget_usd' | 'job_ceiling' | 'no_budget'
  cap_usd: number | null
  spent_usd: number
}

export type FlowBudgetCheck =
  | { ok: true; /** Set when policy `observe` let an unbudgeted node through. */ observed: string | null }
  | { ok: false; problem: FlowBudgetProblem }

export interface FlowBudgetRun {
  id: number
  workspace: string
  objective_id: number | null
}

/** Does running this node spend money? */
export function isSpendingNode(node: FlowNode, effect: FlowEffect): boolean {
  return node.kind === 'llm' || node.kind === 'agent' || effect === 'spend'
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
const usd = (n: number) => `$${n.toFixed(4)}`

/** Spend already recorded for the run, and for one node of it (all attempts). */
export function recordedSpend(db: Database.Database, runId: number, nodeId: string): { run: number; node: number } {
  const run = db.prepare('SELECT spent_usd FROM flow_runs WHERE id = ?').get(runId) as { spent_usd: number } | undefined
  const node = db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS s FROM flow_step_runs WHERE run_id = ? AND node_id = ?').get(runId, nodeId) as { s: number }
  return { run: run?.spent_usd ?? 0, node: node.s }
}

/**
 * May `node` (about to spend) run now? `pendingUsd` is spend of the CURRENT
 * attempt not yet written (between turns of one llm node).
 */
export function checkFlowBudget(
  db: Database.Database,
  args: { run: FlowBudgetRun; budget?: FlowBudget; node: FlowNode; pendingUsd?: number },
): FlowBudgetCheck {
  const { run, node } = args
  const pending = finite(args.pendingUsd) ? args.pendingUsd : 0
  const rec = recordedSpend(db, run.id, node.id)
  const runSpent = rec.run + pending
  const nodeSpent = rec.node + pending
  const refuse = (limit: FlowBudgetProblem['limit'], cap: number | null, spent: number, title: string, detail: string): FlowBudgetCheck => ({
    ok: false,
    problem: { type: 'budget', title, detail, node_id: node.id, retryable: false, limit, cap_usd: cap, spent_usd: spent },
  })

  let anyCap = false

  const runUsd = args.budget?.run_usd
  if (finite(runUsd)) {
    anyCap = true
    if (runSpent >= runUsd) {
      return refuse('run_usd', runUsd, runSpent,
        `run budget exhausted before "${node.id}": ${usd(runSpent)} spent of budget.run_usd ${usd(runUsd)}`,
        'The run stopped before this spending node. Raise budget.run_usd in a new version (owner approval) to let it spend more.')
    }
  }

  const nodeUsd = (node.kind === 'llm' || node.kind === 'agent') ? node.budget_usd : undefined
  if (finite(nodeUsd)) {
    anyCap = true
    if (nodeSpent >= nodeUsd) {
      return refuse('node_budget_usd', nodeUsd, nodeSpent,
        `node budget exhausted for "${node.id}": ${usd(nodeSpent)} spent of budget_usd ${usd(nodeUsd)}`,
        'This node has used its own budget_usd across its attempts in this run.')
    }
  }

  const { policy, source: policySource } = resolveAutoStartPolicy(db, 'flow_run', run.workspace)
  if (policy !== 'off') {
    const ceiling = resolveConfiguredCeiling(db, run.objective_id ?? -1, run.workspace)
    if (ceiling.costUsd !== null) {
      anyCap = true
      const perCard = run.objective_id !== null && ceiling.source !== 'global' && !ceiling.source.startsWith('workspace:')
      const spent = perCard ? getSpend(db, run.objective_id as number).spentUsd + pending : runSpent
      if (spent >= ceiling.costUsd) {
        return refuse('job_ceiling', ceiling.costUsd, spent,
          `job cost ceiling reached before "${node.id}": ${usd(spent)} spent against ${usd(ceiling.costUsd)} (source: ${ceiling.source})`,
          perCard
            ? `The workflow's home card #${run.objective_id} is at its cumulative cost ceiling. Policy ${policy} (${policySource}).`
            : `Per-job ceiling for this workspace applies to each run. Policy ${policy} (${policySource}).`)
      }
    }
  }

  if (!anyCap && policy !== 'off') {
    const diag =
      `"${node.id}" spends money but this run has no finite cost limit: no budget.run_usd, no budget_usd on the node, ` +
      `and no job ceiling (settings.job_cost_ceiling_usd:${run.workspace} / settings.job_cost_ceiling_usd). No default was assumed.`
    if (policy === 'enforce') {
      return refuse('no_budget', null, runSpent, `no budget for spending node "${node.id}"`,
        `${diag} Set budget.run_usd on the flow, or set settings.job_ceiling_policy:flow_run:${run.workspace} = 'observe' (${policySource}).`)
    }
    return { ok: true, observed: `${diag} Proceeding under policy ${policy} (${policySource}).` }
  }
  return { ok: true, observed: null }
}

/**
 * Add measured spend to the run and (when the run has a home card) to the card's
 * job-accounting ledger — the "same ledger as job ceilings" of §7.3. The caller
 * runs this inside its fenced transaction together with the step row update.
 */
export function addRunSpend(db: Database.Database, run: FlowBudgetRun, amountUsd: number): void {
  if (!finite(amountUsd) || amountUsd <= 0) return
  db.prepare('UPDATE flow_runs SET spent_usd = spent_usd + ? WHERE id = ?').run(amountUsd, run.id)
  if (run.objective_id !== null) recordSpend(db, run.objective_id, { usd: amountUsd })
}
