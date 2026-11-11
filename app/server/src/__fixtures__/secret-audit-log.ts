/**
 * TEST-ONLY: wipe secret_access_log between tests.
 *
 * The table is append-only in every real database (db/schema/secrets.ts
 * installs BEFORE UPDATE/DELETE triggers that abort). Test files that reset
 * state between cases drop the delete trigger, clear the rows, and put the
 * trigger straight back, so each test still runs against an append-only table.
 * Never import this from server code.
 */
import type Database from 'better-sqlite3'

export function clearSecretAuditLogForTests(db: Database.Database): void {
  db.exec(`
    DROP TRIGGER IF EXISTS trg_secret_access_log_no_delete;
    DELETE FROM secret_access_log;
    CREATE TRIGGER trg_secret_access_log_no_delete
      BEFORE DELETE ON secret_access_log
      BEGIN SELECT RAISE(ABORT, 'secret_access_log is append-only'); END;
  `)
}
