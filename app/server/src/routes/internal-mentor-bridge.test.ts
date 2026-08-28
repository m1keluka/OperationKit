// Tests for the Jarvis service-auth bridge (objective 341) in routes/internal.ts.
// Covers:
//   - auth matrix (localhost × token → 200/401/403)
//   - fail-closed when MENTOR_SERVICE_TOKEN is unset
//   - owner resolution + scoping (foreign / unowned threads → 404)
//   - thread create defaults (title "Telegram", workspace "example", tag "telegram")
//
// mentor-session is mocked so no Claude subprocess is spawned. SQLite is real.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'

const TMP_DB = path.join(os.tmpdir(), `cc-bridge-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.MENTOR_SERVICE_TOKEN = 'test-service-token'

const sendMentorMessageMock = vi.fn()
const getMentorSessionStateMock = vi.fn()
const getMentorJsonlPathMock = vi.fn()

vi.mock('../services/mentor-session.js', () => ({
  sendMentorMessage: (...args: unknown[]) => sendMentorMessageMock(...args),
  getMentorSessionState: (...args: unknown[]) => getMentorSessionStateMock(...args),
  getMentorJsonlPath: (...args: unknown[]) => getMentorJsonlPathMock(...args),
}))

const { initDb, getDb } = await import('../db/index.js')
const { default: internalRouter } = await import('./internal.js')

let server: http.Server
let baseUrl: string
let mikeId: number
let aliceId: number
const TOKEN = 'test-service-token'

function makeApp(): express.Express {
  const app = express()
  app.set('trust proxy', true)
  app.use(express.json())
  app.use('/api/internal', internalRouter)
  return app
}

async function call(
  method: string,
  pathname: string,
  opts: { body?: unknown; token?: string | null; forwardedFor?: string } = {},
): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.token) headers['x-service-token'] = opts.token
  if (opts.forwardedFor) headers['x-forwarded-for'] = opts.forwardedFor
  const res = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  let json: unknown = null
  if (res.status !== 204) {
    const text = await res.text()
    json = text ? JSON.parse(text) : null
  }
  return { status: res.status, json }
}

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  mikeId = db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('mike', '', 'admin')").run().lastInsertRowid as number
  aliceId = db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('alice', '', 'member')").run().lastInsertRowid as number

  const app = makeApp()
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()) })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('server has no address')
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
  getDb().exec('DELETE FROM mentor_threads;')
  sendMentorMessageMock.mockReset()
  getMentorSessionStateMock.mockReset()
  getMentorJsonlPathMock.mockReset()
  process.env.MENTOR_SERVICE_TOKEN = TOKEN
})

// ── Auth matrix ────────────────────────────────────────────────────────────

describe('bridge auth matrix (localhost × token)', () => {
  it('localhost + valid token → 200', async () => {
    const res = await call('GET', '/api/internal/mentor/threads', { token: TOKEN })
    expect(res.status).toBe(200)
    expect((res.json as { threads: unknown[] }).threads).toEqual([])
  })

  it('localhost + missing token → 401', async () => {
    const res = await call('GET', '/api/internal/mentor/threads', { token: null })
    expect(res.status).toBe(401)
  })

  it('localhost + wrong token → 401', async () => {
    const res = await call('GET', '/api/internal/mentor/threads', { token: 'nope' })
    expect(res.status).toBe(401)
  })

  it('non-localhost (external X-Forwarded-For) → 403, even with a valid token', async () => {
    const res = await call('GET', '/api/internal/mentor/threads', { token: TOKEN, forwardedFor: '203.0.113.7' })
    expect(res.status).toBe(403)
  })

  it('fails closed (401) when MENTOR_SERVICE_TOKEN is unset', async () => {
    delete process.env.MENTOR_SERVICE_TOKEN
    const res = await call('GET', '/api/internal/mentor/threads', { token: TOKEN })
    expect(res.status).toBe(401)
  })
})

// ── Thread create ────────────────────────────────────────────────────────

describe('POST /mentor/threads — create owned by Mike', () => {
  it('applies defaults (title Telegram, workspace example, tag telegram) and sets created_by=mike', async () => {
    const res = await call('POST', '/api/internal/mentor/threads', { token: TOKEN, body: {} })
    expect(res.status).toBe(201)
    const t = (res.json as { thread: Record<string, unknown> }).thread
    expect(t.title).toBe('Telegram')
    expect(t.workspace).toBe('example')
    expect(t.tags).toEqual(['telegram'])
    expect(t.created_by).toBe(mikeId)
  })

  it('honors a supplied title/workspace and ensures the telegram tag is present', async () => {
    const res = await call('POST', '/api/internal/mentor/threads', {
      token: TOKEN,
      body: { title: 'Q3 planning', workspace: 'personal', tags: ['planning'] },
    })
    const t = (res.json as { thread: Record<string, unknown> }).thread
    expect(t.title).toBe('Q3 planning')
    expect(t.workspace).toBe('personal')
    expect(t.tags).toEqual(expect.arrayContaining(['telegram', 'planning']))
  })
})

// ── List ──────────────────────────────────────────────────────────────────

describe('GET /mentor/threads — owner-scoped list', () => {
  it("returns only Mike's threads, never a member's", async () => {
    const db = getDb()
    db.prepare("INSERT INTO mentor_threads (title, created_by, workspace) VALUES ('mine', ?, 'example')").run(mikeId)
    db.prepare("INSERT INTO mentor_threads (title, created_by, workspace) VALUES ('hers', ?, 'example')").run(aliceId)
    const res = await call('GET', '/api/internal/mentor/threads', { token: TOKEN })
    const titles = (res.json as { threads: Array<{ title: string }> }).threads.map(t => t.title)
    expect(titles).toEqual(['mine'])
  })

  it('excludes archived by default, includes with ?include_archived=1', async () => {
    const db = getDb()
    db.prepare("INSERT INTO mentor_threads (title, created_by, archived) VALUES ('open', ?, 0)").run(mikeId)
    db.prepare("INSERT INTO mentor_threads (title, created_by, archived) VALUES ('shut', ?, 1)").run(mikeId)
    const def = await call('GET', '/api/internal/mentor/threads', { token: TOKEN })
    expect((def.json as { threads: Array<{ title: string }> }).threads.map(t => t.title)).toEqual(['open'])
    const all = await call('GET', '/api/internal/mentor/threads?include_archived=1', { token: TOKEN })
    expect((all.json as { threads: Array<{ title: string }> }).threads.map(t => t.title).sort()).toEqual(['open', 'shut'])
  })
})

// ── Messages / output owner-scoping ─────────────────────────────────────────

describe('owner-scoping on :id routes', () => {
  it('POST messages on a foreign thread → 404 (no sendMentorMessage call)', async () => {
    const db = getDb()
    const id = db.prepare("INSERT INTO mentor_threads (title, created_by) VALUES ('hers', ?)").run(aliceId).lastInsertRowid as number
    const res = await call('POST', `/api/internal/mentor/threads/${id}/messages`, { token: TOKEN, body: { content: 'hi' } })
    expect(res.status).toBe(404)
    expect(sendMentorMessageMock).not.toHaveBeenCalled()
  })

  it('POST messages on a missing thread → 404', async () => {
    const res = await call('POST', '/api/internal/mentor/threads/999999/messages', { token: TOKEN, body: { content: 'hi' } })
    expect(res.status).toBe(404)
  })

  it("POST messages on Mike's thread → 202 with session_id + thread_id", async () => {
    const db = getDb()
    const id = db.prepare("INSERT INTO mentor_threads (title, created_by) VALUES ('mine', ?)").run(mikeId).lastInsertRowid as number
    sendMentorMessageMock.mockReturnValue('mentor-x-1')
    const res = await call('POST', `/api/internal/mentor/threads/${id}/messages`, { token: TOKEN, body: { content: 'hello' } })
    expect(res.status).toBe(202)
    expect(sendMentorMessageMock).toHaveBeenCalledWith(id, 'hello')
    expect(res.json).toEqual({ session_id: 'mentor-x-1', thread_id: id })
  })

  it('POST messages rejects empty content with 400', async () => {
    const db = getDb()
    const id = db.prepare("INSERT INTO mentor_threads (title, created_by) VALUES ('mine', ?)").run(mikeId).lastInsertRowid as number
    const res = await call('POST', `/api/internal/mentor/threads/${id}/messages`, { token: TOKEN, body: { content: '   ' } })
    expect(res.status).toBe(400)
    expect(sendMentorMessageMock).not.toHaveBeenCalled()
  })

  it('GET output on a foreign thread → 404', async () => {
    const db = getDb()
    const id = db.prepare("INSERT INTO mentor_threads (title, created_by) VALUES ('hers', ?)").run(aliceId).lastInsertRowid as number
    const res = await call('GET', `/api/internal/mentor/threads/${id}/output`, { token: TOKEN })
    expect(res.status).toBe(404)
  })

  it("GET output on Mike's thread → 200 with state + messages + last_active_at", async () => {
    const db = getDb()
    const id = db.prepare("INSERT INTO mentor_threads (title, created_by, last_active_at) VALUES ('mine', ?, '2026-06-14T00:00:00Z')").run(mikeId).lastInsertRowid as number
    const tmpJsonl = path.join(os.tmpdir(), `bridge-out-${Date.now()}.jsonl`)
    fs.writeFileSync(tmpJsonl, [
      JSON.stringify({ type: 'prompt', text: 'hi', timestamp: '2026-06-14T00:00:00Z' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'reply' }] }, timestamp: '2026-06-14T00:00:01Z' }),
    ].join('\n'))
    getMentorJsonlPathMock.mockReturnValue(tmpJsonl)
    getMentorSessionStateMock.mockReturnValue('review')
    const res = await call('GET', `/api/internal/mentor/threads/${id}/output`, { token: TOKEN })
    expect(res.status).toBe(200)
    const body = res.json as { state: string; messages: Array<{ type: string; text?: string }>; last_active_at: string }
    expect(body.state).toBe('review')
    expect(body.last_active_at).toBe('2026-06-14T00:00:00Z')
    expect(body.messages.find(m => m.type === 'assistant')?.text).toBe('reply')
    fs.unlinkSync(tmpJsonl)
  })

  it('GET output respects ?tail=N', async () => {
    const db = getDb()
    const id = db.prepare("INSERT INTO mentor_threads (title, created_by) VALUES ('mine', ?)").run(mikeId).lastInsertRowid as number
    const tmpJsonl = path.join(os.tmpdir(), `bridge-tail-${Date.now()}.jsonl`)
    fs.writeFileSync(tmpJsonl, [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'one' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'two' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'three' }] } }),
    ].join('\n'))
    getMentorJsonlPathMock.mockReturnValue(tmpJsonl)
    getMentorSessionStateMock.mockReturnValue('review')
    const res = await call('GET', `/api/internal/mentor/threads/${id}/output?tail=1`, { token: TOKEN })
    const body = res.json as { messages: Array<{ text?: string }> }
    expect(body.messages).toHaveLength(1)
    expect(body.messages[0].text).toBe('three')
    fs.unlinkSync(tmpJsonl)
  })
})
