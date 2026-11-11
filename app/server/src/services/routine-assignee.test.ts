import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TMP = path.join(os.tmpdir(), `cc-routine-assignee-${process.pid}-${Date.now()}`)
process.env.DB_PATH = path.join(TMP, 'test.db')
fs.mkdirSync(TMP, { recursive: true })

const { getDb, initDb } = await import('../db/index.js')
const { fireRoutine } = await import('./routine-scheduler.js')
type RoutineRow = Parameters<typeof fireRoutine>[0]

// A per-owner routine (the multi-owner content engine) files an objective FOR a
// specific person. Members in an `own`-visibility workspace only list objectives
// where they are the assignee or the creator, so a routine row carrying neither
// is invisible to the person it was filed for. Regression for obj 710856.

// fireRoutine transitions the new objective by calling its OWN server over
// 127.0.0.1:$PORT. Under vitest that would reach whatever is listening on the
// dev box's port — stub fetch so this suite is hermetic and can never PATCH a
// real objective.
vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))

const tpl = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ title: 'Granola content intake — test', workspace: 'operationkit', ...over })

function mkRoutine(template: string): RoutineRow {
  const db = getDb()
  const name = `test-routine-${Math.floor(performance.now() * 1000)}`
  db.prepare(
    `INSERT INTO routines (name, cron_expr, objective_template, enabled, max_queue_depth)
     VALUES (?, '40 7 * * *', ?, 1, 99)`
  ).run(name, template)
  return db.prepare('SELECT * FROM routines WHERE name = ?').get(name) as RoutineRow
}

let userId: number

beforeAll(() => {
  initDb()
})

beforeEach(() => {
  const db = getDb()
  const r = db
    .prepare("INSERT INTO users (username, password_hash, role) VALUES (?, 'x', 'member')")
    .run(`owner-${Math.floor(performance.now() * 1000)}`)
  userId = r.lastInsertRowid as number
})

describe('routine objective assignment', () => {
  it('assigns the objective to the owner named in the template', async () => {
    const res = await fireRoutine(mkRoutine(tpl({ assigned_user_id: userId })), 'run-now')
    expect(res.ok).toBe(true)
    const db = getDb()
    const obj = db
      .prepare('SELECT assigned_user_id, created_by FROM objectives WHERE id = ?')
      .get(res.objective_id) as { assigned_user_id: number; created_by: number }
    expect(obj.assigned_user_id).toBe(userId)
    expect(obj.created_by).toBe(userId)
    const link = db
      .prepare('SELECT 1 FROM objective_assignees WHERE objective_id = ? AND user_id = ?')
      .get(res.objective_id, userId)
    expect(link).toBeTruthy()
  })

  it('leaves pre-existing templates unassigned', async () => {
    const res = await fireRoutine(mkRoutine(tpl()), 'run-now')
    expect(res.ok).toBe(true)
    const obj = getDb()
      .prepare('SELECT assigned_user_id, created_by FROM objectives WHERE id = ?')
      .get(res.objective_id) as { assigned_user_id: number | null; created_by: number | null }
    expect(obj.assigned_user_id).toBeNull()
    expect(obj.created_by).toBeNull()
  })

  it('ignores an assigned_user_id that does not resolve to a user', async () => {
    const res = await fireRoutine(mkRoutine(tpl({ assigned_user_id: 999999 })), 'run-now')
    expect(res.ok).toBe(true)
    const obj = getDb()
      .prepare('SELECT assigned_user_id FROM objectives WHERE id = ?')
      .get(res.objective_id) as { assigned_user_id: number | null }
    expect(obj.assigned_user_id).toBeNull()
  })
})
