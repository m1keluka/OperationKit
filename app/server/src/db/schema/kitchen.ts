/**
 * Kitchen-loop / blocked-combos / routines DDL — extracted from db/index.ts
 * (behavior frozen). Additive CREATE TABLE only; routines ALTER stays in initDb().
 */
import type Database from 'better-sqlite3'

export function initKitchenLoopSchema(db: Database.Database): void {
  // ── Kitchen Loop Phase-0 tables (obj 700099) ───────────────────────────────
  // Additive + idempotent. Neither table alters or references any existing table,
  // so creating them is a no-op for every other code path. `kitchen_loop_runs` is
  // the per-scope phase state machine (one in-flight row per scope, advanced one
  // step per tick on the dream-cycle wall-clock cadence — NOT the 3s state-poller).
  // `loop_drift_metrics` is a pure ROLLUP snapshot written each Regress phase; every
  // column is fed by telemetry that already exists (oracle --json, getCanaryCatchRate,
  // getFalsePassRate, objective_reviews) — no new capture pipeline. Columns mirror the
  // W2 integration-architecture doc (2026-06-29-kitchen-loop-integration-architecture).
  db.exec(`
    CREATE TABLE IF NOT EXISTS kitchen_loop_runs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      scope         TEXT NOT NULL,
      iteration     INTEGER NOT NULL,
      phase         TEXT NOT NULL CHECK(phase IN
                      ('backlog','ideate','triage','execute','polish','regress','paused','monitor_only')),
      mode          TEXT NOT NULL DEFAULT 'shadow',
      started_at    TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at      TEXT,
      detail        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_kitchen_loop_runs_scope ON kitchen_loop_runs(scope, iteration);
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS loop_drift_metrics (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      scope              TEXT NOT NULL,
      iteration          INTEGER NOT NULL,
      captured_at        TEXT NOT NULL DEFAULT (datetime('now')),
      test_count         INTEGER,
      pass_rate          REAL,
      oracle_pass_rate   REAL,
      bug_discovery_rate REAL,
      blocked_combos     INTEGER,
      canary_catch_rate  REAL,
      canary_escape_rate REAL,
      false_pass_rate    REAL,
      coverage_filled    INTEGER,
      coverage_total     INTEGER,
      consecutive_red    INTEGER,
      detail             TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_loop_drift_metrics_scope ON loop_drift_metrics(scope, iteration);
  `)

  // ── KL-11 blocked-combos registry (obj-2509) ───────────────────────────────
  // A small registry of objective patterns that are known-blocked on an external
  // dependency, so the delegator/objective-generation path can SKIP re-spawning
  // work that cannot make progress. Rows AUTO-EXPIRE two ways (see
  // services/governance.ts): (1) time-based — a non-null `expires_at` in the past
  // is filtered out on every read; (2) ticket-based — `expireResolvedBlockedObjectives()`
  // stamps `resolved_at` once the `unblock_ticket` resolves. `since` is the human
  // record of when the block started; `objective_pattern` is matched against the
  // objective title (substring, or glob when it contains `*`).
  db.exec(`
    CREATE TABLE IF NOT EXISTS blocked_objectives (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      objective_pattern TEXT NOT NULL,
      reason TEXT NOT NULL,
      since TEXT NOT NULL DEFAULT (datetime('now')),
      unblock_ticket TEXT,
      expires_at TEXT,
      resolved_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)
  db.exec("CREATE INDEX IF NOT EXISTS idx_blocked_objectives_active ON blocked_objectives(resolved_at, expires_at)")

  // `routines` — cron-scheduled recurring objectives. objective_template is a
  // JSON blob (title, description, agent_context, workspace, project, category,
  // completion_goal, workflow_hint, effort, model, type) that the scheduler
  // instantiates into a normal board objective when the cron expression fires.
  db.exec(`
    CREATE TABLE IF NOT EXISTS routines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      cron_expr TEXT NOT NULL,
      objective_template TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      max_queue_depth INTEGER NOT NULL DEFAULT 1,
      last_run_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)

}
