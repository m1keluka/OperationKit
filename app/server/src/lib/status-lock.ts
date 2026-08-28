import type { Database } from 'better-sqlite3'

/** Statuses a machine must never overwrite. Human (or explicit reopen) only. */
export const LOCKED_STATUSES = new Set(['done', 'cancelled'])

export function isLockedStatus(status: string | null | undefined): boolean {
  return !!status && LOCKED_STATUSES.has(status)
}

/**
 * Re-read the row. True if it is gone or the human already parked it in
 * done/cancelled — poller/internal must not write status over that.
 */
export function skipMachineStatusWrite(db: Database, id: number): boolean {
  const row = db.prepare('SELECT status FROM objectives WHERE id = ?').get(id) as { status: string } | undefined
  return !row || isLockedStatus(row.status)
}

/**
 * Machine status UPDATE that cannot clobber done/cancelled.
 *
 * `sql` must contain `WHERE id = ?`; `id` is the last bound parameter.
 * Re-reads, then the UPDATE itself requires `status NOT IN ('done','cancelled')`
 * so a human click between SELECT and this write still sticks.
 */
export function runMachineStatusUpdate(
  db: Database,
  sql: string,
  ...params: unknown[]
): { changes: number } {
  const id = Number(params[params.length - 1])
  if (!Number.isFinite(id) || skipMachineStatusWrite(db, id)) {
    if (Number.isFinite(id)) {
      console.log(`[status-lock] skip machine status write for #${id}`)
    }
    return { changes: 0 }
  }
  const guarded = /status NOT IN\s*\(\s*'done'/i.test(sql)
    ? sql
    : sql.replace(/WHERE id = \?/i, "WHERE id = ? AND status NOT IN ('done', 'cancelled')")
  if (guarded === sql && !/status NOT IN\s*\(\s*'done'/i.test(sql)) {
    throw new Error('runMachineStatusUpdate: SQL must include WHERE id = ?')
  }
  return db.prepare(guarded).run(...params)
}
