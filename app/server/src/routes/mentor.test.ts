import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

// ---- Test bootstrapping ----------------------------------------------------
// Mentor routes are now backed by a Claude Code subprocess (see services/
// mentor-session.ts), so the tests mock that service rather than LiteLLM.
// SQLite is real so the schema migration (mentor_messages dropped, account_id
// + session_id + last_active_at added to mentor_threads) gets exercised.

const TMP_DB = path.join(os.tmpdir(), `cc-mentor-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-mentor'

const startMentorSessionMock = vi.fn()
const sendMentorMessageMock = vi.fn()
const stopMentorSessionMock = vi.fn()
const getMentorSessionStateMock = vi.fn()
const getMentorJsonlPathMock = vi.fn()

vi.mock('../services/mentor-session.js', () => ({
  startMentorSession: (...args: unknown[]) => startMentorSessionMock(...args),
  sendMentorMessage: (...args: unknown[]) => sendMentorMessageMock(...args),
  stopMentorSession: (...args: unknown[]) => stopMentorSessionMock(...args),
  getMentorSessionState: (...args: unknown[]) => getMentorSessionStateMock(...args),
  getMentorJsonlPath: (...args: unknown[]) => getMentorJsonlPathMock(...args),
}))

const { initDb, getDb } = await import('../db/index.js')
const { default: mentorRouter } = await import('./mentor.js')

let server: http.Server
let baseUrl: string
let cookie: string
let tmpJsonl: string

function makeApp(): express.Express {
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/mentor', mentorRouter)
  return app
}

function authToken(): string {
  return jwt.sign({ id: 1, username: 'tester', role: 'admin' }, process.env.JWT_SECRET as string, { expiresIn: '1h' })
}

async function call(method: string, pathname: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
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

  // The auth token signs user id=1 — insert a matching row so FK constraints
  // (mentor_threads.created_by → users.id) pass.
  getDb()
    .prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'tester', '', 'admin')")
    .run()

  tmpJsonl = path.join(os.tmpdir(), `cc-mentor-jsonl-${process.pid}-${Date.now()}.jsonl`)

  const app = makeApp()
  await new Promise<void>(resolve => {
    server = app.listen(0, () => resolve())
  })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('server has no address')
  baseUrl = `http://127.0.0.1:${addr.port}`
  cookie = `token=${authToken()}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  try { getDb().close() } catch {}
  for (const suffix of ['', '-wal', '-shm']) {
    const f = `${TMP_DB}${suffix}`
    if (fs.existsSync(f)) fs.unlinkSync(f)
  }
  if (fs.existsSync(tmpJsonl)) fs.unlinkSync(tmpJsonl)
})

beforeEach(() => {
  getDb().exec('DELETE FROM mentor_threads; DELETE FROM mentor_summaries;')
  startMentorSessionMock.mockReset()
  sendMentorMessageMock.mockReset()
  stopMentorSessionMock.mockReset()
  getMentorSessionStateMock.mockReset()
  getMentorJsonlPathMock.mockReset()
})

// ---- Auth ------------------------------------------------------------------

describe('mentor routes — auth', () => {
  it('rejects requests without an auth cookie', async () => {
    const res = await fetch(`${baseUrl}/api/mentor/threads`)
    expect(res.status).toBe(401)
  })
})

// ---- Threads CRUD ----------------------------------------------------------

describe('mentor routes — threads CRUD', () => {
  it('POST /threads creates a thread with defaults', async () => {
    const res = await call('POST', '/api/mentor/threads', {})
    expect(res.status).toBe(201)
    const t = res.json as Record<string, unknown>
    expect(t.title).toBe('Untitled')
    expect(t.tags).toEqual([])
    expect(t.pinned).toBe(false)
    expect(t.archived).toBe(false)
    expect(t.account_id).toBeNull()
    expect(t.session_id).toBeNull()
    expect(typeof t.id).toBe('number')
  })

  it('POST /threads accepts title and tags', async () => {
    const res = await call('POST', '/api/mentor/threads', {
      title: 'Pricing strategy',
      tags: ['pricing', 'positioning'],
    })
    expect(res.status).toBe(201)
    const t = res.json as Record<string, unknown>
    expect(t.title).toBe('Pricing strategy')
    expect(t.tags).toEqual(['pricing', 'positioning'])
  })

  it('GET /threads excludes archived by default and includes them with ?include_archived=1', async () => {
    const a = (await call('POST', '/api/mentor/threads', { title: 'A' })).json as { id: number }
    const b = (await call('POST', '/api/mentor/threads', { title: 'B' })).json as { id: number }
    await call('PATCH', `/api/mentor/threads/${b.id}`, { archived: true })

    const visible = await call('GET', '/api/mentor/threads')
    expect(visible.status).toBe(200)
    const visibleIds = (visible.json as Array<{ id: number }>).map(t => t.id)
    expect(visibleIds).toContain(a.id)
    expect(visibleIds).not.toContain(b.id)

    const all = await call('GET', '/api/mentor/threads?include_archived=1')
    const allIds = (all.json as Array<{ id: number }>).map(t => t.id)
    expect(allIds).toContain(a.id)
    expect(allIds).toContain(b.id)
  })

  it('GET /threads orders pinned first', async () => {
    const t1 = (await call('POST', '/api/mentor/threads', { title: 'first' })).json as { id: number }
    const t2 = (await call('POST', '/api/mentor/threads', { title: 'second' })).json as { id: number }
    const t3 = (await call('POST', '/api/mentor/threads', { title: 'third' })).json as { id: number }
    await call('PATCH', `/api/mentor/threads/${t1.id}`, { pinned: true })

    const list = (await call('GET', '/api/mentor/threads')).json as Array<{ id: number; pinned: boolean }>
    expect(list[0].id).toBe(t1.id)
    expect(list[0].pinned).toBe(true)
    const tail = list.slice(1).map(t => t.id)
    expect(tail).toEqual(expect.arrayContaining([t2.id, t3.id]))
  })

  it('PATCH /threads/:id updates fields independently', async () => {
    const t = (await call('POST', '/api/mentor/threads', { title: 'orig' })).json as { id: number }

    const renamed = await call('PATCH', `/api/mentor/threads/${t.id}`, { title: 'new-name' })
    expect((renamed.json as Record<string, unknown>).title).toBe('new-name')

    const tagged = await call('PATCH', `/api/mentor/threads/${t.id}`, { tags: ['x', 'y'] })
    expect((tagged.json as Record<string, unknown>).tags).toEqual(['x', 'y'])

    const pinned = await call('PATCH', `/api/mentor/threads/${t.id}`, { pinned: true })
    expect((pinned.json as Record<string, unknown>).pinned).toBe(true)

    const archived = await call('PATCH', `/api/mentor/threads/${t.id}`, { archived: true })
    expect((archived.json as Record<string, unknown>).archived).toBe(true)
  })

  it('PATCH /threads/:id rejects empty title', async () => {
    const t = (await call('POST', '/api/mentor/threads', { title: 'x' })).json as { id: number }
    const res = await call('PATCH', `/api/mentor/threads/${t.id}`, { title: '   ' })
    expect(res.status).toBe(400)
  })

  it('PATCH /threads/:id returns 404 for unknown id', async () => {
    const res = await call('PATCH', '/api/mentor/threads/99999', { title: 'no' })
    expect(res.status).toBe(404)
  })

  it('DELETE /threads/:id stops the session and returns 204', async () => {
    const t = (await call('POST', '/api/mentor/threads', { title: 'doomed' })).json as { id: number }
    const res = await call('DELETE', `/api/mentor/threads/${t.id}`)
    expect(res.status).toBe(204)
    expect(stopMentorSessionMock).toHaveBeenCalledWith(t.id)
  })

  it('DELETE /threads/:id returns 404 for unknown id', async () => {
    const res = await call('DELETE', '/api/mentor/threads/99999')
    expect(res.status).toBe(404)
  })
})

// ---- Output ---------------------------------------------------------------

describe('mentor routes — output', () => {
  it('GET /threads/:id/output returns thread + state + parsed messages', async () => {
    const t = (await call('POST', '/api/mentor/threads', { title: 't' })).json as { id: number }

    fs.writeFileSync(tmpJsonl, [
      JSON.stringify({ type: 'prompt', text: 'hi mentor', timestamp: '2026-04-25T19:00:00Z' }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'hello back' }] },
        timestamp: '2026-04-25T19:00:01Z',
      }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: 'done',
        total_cost_usd: 0.0001,
        duration_ms: 1500,
        timestamp: '2026-04-25T19:00:02Z',
      }),
    ].join('\n'))

    getMentorJsonlPathMock.mockReturnValue(tmpJsonl)
    getMentorSessionStateMock.mockReturnValue('review')

    const res = await call('GET', `/api/mentor/threads/${t.id}/output`)
    expect(res.status).toBe(200)
    const body = res.json as { thread: { id: number }; state: string; messages: Array<{ type: string; text?: string }> }
    expect(body.thread.id).toBe(t.id)
    expect(body.state).toBe('review')
    expect(body.messages.find(m => m.type === 'followup')?.text).toBe('hi mentor')
    expect(body.messages.find(m => m.type === 'assistant')?.text).toBe('hello back')
    expect(body.messages.find(m => m.type === 'result')?.text).toBe('done')
  })

  it('GET /threads/:id/output returns empty messages when no transcript exists', async () => {
    const t = (await call('POST', '/api/mentor/threads', { title: 't' })).json as { id: number }
    getMentorJsonlPathMock.mockReturnValue(null)
    getMentorSessionStateMock.mockReturnValue('idle')
    const res = await call('GET', `/api/mentor/threads/${t.id}/output`)
    expect(res.status).toBe(200)
    expect((res.json as { messages: unknown[] }).messages).toEqual([])
    expect((res.json as { state: string }).state).toBe('idle')
  })

  it('GET /threads/:id/output returns 404 for unknown thread', async () => {
    const res = await call('GET', '/api/mentor/threads/99999/output')
    expect(res.status).toBe(404)
  })
})

// ---- Messages -------------------------------------------------------------

describe('mentor routes — messages', () => {
  it('POST /threads/:id/messages calls sendMentorMessage and returns 202 with thread + session_id', async () => {
    const t = (await call('POST', '/api/mentor/threads', { title: 't' })).json as { id: number }
    sendMentorMessageMock.mockReturnValue('mentor-1-1234')

    const res = await call('POST', `/api/mentor/threads/${t.id}/messages`, { content: 'hi mentor' })
    expect(res.status).toBe(202)
    expect(sendMentorMessageMock).toHaveBeenCalledWith(t.id, 'hi mentor')

    const body = res.json as { thread: { id: number }; session_id: string }
    expect(body.thread.id).toBe(t.id)
    expect(body.session_id).toBe('mentor-1-1234')
  })

  it('POST /threads/:id/messages rejects empty content with 400', async () => {
    const t = (await call('POST', '/api/mentor/threads', { title: 't' })).json as { id: number }
    const res = await call('POST', `/api/mentor/threads/${t.id}/messages`, { content: '   ' })
    expect(res.status).toBe(400)
    expect(sendMentorMessageMock).not.toHaveBeenCalled()
  })

  it('POST /threads/:id/messages returns 502 when sendMentorMessage throws', async () => {
    const t = (await call('POST', '/api/mentor/threads', { title: 't' })).json as { id: number }
    sendMentorMessageMock.mockImplementation(() => { throw new Error('All Claude accounts are exhausted.') })
    const res = await call('POST', `/api/mentor/threads/${t.id}/messages`, { content: 'hi' })
    expect(res.status).toBe(502)
    expect((res.json as { error: string }).error).toMatch(/exhausted/)
  })

  it('POST /threads/:id/messages returns 404 for unknown thread', async () => {
    const res = await call('POST', '/api/mentor/threads/99999/messages', { content: 'x' })
    expect(res.status).toBe(404)
    expect(sendMentorMessageMock).not.toHaveBeenCalled()
  })
})

// ---- Stop -----------------------------------------------------------------

describe('mentor routes — stop', () => {
  it('POST /threads/:id/stop calls stopMentorSession and returns the thread', async () => {
    const t = (await call('POST', '/api/mentor/threads', { title: 't' })).json as { id: number }
    const res = await call('POST', `/api/mentor/threads/${t.id}/stop`)
    expect(res.status).toBe(200)
    expect(stopMentorSessionMock).toHaveBeenCalledWith(t.id)
    expect((res.json as { id: number }).id).toBe(t.id)
  })

  it('POST /threads/:id/stop returns 404 for unknown thread', async () => {
    const res = await call('POST', '/api/mentor/threads/99999/stop')
    expect(res.status).toBe(404)
  })
})
