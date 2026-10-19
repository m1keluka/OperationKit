import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

// Real SQLite + a real Express server (mirrors routes/mentor.test.ts). Exercises
// the /api/assistant/config auth gate (requireAuth + requireAssistantAccess),
// req.user scoping, and the PUT→GET round-trip.
const TMP_DB = path.join(os.tmpdir(), `cc-assistant-route-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-assistant'

const { initDb, getDb } = await import('../db/index.js')
const { default: assistantRouter } = await import('./assistant.js')

let server: http.Server
let baseUrl: string

const ADMIN_ID = 1
const MEMBER_ID = 2

function makeApp(): express.Express {
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/assistant', assistantRouter)
  return app
}

function tokenFor(id: number, role: 'admin' | 'member'): string {
  return jwt.sign({ id, username: `u${id}`, role }, process.env.JWT_SECRET as string, { expiresIn: '1h' })
}

async function call(method: string, pathname: string, opts: { cookie?: string; body?: unknown } = {}): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.cookie) headers.Cookie = opts.cookie
  const res = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : null }
}

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (?, 'admin', '', 'admin')").run(ADMIN_ID)
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (?, 'nobody', '', 'member')").run(MEMBER_ID)
  // MEMBER_ID has NO can_use_assistant membership → requireAssistantAccess must 403.

  const app = makeApp()
  await new Promise<void>(resolve => { server = app.listen(0, () => resolve()) })
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

describe('GET/PUT /api/assistant/config — authz', () => {
  it('401 when unauthenticated', async () => {
    const { status } = await call('GET', '/api/assistant/config')
    expect(status).toBe(401)
  })

  it('403 for a member with no assistant access', async () => {
    const { status } = await call('GET', '/api/assistant/config', { cookie: `token=${tokenFor(MEMBER_ID, 'member')}` })
    expect(status).toBe(403)
  })

  it('403 also blocks PUT for a no-assistant member', async () => {
    const { status } = await call('PUT', '/api/assistant/config', {
      cookie: `token=${tokenFor(MEMBER_ID, 'member')}`,
      body: { persona: { displayName: 'Sneaky', systemPrompt: 'x' } },
    })
    expect(status).toBe(403)
  })
})

describe('GET/PUT /api/assistant/config — happy path round-trip', () => {
  const adminCookie = `token=${tokenFor(ADMIN_ID, 'admin')}`

  it('GET create-on-reads a default config scoped to the caller', async () => {
    const { status, json } = await call('GET', '/api/assistant/config', { cookie: adminCookie })
    expect(status).toBe(200)
    expect(json.userId).toBe(ADMIN_ID)
    expect(json.persona.displayName).toBe('Assistant')
    expect(json.enabled).toBe(true)
    expect(json.autonomy.level).toBe('confirm_external')
  })

  it('PUT merges a partial patch and returns the full updated config', async () => {
    const { status, json } = await call('PUT', '/api/assistant/config', {
      cookie: adminCookie,
      body: {
        persona: { displayName: 'Ada', tagline: 'ops', systemPrompt: 'You are Ada.' },
        enabledConnectors: ['google-workspace'],
        autonomy: { level: 'confirm_all' },
      },
    })
    expect(status).toBe(200)
    expect(json.userId).toBe(ADMIN_ID)
    expect(json.persona.displayName).toBe('Ada')
    expect(json.persona.tagline).toBe('ops')
    expect(json.enabledConnectors).toEqual(['google-workspace'])
    expect(json.autonomy.level).toBe('confirm_all')
  })

  it('GET after PUT returns the persisted update (round-trip)', async () => {
    const { json } = await call('GET', '/api/assistant/config', { cookie: adminCookie })
    expect(json.persona.displayName).toBe('Ada')
    expect(json.autonomy.level).toBe('confirm_all')
    expect(json.enabledConnectors).toEqual(['google-workspace'])
  })

  it('a partial PUT preserves unspecified fields', async () => {
    const { json } = await call('PUT', '/api/assistant/config', { cookie: adminCookie, body: { enabled: false } })
    expect(json.enabled).toBe(false)
    expect(json.persona.displayName).toBe('Ada') // unchanged
    expect(json.autonomy.level).toBe('confirm_all') // unchanged
  })
})
