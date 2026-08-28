/**
 * Assignees, learnings, activity, scratchpads, session intel/events —
 * extracted from db/index.ts (behavior frozen). Additive CREATE TABLE +
 * column ALTERs only. session_events CHECK rebuild stays in initDb().
 */
import type Database from 'better-sqlite3'

export function initSessionTablesSchema(db: Database.Database): void {
  // Objective assignees — supports multi-user assignment. Idempotent.
  // `assigned_user_id` on objectives is preserved as the "primary" assignee
  // (the user the spawn pipeline targets via prompt-builder.ts). Every row in
  // this join table — including the primary — represents an explicit assignee
  // for visibility and listing purposes.
  db.exec(`
    CREATE TABLE IF NOT EXISTS objective_assignees (
      objective_id INTEGER NOT NULL REFERENCES objectives(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (objective_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_assignees_user ON objective_assignees(user_id);
  `)
  // Backfill: mirror existing single-assignee rows into the join table once.
  db.exec(`
    INSERT OR IGNORE INTO objective_assignees (objective_id, user_id)
    SELECT id, assigned_user_id FROM objectives WHERE assigned_user_id IS NOT NULL
  `)

  // Objective learnings — used for conversation compaction summaries across sessions
  db.exec(`
    CREATE TABLE IF NOT EXISTS objective_learnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      objective_id INTEGER NOT NULL REFERENCES objectives(id) ON DELETE CASCADE,
      task_id INTEGER,
      session_id TEXT,
      content TEXT NOT NULL,
      learning_type TEXT NOT NULL DEFAULT 'summary'
        CHECK(learning_type IN ('decision', 'pattern', 'gotcha', 'summary')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_learnings_objective ON objective_learnings(objective_id);
  `)

  // Human mistake-labeling surface (ST5) — a structured record of a human
  // correction ("this session got X wrong") tied to an objective/session.
  // Each active row is injected as a HIGH-PRIORITY gotcha into the next spawn's
  // context (see context-builder.ts), so human judgment compounds across
  // sessions instead of being lost. workspace/agent_context are denormalized at
  // insert time so a correction can also warn sibling objectives of the same
  // agent role in the same workspace without a join.
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_corrections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      objective_id INTEGER NOT NULL REFERENCES objectives(id) ON DELETE CASCADE,
      session_id TEXT,
      workspace TEXT,
      agent_context TEXT,
      label TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_corrections_objective ON session_corrections(objective_id);
    CREATE INDEX IF NOT EXISTS idx_corrections_ws_agent ON session_corrections(workspace, agent_context);
  `)

  // Activity log — mid-session progress + post-session events, unified timeline
  db.exec(`
    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      workspace TEXT NOT NULL DEFAULT 'example',
      objective_id INTEGER REFERENCES objectives(id) ON DELETE SET NULL,
      task_id INTEGER,
      session_id TEXT,
      event_type TEXT NOT NULL CHECK(event_type IN (
        'session_start', 'session_end',
        'progress', 'decision', 'blocker', 'file_change', 'milestone', 'error'
      )),
      title TEXT NOT NULL,
      detail TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_activity_project ON activity_log(project);
    CREATE INDEX IF NOT EXISTS idx_activity_workspace ON activity_log(workspace);
    CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_activity_objective ON activity_log(objective_id);
  `)

  // Scratchpads — a dead-simple, per-USER human markdown store (one row per user,
  // keyed by user_id). Human-only surface: agents never write here. See
  // services/scratchpad.ts + routes/scratchpad.ts. CASCADE so a deleted user's
  // scratchpad is cleaned up. Idempotent CREATE ... IF NOT EXISTS.
  db.exec(`
    CREATE TABLE IF NOT EXISTS scratchpads (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      content TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)

  // Session intelligence tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_intel (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      objective_id INTEGER NOT NULL REFERENCES objectives(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL UNIQUE,
      account_id TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      total_cost_usd REAL NOT NULL DEFAULT 0,
      files_created TEXT NOT NULL DEFAULT '[]',
      files_modified TEXT NOT NULL DEFAULT '[]',
      commands_run INTEGER NOT NULL DEFAULT 0,
      tool_calls INTEGER NOT NULL DEFAULT 0,
      errors TEXT NOT NULL DEFAULT '[]',
      exit_code INTEGER,
      summary TEXT,
      decisions TEXT DEFAULT '[]',
      blockers TEXT DEFAULT '[]',
      follow_ups TEXT DEFAULT '[]',
      skills_used TEXT DEFAULT '[]',
      outcome TEXT CHECK(outcome IN ('success','partial','failed','blocked')),
      extraction_status TEXT NOT NULL DEFAULT 'pending'
        CHECK(extraction_status IN ('pending','parsed','summarized','failed')),
      -- 1 when the session's terminal result event was a Claude API 429
      -- (usage/rate limit): transcript truncated, outcome NOT authoritative.
      -- A dedicated flag, NOT an extraction_status enum value: that column has
      -- a CHECK constraint and stays 'summarized' for truncated rows.
      truncated_usage_limit INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_session_intel_objective ON session_intel(objective_id);
    CREATE INDEX IF NOT EXISTS idx_session_intel_session ON session_intel(session_id);
    CREATE INDEX IF NOT EXISTS idx_session_intel_status ON session_intel(extraction_status);
    CREATE INDEX IF NOT EXISTS idx_session_intel_started ON session_intel(started_at);
  `)

  // model_usage: JSON map of model id → { tokens, cost_usd }, summed from the
  // transcript's per-turn result.modelUsage blocks. Lets the costs page show
  // which model actually ran (subagents/fast-mode can differ from objectives.model).
  const intelCols = db.prepare("PRAGMA table_info(session_intel)").all() as { name: string }[]
  const intelColNames = new Set(intelCols.map(c => c.name))
  if (!intelColNames.has('model_usage')) {
    db.exec("ALTER TABLE session_intel ADD COLUMN model_usage TEXT")
  }
  // agents_invoked / subagents_spawned: JSON arrays of the persona slugs adopted
  // (agents/<x>.md reads) and the sub-agent worker types spawned (Agent/Task
  // subagent_type) during the session. Surfaced per-session in SessionViewer
  // alongside skills_used (obj-2387). Additive, default '[]'.
  if (!intelColNames.has('agents_invoked')) {
    db.exec("ALTER TABLE session_intel ADD COLUMN agents_invoked TEXT DEFAULT '[]'")
  }
  if (!intelColNames.has('subagents_spawned')) {
    db.exec("ALTER TABLE session_intel ADD COLUMN subagents_spawned TEXT DEFAULT '[]'")
  }
  // truncated_usage_limit: 1 when the session ended on a Claude API 429
  // (usage/rate limit) and its transcript is therefore truncated. Downstream
  // miners (distill, DSR retro, fabrication detectors) must treat outcome as
  // NOT authoritative for these rows. Additive, default 0 (obj 705919).
  if (!intelColNames.has('truncated_usage_limit')) {
    db.exec("ALTER TABLE session_intel ADD COLUMN truncated_usage_limit INTEGER NOT NULL DEFAULT 0")
  }

  // Denormalized last-activity timestamp on objectives (obj 700850). Defined as
  // the most recent moment the agent side did/sent something for the objective =
  // MAX(session_intel.ended_at). Surfaced on the board LIST payload so cards show
  // real recency without a per-card join; NULL when the objective has no sessions
  // (the frontend falls back to updated_at). Kept fresh forward-only wherever a
  // session_intel row is written (see services/session-intel.ts). This migration
  // is placed AFTER the session_intel table + its ALTERs so the backfill subquery
  // is valid on a fresh DB (objectives are migrated earlier, before session_intel
  // exists). Re-query the objectives columns here since colNames was captured
  // before this point.
  const objColsForActivity = db.prepare("PRAGMA table_info(objectives)").all() as { name: string }[]
  if (!objColsForActivity.some(c => c.name === 'last_activity_at')) {
    db.exec("ALTER TABLE objectives ADD COLUMN last_activity_at TEXT")
    // One-time backfill from existing session_intel rows. Idempotent: only runs
    // when the column was just added, and MAX(ended_at) is stable on re-run.
    db.exec(`
      UPDATE objectives SET last_activity_at = (
        SELECT MAX(si.ended_at) FROM session_intel si WHERE si.objective_id = objectives.id
      )
      WHERE EXISTS (
        SELECT 1 FROM session_intel si WHERE si.objective_id = objectives.id
      )
    `)
  }

  db.exec(`

    CREATE TABLE IF NOT EXISTS session_file_ops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      objective_id INTEGER NOT NULL,
      file_path TEXT NOT NULL,
      operation TEXT NOT NULL CHECK(operation IN ('create','modify','read')),
      timestamp TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_file_ops_path ON session_file_ops(file_path);
    CREATE INDEX IF NOT EXISTS idx_file_ops_session ON session_file_ops(session_id);

    CREATE TABLE IF NOT EXISTS session_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      objective_id INTEGER NOT NULL,
      event_type TEXT NOT NULL CHECK(event_type IN ('decision','blocker','follow_up','error','milestone','warning')),
      description TEXT NOT NULL,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_events_objective ON session_events(objective_id);
    CREATE INDEX IF NOT EXISTS idx_events_type ON session_events(event_type);
    CREATE INDEX IF NOT EXISTS idx_events_created ON session_events(created_at);

    CREATE TABLE IF NOT EXISTS uptime_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      received_at TEXT NOT NULL,
      event_at TEXT NOT NULL,
      monitor_id TEXT NOT NULL,
      monitor_name TEXT,
      monitor_url TEXT,
      alert_type INTEGER,
      alert_type_friendly_name TEXT,
      alert_details TEXT,
      alert_duration INTEGER,
      response_time INTEGER,
      payload_raw TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_uptime_events_event_at ON uptime_events(event_at);
    CREATE INDEX IF NOT EXISTS idx_uptime_events_monitor ON uptime_events(monitor_id, event_at);
  `)

}
