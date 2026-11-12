// Run-status helpers for the read-only viewer and the Jobs lanes (card B4,
// docs/design/WORKFLOWS.md §6.2 "Run overlay" and §7.1 lanes).
//
// Pure functions of stored rows, shared by the server (which renders the
// Mermaid text) and the client (which places runs in Jobs lanes).

import type { FlowNodeRunStatus } from './types.js'

/** `flow_runs.status` values (mirrors FLOW_RUN_STATUSES in server db/schema/flow.ts). */
export type FlowRunStatusName = 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'repairing' | 'cancelled'
/** `flow_step_runs.status` values. */
export type FlowStepStatusName = 'running' | 'succeeded' | 'failed' | 'interrupted' | 'unknown'

export const ACTIVE_FLOW_RUN_STATUSES: readonly FlowRunStatusName[] = ['queued', 'running', 'waiting', 'repairing']

export function isActiveFlowRun(status: string): boolean {
  return (ACTIVE_FLOW_RUN_STATUSES as readonly string[]).includes(status)
}

export interface StepStatusRow {
  node_id: string
  iteration?: number
  attempt: number
  status: FlowStepStatusName | string
}

/**
 * Per-node overlay status for one run: the LATEST attempt of each node decides.
 *
 *  - `succeeded` → succeeded
 *  - `running` / `interrupted` → running (in flight, or will be re-run on resume)
 *  - `unknown` → waiting (an "unknown outcome, confirm" approval is pending)
 *  - `failed` while the run is still active → running (a retry is scheduled);
 *    once the run is terminal → failed
 *  - no row at all, on a run that SUCCEEDED → skipped (a branch not taken).
 *    On a failed or active run a node without a row simply has no status yet.
 */
export function nodeStatusFromSteps(
  steps: readonly StepStatusRow[],
  runStatus: FlowRunStatusName | string,
  nodeIds: readonly string[] = [],
): Record<string, FlowNodeRunStatus> {
  const latest = new Map<string, StepStatusRow>()
  for (const s of steps) {
    const prev = latest.get(s.node_id)
    if (!prev || (s.iteration ?? 0) > (prev.iteration ?? 0)
      || ((s.iteration ?? 0) === (prev.iteration ?? 0) && s.attempt >= prev.attempt)) latest.set(s.node_id, s)
  }
  const active = isActiveFlowRun(runStatus)
  const out: Record<string, FlowNodeRunStatus> = {}
  for (const [id, s] of latest) {
    switch (s.status) {
      case 'succeeded': out[id] = 'succeeded'; break
      // B9: in a `waiting` run nothing executes — a `running` row is a node parked
      // on a wait token (approval, agent card, event, timer).
      case 'running': out[id] = runStatus === 'waiting' ? 'waiting' : 'running'; break
      case 'interrupted': out[id] = 'running'; break
      case 'unknown': out[id] = 'waiting'; break
      case 'failed': out[id] = active ? 'running' : 'failed'; break
      default: break
    }
  }
  if (runStatus === 'succeeded') for (const id of nodeIds) if (!(id in out)) out[id] = 'skipped'
  return out
}

/** The three Jobs lanes (same names as the agent-job lanes in JobsBoard). */
export type FlowRunLane = 'running' | 'needs_review' | 'complete'

/**
 * §7.1: Running = queued/running/waiting/repairing; Needs Review = failed, or the
 * run finished but its goal was not met (`goal_met = 0`); Complete = the rest.
 * A failed run that the auto-debug watcher (B8) is repairing is `repairing` (Running)
 * until the repair is applied or handed to the owner; it then shows as failed here.
 */
export function flowRunLane(run: { status: string; goal_met?: number | null }): FlowRunLane {
  if (isActiveFlowRun(run.status)) return 'running'
  if (run.status === 'failed' || run.goal_met === 0) return 'needs_review'
  return 'complete'
}
