/**
 * Owner isolation at the HTTP surface (obj 900089).
 *
 * The service-level proof lives in services/connector-isolation.test.ts. This
 * one is about the doors: can a request — as an ordinary user, as an admin, or
 * with an admin's legacy full-access key — route a card to somebody else so the
 * session runs as them, or read their connection through any route we expose?
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

const TMP_DB = path.join(os.tmpdir(), `cc-connector-api-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-connector-isolation-api'
process.env.TEST_CRED_ENCRYPTION_KEY = Buffer.alloc(32, 13).toString('base64')
process.env.SECRETS_MASTER_KEY = Buffer.alloc(32, 14).toString('base64')

const { initDb, getDb } = await import('../db/index.js')
const { default: authRouter } = await import('./auth.js')
const { default: objectivesRouter } = await import('./objectives.js')
const { default: githubTokenRouter } = await import('./user-github-token.js')
const { agentKeyGuard } = await import('../middleware/agent-key-guard.js')
const github = await import('../services/user-github-tokens.js')
const { mintApiKey, hashApiKey } = await import('../lib/api-keys.js')

const USER_A = 201
const USER_B = 202
const ADMIN = 203
const B_PAT = 'github_pat_11BBBB_user_b_secret_api_0002'

let server: http.Server
let baseUrl: string
let adminLegacyKey = ''

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

function cookieFor(id: number, username: string, role: 'admin' | 'member'): string {
  return `token=${jwt.sign({ id, username, role }, process.env.JWT_SECRET as string, { expiresIn: '1h' })}`
}

async function call(
  method: string,
  p: string,
  opts: { as?: { id: number; username: string; role: 'admin' | 'member' }; bearer?: string; body?: unknown } = {},
) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.bearer) headers.Authorization = `Bearer ${opts.bearer}`
  else if (opts.as) headers.Cookie = cookieFor(opts.as.id, opts.as.username, opts.as.role)
  const res = await fetch(`${baseUrl}${p}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  const text = await res.text()
  let json: unknown = null
  try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, json: json as Loose, text }
}

const AS_A = { id: USER_A, username: 'user-a', role: 'member' as const }
const AS_B = { id: USER_B, username: 'user-b', role: 'member' as const }
const AS_ADMIN = { id: ADMIN, username: 'admin-user', role: 'admin' as const }

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  for (const [id, username, role] of [[USER_A, 'user-a', 'member'], [USER_B, 'user-b', 'member'], [ADMIN, 'admin-user', 'admin']] as const) {
    db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, 'x', ?)`).run(id, username, role)
  }
  for (const [id, ws] of [[USER_A, 'main'], [USER_B, 'main'], [ADMIN, 'main']] as const) {
    db.prepare(`INSERT OR IGNORE INTO user_workspaces (user_id, workspace) VALUES (?, ?)`).run(id, ws)
  }
  // The legacy, full-access per-user key the admin may still hold.
  adminLegacyKey = mintApiKey()
  db.prepare('UPDATE users SET api_token_hash = ? WHERE id = ?').run(hashApiKey(adminLegacyKey), ADMIN)

  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use(agentKeyGuard)
  app.use('/api/auth', authRouter)
  app.use('/api/objectives', objectivesRouter)
  app.use('/api/user/github-token', githubTokenRouter)
  await new Promise<void>(r => { server = app.listen(0, '127.0.0.1', () => r()) })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no address')
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  await new Promise<void>(r => server.close(() => r()))
  try { getDb().close() } catch { /* already closed */ }
  for (const s of ['', '-wal', '-shm']) {
    const f = `${TMP_DB}${s}`
    if (fs.existsSync(f)) fs.unlinkSync(f)
  }
})

beforeEach(() => {
  getDb().exec('DELETE FROM objectives; DELETE FROM objective_assignees; DELETE FROM user_github_tokens; DELETE FROM agent_api_keys;')
})

// ── Assignment is not an impersonation primitive ────────────────────────────

describe('who a card may be assigned to', () => {
  it('refuses a non-admin naming somebody else on create', async () => {
    const r = await call('POST', '/api/objectives', {
      as: AS_A,
      body: { title: 'work for someone else', workspace: 'main', assigned_user_id: USER_B },
    })
    expect(r.status).toBe(403)
    expect(String(r.json.error)).toMatch(/only assign/i)
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM objectives').get()).toEqual({ n: 0 })
  })

  it('refuses the same thing through the multi-assign array, and through a mixed list', async () => {
    expect((await call('POST', '/api/objectives', {
      as: AS_A, body: { title: 'x', workspace: 'main', assigned_user_ids: [USER_B] },
    })).status).toBe(403)
    // Naming yourself does not launder naming somebody else too.
    expect((await call('POST', '/api/objectives', {
      as: AS_A, body: { title: 'x', workspace: 'main', assigned_user_ids: [USER_A, USER_B] },
    })).status).toBe(403)
  })

  it('lets a non-admin assign to themselves', async () => {
    const r = await call('POST', '/api/objectives', {
      as: AS_A, body: { title: 'my own work', workspace: 'main', assigned_user_id: USER_A },
    })
    expect(r.status).toBe(201)
    expect(r.json.assigned_user_id).toBe(USER_A)
  })

  it('refuses a non-admin re-assigning an existing card to somebody else', async () => {
    const created = await call('POST', '/api/objectives', {
      as: AS_A, body: { title: 'mine', workspace: 'main' },
    })
    expect(created.status).toBe(201)
    const r = await call('PUT', `/api/objectives/${created.json.id}`, {
      as: AS_A, body: { assigned_user_id: USER_B },
    })
    expect(r.status).toBe(403)
    const row = getDb().prepare('SELECT assigned_user_id FROM objectives WHERE id = ?').get(created.json.id) as { assigned_user_id: number }
    expect(row.assigned_user_id).toBe(USER_A)
  })

  it('lets an admin route work to another person — that is ordinary', async () => {
    const r = await call('POST', '/api/objectives', {
      as: AS_ADMIN, body: { title: 'routed work', workspace: 'main', assigned_user_id: USER_B },
    })
    expect(r.status).toBe(201)
    expect(r.json.assigned_user_id).toBe(USER_B)
  })

  it('and the legacy full-access key cannot do what its owner could not', async () => {
    // The admin's legacy key IS the admin, so routing is allowed here too — the
    // containment is that the resulting session gets no credential of B's
    // (services/connector-isolation.test.ts). What must NOT happen is a
    // non-admin key gaining admin routing, which requireAdmin already blocks.
    const r = await call('POST', '/api/objectives', {
      bearer: adminLegacyKey, body: { title: 'routed by key', workspace: 'main', assigned_user_id: USER_B },
    })
    expect(r.status).toBe(201)
    const spawnOwner = getDb().prepare('SELECT assigned_user_id, created_by FROM objectives WHERE id = ?')
      .get(r.json.id) as { assigned_user_id: number; created_by: number }
    // The card records that somebody else routed it, which is precisely what
    // makes the spawn withhold B's connectors.
    expect(spawnOwner.assigned_user_id).toBe(USER_B)
    expect(spawnOwner.created_by).toBe(ADMIN)
  })
})

// ── No route hands one person another person's credential ───────────────────

describe('reading a connection through the API', () => {
  beforeEach(() => {
    github.upsert(USER_B, {
      rawToken: B_PAT,
      login: 'user-b',
      githubUserId: USER_B,
      email: 'user-b@users.noreply.github.test',
      scopes: null,
      tokenType: 'pat_fine',
    })
  })

  it('answers every caller with THEIR row, never a named other person\'s', async () => {
    // B sees their own masked summary — and even that has no token in it.
    const mine = await call('GET', '/api/user/github-token', { as: AS_B })
    expect(mine.status).toBe(200)
    expect(mine.json?.github_login).toBe('user-b')
    expect(mine.text).not.toContain(B_PAT)

    // A and the admin see their own absence, not B's connection.
    for (const who of [AS_A, AS_ADMIN]) {
      const r = await call('GET', '/api/user/github-token', { as: who })
      expect(r.status).toBe(200)
      expect(r.json).toBeNull()
      expect(r.text).not.toContain(B_PAT)
    }
  })

  it('ignores an attempt to name the user in the request', async () => {
    for (const q of [`?user_id=${USER_B}`, `?userId=${USER_B}`]) {
      const r = await call('GET', `/api/user/github-token${q}`, { as: AS_ADMIN })
      expect(r.json).toBeNull()
      expect(r.text).not.toContain(B_PAT)
    }
    const posted = await call('POST', '/api/user/github-token/validate', { as: AS_ADMIN, body: { user_id: USER_B } })
    expect(posted.status).toBe(404)
    expect(posted.text).not.toContain(B_PAT)
  })

  it("does not let the admin's legacy full-access key read it either", async () => {
    const r = await call('GET', '/api/user/github-token', { bearer: adminLegacyKey })
    expect(r.status).toBe(200)
    expect(r.json).toBeNull()
    expect(r.text).not.toContain(B_PAT)
  })
})

// ── Managing a key's connector list ─────────────────────────────────────────

describe('agent-key connector allow-list over HTTP', () => {
  it('creates with none, is narrowed by its owner, and never echoes a token', async () => {
    const created = await call('POST', '/api/auth/agent-keys', { as: AS_A, body: { label: 'reporting bot' } })
    expect(created.status).toBe(201)
    expect(created.json.connectors).toEqual([])

    const patched = await call('PATCH', `/api/auth/agent-keys/${created.json.id}`, {
      as: AS_A, body: { connectors: ['github'] },
    })
    expect(patched.status).toBe(200)
    expect(patched.json.connectors).toEqual(['github'])
    // The issued token is shown exactly once, at creation, and never again.
    expect(patched.text).not.toContain(created.json.token)

    const listed = await call('GET', '/api/auth/agent-keys', { as: AS_A })
    expect(listed.json.keys[0].connectors).toEqual(['github'])
    expect(listed.text).not.toContain(created.json.token)
  })

  it("will not let another member edit a key that is not theirs", async () => {
    const created = await call('POST', '/api/auth/agent-keys', { as: AS_A, body: { label: 'a key' } })
    const r = await call('PATCH', `/api/auth/agent-keys/${created.json.id}`, {
      as: AS_B, body: { connectors: ['github'] },
    })
    expect(r.status).toBe(404)
  })

  it('lets an admin administer any key', async () => {
    const created = await call('POST', '/api/auth/agent-keys', { as: AS_A, body: { label: 'a key' } })
    const r = await call('PATCH', `/api/auth/agent-keys/${created.json.id}`, {
      as: AS_ADMIN, body: { connectors: [] },
    })
    expect(r.status).toBe(200)
    expect(r.json.connectors).toEqual([])
  })

  it('cannot be used by an agent key to widen itself', async () => {
    const created = await call('POST', '/api/auth/agent-keys', { as: AS_A, body: { label: 'bootstrap' } })
    const r = await call('PATCH', `/api/auth/agent-keys/${created.json.id}`, {
      bearer: created.json.token, body: { connectors: ['github', 'google-workspace'] },
    })
    expect(r.status).toBe(403)
    const after = await call('GET', '/api/auth/agent-keys', { as: AS_A })
    expect(after.json.keys[0].connectors).toEqual([])
  })
})
