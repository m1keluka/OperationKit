import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

// obj 700850 — board objective-data: denormalized last_activity_at + assignee
// usernames on the list payload. Real SQLite + the real objectives router.
// Two proofs:
//  (a) the initDb migration BACKFILLS objectives.last_activity_at to
//      MAX(session_intel.ended_at), leaving NULL when there are no sessions.
//  (b) GET /api/objectives returns last_activity_at AND assigned_usernames[]
//      (names resolved from users.username, primary-first order preserved).
const TMP_DB = path.join(os.tmpdir(), `cc-activity-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-activity'

const { initDb, getDb } = await import('../db/index.js')
const { default: objectivesRouter } = await import('./objectives.js')

let server: http.Server
let baseUrl: string
let cookie: string
// objective ids seeded for the payload assertions
let objWithSessions = 0
let objNoSessions = 0

function makeApp(): express.Express {
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/objectives', objectivesRouter)
  return app
}

async function get(pathPart: string) {
  const res = await fetch(`${baseUrl}${pathPart}`, { headers: { Cookie: cookie } })
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}

function insSessionIntel(objectiveId: number, sessionId: string, endedAt: string): void {
  getDb().prepare(
    `INSERT INTO session_intel (objective_id, session_id, started_at, ended_at, extraction_status)
     VALUES (?, ?, ?, ?, 'parsed')`
  ).run(objectiveId, sessionId, endedAt, endedAt)
}

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()

  // Two users to resolve assignee names against.
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (7, 'alice', 'x', 'member')").run()
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (9, 'bob', 'x', 'member')").run()

  const ins = db.prepare(
    'INSERT INTO objectives (title, status, workspace, assigned_user_id) VALUES (?, ?, ?, ?)'
  )
  objWithSessions = Number(ins.run('has-sessions', 'working', 'testws', 7).lastInsertRowid)
  objNoSessions = Number(ins.run('no-sessions', 'queue', 'testws', null).lastInsertRowid)

  // Multi-assign: obj gets primary 7 (alice) + 9 (bob) via the join table.
  const insAssignee = db.prepare('INSERT INTO objective_assignees (objective_id, user_id) VALUES (?, ?)')
  insAssignee.run(objWithSessions, 7)
  insAssignee.run(objWithSessions, 9)

  // Simulate the UPGRADE path so the migration's backfill actually runs over
  // pre-existing session_intel rows: drop the column, seed sessions, re-run initDb.
  db.exec('ALTER TABLE objectives DROP COLUMN last_activity_at')
  insSessionIntel(objWithSessions, 'sess-old', '2026-01-01T00:00:00.000Z')
  insSessionIntel(objWithSessions, 'sess-new', '2026-06-15T12:30:00.000Z') // MAX
  insSessionIntel(objWithSessions, 'sess-mid', '2026-03-01T00:00:00.000Z')
  // objNoSessions intentionally has NO session_intel rows.
  initDb() // idempotent re-run: re-adds last_activity_at + backfills

  const app = makeApp()
  await new Promise<void>(resolve => { server = app.listen(0, () => resolve()) })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('server has no address')
  baseUrl = `http://127.0.0.1:${addr.port}`
  cookie = `token=${jwt.sign({ id: 1, username: 'tester', role: 'admin' }, process.env.JWT_SECRET as string, { expiresIn: '1h' })}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
})

describe('obj 700850 — last_activity_at backfill + assignee names on the board list', () => {
  it('(a) backfill sets last_activity_at to MAX(session_intel.ended_at); NULL with no sessions', () => {
    const db = getDb()
    const withS = db.prepare('SELECT last_activity_at FROM objectives WHERE id = ?').get(objWithSessions) as { last_activity_at: string | null }
    const noS = db.prepare('SELECT last_activity_at FROM objectives WHERE id = ?').get(objNoSessions) as { last_activity_at: string | null }
    expect(withS.last_activity_at).toBe('2026-06-15T12:30:00.000Z')
    expect(noS.last_activity_at).toBeNull()
  })

  it('(b) GET /api/objectives payload includes last_activity_at and assigned_usernames[]', async () => {
    const { status, json } = await get('/api/objectives?workspace=testws')
    expect(status).toBe(200)
    const rows = json as any[]

    const row = rows.find(o => o.id === objWithSessions)
    expect(row).toBeTruthy()
    // last_activity_at present with the backfilled MAX value
    expect(row.last_activity_at).toBe('2026-06-15T12:30:00.000Z')
    // assignee names resolved from users.username, primary (7=alice) first
    expect(row.assigned_user_ids).toEqual([7, 9])
    expect(row.assigned_usernames).toEqual(['alice', 'bob'])

    const bare = rows.find(o => o.id === objNoSessions)
    expect(bare).toBeTruthy()
    expect(bare.last_activity_at).toBeNull()
    expect(bare.assigned_usernames).toEqual([])

    // Show a real sample of the list payload contract for the two new fields.
    console.log('[obj700850] sample list payload row:', JSON.stringify({
      id: row.id,
      title: row.title,
      last_activity_at: row.last_activity_at,
      assigned_user_ids: row.assigned_user_ids,
      assigned_usernames: row.assigned_usernames,
    }, null, 2))
  })

  it('keeps last_activity_at forward-only when a newer session lands (never backwards)', () => {
    const db = getDb()
    // A newer session advances the marker...
    insSessionIntel(objWithSessions, 'sess-newer', '2026-07-01T00:00:00.000Z')
    db.prepare(`UPDATE objectives SET last_activity_at = ? WHERE id = ? AND (last_activity_at IS NULL OR last_activity_at < ?)`)
      .run('2026-07-01T00:00:00.000Z', objWithSessions, '2026-07-01T00:00:00.000Z')
    let cur = db.prepare('SELECT last_activity_at FROM objectives WHERE id = ?').get(objWithSessions) as { last_activity_at: string }
    expect(cur.last_activity_at).toBe('2026-07-01T00:00:00.000Z')
    // ...an OLDER out-of-order arrival must NOT regress it.
    db.prepare(`UPDATE objectives SET last_activity_at = ? WHERE id = ? AND (last_activity_at IS NULL OR last_activity_at < ?)`)
      .run('2026-02-01T00:00:00.000Z', objWithSessions, '2026-02-01T00:00:00.000Z')
    cur = db.prepare('SELECT last_activity_at FROM objectives WHERE id = ?').get(objWithSessions) as { last_activity_at: string }
    expect(cur.last_activity_at).toBe('2026-07-01T00:00:00.000Z')
  })
})
