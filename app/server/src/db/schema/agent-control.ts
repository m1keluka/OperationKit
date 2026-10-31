/**
 * Control-layer tables for third-party orchestrators (obj 714091).
 *
 * objective_events — the cursor source for GET /api/agent/changes.
 *
 * Why a trigger-fed table and not `objective_audit`: objective_audit is written by
 * explicit logObjectiveAudit() calls at the HTTP mutation sites, and the
 * state-poller's transitions (working → ai_review → review, the bulk of "a card
 * entered Needs You") never call it. Measured on a copy of the live board
 * (2026-10-04, last 7 days): 710 audited queue→working but only 12 working→review
 * and ZERO →ai_review rows, while the board moved dozens of cards through review
 * per day. activity_log / session_events carry no status at all. A changes feed
 * built on any of them would silently miss the events an orchestrator polls for.
 *
 * AFTER-triggers on `objectives` / `objective_prs` record every change at the
 * storage layer regardless of which code path made it, with no edits to the
 * dozens of UPDATE sites. The cursor is the AUTOINCREMENT id: SQLite has a single
 * writer, so ids are assigned in commit order and are never reused — monotonic and
 * gap-free from a reader's point of view.
 *
 * Triggers survive the objectives rebuild (objectives-rebuild.ts captures and
 * re-creates them) and are re-asserted with IF NOT EXISTS on every boot.
 *
 * The objective_prs triggers deliberately do NOT sub-select objectives.workspace:
 * a trigger body that names `objectives` would break the DROP + RENAME in
 * rebuildObjectivesTable (SQLite re-parses every trigger on RENAME and fails on
 * the momentarily-missing table). The reader resolves workspace via its JOIN.
 *
 * idempotency_keys — Idempotency-Key replay store for POST /api/objectives and
 * POST /api/objectives/:id/message (lib/idempotency.ts). 24h window.
 */
import type Database from 'better-sqlite3'

/** Events older than this are pruned at boot. A cursor older than the oldest
 *  surviving id just resumes from the oldest row. */
export const OBJECTIVE_EVENTS_RETENTION_DAYS = 30

export function initAgentControlSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS objective_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      objective_id INTEGER NOT NULL,
      workspace TEXT,
      kind TEXT NOT NULL,
      from_value TEXT,
      to_value TEXT,
      detail TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_objective_events_ws_id ON objective_events(workspace, id);
    CREATE INDEX IF NOT EXISTS idx_objective_events_created ON objective_events(created_at);

    CREATE TABLE IF NOT EXISTS idempotency_keys (
      user_id INTEGER NOT NULL,
      scope TEXT NOT NULL,
      idem_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      status_code INTEGER,
      response_body TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, scope, idem_key)
    );
    CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created ON idempotency_keys(created_at);
  `)

  // The boot-time status-CHECK probes in db/index.ts insert + delete
  // '__status_constraint_probe…' rows on EVERY boot; keep them out of the feed.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_objective_events_created
    AFTER INSERT ON objectives
    WHEN NEW.title NOT LIKE '\\_\\_status\\_constraint\\_probe%' ESCAPE '\\'
    BEGIN
      INSERT INTO objective_events (objective_id, workspace, kind, to_value)
      VALUES (NEW.id, NEW.workspace, 'created', NEW.status);
    END;

    CREATE TRIGGER IF NOT EXISTS trg_objective_events_status
    AFTER UPDATE OF status ON objectives
    WHEN OLD.status IS NOT NEW.status
    BEGIN
      INSERT INTO objective_events (objective_id, workspace, kind, from_value, to_value)
      VALUES (NEW.id, NEW.workspace, 'status', OLD.status, NEW.status);
    END;

    CREATE TRIGGER IF NOT EXISTS trg_objective_events_verdict
    AFTER UPDATE OF ai_review_verdict ON objectives
    WHEN NEW.ai_review_verdict IS NOT NULL AND OLD.ai_review_verdict IS NOT NEW.ai_review_verdict
    BEGIN
      INSERT INTO objective_events (objective_id, workspace, kind, to_value, detail)
      VALUES (NEW.id, NEW.workspace, 'verdict', NEW.ai_review_verdict, substr(NEW.ai_review_findings, 1, 400));
    END;

    CREATE TRIGGER IF NOT EXISTS trg_objective_events_summary
    AFTER UPDATE OF last_session_summary ON objectives
    WHEN NEW.last_session_summary IS NOT NULL AND OLD.last_session_summary IS NOT NEW.last_session_summary
    BEGIN
      INSERT INTO objective_events (objective_id, workspace, kind, detail)
      VALUES (NEW.id, NEW.workspace, 'session_ended', substr(NEW.last_session_summary, 1, 400));
    END;

    CREATE TRIGGER IF NOT EXISTS trg_objective_events_soft_delete
    AFTER UPDATE OF deleted_at ON objectives
    WHEN NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL
    BEGIN
      INSERT INTO objective_events (objective_id, workspace, kind)
      VALUES (NEW.id, NEW.workspace, 'deleted');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_objective_events_hard_delete
    AFTER DELETE ON objectives
    WHEN OLD.title NOT LIKE '\\_\\_status\\_constraint\\_probe%' ESCAPE '\\'
    BEGIN
      INSERT INTO objective_events (objective_id, workspace, kind, detail)
      VALUES (OLD.id, OLD.workspace, 'deleted', substr(OLD.title, 1, 120));
    END;

    CREATE TRIGGER IF NOT EXISTS trg_objective_events_pr_opened
    AFTER INSERT ON objective_prs
    BEGIN
      INSERT INTO objective_events (objective_id, workspace, kind, to_value, detail)
      VALUES (NEW.objective_id, NULL, 'pr', NEW.state, NEW.pr_url);
    END;

    CREATE TRIGGER IF NOT EXISTS trg_objective_events_pr_state
    AFTER UPDATE OF state ON objective_prs
    WHEN OLD.state IS NOT NEW.state
    BEGIN
      INSERT INTO objective_events (objective_id, workspace, kind, from_value, to_value, detail)
      VALUES (NEW.objective_id, NULL, 'pr', OLD.state, NEW.state, NEW.pr_url);
    END;
  `)

  try {
    db.prepare(`DELETE FROM objective_events WHERE created_at < datetime('now', ?)`)
      .run(`-${OBJECTIVE_EVENTS_RETENTION_DAYS} days`)
    db.prepare(`DELETE FROM idempotency_keys WHERE created_at < datetime('now', '-1 day')`).run()
  } catch (err) {
    console.error('[agent-control] prune failed:', (err as Error).message)
  }
}
