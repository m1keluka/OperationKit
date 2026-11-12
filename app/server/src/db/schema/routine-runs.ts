/**
 * `routine_runs` — one row per routine FIRE (obj 900676, per-run execution history).
 *
 * Before this table a routine only remembered its LAST run (`routines.last_run_at`,
 * `last_run_status`, `last_output_tail`), so a script routine's 06:03 run was
 * overwritten by the 07:03 one and a refused fire left no trace at all. Every fire
 * attempt now writes a row here — AI, script and flow routines alike, cron or
 * run-now, including the ones a guard refused — so the Jobs → Executions view can
 * list every run and open its log, the way n8n's executions view does.
 *
 * What a row holds depends on the kind; the row never duplicates a record that
 * already exists elsewhere, it points at it:
 *   ai     → `objective_id`: the card the fire filed (its session IS the run's log)
 *   flow   → `flow_run_id`:  the flow run it queued (flow_step_runs IS the step log)
 *   script → `output`:       the script's captured stdout+stderr (capped), exit code
 *
 * `status` is the FIRE's own outcome. For ai/flow rows the live status of the run
 * comes from the linked card / flow run at read time (services/routine-runs.ts),
 * so this table never goes stale when the card or run finishes later.
 *
 * Idempotent; called from initDb() and lazily by services/routine-runs.ts so a
 * test DB that skipped initDb works.
 */
import type Database from 'better-sqlite3'

export const ROUTINE_RUN_STATUSES = ['running', 'dispatched', 'succeeded', 'alert', 'failed', 'skipped'] as const
export type RoutineRunStatus = (typeof ROUTINE_RUN_STATUSES)[number]

/** Max bytes of script output kept per run (the executor itself caps capture at 256KB). */
export const ROUTINE_RUN_OUTPUT_BYTES = 64 * 1024

const inList = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(', ')

export function initRoutineRunsSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS routine_runs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      routine_id    INTEGER NOT NULL,
      kind          TEXT NOT NULL DEFAULT 'ai',
      source        TEXT NOT NULL DEFAULT 'cron',
      status        TEXT NOT NULL DEFAULT 'running' CHECK(status IN (${inList(ROUTINE_RUN_STATUSES)})),
      reason        TEXT,
      objective_id  INTEGER,
      flow_run_id   INTEGER,
      exit_code     INTEGER,
      output        TEXT,
      output_truncated INTEGER NOT NULL DEFAULT 0,
      started_at    TEXT NOT NULL,
      ended_at      TEXT,
      duration_ms   INTEGER
    );
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_routine_runs_routine ON routine_runs(routine_id, id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_routine_runs_objective ON routine_runs(objective_id) WHERE objective_id IS NOT NULL')
  db.exec('CREATE INDEX IF NOT EXISTS idx_routine_runs_flow_run ON routine_runs(flow_run_id) WHERE flow_run_id IS NOT NULL')
}
