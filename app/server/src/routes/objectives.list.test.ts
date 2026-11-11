import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

// Board LIST slimming + done-exclusion + pagination + GET /:id detail (obj 700512).
// Real SQLite + the real objectives router, admin JWT (admins hit the simplest
// visibility branch). We seed a mix of active/done rows with heavy text and
// assert the list contract.
const TMP_DB = path.join(os.tmpdir(), `cc-list-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-list'

const { initDb, getDb } = await import('../db/index.js')
const { default: objectivesRouter } = await import('./objectives.js')

let server: http.Server
let baseUrl: string
let cookie: string
// Ids we seed, so assertions don't depend on whatever initDb seeds by default.
const seeded: { active: number[]; done: number[]; cancelled: number[] } = { active: [], done: [], cancelled: [] }

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

const HEAVY = ['description', 'last_session_summary', 'approved_plan', 'ai_review_findings', 'acceptance_criteria', 'transcript_path'] as const

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  const ins = db.prepare(
    `INSERT INTO objectives (title, description, last_session_summary, approved_plan, ai_review_findings, acceptance_criteria, transcript_path, status, workspace)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  // 3 active (queue/working/review) + 2 done, all with fat heavy text.
  const fat = 'x'.repeat(4000)
  for (const st of ['queue', 'working', 'review']) {
    const r = ins.run(`active-${st}`, fat, fat, fat, fat, '[]', '/tmp/t', st, 'testws')
    seeded.active.push(Number(r.lastInsertRowid))
  }
  for (let i = 0; i < 2; i++) {
    const r = ins.run(`done-${i}`, fat, fat, fat, fat, '[]', '/tmp/t', 'done', 'testws')
    seeded.done.push(Number(r.lastInsertRowid))
  }
  // Retired/cancelled rows (obj 700872) — hidden by default like done, fetched
  // on demand via ?status=cancelled.
  for (let i = 0; i < 3; i++) {
    const r = ins.run(`cancelled-${i}`, fat, fat, fat, fat, '[]', '/tmp/t', 'cancelled', 'testws')
    seeded.cancelled.push(Number(r.lastInsertRowid))
  }

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

describe('GET /api/objectives — slim board list (obj 700512)', () => {
  it('default list excludes status=done AND status=cancelled (obj 700872)', async () => {
    const { status, json } = await get('/api/objectives?workspace=testws')
    expect(status).toBe(200)
    const ids = (json as any[]).map(o => o.id)
    for (const id of seeded.active) expect(ids).toContain(id)
    for (const id of seeded.done) expect(ids).not.toContain(id)
    for (const id of seeded.cancelled) expect(ids).not.toContain(id)
    expect((json as any[]).every(o => o.status !== 'done' && o.status !== 'cancelled')).toBe(true)
  })

  it('default list omits heavy text columns', async () => {
    const { json } = await get('/api/objectives?workspace=testws')
    const row = (json as any[]).find(o => o.id === seeded.active[0])
    expect(row).toBeTruthy()
    // heavy text fields are absent from the projection (acceptance_criteria is
    // normalized to null by mapObjective, never the raw JSON string).
    for (const f of HEAVY) {
      if (f === 'acceptance_criteria') expect(row[f]).toBeNull()
      else expect(row[f]).toBeUndefined()
    }
    // but the small board fields the card renders ARE present
    expect(row.title).toBe('active-queue')
    expect(row.status).toBe('queue')
    expect(row.workspace).toBe('testws')
    expect(typeof row.has_blockers).toBe('boolean')
  })

  it('?status=done returns only done, and ?limit/&offset paginate newest-first', async () => {
    const all = await get('/api/objectives?status=done&workspace=testws')
    expect(all.status).toBe(200)
    expect((all.json as any[]).every(o => o.status === 'done')).toBe(true)
    expect((all.json as any[]).length).toBe(seeded.done.length)

    const page1 = await get('/api/objectives?status=done&workspace=testws&limit=1&offset=0')
    const page2 = await get('/api/objectives?status=done&workspace=testws&limit=1&offset=1')
    expect((page1.json as any[]).length).toBe(1)
    expect((page2.json as any[]).length).toBe(1)
    // distinct rows across pages
    expect((page1.json as any[])[0].id).not.toBe((page2.json as any[])[0].id)
  })

  it('?status=cancelled returns only cancelled, paginated newest-first (obj 700872)', async () => {
    const all = await get('/api/objectives?status=cancelled&workspace=testws')
    expect(all.status).toBe(200)
    expect((all.json as any[]).every(o => o.status === 'cancelled')).toBe(true)
    expect((all.json as any[]).length).toBe(seeded.cancelled.length)
    // slim projection — heavy text omitted on the cancelled path too
    const row = (all.json as any[])[0]
    for (const f of HEAVY) {
      if (f === 'acceptance_criteria') expect(row[f]).toBeNull()
      else expect(row[f]).toBeUndefined()
    }

    const page1 = await get('/api/objectives?status=cancelled&workspace=testws&limit=2&offset=0')
    const page2 = await get('/api/objectives?status=cancelled&workspace=testws&limit=2&offset=2')
    expect((page1.json as any[]).length).toBe(2)
    expect((page2.json as any[]).length).toBe(1)
    const ids1 = (page1.json as any[]).map(o => o.id)
    const ids2 = (page2.json as any[]).map(o => o.id)
    expect(ids1.some(id => ids2.includes(id))).toBe(false)
  })

  it('GET /:id returns the FULL row including heavy text', async () => {
    const { status, json } = await get(`/api/objectives/${seeded.done[0]}`)
    expect(status).toBe(200)
    expect((json as any).id).toBe(seeded.done[0])
    // heavy fields restored on the detail fetch
    expect((json as any).description).toContain('x')
    expect((json as any).last_session_summary).toContain('x')
    expect((json as any).approved_plan).toContain('x')
  })

  it('GET /:id 404s for a missing objective', async () => {
    const { status } = await get('/api/objectives/99999999')
    expect(status).toBe(404)
  })

  // Regression guard (obj 700512 × 700415): the slim LIST_COLUMNS projection omits
  // `deleted_at`, so the tombstone MUST be enforced in SQL — a post-SELECT filter
  // on the (absent) column would let deleted rows leak back onto the board.
  it('default list hides soft-deleted rows; admin ?include_deleted=1 shows them', async () => {
    const db = getDb()
    const gone = seeded.active[1] // an active (working) row
    db.prepare("UPDATE objectives SET deleted_at = datetime('now') WHERE id = ?").run(gone)

    const def = await get('/api/objectives?workspace=testws')
    expect((def.json as any[]).some(o => o.id === gone)).toBe(false)

    const withDeleted = await get('/api/objectives?workspace=testws&include_deleted=1')
    expect((withDeleted.json as any[]).some(o => o.id === gone)).toBe(true)

    // restore so later ordering assertions (if any) aren't disturbed
    db.prepare('UPDATE objectives SET deleted_at = NULL WHERE id = ?').run(gone)
  })

  it('?workspaces= comma-list returns only those workspaces (single ?workspace= still works)', async () => {
    const db = getDb()
    const fat = 'x'.repeat(4000)
    const ins = db.prepare(
      `INSERT INTO objectives (title, description, last_session_summary, approved_plan, ai_review_findings, acceptance_criteria, transcript_path, status, workspace)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const other = ins.run('other-ws', fat, fat, fat, fat, '[]', '/tmp/t', 'queue', 'otherws')
    const otherId = Number(other.lastInsertRowid)

    const multi = await get('/api/objectives?workspaces=testws,otherws')
    expect(multi.status).toBe(200)
    const multiIds = (multi.json as any[]).map(o => o.id)
    for (const id of seeded.active) expect(multiIds).toContain(id)
    expect(multiIds).toContain(otherId)

    const onlyOther = await get('/api/objectives?workspaces=otherws')
    expect((onlyOther.json as any[]).map(o => o.id)).toEqual([otherId])

    // Legacy single-workspace param is unchanged.
    const legacy = await get('/api/objectives?workspace=otherws')
    expect((legacy.json as any[]).map(o => o.id)).toEqual([otherId])
  })
})
