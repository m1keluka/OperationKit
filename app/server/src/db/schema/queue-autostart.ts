import type Database from 'better-sqlite3'

/**
 * obj 900625 — queue auto-start state on the card.
 *
 *  - `objectives.queued_at`               when the card last ENTERED `queue` (set by
 *                                         the trigger below on every transition into
 *                                         queue). NULL on rows that have not moved
 *                                         since this migration: readers fall back to
 *                                         `created_at`, which is when such a row
 *                                         entered queue.
 *  - `objectives.auto_start_requested_at` the per-card "start me when a slot frees"
 *                                         flag. Set by the start paths that hit the
 *                                         session cap (POST create `start:true`,
 *                                         PATCH status=working / start_objective).
 *                                         Cleared by the trigger the moment the card
 *                                         leaves `queue` by ANY path, so a flag can
 *                                         never outlive the queue stay it was set in.
 *  - `objectives.queue_hold`              free-text hold reason. Non-NULL = the queue
 *                                         auto-starter never touches the card.
 *  - `objectives.blocked_by`              objective id this card waits on. The
 *                                         auto-starter skips the card until that
 *                                         objective is `done`.
 *  - `objectives.autostarted_at`          when the queue auto-starter launched it —
 *                                         the in-flight cap counts running cards
 *                                         carrying this stamp.
 *  - `objectives.auto_start_note`         the auto-starter's latest decision for a
 *                                         queued card it considered and did NOT start
 *                                         ("waiting: every claude seat is cooling",
 *                                         "refused: no finite job ceiling …"), so
 *                                         "why hasn't it started?" is one read.
 *
 * Additive only: six nullable columns and one trigger. Run after
 * initAgentControlSchema, like the stall watchdog, so it attaches to the final
 * objectives shape.
 */
export function initQueueAutostartSchema(db: Database.Database): void {
  const cols = new Set(
    (db.prepare('PRAGMA table_info(objectives)').all() as { name: string }[]).map(c => c.name),
  )
  if (cols.size === 0) return
  if (!cols.has('queued_at')) db.exec('ALTER TABLE objectives ADD COLUMN queued_at TEXT')
  if (!cols.has('auto_start_requested_at')) db.exec('ALTER TABLE objectives ADD COLUMN auto_start_requested_at TEXT')
  if (!cols.has('queue_hold')) db.exec('ALTER TABLE objectives ADD COLUMN queue_hold TEXT')
  if (!cols.has('blocked_by')) db.exec('ALTER TABLE objectives ADD COLUMN blocked_by INTEGER')
  if (!cols.has('autostarted_at')) db.exec('ALTER TABLE objectives ADD COLUMN autostarted_at TEXT')
  if (!cols.has('auto_start_note')) db.exec('ALTER TABLE objectives ADD COLUMN auto_start_note TEXT')

  // Entering queue stamps queued_at; leaving queue clears the auto-start request
  // and the stale skip note. The inner UPDATE touches only these two columns, so it
  // does not re-fire this trigger (recursive_triggers is off) or any of the
  // `AFTER UPDATE OF <col>` feed triggers on other columns.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_objectives_queue_autostart_status
    AFTER UPDATE OF status ON objectives
    WHEN OLD.status IS NOT NEW.status
    BEGIN
      UPDATE objectives SET
        queued_at = CASE WHEN NEW.status = 'queue' THEN datetime('now') ELSE queued_at END,
        auto_start_requested_at = CASE WHEN NEW.status = 'queue' THEN auto_start_requested_at ELSE NULL END,
        auto_start_note = CASE WHEN NEW.status = 'queue' THEN auto_start_note ELSE NULL END
      WHERE id = NEW.id;
    END;
  `)
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_objectives_queue_autostart ON objectives(status, workspace) WHERE status = 'queue' AND parent_id IS NULL",
  )
}
