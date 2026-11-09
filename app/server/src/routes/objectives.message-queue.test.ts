import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

// obj 900412 — POST /api/objectives/:id/message must NOT restart a worker that
// is mid-turn. Real SQLite + real router; only the process-level session calls
// (state probe, respawn, kill) are stubbed.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-msgqueue-test-'))
process.env.DB_PATH = path.join(TMP, 'db.sqlite')
process.env.JWT_SECRET = 'test-secret-msgqueue'
process.env.TRANSCRIPT_DIR = TMP

const state = vi.hoisted(() => ({ session: 'working' as 'working' | 'review' | 'dead' }))
const sendFollowUp = vi.hoisted(() => vi.fn((sid: string, _message: string, _objective: unknown, _opts?: unknown) => sid))
const stopSession = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('../services/session-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/session-manager.js')>()),
  getSessionState: () => state.session,
  sendFollowUp,
  stopSession,
}))

const { getDb, initDb } = await import('../db/index.js')
const { default: objectivesRouter } = await import('./objectives.js')
const { listPendingFollowUps } = await import('../services/followup-queue.js')

let server: http.Server
let baseUrl: string
let cookie: string
let objId: number
let sessionId: string
let jsonl: string

async function post(pathname: string, body: unknown = {}): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}/api/objectives/${objId}${pathname}`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() }
}
const tick = () => new Promise(r => setTimeout(r, 20))

beforeAll(async () => {
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (1, 'tester', 'x', 'admin')`).run()
  const r = db.prepare(
    `INSERT INTO objectives (title, agent_context, workspace, created_by, status) VALUES ('site copy check', 'general', 'ws', 1, 'working')`,
  ).run()
  objId = Number(r.lastInsertRowid)
  sessionId = `cc-${objId}-1794250000000`
  db.prepare('UPDATE objectives SET session_id = ? WHERE id = ?').run(sessionId, objId)
  jsonl = path.join(TMP, `${sessionId}.jsonl`)

  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/objectives', objectivesRouter)
  server = http.createServer(app)
  await new Promise<void>(resolve => server.listen(0, resolve))
  const addr = server.address()
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  cookie = `token=${jwt.sign({ id: 1, username: 'tester', role: 'admin' }, process.env.JWT_SECRET as string, { expiresIn: '1h' })}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  fs.rmSync(TMP, { recursive: true, force: true })
})

beforeEach(() => {
  sendFollowUp.mockClear()
  stopSession.mockClear()
  state.session = 'working'
  const db = getDb()
  db.prepare("UPDATE objectives SET status = 'working', session_id = ? WHERE id = ?").run(sessionId, objId)
  db.prepare('DELETE FROM followup_queue').run()
  // A worker mid-turn: last event is a tool call, transcript just written.
  fs.writeFileSync(jsonl, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'curl -s https://operationkit.com' } }] } }) + '\n')
})

describe('POST /:id/message while the worker is mid-turn (obj 900412)', () => {
  it('queues every message and never restarts the running worker', async () => {
    const msgs = ['does the site language match what Mike said?', '????????', 'answer?', 'hello ???']
    for (const m of msgs) {
      const r = await post('/message', { message: m })
      expect(r.status).toBe(200)
      expect(r.json.followup_queued).toBe(true)
      expect(r.json.status).toBe('working')
    }
    await tick()
    expect(sendFollowUp).not.toHaveBeenCalled()
    expect(listPendingFollowUps(getDb(), objId).map(q => q.message)).toEqual(msgs)

    // Each bubble is in the thread right away, flagged as queued.
    const events = fs.readFileSync(jsonl, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(e => e.type === 'followup')
    expect(events.map(e => e.text)).toEqual(msgs)
    expect(events.every(e => e.queued === true && e.sender?.username === 'tester')).toBe(true)
  })

  it('restarts as before once the turn has ended, carrying anything still queued', async () => {
    await post('/message', { message: 'first question' })
    state.session = 'review' // the turn wrote its result
    const r = await post('/message', { message: 'second question' })
    expect(r.status).toBe(200)
    expect(r.json.followup_queued).toBeUndefined()
    await tick()
    expect(sendFollowUp).toHaveBeenCalledTimes(1)
    const [sid, , , rawOpts] = sendFollowUp.mock.calls[0]
    const opts = rawOpts as { sessionTextOverride?: string }
    expect(sid).toBe(sessionId)
    expect(opts.sessionTextOverride).toContain('first question')
    expect(opts.sessionTextOverride).toContain('second question')
    expect(listPendingFollowUps(getDb(), objId)).toEqual([])
  })

  it('a worker silent past the stale window is treated as hung: the message restarts it', async () => {
    const old = new Date(Date.now() - 6 * 60_000)
    fs.utimesSync(jsonl, old, old)
    const r = await post('/message', { message: 'are you stuck?' })
    expect(r.json.followup_queued).toBeUndefined()
    await tick()
    expect(sendFollowUp).toHaveBeenCalledTimes(1)
    expect(sendFollowUp.mock.calls[0][1]).toBe('are you stuck?')
  })

  it('kill switch: followup_queue_enabled=0 restores restart-on-every-message', async () => {
    getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('followup_queue_enabled', '0')").run()
    try {
      const r = await post('/message', { message: 'hi' })
      expect(r.json.followup_queued).toBeUndefined()
      await tick()
      expect(sendFollowUp).toHaveBeenCalledTimes(1)
    } finally {
      getDb().prepare("DELETE FROM settings WHERE key = 'followup_queue_enabled'").run()
    }
  })

  it('Stop drops queued messages so a stopped card stays stopped', async () => {
    await post('/message', { message: 'queued then stopped' })
    expect(listPendingFollowUps(getDb(), objId)).toHaveLength(1)
    const r = await post('/stop')
    expect(r.status).toBe(200)
    expect(stopSession).toHaveBeenCalled()
    expect(listPendingFollowUps(getDb(), objId)).toEqual([])
  })
})
