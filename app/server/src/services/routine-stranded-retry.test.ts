// Stranded routine card retry (obj 713168).
//
// A routine fire creates its card in `queue`, then PATCHes it to `working` to spawn
// the session. If that PATCH fails, the card used to sit in `queue` forever and the
// queue-depth guard skipped every later fire without a trace. The next fire must
// re-attempt the stranded card's spawn instead. DB_PATH → temp sqlite; PORT → dead
// port so a real fetch can never reach a live Command Center.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { RoutineRow } from './routine-scheduler.js'

const TMP_DB = path.join(os.tmpdir(), `cc-routine-stranded-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.PORT = '59949'

const { initDb, getDb } = await import('../db/index.js')
const { fireRoutine } = await import('./routine-scheduler.js')

let routineSeq = 0
function seedRoutine(): RoutineRow {
  const template = JSON.stringify({ title: 'Vansh offboard', workspace: 'example' })
  const id = getDb()
    .prepare(`INSERT INTO routines (name, cron_expr, objective_template, enabled, max_queue_depth) VALUES (?, '18 0 * * *', ?, 1, 1)`)
    .run(`r-${++routineSeq}`, template).lastInsertRowid as number
  return getDb().prepare('SELECT * FROM routines WHERE id = ?').get(id) as RoutineRow
}

function seedQueuedCard(routineId: number, minutesAgo: number): number {
  return getDb()
    .prepare(`INSERT INTO objectives (title, agent_context, workspace, status, routine_id, origin, created_at)
              VALUES ('Vansh offboard', 'cto', 'example', 'queue', ?, 'routine', datetime('now', ?))`)
    .run(routineId, `-${minutesAgo} minutes`).lastInsertRowid as number
}

const cardsFor = (routineId: number) =>
  (getDb().prepare('SELECT COUNT(*) AS n FROM objectives WHERE routine_id = ?').get(routineId) as { n: number }).n

beforeAll(() => {
  for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f)
  initDb()
})
beforeEach(() => { getDb().prepare('DELETE FROM objectives').run() })
afterEach(() => { vi.restoreAllMocks() })
afterAll(() => {
  try { getDb().close() } catch { /* ignore */ }
  for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f)
})

describe('fireRoutine — stranded queue card', () => {
  it('re-spawns a card stuck in queue instead of skipping, and creates no new card', async () => {
    const r = seedRoutine()
    const stuck = seedQueuedCard(r.id, 60 * 24)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
    const res = await fireRoutine(r, 'cron')
    expect(res).toMatchObject({ ok: true, objective_id: stuck })
    expect(String(fetchSpy.mock.calls[0][0])).toContain(`/objectives/${stuck}/status`)
    expect(cardsFor(r.id)).toBe(1)
  })

  it('reports why a stranded card still will not spawn', async () => {
    const r = seedRoutine()
    const stuck = seedQueuedCard(r.id, 60)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"error":"Maximum 100 concurrent sessions reached"}', { status: 409 }))
    const res = await fireRoutine(r, 'cron')
    expect(res.ok).toBe(false)
    expect(res.reason).toContain(`stranded objective ${stuck} still not spawning: 409`)
    expect(res.reason).toContain('concurrent sessions')
  })

  it('leaves a freshly queued card alone (depth guard still applies)', async () => {
    const r = seedRoutine()
    seedQueuedCard(r.id, 2)
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const res = await fireRoutine(r, 'cron')
    expect(res.ok).toBe(false)
    expect(res.reason).toMatch(/queue depth guard/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('a failed spawn on a new card is reported, not silent', async () => {
    const r = seedRoutine()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('boom', { status: 500 }))
    const res = await fireRoutine(r, 'cron')
    expect(res.ok).toBe(true)
    expect(res.reason).toBe('created but spawn failed: 500 boom')
  })
})
