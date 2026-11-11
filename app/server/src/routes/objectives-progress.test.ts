import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

// Live card visibility over HTTP (obj 715699): GET/POST /api/objectives/:id/progress
// and the artifacts routes on the authenticated objectives router — cookie + API
// key auth, workspace scoping, transcript fallback, children roll-up.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-progress-route-'))
const MEM = path.join(TMP, 'memory')
process.env.DB_PATH = path.join(TMP, 'db.sqlite')
process.env.JWT_SECRET = 'test-secret-progress-route'
process.env.TRANSCRIPT_DIR = TMP
process.env.OBJECTIVE_MEMORY_ROOT = MEM

const { getDb, initDb } = await import('../db/index.js')
const { default: objectivesRouter } = await import('./objectives.js')
const { issueApiKey } = await import('../lib/api-keys.js')
const { logSessionStart, noteStartReason } = await import('../services/session-start-reasons.js')
const { recordProgress } = await import('../services/objective-progress.js')

const ADMIN = 1
const MEMBER = 2
const SECRET = 'route-artifact-secret-xyz789'

let server: http.Server
let baseUrl: string
let adminCookie: string
let memberCookie: string
let memberKey: string
// cards
let adminWsA: number      // ws-a, created by admin
let memberWsA: number     // ws-a, created by member
let adminWsB: number      // ws-b, created by admin
let memberWsB: number     // ws-b, created by member (but member has no ws-b membership)
let transcriptCard: number
let parent: number
let childWorking: number
let childDone: number

function cookieFor(id: number, username: string, role: string): string {
  return `token=${jwt.sign({ id, username, role }, process.env.JWT_SECRET as string, { expiresIn: '1h' })}`
}

function insertCard(fields: Record<string, unknown>): number {
  const cols = Object.keys(fields)
  return Number(
    getDb()
      .prepare(`INSERT INTO objectives (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
      .run(...Object.values(fields)).lastInsertRowid,
  )
}

async function call(p: string, auth: Record<string, string>, init: RequestInit = {}): Promise<{ status: number; json: any; headers: Headers }> {
  const res = await fetch(`${baseUrl}/api/objectives${p}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...auth, ...(init.headers || {}) },
  })
  const text = await res.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, json, headers: res.headers }
}
const asAdmin = () => ({ Cookie: adminCookie })
const asMember = () => ({ Cookie: memberCookie })
const asKey = () => ({ Authorization: `Bearer ${memberKey}` })

beforeAll(async () => {
  process.env.TEST_ROUTE_SECRET_TOKEN = SECRET
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'admin', 'x', 'admin')`).run(ADMIN)
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'member', 'x', 'member')`).run(MEMBER)
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace, role, objective_visibility) VALUES (?, 'ws-a', 'member', 'all')`).run(MEMBER)

  adminWsA = insertCard({ title: 'admin ws-a', workspace: 'ws-a', created_by: ADMIN, status: 'working' })
  memberWsA = insertCard({ title: 'member ws-a', workspace: 'ws-a', created_by: MEMBER, status: 'working' })
  adminWsB = insertCard({ title: 'admin ws-b', workspace: 'ws-b', created_by: ADMIN, status: 'working' })
  memberWsB = insertCard({ title: 'member ws-b', workspace: 'ws-b', created_by: MEMBER, status: 'working' })

  // Transcript-fallback card: no progress rows, but a live transcript on disk.
  transcriptCard = insertCard({ title: 'transcript only', workspace: 'ws-a', created_by: MEMBER, status: 'working', session_id: 'cc-route-tx-1' })
  fs.writeFileSync(
    path.join(TMP, 'cc-route-tx-1.jsonl'),
    [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Looking at the repo.' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } }),
    ].join('\n') + '\n',
  )

  // Fan-out parent with two children.
  parent = insertCard({ title: 'parent', workspace: 'ws-a', created_by: MEMBER, status: 'working' })
  childWorking = insertCard({ title: 'child working', workspace: 'ws-a', created_by: MEMBER, status: 'working', parent_id: parent, last_session_summary: 'should be hidden while working' })
  childDone = insertCard({ title: 'child done', workspace: 'ws-a', created_by: MEMBER, status: 'done', parent_id: parent, last_session_summary: `Shipped the thing. token=${SECRET}` })
  recordProgress(db, childWorking, { step: 2, total_steps: 4, label: 'scraping' })

  // Objective memory for memberWsA (mid-run: card is 'working').
  const dir = path.join(MEM, String(memberWsA))
  fs.mkdirSync(path.join(dir, 'live'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'ARTIFACT.md'), `# Deliverable\nkey ${SECRET}\n`)
  fs.writeFileSync(path.join(dir, 'NOTES.md'), 'scratch\n')
  fs.writeFileSync(path.join(dir, 'live', 'rows.csv'), 'a,b\n1,2\n3,4\n')
  fs.mkdirSync(path.join(MEM, String(adminWsB)), { recursive: true })
  fs.writeFileSync(path.join(MEM, String(adminWsB), 'ARTIFACT.md'), 'foreign\n')

  memberKey = issueApiKey(MEMBER).token

  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/objectives', objectivesRouter)
  server = http.createServer(app)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  adminCookie = cookieFor(ADMIN, 'admin', 'admin')
  memberCookie = cookieFor(MEMBER, 'member', 'member')
})

afterAll(async () => {
  delete process.env.TEST_ROUTE_SECRET_TOKEN
  await new Promise<void>(resolve => server.close(() => resolve()))
  try { getDb().close() } catch { /* ignore */ }
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('POST /:id/progress', () => {
  it('owner (member) writes a snapshot → 201, source api, redacted', async () => {
    const r = await call(`/${memberWsA}/progress`, asMember(), {
      method: 'POST',
      body: JSON.stringify({ step: 1, total_steps: 3, label: 'fetch', note: `using ${SECRET}`, artifacts: ['live/rows.csv'] }),
    })
    expect(r.status).toBe(201)
    expect(r.json).toMatchObject({ objective_id: memberWsA, step: 1, total_steps: 3, label: 'fetch', source: 'api', artifacts: ['live/rows.csv'] })
    expect(r.json.note).toBe('using [REDACTED:TEST_ROUTE_SECRET_TOKEN]')
  })

  it('admin may write to any card', async () => {
    const r = await call(`/${adminWsB}/progress`, asAdmin(), { method: 'POST', body: JSON.stringify({ step: 1, total_steps: 1 }) })
    expect(r.status).toBe(201)
  })

  it('invalid body → 400', async () => {
    const r = await call(`/${memberWsA}/progress`, asMember(), { method: 'POST', body: JSON.stringify({ step: 9, total_steps: 2 }) })
    expect(r.status).toBe(400)
    expect(r.json.error).toMatch(/exceed/)
    const empty = await call(`/${memberWsA}/progress`, asMember(), { method: 'POST', body: JSON.stringify({}) })
    expect(empty.status).toBe(400)
  })

  it('a card in a workspace the member is not in → 404, even when the member created it', async () => {
    const r = await call(`/${memberWsB}/progress`, asMember(), { method: 'POST', body: JSON.stringify({ step: 1 }) })
    expect(r.status).toBe(404)
  })

  it('unauthenticated → 401', async () => {
    const r = await call(`/${memberWsA}/progress`, {})
    expect(r.status).toBe(401)
  })
})

describe('GET /:id/progress', () => {
  it('returns latest + events with progress_source worker', async () => {
    const r = await call(`/${memberWsA}/progress`, asMember())
    expect(r.status).toBe(200)
    expect(r.json.objective_id).toBe(memberWsA)
    expect(r.json.status).toBe('working')
    expect(r.json.progress_source).toBe('worker')
    expect(r.json.latest).toMatchObject({ step: 1, total_steps: 3, label: 'fetch' })
    expect(r.json.events.length).toBeGreaterThanOrEqual(1)
    expect(r.json.total_events).toBe(r.json.events.length)
    expect(r.json.children).toBeNull()
    expect(Array.isArray(r.json.session_starts)).toBe(true)
  })

  it('pages via limit/before; latest stays the newest snapshot', async () => {
    for (let i = 2; i <= 3; i++) {
      await call(`/${memberWsA}/progress`, asMember(), { method: 'POST', body: JSON.stringify({ step: i, total_steps: 3 }) })
    }
    const p1 = await call(`/${memberWsA}/progress?limit=1`, asMember())
    expect(p1.json.events).toHaveLength(1)
    expect(p1.json.next_before).toBeTruthy()
    const p2 = await call(`/${memberWsA}/progress?limit=1&before=${p1.json.next_before}`, asMember())
    expect(p2.json.events[0].id).toBeLessThan(p1.json.events[0].id)
    expect(p2.json.latest.id).toBe(p1.json.events[0].id)
  })

  it('unsupported / malformed query params → 400 with supported_params', async () => {
    const r = await call(`/${memberWsA}/progress?foo=1`, asMember())
    expect(r.status).toBe(400)
    expect(r.json.supported_params).toEqual(['limit', 'before'])
    expect((await call(`/${memberWsA}/progress?limit=0`, asMember())).status).toBe(400)
    expect((await call(`/${memberWsA}/progress?limit=101`, asMember())).status).toBe(400)
    expect((await call(`/${memberWsA}/progress?before=abc`, asMember())).status).toBe(400)
  })

  it('workspace scoping: member gets 404 on ws-b cards (progress and artifacts)', async () => {
    for (const id of [adminWsB, memberWsB]) {
      expect((await call(`/${id}/progress`, asMember())).status).toBe(404)
      expect((await call(`/${id}/artifacts`, asMember())).status).toBe(404)
      expect((await call(`/${id}/artifacts/file?path=ARTIFACT.md`, asMember())).status).toBe(404)
    }
    expect((await call(`/999999/progress`, asMember())).status).toBe(404)
    // Admin sees everything.
    expect((await call(`/${adminWsB}/progress`, asAdmin())).status).toBe(200)
  })

  // KNOWN BUG (reported): middleware/workspace.ts getUserWorkspaces projects only
  // (workspace, role) and drops objective_visibility, so canReadObjective's
  // `membership.objective_visibility === 'all'` branch can never fire — a member
  // with visibility 'all' still cannot read a teammate's card. it.fails flips red
  // once getUserWorkspaces selects the column.
  it.fails("member with visibility 'all' can read a ws-a card created by someone else", async () => {
    const r = await call(`/${adminWsA}/progress`, asMember())
    expect(r.status).toBe(200)
  })

  it('transcript fallback: no worker rows → progress_source transcript with last_tool', async () => {
    const r = await call(`/${transcriptCard}/progress`, asMember())
    expect(r.status).toBe(200)
    expect(r.json.latest).toBeNull()
    expect(r.json.events).toEqual([])
    expect(r.json.progress_source).toBe('transcript')
    expect(r.json.session_id).toBe('cc-route-tx-1')
    expect(r.json.transcript).toMatchObject({
      source: 'transcript',
      session_id: 'cc-route-tx-1',
      last_tool: { name: 'Bash', summary: 'npm test' },
      last_assistant_message: 'Looking at the repo.',
      assistant_turns: 2,
      tool_calls: 1,
    })
  })

  it("no worker rows and no transcript → progress_source 'none'", async () => {
    const blank = insertCard({ title: 'blank', workspace: 'ws-a', created_by: MEMBER, status: 'queue' })
    const b = await call(`/${blank}/progress`, asMember())
    expect(b.json.progress_source).toBe('none')
    expect(b.json.transcript).toBeNull()
  })

  it('children roll-up: totals, by_status, child latest progress and final result', async () => {
    const r = await call(`/${parent}/progress`, asMember())
    expect(r.status).toBe(200)
    const c = r.json.children
    expect(c.total).toBe(2)
    expect(c.by_status).toEqual({ working: 1, done: 1 })
    expect(c.done).toBe(1)
    const w = c.items.find((i: any) => i.id === childWorking)
    const d = c.items.find((i: any) => i.id === childDone)
    expect(w.latest).toMatchObject({ step: 2, total_steps: 4, label: 'scraping' })
    expect(w.result).toBeNull() // no final result while still working
    expect(d.latest).toBeNull()
    expect(d.result).toBe('Shipped the thing. token=[REDACTED:TEST_ROUTE_SECRET_TOKEN]')
  })

  it('session_starts appear after logSessionStart, newest first', async () => {
    noteStartReason(memberWsA, 'agent', 'bot-1')
    logSessionStart(getDb(), { objectiveId: memberWsA, sessionId: 'cc-a-1', kind: 'spawn' })
    logSessionStart(getDb(), { objectiveId: memberWsA, sessionId: 'cc-a-1', kind: 'attach' })
    const r = await call(`/${memberWsA}/progress`, asMember())
    expect(r.json.session_starts).toHaveLength(2)
    expect(r.json.session_starts[0]).toMatchObject({ kind: 'attach', reason: 'unattributed' })
    expect(r.json.session_starts[1]).toMatchObject({ kind: 'spawn', reason: 'agent', actor: 'bot-1', session_id: 'cc-a-1' })
  })

  it('API-key bearer auth works for GET progress (and respects the same scoping)', async () => {
    const r = await call(`/${memberWsA}/progress`, asKey())
    expect(r.status).toBe(200)
    expect(r.json.progress_source).toBe('worker')
    expect((await call(`/${adminWsB}/progress`, asKey())).status).toBe(404)
    expect((await call(`/${memberWsA}/progress`, { Authorization: 'Bearer cc_live_bogus' })).status).toBe(401)
  })
})

describe('GET /:id/artifacts (+ /file)', () => {
  it('lists files mid-run, masking NOTES.md', async () => {
    const r = await call(`/${memberWsA}/artifacts`, asMember())
    expect(r.status).toBe(200)
    expect(r.json.status).toBe('working')
    expect(r.json.entries.map((e: any) => e.path).sort()).toEqual(['ARTIFACT.md', 'live/rows.csv'])
  })

  it('reads a file with redaction headers', async () => {
    const r = await call(`/${memberWsA}/artifacts/file?path=ARTIFACT.md`, asKey())
    expect(r.status).toBe(200)
    expect(r.json.content).toContain('[REDACTED:TEST_ROUTE_SECRET_TOKEN]')
    expect(r.json.content).not.toContain(SECRET)
    expect(r.headers.get('x-redacted')).toBe('1')
    expect(r.headers.get('x-redaction-count')).toBe('1')
  })

  it('tail_bytes on a partial output', async () => {
    const r = await call(`/${memberWsA}/artifacts/file?path=live/rows.csv&tail_bytes=4`, asMember())
    expect(r.status).toBe(200)
    expect(r.json.content).toBe('3,4\n')
  })

  it('NOTES.md → 403; traversal → 400; missing path → 400; bad param → 400', async () => {
    expect((await call(`/${memberWsA}/artifacts/file?path=NOTES.md`, asMember())).status).toBe(403)
    expect((await call(`/${memberWsA}/artifacts/file?path=..%2F${adminWsB}%2FARTIFACT.md`, asMember())).status).toBe(400)
    expect((await call(`/${memberWsA}/artifacts/file`, asMember())).status).toBe(400)
    expect((await call(`/${memberWsA}/artifacts/file?path=ARTIFACT.md&bogus=1`, asMember())).status).toBe(400)
    expect((await call(`/${memberWsA}/artifacts/file?path=ARTIFACT.md&offset=-1`, asMember())).status).toBe(400)
  })
})
