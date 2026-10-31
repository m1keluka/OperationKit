// Over-fire guard (routine #972 fired every 5 minutes instead of hourly, 10/1–10/2).
// An AUTOMATIC fire is refused when last_run_at is newer than max(1 min, 50% of the
// cron's minimum interval). An explicit run-now is never guarded.
// DB_PATH → temp sqlite; PORT → dead port + mocked fetch so no live spawn is possible.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { RoutineRow } from './routine-scheduler.js'

const TMP_DB = path.join(os.tmpdir(), `cc-routine-overfire-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.PORT = '59947'

const { initDb, getDb } = await import('../db/index.js')
const { fireRoutine, overFireGuardReason, minCronIntervalMs, getLastSkipReason } = await import('./routine-scheduler.js')

const minsAgo = (m: number) => new Date(Date.now() - m * 60 * 1000).toISOString()

let seq = 0
function seedRoutine(cron: string, lastRunAt: string | null): RoutineRow {
  const template = JSON.stringify({ title: 'Overfire probe', workspace: 'example' })
  const id = getDb()
    .prepare(`INSERT INTO routines (name, cron_expr, objective_template, enabled, max_queue_depth, last_run_at) VALUES (?, ?, ?, 1, 5, ?)`)
    .run(`overfire-${++seq}`, cron, template, lastRunAt).lastInsertRowid as number
  return getDb().prepare('SELECT * FROM routines WHERE id = ?').get(id) as RoutineRow
}
const cardsFor = (routineId: number) =>
  (getDb().prepare('SELECT COUNT(*) AS n FROM objectives WHERE routine_id = ?').get(routineId) as { n: number }).n

beforeAll(() => {
  for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f)
  initDb()
})
beforeEach(() => {
  getDb().prepare('DELETE FROM objectives').run()
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
})
afterEach(() => { vi.restoreAllMocks() })
afterAll(() => {
  try { getDb().close() } catch { /* ignore */ }
  for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f)
})

describe('minCronIntervalMs', () => {
  const at = new Date('2026-10-12T10:30:00')
  it('derives the tightest gap between consecutive matches', () => {
    expect(minCronIntervalMs('0 * * * *', at)).toBe(60 * 60 * 1000)
    expect(minCronIntervalMs('*/5 * * * *', at)).toBe(5 * 60 * 1000)
    expect(minCronIntervalMs('0 9 * * *', at)).toBe(24 * 60 * 60 * 1000)
    expect(minCronIntervalMs('0 9,10 * * *', at)).toBe(60 * 60 * 1000)
    expect(minCronIntervalMs('not a cron', at)).toBeNull()
  })
})

describe('overFireGuardReason (pure)', () => {
  const now = new Date('2026-10-12T10:00:30')
  const ago = (m: number) => new Date(now.getTime() - m * 60 * 1000).toISOString()
  it('refuses an hourly routine that ran 5 min ago, allows one that ran 61 min ago', () => {
    expect(overFireGuardReason('0 * * * *', ago(5), now)).toMatch(/over-fire guard/)
    expect(overFireGuardReason('0 * * * *', ago(61), now)).toBeNull()
  })
  it('allows a */5 routine that ran 5 min ago', () => {
    expect(overFireGuardReason('*/5 * * * *', ago(5), now)).toBeNull()
  })
  it('allows an every-minute routine ~1 min later (floor does not swallow it)', () => {
    expect(overFireGuardReason('* * * * *', new Date(now.getTime() - 55 * 1000).toISOString(), now)).toBeNull()
  })
  it('never-run routines are not guarded', () => {
    expect(overFireGuardReason('0 * * * *', null, now)).toBeNull()
  })
})

describe('fireRoutine over-fire guard', () => {
  it('refuses an automatic fire of an hourly routine whose last run was 5 min ago', async () => {
    const r = seedRoutine('0 * * * *', minsAgo(5))
    const res = await fireRoutine(r, 'cron')
    expect(res.ok).toBe(false)
    expect(res.reason).toMatch(/over-fire guard/)
    expect(getLastSkipReason(r.id)).toMatch(/over-fire guard/)
    expect(cardsFor(r.id)).toBe(0)
  })

  it('fires an hourly routine whose last run was 61 min ago', async () => {
    const r = seedRoutine('0 * * * *', minsAgo(61))
    const res = await fireRoutine(r, 'cron')
    expect(res.ok).toBe(true)
    expect(cardsFor(r.id)).toBe(1)
  })

  it('fires a */5 routine whose last run was 5 min ago', async () => {
    const r = seedRoutine('*/5 * * * *', minsAgo(5))
    const res = await fireRoutine(r, 'cron')
    expect(res.ok).toBe(true)
    expect(cardsFor(r.id)).toBe(1)
  })

  it('reads last_run_at fresh from the DB, not the caller-supplied (stale) row', async () => {
    const r = seedRoutine('0 * * * *', minsAgo(120))
    getDb().prepare('UPDATE routines SET last_run_at = ? WHERE id = ?').run(minsAgo(2), r.id)
    const res = await fireRoutine(r, 'cron')
    expect(res.ok).toBe(false)
    expect(res.reason).toMatch(/over-fire guard/)
  })

  it('guards the stranded-card retry path too', async () => {
    const r = seedRoutine('0 * * * *', minsAgo(5))
    getDb()
      .prepare(`INSERT INTO objectives (title, agent_context, workspace, status, routine_id, origin, created_at)
                VALUES ('stuck', 'cto', 'example', 'queue', ?, 'routine', datetime('now', '-60 minutes'))`)
      .run(r.id)
    const res = await fireRoutine(r, 'cron')
    expect(res.ok).toBe(false)
    expect(res.reason).toMatch(/over-fire guard/)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('a manual run-now bypasses the guard', async () => {
    const r = seedRoutine('0 * * * *', minsAgo(5))
    const res = await fireRoutine(r, 'run-now')
    expect(res.ok).toBe(true)
    expect(cardsFor(r.id)).toBe(1)
  })
})
