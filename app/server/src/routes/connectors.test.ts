import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'
import type { ConnectorSummary } from '@operationkit/shared'

// Encryption key + isolated DB + JWT secret BEFORE importing modules.
process.env.TEST_CRED_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64')
process.env.JWT_SECRET = 'test-secret-connectors-route'
const TMP_DB = path.join(os.tmpdir(), `cc-connectors-route-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
delete process.env.GOOGLE_OAUTH_CLIENT_ID
delete process.env.GOOGLE_OAUTH_CLIENT_SECRET

const { initDb, getDb } = await import('../db/index.js')
const { default: router } = await import('./connectors.js')
const { __setFetchForTests } = await import('../services/user-github-tokens.js')
const { isConnectorAllowed } = await import('../connectors/access.js')
const { __loadConnectorsFrom, listConnectors } = await import('../connectors/registry.js')

let server: http.Server
let baseUrl: string

const RAW_PAT = 'github_pat_11ABCDEsecret_value_conn42'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function installFakeGithub() {
  __setFetchForTests(async (url: string, init?: RequestInit) => {
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization || ''
    if (url === 'https://api.github.com/user') {
      if (!auth.includes(RAW_PAT)) return jsonResponse(401, { message: 'Bad credentials' })
      return jsonResponse(200, { login: 'octo-dev', id: 4242 })
    }
    if (url === 'https://api.github.com/user/emails') {
      return jsonResponse(200, [{ email: 'octo@example.com', primary: true, verified: true }])
    }
    return jsonResponse(500, { error: 'unexpected ' + url })
  })
}

const COOKIE = `token=${jwt.sign({ id: 20, username: 'owner', role: 'member' }, process.env.JWT_SECRET as string, { expiresIn: '1h' })}`

async function call(method: string, p: string, body?: unknown, cookie: string | null = COOKIE) {
  const res = await fetch(`${baseUrl}/api/connectors${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: res.status, json, text }
}

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  getDb().prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (20, 'owner', 'x', 'member')`).run()
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/connectors', router)
  await new Promise<void>(resolve => { server = app.listen(0, () => resolve()) })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no address')
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  __setFetchForTests(null)
  await new Promise<void>(resolve => server.close(() => resolve()))
  try { getDb().close() } catch {}
  for (const s of ['', '-wal', '-shm']) { const f = `${TMP_DB}${s}`; if (fs.existsSync(f)) fs.unlinkSync(f) }
})

beforeEach(() => {
  getDb().exec('DELETE FROM user_github_tokens')
  try { getDb().exec('DELETE FROM connector_access') } catch { /* created lazily */ }
  installFakeGithub()
})

describe('connectors routes', () => {
  it('needs a signed-in person', async () => {
    expect((await call('GET', '/', undefined, null)).status).toBe(401)
    expect((await call('POST', '/github/connect', { fields: { token: RAW_PAT } }, null)).status).toBe(401)
  })

  it('lists GitHub and Google Workspace (Gmail, Calendar, Drive), not connected', async () => {
    const { status, json } = await call('GET', '/')
    expect(status).toBe(200)
    const list = json as ConnectorSummary[]
    expect(list.map(c => c.id)).toEqual(['github', 'google-workspace'])
    const google = list.find(c => c.id === 'google-workspace')!
    expect(google.products.map(p => p.name)).toEqual(['Gmail', 'Calendar', 'Drive'])
    expect(google.available).toBe(false) // no OAuth client in this env
    expect(google.unavailable_reason).toMatch(/not set up/)
    for (const c of list) {
      expect(c.status.state).toBe('not_connected')
      expect(c.access).toEqual({ agents: null, workspaces: null })
    }
  })

  it('connects GitHub with a token and never sends the token back', async () => {
    const bad = await call('POST', '/github/connect', { fields: { token: 'ghp_wrong' } })
    expect(bad.status).toBe(400)

    const ok = await call('POST', '/github/connect', { fields: { token: RAW_PAT } })
    expect(ok.status).toBe(200)
    expect(ok.json.status.state).toBe('connected')
    expect(ok.json.status.account).toBe('octo-dev')
    expect(ok.text).not.toContain(RAW_PAT)

    const list = await call('GET', '/')
    expect(list.text).not.toContain(RAW_PAT)
    expect(list.text).toContain('••••')

    // Stored encrypted in the same table the old GitHub card used.
    const row = getDb().prepare('SELECT token_encrypted FROM user_github_tokens WHERE user_id = 20').get() as { token_encrypted: string }
    expect(row.token_encrypted).not.toContain(RAW_PAT)

    const checked = await call('POST', '/github/check')
    expect(checked.status).toBe(200)
    expect(checked.json.status.state).toBe('connected')

    const gone = await call('DELETE', '/github')
    expect(gone.status).toBe(200)
    expect(gone.json.status.state).toBe('not_connected')
  })

  it('refuses to start Google sign-in when the server is not set up for it', async () => {
    const r = await call('POST', '/google-workspace/connect', {})
    expect(r.status).toBe(503)
  })

  it('starts Google sign-in when the server is set up for it', async () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'client-id-test'
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'client-secret-test'
    try {
      const r = await call('POST', '/google-workspace/connect', {})
      expect(r.status).toBe(200)
      expect(r.json.redirect_url).toMatch(/^https:\/\/accounts\.google\.com\//)
      expect(r.text).not.toContain('client-secret-test')
    } finally {
      delete process.env.GOOGLE_OAUTH_CLIENT_ID
      delete process.env.GOOGLE_OAUTH_CLIENT_SECRET
    }
  })

  it('saves access rules and the spawn check honours them', async () => {
    expect(isConnectorAllowed('github', 20, { agent: 'operator', workspace: 'main' })).toBe(true)

    const bad = await call('PUT', '/github/access', { agents: 'operator' })
    expect(bad.status).toBe(400)

    const r = await call('PUT', '/github/access', { agents: ['operator'], workspaces: ['main'] })
    expect(r.status).toBe(200)
    expect(r.json.access).toEqual({ agents: ['operator'], workspaces: ['main'] })

    expect(isConnectorAllowed('github', 20, { agent: 'operator', workspace: 'main' })).toBe(true)
    expect(isConnectorAllowed('github', 20, { agent: 'librarian', workspace: 'main' })).toBe(false)
    expect(isConnectorAllowed('github', 20, { agent: 'operator', workspace: 'other' })).toBe(false)
    // Rules are per connector and per person.
    expect(isConnectorAllowed('google-workspace', 20, { agent: 'librarian', workspace: 'other' })).toBe(true)
    expect(isConnectorAllowed('github', 99, { agent: 'librarian', workspace: 'other' })).toBe(true)

    const reset = await call('PUT', '/github/access', { agents: null, workspaces: null })
    expect(reset.json.access).toEqual({ agents: null, workspaces: null })
    expect(isConnectorAllowed('github', 20, { agent: 'librarian', workspace: 'other' })).toBe(true)
  })

  it('an empty list means no agent gets it', async () => {
    await call('PUT', '/github/access', { agents: [] })
    expect(isConnectorAllowed('github', 20, { agent: 'operator', workspace: 'main' })).toBe(false)
  })

  it('404s an unknown connector', async () => {
    expect((await call('POST', '/nope/connect', {})).status).toBe(404)
    expect((await call('DELETE', '/nope')).status).toBe(404)
  })
})

describe('connector registry', () => {
  it('picks up a new connector from a single file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cc-connector-defs-${process.pid}-`))
    fs.writeFileSync(
      path.join(dir, 'slack.mjs'),
      `export default {
        id: 'slack', name: 'Slack', description: 'Post to channels.',
        connect: { kind: 'token', fields: [{ key: 'token', label: 'Bot token', secret: true }] },
        status: () => ({ state: 'not_connected', account: null, details: [], connected_at: null, checked_at: null, error: null }),
        disconnect: async () => {},
      }\n`,
    )
    fs.writeFileSync(path.join(dir, 'not-a-connector.mjs'), 'export default { hello: 1 }\n')
    fs.writeFileSync(path.join(dir, 'slack.test.mjs'), 'throw new Error("tests are never loaded")\n')
    try {
      const defs = await __loadConnectorsFrom(dir)
      expect(defs.map(d => d.id)).toEqual(['slack'])
    } finally {
      await __loadConnectorsFrom(null)
      fs.rmSync(dir, { recursive: true, force: true })
    }
    expect((await listConnectors()).map(d => d.id)).toEqual(['github', 'google-workspace'])
  })
})
