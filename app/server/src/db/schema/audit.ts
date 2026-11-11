/**
 * Objective audit, remediations, and planning conversations — extracted from
 * db/index.ts (behavior frozen). Additive CREATE TABLE + column ALTERs only.
 */
import type Database from 'better-sqlite3'

export function initAuditSchema(db: Database.Database): void {
  // objective_audit — append-only lifecycle trail (obj 700415). One row on EVERY
  // status transition, reactivation, and delete (soft or hard), written via
  // services/objective-audit.logObjectiveAudit at each mutation site. This is the
  // trail whose absence made the 06-28 resurrection caller UNVERIFIABLE
  // (deliverable A §3) — activity_log logs none of these events. `title_snapshot`
  // + `workspace` make a deleted/wiped row reconstructable. Never updated/deleted.
  db.exec(`
    CREATE TABLE IF NOT EXISTS objective_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      objective_id INTEGER,
      event_type TEXT,
      from_status TEXT,
      to_status TEXT,
      actor TEXT,
      pathway TEXT,
      session_id TEXT,
      title_snapshot TEXT,
      workspace TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_objective_audit_objective ON objective_audit(objective_id);
    CREATE INDEX IF NOT EXISTS idx_objective_audit_event ON objective_audit(event_type);
  `)

  // external_check_remediations — auto-remediation loop for third-party PR check
  // failures (obj 1960). One row per UNIQUE (repo, pr_number, check_name, head_sha)
  // failure event we have acted on. The UNIQUE key is the idempotency/dedup guard:
  // GitHub re-delivers check_run/check_suite/workflow_run/status events, so the same
  // failing check on the same commit must NOT spawn a second remediation. Per-PR
  // attempt count = COUNT(*) for (repo, pr_number); `escalated` marks the PR as
  // having hit the attempt cap so we escalate-to-human exactly once. Not linked with
  // ON DELETE CASCADE because the marker must survive even if the objective row is
  // later GC'd — it is keyed by repo/PR, not objective.
  db.exec(`
    CREATE TABLE IF NOT EXISTS external_check_remediations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      objective_id INTEGER NOT NULL,
      repo TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      check_name TEXT NOT NULL,
      head_sha TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      escalated INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(repo, pr_number, check_name, head_sha)
    );
    CREATE INDEX IF NOT EXISTS idx_ext_remediation_pr ON external_check_remediations(repo, pr_number);
  `)

  // check_class (obj 704698, gap A): which fixability class this row was recorded under
  // — 'code-fixable' | 'environmental' | 'advisory' | 'scheduled' | 'cancelled' |
  // 'unowned' | 'orphan'. NULL on legacy rows (and on ci-feedback-bridge rows), which
  // still count toward the attempt budget; only explicitly non-code-fixable rows are
  // excluded, so environmental/cron noise can no longer burn a real fix's five attempts.
  {
    const cols = db.prepare('PRAGMA table_info(external_check_remediations)').all() as { name: string }[]
    if (!new Set(cols.map(c => c.name)).has('check_class')) {
      db.exec('ALTER TABLE external_check_remediations ADD COLUMN check_class TEXT')
    }
  }

  // planning_conversations — Q&A between user and planner sub-session.
  // One row per message. Linked to objective; cascades on delete.
  db.exec(`
    CREATE TABLE IF NOT EXISTS planning_conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      objective_id INTEGER NOT NULL REFERENCES objectives(id) ON DELETE CASCADE,
      session_id TEXT,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
      content TEXT NOT NULL,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_planning_objective ON planning_conversations(objective_id);
    CREATE INDEX IF NOT EXISTS idx_planning_created ON planning_conversations(created_at);
  `)

  // Add seq column (idempotent) — maps each row to its index in the planner
  // session output so we can mirror both sides of the transcript without
  // double-inserting. Unique per (objective_id, session_id, seq); user-only
  // legacy rows have seq=NULL and are kept for backwards compatibility.
  const planningCols = db.prepare("PRAGMA table_info(planning_conversations)").all() as { name: string }[]
  const planningColNames = new Set(planningCols.map(c => c.name))
  if (!planningColNames.has('seq')) {
    db.exec("ALTER TABLE planning_conversations ADD COLUMN seq INTEGER")
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_planning_obj_session_seq ON planning_conversations(objective_id, session_id, seq) WHERE seq IS NOT NULL")

}
