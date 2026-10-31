import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express, { Router } from 'express'

// Worker-side live progress routes on /api/internal (obj 715699): localhost-gated
// progress write/read, artifacts, and fan-out registration (start:false so no
// child is actually started over HTTP — the tick itself is covered in fanout.test.ts).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-internal-progress-'))
const MEM = path.join(TMP, 'memory')
process.env.DB_PATH = path.join(TMP, 'db.sqlite')
process.env.JWT_SECRET = 'test-secret-internal-progress'
process.env.TRANSCRIPT_DIR = TMP
process.env.OBJECTIVE_MEMORY_ROOT = MEM

const { getDb, initDb } = await import('../db/index.js')
const { registerInternalProgressRoutes } = await import('./internal-progress.js')
const { getFanoutGroup } = await import('../services/fanout.js')

let server: http.Server
let baseUrl: string
let card: number
let parent: number
let kids: number[]
let stranger: number

function insertCard(fields: Record<string, unknown>): number {
  const cols = Object.keys(fields)
  return Number(
    getDb()
      .prepare(`INSERT INTO objectives (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
      .run(...Object.values(fields)).lastInsertRowid,
  )
}

async function call(p: string, init: RequestInit = {}): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}/api/internal${p}`, { ...init, headers: { 'Content-Type': 'application/json', ...(init.headers || {}) } })
  return { status: res.status, json: await res.json().catch(() => null) }
}

beforeAll(async () => {
  initDb()
  card = insertCard({ title: 'worker card', workspace: 'ws-a', status: 'working', session_id: 'cc-int-1' })
  parent = insertCard({ title: 'parent', workspace: 'ws-a', status: 'working' })
  kids = [1, 2, 3].map(i => insertCard({ title: `kid ${i}`, workspace: 'ws-a', status: 'queue', parent_id: parent }))
  stranger = insertCard({ title: 'stranger', workspace: 'ws-a', status: 'queue' })

  fs.mkdirSync(path.join(MEM, String(card), 'live'), { recursive: true })
  fs.writeFileSync(path.join(MEM, String(card), 'ARTIFACT.md'), '# out\n')
  fs.writeFileSync(path.join(MEM, String(card), 'NOTES.md'), 'scratch\n')
  fs.writeFileSync(path.join(MEM, String(card), 'live', 'p.txt'), 'partial\n')

  const router = Router()
  registerInternalProgressRoutes(router)
  const app = express()
  app.use(express.json())
  app.use('/api/internal', router)
  server = http.createServer(app)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  try { getDb().close() } catch { /* ignore */ }
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('POST /api/internal/objectives/:id/progress', () => {
  it('records a worker snapshot, defaulting session_id from the objective', async () => {
    const r = await call(`/objectives/${card}/progress`, { method: 'POST', body: JSON.stringify({ step: 1, total_steps: 4, label: 'clone' }) })
    expect(r.status).toBe(201)
    expect(r.json).toMatchObject({ objective_id: card, session_id: 'cc-int-1', step: 1, total_steps: 4, label: 'clone', source: 'worker' })
  })

  it('an explicit session_id wins', async () => {
    const r = await call(`/objectives/${card}/progress`, { method: 'POST', body: JSON.stringify({ step: 2, session_id: 'cc-int-explicit' }) })
    expect(r.status).toBe(201)
    expect(r.json.session_id).toBe('cc-int-explicit')
  })

  it('invalid body → 400', async () => {
    expect((await call(`/objectives/${card}/progress`, { method: 'POST', body: JSON.stringify({}) })).status).toBe(400)
    expect((await call(`/objectives/${card}/progress`, { method: 'POST', body: JSON.stringify({ note: 'x', artifacts: 'nope' }) })).status).toBe(400)
    expect((await call(`/objectives/${card}/progress`, { method: 'POST', body: JSON.stringify({ step: 5, total_steps: 2 }) })).status).toBe(400)
  })

  it('unknown objective → 404', async () => {
    expect((await call(`/objectives/999999/progress`, { method: 'POST', body: JSON.stringify({ step: 1 }) })).status).toBe(404)
  })
})

describe('GET /api/internal/objectives/:id/progress', () => {
  it('returns the progress view', async () => {
    const r = await call(`/objectives/${card}/progress`)
    expect(r.status).toBe(200)
    expect(r.json.progress_source).toBe('worker')
    expect(r.json.total_events).toBe(2)
    expect(r.json.latest.step).toBe(2)
  })

  it('bad query → 400; unknown objective → 404', async () => {
    expect((await call(`/objectives/${card}/progress?nope=1`)).status).toBe(400)
    expect((await call(`/objectives/999999/progress`)).status).toBe(404)
  })
})

describe('internal artifacts', () => {
  it('lists without NOTES.md and reads a partial output', async () => {
    const l = await call(`/objectives/${card}/artifacts`)
    expect(l.status).toBe(200)
    expect(l.json.objective_id).toBe(card)
    expect(l.json.entries.map((e: any) => e.path).sort()).toEqual(['ARTIFACT.md', 'live/p.txt'])
    const f = await call(`/objectives/${card}/artifacts/file?path=live/p.txt`)
    expect(f.status).toBe(200)
    expect(f.json.content).toBe('partial\n')
    expect((await call(`/objectives/${card}/artifacts/file?path=NOTES.md`)).status).toBe(403)
  })
})

describe('POST /api/internal/objectives/:id/fanout', () => {
  it('rejects a non-child (400) without creating a group', async () => {
    const r = await call(`/objectives/${parent}/fanout`, { method: 'POST', body: JSON.stringify({ child_ids: [kids[0], stranger], max_concurrency: 2, start: false }) })
    expect(r.status).toBe(400)
    expect(r.json.error).toMatch(/not a direct child/)
    expect(getFanoutGroup(getDb(), parent)).toBeNull()
  })

  it('rejects bad max_concurrency (400) and unknown parent (404)', async () => {
    expect((await call(`/objectives/${parent}/fanout`, { method: 'POST', body: JSON.stringify({ child_ids: kids, max_concurrency: 99, start: false }) })).status).toBe(400)
    expect((await call(`/objectives/999999/fanout`, { method: 'POST', body: JSON.stringify({ child_ids: kids, start: false }) })).status).toBe(404)
  })

  it('registers the group with start:false → 201, tick null, children untouched', async () => {
    const r = await call(`/objectives/${parent}/fanout`, { method: 'POST', body: JSON.stringify({ child_ids: kids, max_concurrency: 2, start: false }) })
    expect(r.status).toBe(201)
    expect(r.json.tick).toBeNull()
    expect(r.json.group).toMatchObject({ parent_id: parent, max_concurrency: 2, child_ids: kids, completed_at: null })
    for (const id of kids) {
      expect((getDb().prepare('SELECT status FROM objectives WHERE id = ?').get(id) as { status: string }).status).toBe('queue')
    }
    // The parent's progress view now carries the group.
    const v = await call(`/objectives/${parent}/progress`)
    expect(v.json.fanout).toMatchObject({ parent_id: parent, max_concurrency: 2 })
    expect(v.json.children.total).toBe(3)
    expect(v.json.children.by_status).toEqual({ queue: 3 })
  })
})
