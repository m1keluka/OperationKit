import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

// Control-layer endpoints (obj 714091): /api/agent/changes cursor paging,
// /api/agent/attention shape + size, Idempotency-Key on create, start:true.
// Exercises the real routers over HTTP against a throwaway DB; only the tmux
// session spawn is mocked.
const TMP_DB = path.join(os.tmpdir(), `cc-agent-control-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-agent-control'

const startSessionMock = vi.fn(async (o: { id: number }) => `sess-${o.id}`)
vi.mock('../services/session-manager.js', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, startSession: (o: { id: number }) => startSessionMock(o) }
})

const { initDb, getDb } = await import('../db/index.js')
const { default: objectivesRouter } = await import('./objectives.js')
const { default: agentApiRouter } = await import('./agent-api.js')
const { default: agentControlRouter } = await import('./agent-control.js')
const { MAX_CONCURRENT_SESSIONS } = await import('@operationkit/shared')
const { rebuildObjectivesTable } = await import('../db/schema/objectives-rebuild.js')

const ADMIN_ID = 1
const MEMBER_ID = 2
const WS = 'ctl-ws'
const OTHER_WS = 'other-ws'

let server: http.Server
let baseUrl: string

function token(role: 'admin' | 'member'): string {
  const id = role === 'admin' ? ADMIN_ID : MEMBER_ID
  return jwt.sign({ id, username: role, role }, process.env.JWT_SECRET as string, { expiresIn: '1h' })
}

async function call(
  method: string,
  url: string,
  opts: { role?: 'admin' | 'member'; body?: unknown; headers?: Record<string, string> } = {},
) {
  const res = await fetch(`${baseUrl}${url}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Cookie: `token=${token(opts.role ?? 'admin')}`,
      ...(opts.headers ?? {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  const text = await res.text()
  return { status: res.status, headers: res.headers, text, json: JSON.parse(text) as Record<string, any> }
}

function insertCard(title: string, opts: { workspace?: string; status?: string; createdBy?: number } = {}): number {
  return Number(
    getDb()
      .prepare(`INSERT INTO objectives (title, agent_context, workspace, status, created_by) VALUES (?, 'general', ?, ?, ?)`)
      .run(title, opts.workspace ?? WS, opts.status ?? 'queue', opts.createdBy ?? ADMIN_ID).lastInsertRowid,
  )
}

function setStatus(id: number, status: string): void {
  // The same UPDATE shape the state-poller uses — no app-level audit call.
  getDb().prepare("UPDATE objectives SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id)
}

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const ins = getDb().prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, 'x', ?)`)
  ins.run(ADMIN_ID, 'admin', 'admin')
  ins.run(MEMBER_ID, 'member', 'member')
  getDb().prepare(`INSERT INTO user_workspaces (user_id, workspace, role) VALUES (?, ?, 'member')`).run(MEMBER_ID, WS)
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/objectives', objectivesRouter)
  app.use('/api', agentApiRouter)
  app.use('/api/agent', agentControlRouter)
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()) })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no address')
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  try { getDb().close() } catch {}
  for (const suffix of ['', '-wal', '-shm']) {
    const f = `${TMP_DB}${suffix}`
    if (fs.existsSync(f)) fs.unlinkSync(f)
  }
})

beforeEach(() => {
  const db = getDb()
  db.prepare('DELETE FROM objectives').run()
  db.prepare('DELETE FROM objective_events').run()
  db.prepare('DELETE FROM idempotency_keys').run()
  startSessionMock.mockClear()
})

async function headCursor(): Promise<string> {
  // A poll with no events after the head returns the head as next_cursor.
  const max = (getDb().prepare('SELECT COALESCE(MAX(id),0) AS m FROM objective_events').get() as { m: number }).m
  return String(max)
}

describe('GET /api/agent — discovery stays public', () => {
  it('is still served without auth with the control router mounted under /api/agent', async () => {
    const res = await fetch(`${baseUrl}/api/agent`)
    expect(res.status).toBe(200)
  })
})

describe('GET /api/agent/changes', () => {
  it('requires auth', async () => {
    const res = await fetch(`${baseUrl}/api/agent/changes?since=0`)
    expect(res.status).toBe(401)
  })

  it('pages with a monotonic cursor: no gaps, no duplicates, includes status + entered_review', async () => {
    const start = await headCursor()
    // 6 cards × (created, queue→working, working→ai_review, ai_review→review) = 24 events,
    // all via raw UPDATEs the way the state-poller writes them.
    const ids: number[] = []
    for (let i = 0; i < 6; i++) {
      const id = insertCard(`card ${i}`)
      ids.push(id)
      setStatus(id, 'working')
      setStatus(id, 'ai_review')
      setStatus(id, 'review')
    }
    // A no-op status write must NOT produce an event.
    setStatus(ids[0], 'review')

    const expected = (getDb()
      .prepare('SELECT id FROM objective_events WHERE id > ? ORDER BY id')
      .all(Number(start)) as { id: number }[]).map(r => String(r.id))
    expect(expected).toHaveLength(24)

    const seen: string[] = []
    const events: Array<Record<string, any>> = []
    let cursor = start
    let pages = 0
    for (;;) {
      const res = await call('GET', `/api/agent/changes?since=${cursor}&limit=5&workspace=${WS}`)
      expect(res.status).toBe(200)
      pages++
      for (const ev of res.json.events) {
        seen.push(ev.cursor)
        events.push(ev)
        expect(Number(ev.cursor)).toBeGreaterThan(Number(cursor))
      }
      expect(Number(res.json.next_cursor)).toBeGreaterThanOrEqual(Number(cursor))
      cursor = res.json.next_cursor
      if (!res.json.has_more) break
      expect(pages).toBeLessThan(20)
    }
    expect(pages).toBe(5) // 24 events / 5 per page
    expect(seen).toEqual(expected) // exact sequence: no gaps, no dupes, ascending
    expect(new Set(seen).size).toBe(seen.length)

    const created = events.filter(e => e.type === 'created')
    const status = events.filter(e => e.type === 'status')
    const review = events.filter(e => e.type === 'entered_review')
    expect(created).toHaveLength(6)
    expect(status).toHaveLength(12)
    expect(review).toHaveLength(6)
    expect(review[0]).toMatchObject({ from: 'ai_review', to: 'review', workspace: WS, title: 'card 0' })
    expect(status.find(e => e.to === 'working')).toMatchObject({ from: 'queue', to: 'working' })

    // Caught up: the same cursor yields nothing, then exactly the new event.
    const idle = await call('GET', `/api/agent/changes?since=${cursor}`)
    expect(idle.json.events).toEqual([])
    expect(idle.json.next_cursor).toBe(cursor)
    setStatus(ids[1], 'done')
    const next = await call('GET', `/api/agent/changes?since=${cursor}`)
    expect(next.json.events).toHaveLength(1)
    expect(next.json.events[0]).toMatchObject({ objective_id: ids[1], type: 'status', from: 'review', to: 'done' })
  })

  it('records verdicts, session-ended summaries and PR open/merge', async () => {
    const since = await headCursor()
    const id = insertCard('pr card', { status: 'working' })
    getDb().prepare("UPDATE objectives SET ai_review_verdict = 'fail', ai_review_findings = ? WHERE id = ?")
      .run('Tests missing for cursor paging\nsecond line', id)
    getDb().prepare('UPDATE objectives SET last_session_summary = ? WHERE id = ?').run('## Done\nShipped the thing', id)
    getDb().prepare(`INSERT INTO objective_prs (objective_id, repo, pr_number, pr_url) VALUES (?, 'o/r', 7, 'https://github.com/o/r/pull/7')`).run(id)
    getDb().prepare(`UPDATE objective_prs SET state = 'merged' WHERE objective_id = ?`).run(id)

    const res = await call('GET', `/api/agent/changes?since=${since}`)
    const types = res.json.events.map((e: any) => e.type)
    expect(types).toEqual(['created', 'verdict', 'session_ended', 'pr_opened', 'pr_merged'])
    const byType = Object.fromEntries(res.json.events.map((e: any) => [e.type, e]))
    expect(byType.verdict).toMatchObject({ to: 'fail', detail: 'Tests missing for cursor paging' })
    expect(byType.session_ended.detail).toBe('Done')
    expect(byType.pr_merged).toMatchObject({ from: 'open', to: 'merged', workspace: WS })
  })

  it('scopes a member to their own cards and advances the cursor past invisible rows', async () => {
    const since = await headCursor()
    insertCard('admin card in member ws', { createdBy: ADMIN_ID })
    insertCard('other workspace', { workspace: OTHER_WS, createdBy: MEMBER_ID })
    const mine = insertCard('member card', { createdBy: MEMBER_ID })
    const res = await call('GET', `/api/agent/changes?since=${since}`, { role: 'member' })
    expect(res.json.events.map((e: any) => e.objective_id)).toEqual([mine])
    expect(res.json.next_cursor).toBe(await headCursor())
  })

  it('keeps recording after the boot-time objectives rebuild (DROP + RENAME)', async () => {
    rebuildObjectivesTable(getDb(), {})
    const since = await headCursor()
    const id = insertCard('post-rebuild')
    setStatus(id, 'working')
    getDb().prepare(`INSERT INTO objective_prs (objective_id, pr_number, pr_url) VALUES (?, 9, 'u')`).run(id)
    const res = await call('GET', `/api/agent/changes?since=${since}`)
    expect(res.json.events.map((e: any) => e.type)).toEqual(['created', 'status', 'pr_opened'])
  })

  it('rejects unknown params and malformed cursors', async () => {
    expect((await call('GET', '/api/agent/changes?sinse=1')).status).toBe(400)
    expect((await call('GET', '/api/agent/changes?since=abc')).status).toBe(400)
    expect((await call('GET', '/api/agent/changes?limit=9999')).status).toBe(400)
  })
})

describe('GET /api/agent/attention', () => {
  it('lists failed-review, blocked, review and stuck cards with a one-line why, under 4KB', async () => {
    const db = getDb()
    const longText = `${'This is a long paragraph of worker narration. '.repeat(40)}\nline two\nline three`
    const failed = insertCard('Failed review card', { status: 'review' })
    db.prepare("UPDATE objectives SET ai_review_verdict = 'fail', ai_review_findings = ? WHERE id = ?").run(`[criterion-1] ${longText}`, failed)
    const passed = insertCard('Passed review card', { status: 'review' })
    db.prepare("UPDATE objectives SET ai_review_verdict = 'pass', last_session_summary = ? WHERE id = ?").run(`# Summary\n${longText}`, passed)
    const blocked = insertCard('Blocked worker', { status: 'working' })
    db.prepare('UPDATE objectives SET has_blockers = 1, last_activity_at = datetime(\'now\') WHERE id = ?').run(blocked)
    const stuck = insertCard('Quiet worker', { status: 'working' })
    db.prepare("UPDATE objectives SET last_activity_at = datetime('now', '-95 minutes') WHERE id = ?").run(stuck)
    const fresh = insertCard('Busy worker', { status: 'working' })
    db.prepare("UPDATE objectives SET last_activity_at = datetime('now') WHERE id = ?").run(fresh)
    insertCard('Queued card', { status: 'queue' })
    insertCard('Elsewhere', { status: 'review', workspace: OTHER_WS })
    // Filler so the payload is a realistic "typical workspace" review backlog.
    for (let i = 0; i < 12; i++) {
      const id = insertCard(`Backlog review item number ${i} with a reasonably descriptive title`, { status: 'review' })
      db.prepare('UPDATE objectives SET last_session_summary = ? WHERE id = ?').run(longText, id)
    }

    const res = await call('GET', `/api/agent/attention?workspace=${WS}`)
    expect(res.status).toBe(200)
    const body = res.json
    expect(body.counts).toEqual({ needs_secret: 0, failed_review: 1, blocked: 1, review: 13, stuck: 1 })
    expect(body.items).toHaveLength(15) // default limit
    expect(body.truncated).toBe(true)
    // Urgency order: failed review first, then blocked, then review, then stuck.
    expect(body.items[0]).toMatchObject({ id: failed, kind: 'failed_review' })
    expect(body.items[0].why).toMatch(/^AI review FAIL: \[criterion-1\] This is a long/)
    expect(body.items[1]).toMatchObject({ id: blocked, kind: 'blocked' })
    expect(body.items.some((i: any) => i.id === fresh)).toBe(false)
    const passedItem = body.items.find((i: any) => i.id === passed)
    expect(passedItem.why).toMatch(/^AI review passed — accept or reopen: Summary$/)
    for (const item of body.items) {
      expect(Object.keys(item).sort()).toEqual(['age_min', 'id', 'kind', 'title', 'why'])
      expect(item.why).not.toMatch(/\n/)
      expect(item.why.length).toBeLessThanOrEqual(140)
      expect(item.title.length).toBeLessThanOrEqual(70)
    }

    const all = await call('GET', `/api/agent/attention?workspace=${WS}&limit=50`)
    expect(all.json.items.find((i: any) => i.id === stuck)).toMatchObject({ kind: 'stuck' })
    expect(all.json.items.find((i: any) => i.id === stuck).age_min).toBeGreaterThanOrEqual(94)

    // Size budget: the default brief stays well under 4KB even with long prose on every card.
    expect(Buffer.byteLength(res.text)).toBeLessThan(4096)
  })

  it('falls back to the newest milestone/blocker note when there is no session summary', async () => {
    const db = getDb()
    const parked = insertCard('Parked without summary', { status: 'review' })
    db.prepare("UPDATE objectives SET ai_review_verdict = 'pass' WHERE id = ?").run(parked)
    const blocked = insertCard('Blocked w/ note', { status: 'working' })
    db.prepare("UPDATE objectives SET has_blockers = 1, last_activity_at = datetime('now') WHERE id = ?").run(blocked)
    const note = db.prepare(`INSERT INTO activity_log (project, workspace, objective_id, event_type, title, detail) VALUES ('p', ?, ?, ?, ?, ?)`)
    note.run(WS, parked, 'milestone', 'old_note', 'superseded')
    note.run(WS, parked, 'milestone', 'auto_merge_decision', '[skip] PR is behind/blocked/dirty — rebase before auto-merge')
    note.run(WS, parked, 'session_end', 'Session success: ignored', null)
    note.run(WS, blocked, 'blocker', 'Need the STRIPE_KEY secret', null)
    const res = await call('GET', `/api/agent/attention?workspace=${WS}`)
    const byId = Object.fromEntries(res.json.items.map((i: any) => [i.id, i]))
    expect(byId[parked].why).toBe('AI review passed — accept or reopen: auto_merge_decision: [skip] PR is behind/blocked/dirty — rebase before auto-merge')
    expect(byId[blocked].why).toBe('Blocker raised: Need the STRIPE_KEY secret')
  })

  it('hides cards a member cannot read', async () => {
    insertCard('admin review', { status: 'review', createdBy: ADMIN_ID })
    const mine = insertCard('member review', { status: 'review', createdBy: MEMBER_ID })
    const res = await call('GET', '/api/agent/attention', { role: 'member' })
    expect(res.json.items.map((i: any) => i.id)).toEqual([mine])
    expect(res.json.items[0].ws).toBe(WS)
  })
})

describe('Idempotency-Key on POST /api/objectives', () => {
  it('replays the original response for the same key: same id, one row', async () => {
    const body = { title: 'Idempotent card', workspace: WS }
    const headers = { 'Idempotency-Key': 'grok-run-42-create-1' }
    const first = await call('POST', '/api/objectives', { body, headers })
    const second = await call('POST', '/api/objectives', { body, headers })
    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    expect(second.json.id).toBe(first.json.id)
    expect(second.headers.get('idempotent-replayed')).toBe('true')
    const rows = getDb().prepare('SELECT COUNT(*) AS c FROM objectives WHERE title = ?').get('Idempotent card') as { c: number }
    expect(rows.c).toBe(1)
  })

  it('creates separate cards for different keys or no key, and 422s a reused key with a new body', async () => {
    const a = await call('POST', '/api/objectives', { body: { title: 'A', workspace: WS }, headers: { 'Idempotency-Key': 'k-a' } })
    const b = await call('POST', '/api/objectives', { body: { title: 'A', workspace: WS }, headers: { 'Idempotency-Key': 'k-b' } })
    const c = await call('POST', '/api/objectives', { body: { title: 'A', workspace: WS } })
    expect(new Set([a.json.id, b.json.id, c.json.id]).size).toBe(3)
    const reused = await call('POST', '/api/objectives', { body: { title: 'B', workspace: WS }, headers: { 'Idempotency-Key': 'k-a' } })
    expect(reused.status).toBe(422)
  })

  it('scopes keys per user', async () => {
    const body = { title: 'Per-user', workspace: WS }
    const headers = { 'Idempotency-Key': 'shared-key' }
    const admin = await call('POST', '/api/objectives', { body, headers })
    const member = await call('POST', '/api/objectives', { body, headers, role: 'member' })
    expect(admin.json.id).not.toBe(member.json.id)
  })

  it('expires keys after 24h', async () => {
    const body = { title: 'Old key', workspace: WS }
    const headers = { 'Idempotency-Key': 'k-old' }
    const first = await call('POST', '/api/objectives', { body, headers })
    getDb().prepare("UPDATE idempotency_keys SET created_at = datetime('now', '-25 hours')").run()
    const second = await call('POST', '/api/objectives', { body, headers })
    expect(second.json.id).not.toBe(first.json.id)
  })

  it('rejects a malformed key', async () => {
    const res = await call('POST', '/api/objectives', { body: { title: 'x', workspace: WS }, headers: { 'Idempotency-Key': 'has space' } })
    expect(res.status).toBe(400)
  })
})

describe('Idempotency-Key on POST /api/objectives/:id/message', () => {
  it('stores and replays the response instead of re-running the handler', async () => {
    const id = insertCard('finished', { status: 'done' })
    const opts = { body: { message: 'hello' }, headers: { 'Idempotency-Key': 'msg-1' } }
    const first = await call('POST', `/api/objectives/${id}/message`, opts)
    expect(first.status).toBe(409) // done cards must be reopened first
    getDb().prepare("UPDATE objectives SET status = 'review' WHERE id = ?").run(id)
    const second = await call('POST', `/api/objectives/${id}/message`, opts)
    expect(second.status).toBe(409)
    expect(second.headers.get('idempotent-replayed')).toBe('true')
    expect(second.json).toEqual(first.json)
    const row = getDb().prepare('SELECT scope FROM idempotency_keys WHERE idem_key = ?').get('msg-1') as { scope: string }
    // Namespaced per credential (obj 714100): this test calls with a session JWT.
    expect(row.scope).toBe(`session POST /api/objectives/${id}/message`)
  })
})

describe('POST /api/objectives {start: true}', () => {
  it('creates and transitions to working in one call', async () => {
    const res = await call('POST', '/api/objectives', { body: { title: 'Start me', workspace: WS, start: true } })
    expect(res.status).toBe(201)
    expect(res.json).toMatchObject({ title: 'Start me', status: 'working', start: { started: true } })
    expect(startSessionMock).toHaveBeenCalledTimes(1)
    const row = getDb().prepare('SELECT status, session_id FROM objectives WHERE id = ?').get(res.json.id) as { status: string; session_id: string }
    expect(row).toEqual({ status: 'working', session_id: `sess-${res.json.id}` })
    const audit = getDb().prepare("SELECT pathway FROM objective_audit WHERE objective_id = ? AND to_status = 'working'").get(res.json.id) as { pathway: string }
    expect(audit.pathway).toBe('public-create-start')
  })

  it('on the session cap returns 409, leaves the card queued, and says so', async () => {
    for (let i = 0; i < MAX_CONCURRENT_SESSIONS; i++) insertCard(`busy ${i}`, { status: 'working' })
    const res = await call('POST', '/api/objectives', { body: { title: 'Capped', workspace: WS, start: true } })
    expect(res.status).toBe(409)
    expect(res.json.error).toMatch(/concurrent sessions reached.*created but left in queue/)
    expect(res.json.objective).toMatchObject({ title: 'Capped', status: 'queue' })
    expect(res.json.start).toMatchObject({ started: false, status: 'queue', reason: 'session_cap' })
    expect(startSessionMock).not.toHaveBeenCalled()
    const row = getDb().prepare('SELECT status FROM objectives WHERE id = ?').get(res.json.objective.id) as { status: string }
    expect(row.status).toBe('queue')
  })

  it('replays a capped create+start under the same Idempotency-Key instead of creating a second card', async () => {
    for (let i = 0; i < MAX_CONCURRENT_SESSIONS; i++) insertCard(`busy ${i}`, { status: 'working' })
    const opts = { body: { title: 'Capped once', workspace: WS, start: true }, headers: { 'Idempotency-Key': 'cap-1' } }
    const first = await call('POST', '/api/objectives', opts)
    const second = await call('POST', '/api/objectives', opts)
    expect(first.status).toBe(409)
    expect(second.status).toBe(409)
    expect(second.json.objective.id).toBe(first.json.objective.id)
    const rows = getDb().prepare('SELECT COUNT(*) AS c FROM objectives WHERE title = ?').get('Capped once') as { c: number }
    expect(rows.c).toBe(1)
  })

  it('does not start a project card (planning) and explains why', async () => {
    const res = await call('POST', '/api/objectives', { body: { title: 'Big project', workspace: WS, type: 'project', start: true } })
    expect(res.status).toBe(201)
    expect(res.json.status).toBe('planning')
    expect(res.json.start).toMatchObject({ started: false, reason: 'not_startable' })
    expect(startSessionMock).not.toHaveBeenCalled()
  })

  it('keeps the plain create response unchanged without start', async () => {
    const res = await call('POST', '/api/objectives', { body: { title: 'Plain', workspace: WS } })
    expect(res.status).toBe(201)
    expect(res.json.status).toBe('queue')
    expect(res.json).not.toHaveProperty('start')
  })
})

describe('OpenAPI documents the control layer', () => {
  it('lists the new paths, the Idempotency-Key header and start:true', async () => {
    const spec = (await call('GET', '/api/openapi.json')).json
    expect(spec.paths).toHaveProperty(['/api/agent/changes'])
    expect(spec.paths).toHaveProperty(['/api/agent/attention'])
    const idem = { $ref: '#/components/parameters/IdempotencyKey' }
    expect(spec.paths['/api/objectives'].post.parameters).toContainEqual(idem)
    expect(spec.paths['/api/objectives/{id}/message'].post.parameters).toContainEqual(idem)
    expect(spec.components.parameters.IdempotencyKey).toMatchObject({ name: 'Idempotency-Key', in: 'header' })
    expect(spec.components.schemas.CreateObjectiveRequest.properties).toHaveProperty('start')
  })
})
