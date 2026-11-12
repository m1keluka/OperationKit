/**
 * Workflow engine tables (obj 900638, card B2 of docs/design/WORKFLOWS.md §4.3).
 *
 * The code namespace is `flow` (tables `flow_*`), never `workflow`:
 * `app/shared/workflow.ts` is the objective status-transition engine.
 *
 * Idempotent (CREATE … IF NOT EXISTS / INSERT OR IGNORE). Called from initDb()
 * and lazily by services/flow-engine.ts so a test DB that skipped initDb works.
 *
 *   flow_definitions  one row per workflow; `workspace` is NOT NULL (hard filter, §7.5)
 *   flow_versions     immutable versions; a run pins exactly one
 *   flow_runs         one row per run; carries the run LEASE (lease_owner / lease_expires_at)
 *   flow_step_runs    the step-level log: one row per node attempt (memoised output)
 *   flow_wait_tokens  durable waits (approval / event / until), hashed tokens
 *   flow_self_tests   one row per self-test (card B5): the fixture runs + the engine's verdict
 *   flow_builder_attempts  one row per AGENT-submitted draft (card B6): the builder iteration cap
 *
 * All timestamps the engine writes are ISO-8601 UTC strings from the engine's
 * clock, so lease and backoff comparisons are plain string comparisons.
 */
import type Database from 'better-sqlite3'

export const FLOW_RUN_STATUSES = ['queued', 'running', 'waiting', 'succeeded', 'failed', 'repairing', 'cancelled'] as const
export type FlowRunStatus = (typeof FLOW_RUN_STATUSES)[number]

/**
 * `unknown` = the step was in flight when the engine died and its side effect may
 * or may not have happened (send/spend with no idempotency support). `interrupted`
 * = in flight at crash but safe to run again (read/write, or an idempotent Tool).
 */
/**
 * Run modes (docs/design/WORKFLOWS.md §5.2, card B5). `live` = the real thing.
 * `dry` = no outbound call at all: every tool/mcp/llm node returns its `mock`
 * (an llm without one returns a stub built from its output_schema) and a
 * write/send/spend node is recorded as "would …". `test` = `read` tools and mcp
 * calls and `llm` nodes run for real; write/send/spend nodes are stubbed exactly
 * as in `dry`. `replay` (card B8, the auto-debug loop) re-runs a FAILED run
 * against a patched draft: the failed run's recorded outputs are copied in up to
 * the first failed or changed node, after which it behaves like `test` (read
 * live, write/send/spend stubbed). See FlowEngine.startRun.
 */
export const FLOW_RUN_MODES = ['live', 'dry', 'test', 'replay'] as const
export type FlowRunMode = (typeof FLOW_RUN_MODES)[number]

/**
 * How a step row was produced when it did NOT call out (`flow_step_runs.simulated`).
 * NULL = a real call (or a pure engine node). `replay` = copied from the failed
 * run a replay re-runs (card B8): a recorded output, not a new call.
 */
export const FLOW_STEP_SIMULATIONS = ['mock', 'stub', 'would_write', 'would_send', 'would_spend', 'replay'] as const
export type FlowStepSimulation = (typeof FLOW_STEP_SIMULATIONS)[number]

export const FLOW_SELF_TEST_STATUSES = ['running', 'passed', 'failed'] as const
export type FlowSelfTestStatus = (typeof FLOW_SELF_TEST_STATUSES)[number]

/**
 * Why a run is parked on a `flow_wait_tokens` row (card B9 + B2's unknown outcome).
 * The CHECK'd `kind` column stays `approval | event | until`:
 *
 *   reason           kind      resolved by
 *   agent            event     the child card reaching `done` (or `review` with a disposition)
 *   duration         until     the engine tick once `expires_at` passes (`wait.for`)
 *   until            until     the engine tick once `expires_at` passes (`wait.until`)
 *   event            event     POST /api/flows/:id/events naming `event_name`
 *   approval         approval  an owner's Approve / Reject click (cookie owner/admin)
 *   unknown_outcome  approval  an owner's "it was sent" / "it was not sent" (B2)
 */
export const FLOW_WAIT_REASONS = ['agent', 'duration', 'until', 'event', 'approval', 'unknown_outcome'] as const
export type FlowWaitReason = (typeof FLOW_WAIT_REASONS)[number]

/**
 * A repair incident (card B8). `open` = a repair card is working on it (the run
 * is `repairing`); the rest are terminal: `applied` (a safe patch replayed green
 * and was published by `repair:<run>`, or the owner approved it), `needs_review`
 * (a breaker, the budget, an unsafe patch or a failed replay handed it to the
 * owner), `rejected` (the owner said no).
 */
export const FLOW_REPAIR_STATUSES = ['open', 'applied', 'needs_review', 'rejected'] as const
export type FlowRepairStatus = (typeof FLOW_REPAIR_STATUSES)[number]

export const FLOW_STEP_STATUSES =['running', 'succeeded', 'failed', 'interrupted', 'unknown'] as const
export type FlowStepStatus = (typeof FLOW_STEP_STATUSES)[number]

const inList = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(', ')

export function initFlowSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS flow_definitions (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      slug              TEXT NOT NULL,
      workspace         TEXT NOT NULL,
      name              TEXT NOT NULL,
      status            TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'active', 'paused', 'archived')),
      published_version INTEGER,
      objective_id      INTEGER,
      created_by        TEXT NOT NULL,
      created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE(workspace, slug)
    );
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS flow_versions (
      flow_id          INTEGER NOT NULL REFERENCES flow_definitions(id) ON DELETE CASCADE,
      version          INTEGER NOT NULL,
      definition_json  TEXT NOT NULL,
      sha256           TEXT NOT NULL,
      author           TEXT NOT NULL,
      parent_version   INTEGER,
      patch_json       TEXT,
      validation_json  TEXT,
      self_test_run_id INTEGER,
      approvals_json   TEXT,
      created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (flow_id, version)
    );
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS flow_runs (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      flow_id          INTEGER NOT NULL REFERENCES flow_definitions(id) ON DELETE CASCADE,
      version          INTEGER NOT NULL,
      workspace        TEXT NOT NULL,
      mode             TEXT NOT NULL DEFAULT 'live' CHECK(mode IN (${inList(FLOW_RUN_MODES)})),
      trigger_json     TEXT,
      status           TEXT NOT NULL DEFAULT 'queued' CHECK(status IN (${inList(FLOW_RUN_STATUSES)})),
      goal_met         INTEGER CHECK(goal_met IN (0, 1)),
      spent_usd        REAL NOT NULL DEFAULT 0,
      output_json      TEXT,
      error_json       TEXT,
      lease_owner      TEXT,
      lease_expires_at TEXT,
      next_attempt_at  TEXT,
      parent_run_id    INTEGER,
      objective_id     INTEGER,
      created_at       TEXT NOT NULL,
      started_at       TEXT,
      updated_at       TEXT NOT NULL,
      ended_at         TEXT
    );
  `)
  migrateFlowRunModes(db)
  addColumn(db, 'flow_runs', 'goal_json', 'TEXT')
  addColumn(db, 'flow_runs', 'self_test_id', 'INTEGER')
  // Card B9: bumped whenever one of the run's wait tokens is settled, so an executor
  // that is about to park the run can tell a token was resolved WHILE it walked.
  addColumn(db, 'flow_runs', 'wakes', 'INTEGER NOT NULL DEFAULT 0')
  // Card B9: bumped every time a wait token of the run is settled, so an executor
  // that parks the run can tell a token was resolved WHILE it was walking.
  addColumn(db, 'flow_runs', 'wakes', 'INTEGER NOT NULL DEFAULT 0')
  db.exec('CREATE INDEX IF NOT EXISTS idx_flow_runs_status ON flow_runs(status, next_attempt_at)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_flow_runs_flow ON flow_runs(flow_id, id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_flow_runs_self_test ON flow_runs(self_test_id) WHERE self_test_id IS NOT NULL')

  db.exec(`
    CREATE TABLE IF NOT EXISTS flow_step_runs (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id          INTEGER NOT NULL REFERENCES flow_runs(id) ON DELETE CASCADE,
      node_id         TEXT NOT NULL,
      iteration       INTEGER NOT NULL DEFAULT 0,
      attempt         INTEGER NOT NULL,
      status          TEXT NOT NULL CHECK(status IN (${inList(FLOW_STEP_STATUSES)})),
      effect          TEXT,
      input_json      TEXT,
      output_json     TEXT,
      error_json      TEXT,
      idempotency_key TEXT,
      cost_usd        REAL NOT NULL DEFAULT 0,
      started_at      TEXT NOT NULL,
      ended_at        TEXT,
      UNIQUE(run_id, node_id, iteration, attempt)
    );
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_flow_step_runs_run ON flow_step_runs(run_id, node_id, iteration, attempt)')
  addColumn(db, 'flow_step_runs', 'simulated', 'TEXT')

  db.exec(`
    CREATE TABLE IF NOT EXISTS flow_wait_tokens (
      token_hash  TEXT PRIMARY KEY,
      run_id      INTEGER NOT NULL REFERENCES flow_runs(id) ON DELETE CASCADE,
      node_id     TEXT NOT NULL,
      kind        TEXT NOT NULL CHECK(kind IN ('approval', 'event', 'until')),
      reason      TEXT,
      detail_json TEXT,
      expires_at  TEXT,
      created_at  TEXT NOT NULL,
      resolved_by TEXT,
      resolved_at TEXT,
      resolution  TEXT
    );
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_flow_wait_tokens_run ON flow_wait_tokens(run_id)')
  // Card B9: `agent` and `wait` nodes park on a token. `step_id` is the step row the
  // resolver settles, `iteration` the loop index, `objective_id` the child card of an
  // agent node, `event_name` the event a `wait.event` listens for. `reason` is one of
  // FLOW_WAIT_REASONS (B2's `unknown_outcome` included).
  addColumn(db, 'flow_wait_tokens', 'step_id', 'INTEGER')
  addColumn(db, 'flow_wait_tokens', 'iteration', 'INTEGER NOT NULL DEFAULT 0')
  addColumn(db, 'flow_wait_tokens', 'objective_id', 'INTEGER')
  addColumn(db, 'flow_wait_tokens', 'event_name', 'TEXT')
  db.exec('CREATE INDEX IF NOT EXISTS idx_flow_wait_tokens_open ON flow_wait_tokens(resolved_at, reason)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_flow_wait_tokens_objective ON flow_wait_tokens(objective_id) WHERE objective_id IS NOT NULL')
  // Card B9: the agent / wait nodes park on a token. `step_id` is the step row the
  // resolver settles, `iteration` the loop index, `objective_id` the child card of
  // an agent node, `event_name` the event a wait.event listens for. Reasons:
  // agent | duration | until | event | approval (+ B2's unknown_outcome).
  addColumn(db, 'flow_wait_tokens', 'step_id', 'INTEGER')
  addColumn(db, 'flow_wait_tokens', 'iteration', 'INTEGER NOT NULL DEFAULT 0')
  addColumn(db, 'flow_wait_tokens', 'objective_id', 'INTEGER')
  addColumn(db, 'flow_wait_tokens', 'event_name', 'TEXT')
  db.exec('CREATE INDEX IF NOT EXISTS idx_flow_wait_tokens_open ON flow_wait_tokens(resolved_at, reason)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_flow_wait_tokens_objective ON flow_wait_tokens(objective_id) WHERE objective_id IS NOT NULL')

  // Card B5: one row per self-test. `result_json` is the engine's verdict
  // (services/flow-self-test.ts); the publish gate reads the latest row for a version.
  db.exec(`
    CREATE TABLE IF NOT EXISTS flow_self_tests (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      flow_id       INTEGER NOT NULL REFERENCES flow_definitions(id) ON DELETE CASCADE,
      version       INTEGER NOT NULL,
      mode          TEXT NOT NULL CHECK(mode IN ('dry', 'test')),
      status        TEXT NOT NULL DEFAULT 'running' CHECK(status IN (${inList(FLOW_SELF_TEST_STATUSES)})),
      fixtures_json TEXT NOT NULL,
      result_json   TEXT,
      requested_by  TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      ended_at      TEXT
    );
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_flow_self_tests_version ON flow_self_tests(flow_id, version, id)')

  // Card B6: "New workflow" from a goal. The goal the builder card works from and
  // its iteration budget (`builder.max_iterations`, NULL = the settings default).
  addColumn(db, 'flow_definitions', 'goal_statement', 'TEXT')
  addColumn(db, 'flow_definitions', 'builder_max_iterations', 'INTEGER')
  // One row per draft an AGENT submitted (builder card session or agent key),
  // accepted or refused by the validator. This is what the builder iteration cap
  // counts (services/flow-builder.ts); a human's drafts are never capped.
  db.exec(`
    CREATE TABLE IF NOT EXISTS flow_builder_attempts (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      flow_id      INTEGER NOT NULL REFERENCES flow_definitions(id) ON DELETE CASCADE,
      author       TEXT NOT NULL,
      ok           INTEGER NOT NULL CHECK(ok IN (0, 1)),
      version      INTEGER,
      errors_json  TEXT,
      created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_flow_builder_attempts_flow ON flow_builder_attempts(flow_id, id)')

  // Card B8 (auto-debug, §5.3): has the repair watcher looked at this finished
  // live run? NULL = not yet; 'skipped' = not repairable (budget stop, rejected
  // approval …); 'incident' = a flow_repairs row exists for it.
  addColumn(db, 'flow_runs', 'repair_state', 'TEXT')
  // One row per repair INCIDENT (a failed live run the watcher took on, or
  // refused at a breaker). services/flow-repair.ts owns every write.
  db.exec(`
    CREATE TABLE IF NOT EXISTS flow_repairs (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      flow_id             INTEGER NOT NULL REFERENCES flow_definitions(id) ON DELETE CASCADE,
      workspace           TEXT NOT NULL,
      run_id              INTEGER NOT NULL UNIQUE,
      base_version        INTEGER NOT NULL,
      signature           TEXT NOT NULL,
      failed_node_id      TEXT,
      error_json          TEXT,
      definition_rot      INTEGER NOT NULL DEFAULT 0,
      status              TEXT NOT NULL CHECK(status IN (${inList(FLOW_REPAIR_STATUSES)})),
      reason              TEXT,
      detail              TEXT,
      objective_id        INTEGER,
      review_objective_id INTEGER,
      repair_usd          REAL NOT NULL,
      drafts              INTEGER NOT NULL DEFAULT 0,
      draft_version       INTEGER,
      patch_json          TEXT,
      explanation         TEXT,
      classification_json TEXT,
      replay_run_id       INTEGER,
      replay_json         TEXT,
      applied_version     INTEGER,
      rerun_run_id        INTEGER,
      rerun_note          TEXT,
      resolved_by         TEXT,
      created_at          TEXT NOT NULL,
      updated_at          TEXT NOT NULL,
      resolved_at         TEXT
    );
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_flow_repairs_flow ON flow_repairs(flow_id, created_at)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_flow_repairs_status ON flow_repairs(status)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_flow_runs_repair ON flow_runs(mode, status, repair_state)')

  // Kill switch (mirrors routines_enabled). Seeded OFF here (fail closed for test DBs);
  // initDb then switches it ON once via enableFlowsOnce() now that B4 has shipped
  // the scheduler + Jobs surface (docs/design/WORKFLOWS.md §8, obj 900675).
  // Guarded on the settings table existing so the lazy init works on a bare test DB.
  const hasSettings = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'settings'")
    .get()
  if (hasSettings) db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('flows_enabled', '0')").run()
}

function addColumn(db: Database.Database, table: string, column: string, type: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
}

/**
 * B2 created `flow_runs.mode` with CHECK(mode IN ('live', 'dry', 'replay')). SQLite
 * cannot alter a CHECK, so a DB created before B5 gets the table rebuilt ONCE
 * with 'test' added. Same column order, so `SELECT *` copies it. Foreign keys
 * are switched off around the swap so dropping the old table does not cascade
 * into flow_step_runs / flow_wait_tokens (their FKs name `flow_runs` and resolve
 * to the new table after the rename). A no-op on every later boot.
 */
export function migrateFlowRunModes(db: Database.Database): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'flow_runs'").get() as { sql: string } | undefined
  if (!row || row.sql.includes("'test'")) return
  const oldCheck = /mode IN \('live', 'dry', 'replay'\)/
  if (!oldCheck.test(row.sql)) return
  const newSql = row.sql
    .replace(/CREATE TABLE\s+(IF NOT EXISTS\s+)?"?flow_runs"?/i, 'CREATE TABLE flow_runs_b5_mig')
    .replace(oldCheck, `mode IN (${inList(FLOW_RUN_MODES)})`)
  const fkWasOn = Number(db.pragma('foreign_keys', { simple: true })) === 1
  if (fkWasOn) db.pragma('foreign_keys = OFF')
  try {
    db.transaction(() => {
      db.exec('DROP TABLE IF EXISTS flow_runs_b5_mig')
      db.exec(newSql)
      db.exec('INSERT INTO flow_runs_b5_mig SELECT * FROM flow_runs')
      db.exec('DROP TABLE flow_runs')
      db.exec('ALTER TABLE flow_runs_b5_mig RENAME TO flow_runs')
    })()
  } finally {
    if (fkWasOn) db.pragma('foreign_keys = ON')
  }
}

/** Marker row so the switch-on below runs once per install, never again. */
export const FLOWS_ENABLED_DEFAULT_ON_MARKER = 'flows_enabled_default_on_applied'

/**
 * Turn the Workflows kill switch ON, once (obj 900675). B4 (#900640) shipped the
 * scheduler and the Jobs → Workflows flow-chart surface, which is the condition
 * `initFlowSchema` gave for leaving `flows_enabled` dark. This flips it to '1' on
 * the first boot that runs this code and records a marker, so an operator who
 * later sets `flows_enabled='0'` is never overridden on the next restart.
 *
 * Called from `initDb` only — NOT from `initFlowSchema`, which test DBs use and
 * which must keep the fail-closed '0' default. Returns true when it flipped.
 */
export function enableFlowsOnce(db: Database.Database): boolean {
  const hasSettings = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'settings'")
    .get()
  if (!hasSettings) return false
  const applied = db.prepare('SELECT 1 FROM settings WHERE key = ?').get(FLOWS_ENABLED_DEFAULT_ON_MARKER)
  if (applied) return false
  return db.transaction(() => {
    const res = db.prepare("UPDATE settings SET value = '1' WHERE key = 'flows_enabled' AND value != '1'").run()
    if (res.changes === 0) {
      db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('flows_enabled', '1')").run()
    }
    db.prepare("INSERT INTO settings (key, value) VALUES (?, '1')").run(FLOWS_ENABLED_DEFAULT_ON_MARKER)
    return true
  })()
}
