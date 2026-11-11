import type Database from 'better-sqlite3'

/**
 * obj 900372 — stall watchdog state on the card.
 *
 *  - `objectives.stalled_at`   ISO timestamp the watchdog flagged the card as stalled
 *                              (status `working`, no live process or no transcript
 *                              write for N minutes, AND its one auto-restart is spent).
 *                              NULL = not stalled. Cleared on the next real start,
 *                              on fresh transcript activity, or when the card leaves
 *                              `working`.
 *  - `objectives.stall_reason` one line built from card/session state only
 *                              (class, idle minutes, session id) — never transcript text.
 *  - `objectives.stall_restarts` watchdog auto-restarts spent in the current stall
 *                              episode. Reset to 0 by any start that is NOT the watchdog
 *                              (human, bot, follow-up — see logSessionStart), so
 *                              restart → stall → restart cannot loop.
 *
 * The trigger feeds `objective_events` (kind `stalled`) the moment `stalled_at` goes
 * NULL → set, so GET /api/agent/changes and the needs_agent webhook dispatcher see the
 * stall through the same cursor every other card change already rides on. Additive:
 * three additive columns + one trigger. Must run AFTER initAgentControlSchema (the
 * objective_events table it inserts into).
 */
export function initStallWatchdogSchema(db: Database.Database): void {
  const cols = new Set(
    (db.prepare('PRAGMA table_info(objectives)').all() as { name: string }[]).map(c => c.name),
  )
  if (!cols.has('stalled_at')) db.exec('ALTER TABLE objectives ADD COLUMN stalled_at TEXT')
  if (!cols.has('stall_reason')) db.exec('ALTER TABLE objectives ADD COLUMN stall_reason TEXT')
  if (!cols.has('stall_restarts')) db.exec('ALTER TABLE objectives ADD COLUMN stall_restarts INTEGER NOT NULL DEFAULT 0')
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_objective_events_stalled
    AFTER UPDATE OF stalled_at ON objectives
    WHEN NEW.stalled_at IS NOT NULL AND OLD.stalled_at IS NULL
    BEGIN
      INSERT INTO objective_events (objective_id, workspace, kind, to_value, detail)
      VALUES (NEW.id, NEW.workspace, 'stalled', NEW.status, substr(NEW.stall_reason, 1, 400));
    END;
  `)
}
