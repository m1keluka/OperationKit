// obj 64 Part C — fireRoutine's same-title duplicate guard. A cron fire must not
// file a card while an OPEN card with the same normalized title from ANOTHER source
// exists in the workspace (24h window). Same-routine cards stay governed by the
// queue-depth guard; 'run-now' is explicit and unguarded. DB_PATH → temp sqlite;
// PORT → dead port so the spawn PATCH can never reach a live Command Center.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { RoutineRow } from './routine-scheduler.js'

const TMP_DB = path.join(os.tmpdir(), `cc-routine-dup-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.PORT = '59947'

const { initDb, getDb } = await import('../db/index.js')
const { fireRoutine } = await import('./routine-scheduler.js')

const TITLE = 'Weekly Website Reconcile'

function seedRoutine(name: string, maxQueueDepth = 1): RoutineRow {
  const template = JSON.stringify({ title: TITLE, workspace: 'example' })
  const id = getDb()
    .prepare(`INSERT INTO routines (name, cron_expr, objective_template, enabled, max_queue_depth) VALUES (?, '0 13 * * 1', ?, 1, ?)`)
    .run(name, template, maxQueueDepth).lastInsertRowid as number
  return getDb().prepare('SELECT * FROM routines WHERE id = ?').get(id) as RoutineRow
}
function seedCard(title: string, status = 'queue', routineId: number | null = null): number {
  return Number(
    getDb()
      .prepare(`INSERT INTO objectives (title, agent_context, workspace, status, routine_id) VALUES (?, 'cto', 'example', ?, ?)`)
      .run(title, status, routineId).lastInsertRowid,
  )
}
const cardsFor = (routineId: number) =>
  (getDb().prepare('SELECT COUNT(*) AS n FROM objectives WHERE routine_id = ?').get(routineId) as { n: number }).n

beforeAll(() => {
  for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f)
  initDb()
})
beforeEach(() => {
  getDb().prepare('DELETE FROM objectives').run()
  getDb().prepare('DELETE FROM routines').run()
  getDb().prepare('DELETE FROM activity_log').run()
})
afterAll(() => {
  try { getDb().close() } catch { /* ignore */ }
  for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f)
})

describe('fireRoutine duplicate guard', () => {
  it('a cron fire is refused while an open same-title card from another source exists', async () => {
    const twin = seedCard('weekly website reconcile!', 'working')
    const routine = seedRoutine('dup-cron')
    const res = await fireRoutine(routine, 'cron')
    expect(res.ok).toBe(false)
    expect(res.reason).toMatch(new RegExp(`^duplicate guard: open card #${twin}`))
    expect(cardsFor(routine.id)).toBe(0)
    const meta = getDb().prepare("SELECT metadata FROM activity_log WHERE event_type = 'decision'").get() as { metadata: string }
    expect(JSON.parse(meta.metadata)).toMatchObject({ kind: 'duplicate_refused', source: `routine-scheduler:${routine.id}`, existing_id: twin })
  })

  it('same-routine cards are left to the queue-depth guard (not refused as duplicates)', async () => {
    const routine = seedRoutine('same-routine', 3)
    seedCard(TITLE, 'working', routine.id)
    const res = await fireRoutine(routine, 'cron')
    expect(res.reason ?? '').not.toMatch(/duplicate guard/)
    expect(cardsFor(routine.id)).toBe(2)
  })

  it('a done twin, a run-now fire, and the kill switch all let the card through', async () => {
    seedCard(TITLE, 'done')
    const r1 = seedRoutine('done-twin')
    expect((await fireRoutine(r1, 'cron')).reason ?? '').not.toMatch(/duplicate guard/)
    expect(cardsFor(r1.id)).toBe(1)

    getDb().prepare('DELETE FROM objectives').run()
    seedCard(TITLE, 'queue')
    const r2 = seedRoutine('run-now')
    expect((await fireRoutine(r2, 'run-now')).reason ?? '').not.toMatch(/duplicate guard/)
    expect(cardsFor(r2.id)).toBe(1)

    getDb().prepare('DELETE FROM objectives').run()
    seedCard(TITLE, 'queue')
    getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('duplicate_guard_enabled', '0')").run()
    const r3 = seedRoutine('switch-off')
    expect((await fireRoutine(r3, 'cron')).reason ?? '').not.toMatch(/duplicate guard/)
    expect(cardsFor(r3.id)).toBe(1)
    getDb().prepare("DELETE FROM settings WHERE key = 'duplicate_guard_enabled'").run()
  })
})
