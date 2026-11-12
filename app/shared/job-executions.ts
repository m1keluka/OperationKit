// Per-run execution history for Jobs (obj 900676) — the n8n-style "Executions" view.
//
// One `JobExecutionSummary` per routine fire (AI, script or workflow routine).
// The server merges three records so no run is missing:
//   • `routine_runs`  — every fire since this shipped (incl. refused / skipped fires)
//   • `objectives`    — older AI-routine runs (one card per run, `routine_id` set)
//   • `flow_runs`     — older workflow-routine runs (trigger payload names the routine)
// A workflow run's step log is served by the existing GET /api/flows/:id/runs/:runId.

export type JobExecutionKind = 'ai' | 'script' | 'flow'

/** The run's status as the operator reads it, normalised across the three kinds. */
export type JobExecutionStatus =
  | 'running'
  | 'waiting'
  | 'succeeded'
  | 'needs_review'
  | 'alert'
  | 'failed'
  | 'skipped'
  | 'cancelled'

export const JOB_EXECUTION_STATUSES: readonly JobExecutionStatus[] = [
  'running', 'waiting', 'succeeded', 'needs_review', 'alert', 'failed', 'skipped', 'cancelled',
]

export interface JobExecutionSummary {
  /** Stable id within a routine: `rr-<routine_runs.id>` | `obj-<objective id>` | `flow-<flow run id>`. */
  key: string
  routine_id: number | null
  routine_run_id: number | null
  kind: JobExecutionKind
  /** `cron` (the schedule), `run-now` (a click / API), `manual`, or `unknown` for runs recorded before obj 900676. */
  source: string
  status: JobExecutionStatus
  started_at: string
  ended_at: string | null
  duration_ms: number | null
  /** One line: the guard that refused it, the script outcome, the card / run error … */
  reason: string | null
  objective_id: number | null
  objective_title: string | null
  flow_id: number | null
  flow_run_id: number | null
  exit_code: number | null
  cost_usd: number | null
}

export type JobExecutionLogLevel = 'info' | 'success' | 'warn' | 'error'

export interface JobExecutionLogEntry {
  at: string | null
  level: JobExecutionLogLevel
  label: string
  detail?: string | null
}

export interface JobExecutionRoutineInfo {
  id: number
  name: string
  title: string
  kind: JobExecutionKind
  cadence: string
  flow_id: number | null
}

export interface JobExecutionsResponse {
  routine: JobExecutionRoutineInfo
  executions: JobExecutionSummary[]
}

export interface JobExecutionDetailResponse {
  routine: JobExecutionRoutineInfo
  execution: JobExecutionSummary
  /** What happened, oldest first. */
  log: JobExecutionLogEntry[]
  /** Script routines: captured stdout+stderr (secret-scrubbed, capped). */
  output: string | null
  output_truncated: boolean
  /** Script routines: the command that ran. */
  command: string | null
  /** AI runs (and script escalations): the card that carries the session transcript. */
  objective: {
    id: number
    title: string
    status: string
    job_disposition: string | null
    job_review_note: string | null
    last_session_summary: string | null
    total_cost_usd: number
  } | null
}
