// Routine concurrency guard counts only cards with a live session (obj 713168).
//
// `review` cards are parked awaiting a human and hold no session. Counting them
// against MAX_CONCURRENT_SESSIONS let a backlog of Needs-You cards block every
// routine from firing. DB_PATH → temp sqlite; PORT → dead port so fireRoutine's
// spawn PATCH can never reach a live Command Center.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { MAX_CONCURRENT_SESSIONS } from '@operationkit/shared'
import type { RoutineRow } from './routine-scheduler.js'

const TMP_DB = path.join(os.tmpdir(), `cc-routine-guard-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.PORT = '59948'

const { initDb, getDb } = await import('../db/index.js')
const { fireRoutine } = await import('./routine-scheduler.js')

function seedCards(status: string, n: number): void {
  const ins = getDb().prepare(`INSERT INTO objectives (title, agent_context, workspace, status) VALUES (?, 'cto', 'example', ?)`)
  for (let i = 0; i < n; i++) ins.run(`${status} card ${i}`, status)
}

function seedRoutine(name: string): RoutineRow {
  const template = JSON.stringify({ title: 'Weekly Website Reconcile', workspace: 'example' })
  const id = getDb()
    .prepare(`INSERT INTO routines (name, cron_expr, objective_template, enabled, max_queue_depth) VALUES (?, '0 13 * * 1', ?, 1, 1)`)
    .run(name, template).lastInsertRowid as number
  return getDb().prepare('SELECT * FROM routines WHERE id = ?').get(id) as RoutineRow
}

beforeAll(() => {
  for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f)
  initDb()
})

beforeEach(() => {
  getDb().prepare('DELETE FROM objectives').run()
})

afterAll(() => {
  try { getDb().close() } catch { /* ignore */ }
  for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f)
})

describe('fireRoutine concurrency guard', () => {
  it('fires when the cap is exceeded only by review (Needs You) cards', async () => {
    seedCards('review', MAX_CONCURRENT_SESSIONS + 5)
    const res = await fireRoutine(seedRoutine('review-backlog'), 'run-now')
    expect(res.reason ?? '').not.toMatch(/concurrency guard/)
    expect(res.ok).toBe(true)
    expect(res.objective_id).toBeTruthy()
  })

  it('still skips when working + ai_review sessions reach the cap', async () => {
    seedCards('working', MAX_CONCURRENT_SESSIONS - 1)
    seedCards('ai_review', 1)
    const res = await fireRoutine(seedRoutine('real-load'), 'run-now')
    expect(res.ok).toBe(false)
    expect(res.reason).toMatch(/concurrency guard: 100 active sessions/)
  })
})
