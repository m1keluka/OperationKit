/**
 * AI-review and deterministic-floor tables — extracted from db/index.ts
 * (behavior frozen). Additive CREATE TABLE + column ALTERs only.
 * objective_reviews CHECK rebuild stays in initDb().
 */
import type Database from 'better-sqlite3'

export function initReviewsSchema(db: Database.Database): void {
  // AI Review Stage tables (2026-06-06). See
  // 2026-06-06-cc-ai-review-stage-architecture.md.
  //
  // `objective_reviews` — one row per AI Review iteration. The state poller
  // reads the most recent row when the reviewer session ends to decide the
  // next status transition (pass→review, fail→working or cap-hit→review,
  // blocked→review).
  db.exec(`
    CREATE TABLE IF NOT EXISTS objective_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      objective_id INTEGER NOT NULL REFERENCES objectives(id) ON DELETE CASCADE,
      iteration INTEGER NOT NULL,
      reviewer_session_id TEXT NOT NULL,
      mode TEXT NOT NULL CHECK(mode IN ('browser','api','doc','noop','decision')),
      verdict TEXT NOT NULL CHECK(verdict IN ('pass','fail','blocked','pending')),
      criteria_results TEXT NOT NULL DEFAULT '[]',
      screenshot_paths TEXT NOT NULL DEFAULT '[]',
      markdown_body TEXT NOT NULL DEFAULT '',
      cost_usd REAL NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_reviews_objective ON objective_reviews(objective_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_obj_iter ON objective_reviews(objective_id, iteration);
  `)

  // ── Deterministic floor (ST1 / roadmap P1+P2, 2026-06-17) ──────────────────
  // `objective_floor_runs` — one row per poller-run deterministic-floor check on
  // the worker→done path. Records the commands run, their exit codes, the gating
  // outcome, where the objective WOULD have advanced (resolved_status), and
  // whether an LLM review would otherwise have run — so a red floor that
  // short-circuits the reviewer (llm_would_have_run=1) is the observable verifier
  // signal: "the floor caught a failure the LLM verdict would have passed."
  // Coupled table (not overloaded onto objective_reviews, whose verdict CHECK is
  // pass/fail/blocked). Feature-flagged + per-project opt-in + fail-safe-open;
  // see services/deterministic-floor.ts.
  db.exec(`
    CREATE TABLE IF NOT EXISTS objective_floor_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      objective_id INTEGER NOT NULL REFERENCES objectives(id) ON DELETE CASCADE,
      iteration INTEGER NOT NULL DEFAULT 0,
      outcome TEXT NOT NULL CHECK(outcome IN ('pass','fail','open')),
      commands_json TEXT NOT NULL DEFAULT '[]',
      failed_command TEXT,
      open_reason TEXT,
      cwd TEXT,
      resolved_status TEXT,
      llm_would_have_run INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_floor_runs_objective ON objective_floor_runs(objective_id);
    CREATE INDEX IF NOT EXISTS idx_floor_runs_outcome ON objective_floor_runs(outcome);
  `)

  // Migration (obj 2335): denormalised proof columns so a floor run is auditable
  // with a single flat SELECT — objective_id, project, command, exit_code, passed,
  // created_at — without parsing commands_json. `passed` is the boolean projection
  // of `outcome` (1 iff outcome='pass'); `command` + `exit_code` capture the
  // gating command (the failing one on a red floor, else the last command run).
  // Additive + idempotent; the original columns are retained for back-compat.
  {
    const frCols = new Set(
      (db.prepare('PRAGMA table_info(objective_floor_runs)').all() as { name: string }[]).map(c => c.name),
    )
    if (!frCols.has('project')) db.exec('ALTER TABLE objective_floor_runs ADD COLUMN project TEXT')
    if (!frCols.has('passed')) db.exec('ALTER TABLE objective_floor_runs ADD COLUMN passed INTEGER')
    if (!frCols.has('exit_code')) db.exec('ALTER TABLE objective_floor_runs ADD COLUMN exit_code INTEGER')
    if (!frCols.has('command')) db.exec('ALTER TABLE objective_floor_runs ADD COLUMN command TEXT')
    // Migration (obj 2508, KL-4 layer 4): records the state-delta / E2E ground-truth
    // step's outcome ('pass'|'fail'|'open') when a project opts into layer 4 via a
    // `state_delta_command` in its floor_config row. NULL for every existing row and
    // every project that does NOT configure layer 4 (fallback to layers 1–2). Additive
    // + idempotent — no backfill, no behaviour change for non-opted-in projects.
    if (!frCols.has('layer4_outcome')) db.exec('ALTER TABLE objective_floor_runs ADD COLUMN layer4_outcome TEXT')
    // Migration (obj 700028, outcome verification): a `source` discriminator so a
    // NON-CODE outcome-assertion run (recordOutcomeRunRow writes source='outcome')
    // is mechanically distinguishable from a code-floor run. NULL for every existing
    // row and every code-floor run (recordFloorRunRow never sets it) → existing
    // metrics are byte-identical; outcome rows are filterable via source='outcome'.
    // Additive + idempotent — no backfill, no behaviour change.
    if (!frCols.has('source')) db.exec('ALTER TABLE objective_floor_runs ADD COLUMN source TEXT')
  }

  // Migration (obj 937): `feature_brief` holds the stakeholder-facing brief the
  // reviewer emits in its `<feature_brief>` block — a plain-English description +
  // how-it-works overview produced as part of the PR audit. Stored as JSON
  // ({ headline, description, overview, audience_worthy }) so the changelog
  // collector can pull rich context without re-reading the engineering PR.
  {
    const rCols = db.prepare("PRAGMA table_info(objective_reviews)").all() as { name: string }[]
    const rNames = new Set(rCols.map(c => c.name))
    if (!rNames.has('feature_brief')) {
      db.exec("ALTER TABLE objective_reviews ADD COLUMN feature_brief TEXT NOT NULL DEFAULT ''")
    }
  }

}
