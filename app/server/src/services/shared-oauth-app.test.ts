/**
 * Sprint 7.7 (obj 900511) — optional, opt-in shared third-party OAuth app.
 *
 * The headline property: with the toggle OFF (the default, and the state of
 * every fresh install) nothing about the `oauth_guided` path changes and no
 * shared app is ever contacted. Every test that asserts "default path" also
 * asserts zero network calls.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'
import type { ConnectorSummary } from '@operationkit/shared'

process.env.TEST_CRED_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64')
process.env.JWT_SECRET = 'test-secret-shared-oauth-app'
const TMP_DB = path.join(os.tmpdir(), `cc-shared-oauth-app-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.APP_BASE_URL = 'https://client-a.example.com'
for (const k of Object.keys(process.env)) {
  if (/_OAUTH_CLIENT_(ID|SECRET)$/.test(k) || /_SHARED_OAUTH_CLIENT_SECRET$/.test(k)) delete process.env[k]
}

const { initDb, getDb } = await import('../db/index.js')
const shared = await import('./shared-oauth-app.js')
const store = await import('./generic-connector-oauth.js')
const { listConnectors, getConnector } = await import('../connectors/registry.js')
const { default: connectorsRouter } = await import('../routes/connectors.js')
const { default: callbackRouter } = await import('../routes/connector-oauth-callback.js')

const SHARED_CFG = {
  enabled: true,
  issuer: 'https://auth.third-party.example',
  client_id: 'shared-client-123',
  redirect_uri: 'https://auth.third-party.example/relay/callback',
  provider_label: 'Example Auth Inc.',
}

const META = {
  issuer: 'https://auth.third-party.example',
  authorization_endpoint: 'https://auth.third-party.example/authorize',
  token_endpoint: 'https://auth.third-party.example/token',
}

let fetchMock: ReturnType<typeof vi.fn>
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}
function installFetch() {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === 'https://auth.third-party.example/.well-known/oauth-authorization-server') return json(200, META)
    if (url === META.token_endpoint && init?.method === 'POST') {
      return json(200, { access_token: 'tok-shared', refresh_token: 'rt-shared', expires_in: 3600, scope: 'chat:write' })
    }
    return json(500, { error: 'unexpected ' + url })
  })
  shared.__setSharedAppFetchForTests(fetchMock as never)
  store.__setFetchForTests(fetchMock as never)
}

let server: http.Server
let baseUrl: string
const ADMIN = `token=${jwt.sign({ id: 21, username: 'admin', role: 'admin' }, process.env.JWT_SECRET as string, { expiresIn: '1h' })}`
const MEMBER = `token=${jwt.sign({ id: 20, username: 'member', role: 'member' }, process.env.JWT_SECRET as string, { expiresIn: '1h' })}`

async function call(method: string, p: string, body?: unknown, cookie: string = ADMIN) {
  const res = await fetch(`${baseUrl}${p}`, {
    method,
    redirect: 'manual',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let j: any = null
  try { j = JSON.parse(text) } catch { /* not json */ }
  return { status: res.status, json: j, location: res.headers.get('location') }
}

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  getDb().prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (20, 'member', 'x', 'member'), (21, 'admin', 'x', 'admin')`).run()
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/connectors', connectorsRouter)
  app.use('/api/user/connector-oauth', callbackRouter)
  await new Promise<void>(resolve => { server = app.listen(0, () => resolve()) })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no address')
  baseUrl = `http://127.0.0.1:${addr.port}`
})

beforeEach(() => {
  getDb().exec(`DELETE FROM settings WHERE key = '${shared.SHARED_APP_SETTINGS_KEY}'; DELETE FROM connector_oauth_grants;`)
  delete process.env.SLACK_OAUTH_CLIENT_ID
  delete process.env.SLACK_OAUTH_CLIENT_SECRET
  installFetch()
})

afterAll(async () => {
  shared.__setSharedAppFetchForTests(null)
  store.__setFetchForTests(null)
  await new Promise<void>(resolve => server.close(() => resolve()))
  try { getDb().close() } catch {}
  for (const s of ['', '-wal', '-shm']) { const f = `${TMP_DB}${s}`; if (fs.existsSync(f)) fs.unlinkSync(f) }
})

describe('default path (toggle off) is unchanged', () => {
  it('a fresh install has no shared-app config at all — no settings row, null for every connector', async () => {
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(shared.SHARED_APP_SETTINGS_KEY)
    expect(row).toBeUndefined()
    for (const def of await listConnectors()) expect(shared.getSharedAppConfig(def.id)).toBeNull()
  })

  it('without an own app, every eligible connector stays "not set up" with the pre-7.7 reason and never calls out', async () => {
    const eligible = (await listConnectors()).filter(d => d.shared_app_eligible)
    expect(eligible.length).toBeGreaterThan(0)
    for (const def of eligible) {
      const avail = def.availability!()
      expect(avail.ok).toBe(false)
      if (!avail.ok) expect(avail.reason).toContain('_OAUTH_CLIENT_ID / _OAUTH_CLIENT_SECRET pair in Settings → Secrets')
      const out = await def.startOAuth!({ userId: 21 })
      expect(out).toEqual({ ok: false, error: `${def.name} is not set up on this server yet.` })
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('with an own app, startOAuth goes to the vendor with the install\'s own client id and redirect — no shared app contacted', async () => {
    process.env.SLACK_OAUTH_CLIENT_ID = 'own-slack-id'
    process.env.SLACK_OAUTH_CLIENT_SECRET = 'own-slack-secret'
    const slack = (await getConnector('slack'))!
    const out = await slack.startOAuth!({ userId: 21 })
    expect(out.ok).toBe(true)
    const url = new URL((out as { redirectUrl: string }).redirectUrl)
    expect(`${url.origin}${url.pathname}`).toBe(slack.oauth!.authorize_url)
    expect(url.searchParams.get('client_id')).toBe('own-slack-id')
    expect(url.searchParams.get('redirect_uri')).toBe('https://client-a.example.com/api/user/connector-oauth/slack/callback')
    expect(url.searchParams.get('code_challenge')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a saved but switched-off config behaves exactly like no config', async () => {
    shared.setSharedAppConfig('slack', { ...SHARED_CFG, enabled: false })
    const slack = (await getConnector('slack'))!
    expect(shared.getSharedAppConfig('slack')).toBeNull()
    expect(slack.availability!().ok).toBe(false)
    expect((await slack.startOAuth!({ userId: 21 })).ok).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('the install\'s own app wins even when the shared app is switched on', async () => {
    shared.setSharedAppConfig('slack', SHARED_CFG)
    process.env.SLACK_OAUTH_CLIENT_ID = 'own-slack-id'
    process.env.SLACK_OAUTH_CLIENT_SECRET = 'own-slack-secret'
    const out = await (await getConnector('slack'))!.startOAuth!({ userId: 21 })
    expect(new URL((out as { redirectUrl: string }).redirectUrl).searchParams.get('client_id')).toBe('own-slack-id')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('GET /api/connectors reports the shared app off, and null for connectors that may not use one', async () => {
    const r = await call('GET', '/api/connectors')
    expect(r.status).toBe(200)
    const list = r.json as ConnectorSummary[]
    const slack = list.find(c => c.id === 'slack')!
    expect(slack.shared_app).toMatchObject({ enabled: false, configured: false, issuer: null, client_id: null, redirect_uri: null })
    expect(slack.shared_app!.install_callback_uri).toBe('https://client-a.example.com/api/user/connector-oauth/slack/callback')
    for (const c of list.filter(c => c.auth_path !== 'oauth_guided')) expect(c.shared_app).toBeNull()
    expect(list.find(c => c.id === 'google-workspace')?.shared_app ?? null).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('no built-in shared app', () => {
  it('the module ships no issuer, client id or redirect default — validation never fills one in', () => {
    // Code only: comments explaining the rule may name things freely (and the
    // OSS mirror rewrites brand words inside them).
    const code = fs
      .readFileSync(new URL('./shared-oauth-app.ts', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toMatch(/https?:\/\/[a-z0-9.-]+\.[a-z]{2,}/i)
    // The brand word is assembled at runtime so the OSS rewriter can't turn this check into a different one.
    expect(code.toLowerCase()).not.toContain(['ax', 'ia'].join(''))
    expect(shared.validateSharedAppInput({ enabled: true }).ok).toBe(false)
    expect(shared.validateSharedAppInput({}).ok).toBe(false)
  })

  it('rejects non-https issuers / redirect URIs and a missing client id', () => {
    expect(shared.validateSharedAppInput({ ...SHARED_CFG, issuer: 'http://evil.example' }).ok).toBe(false)
    expect(shared.validateSharedAppInput({ ...SHARED_CFG, redirect_uri: 'ftp://x' }).ok).toBe(false)
    expect(shared.validateSharedAppInput({ ...SHARED_CFG, client_id: '  ' }).ok).toBe(false)
    expect(shared.validateSharedAppInput({ ...SHARED_CFG, enabled: 'yes' }).ok).toBe(false)
    expect(shared.validateSharedAppInput(SHARED_CFG).ok).toBe(true)
  })
})

describe('opt-in path (an admin turned it on for a named connector)', () => {
  it('makes that ONE connector available and starts a PKCE flow at the chosen third party', async () => {
    shared.setSharedAppConfig('slack', SHARED_CFG)
    const slack = (await getConnector('slack'))!
    expect(slack.availability!().ok).toBe(true)
    expect((await getConnector('hubspot'))!.availability!().ok).toBe(false) // not named → untouched

    const out = await slack.startOAuth!({ userId: 21 })
    expect(out.ok).toBe(true)
    const url = new URL((out as { redirectUrl: string }).redirectUrl)
    expect(`${url.origin}${url.pathname}`).toBe(META.authorization_endpoint)
    expect(url.searchParams.get('client_id')).toBe('shared-client-123')
    expect(url.searchParams.get('redirect_uri')).toBe(SHARED_CFG.redirect_uri)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(shared.verifySharedAppState(url.searchParams.get('state')!, 'slack')).toMatchObject({ uid: 21, connector: 'slack' })
    expect(store.verifyState('slack', url.searchParams.get('state')!)).toBeNull()
  })

  it('callback exchanges the relayed code at the third party and labels the connection', async () => {
    shared.setSharedAppConfig('slack', SHARED_CFG)
    const state = shared.signSharedAppState(21, 'slack', 'v'.repeat(43))
    const r = await call('GET', `/api/user/connector-oauth/slack/callback?code=abc&state=${encodeURIComponent(state)}`)
    expect(r.status).toBe(302)
    expect(r.location).toContain('connector=connected')
    const tokenCall = fetchMock.mock.calls.find(c => c[0] === META.token_endpoint)!
    const body = new URLSearchParams(String((tokenCall[1] as RequestInit).body))
    expect(body.get('client_id')).toBe('shared-client-123')
    expect(body.get('code_verifier')).toBe('v'.repeat(43))
    expect(body.get('redirect_uri')).toBe(SHARED_CFG.redirect_uri)
    expect(body.get('client_secret')).toBeNull()
    expect(store.getForUser('slack', 21)?.account_label).toBe('via shared app: Example Auth Inc.')
  })

  it('callback refuses a shared-app state once the admin switched the toggle off', async () => {
    shared.setSharedAppConfig('slack', { ...SHARED_CFG, enabled: false })
    const state = shared.signSharedAppState(21, 'slack', 'v'.repeat(43))
    const r = await call('GET', `/api/user/connector-oauth/slack/callback?code=abc&state=${encodeURIComponent(state)}`)
    expect(r.location).toContain('shared_app_disabled')
    expect(store.getForUser('slack', 21)).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a state minted for another connector is rejected', () => {
    const state = shared.signSharedAppState(21, 'hubspot', 'v'.repeat(43))
    expect(shared.verifySharedAppState(state, 'slack')).toBeNull()
  })
})

describe('admin routes', () => {
  it('PUT /:id/shared-app is admin-only', async () => {
    const r = await call('PUT', '/api/connectors/slack/shared-app', SHARED_CFG, MEMBER)
    expect(r.status).toBe(403)
    expect(shared.getStoredSharedAppConfig('slack')).toBeNull()
  })

  it('only named, eligible connectors accept a config', async () => {
    const r = await call('PUT', '/api/connectors/github/shared-app', SHARED_CFG)
    expect(r.status).toBe(400)
    const g = await call('PUT', '/api/connectors/google-workspace/shared-app', SHARED_CFG)
    expect(g.status).toBe(400)
  })

  it('PUT saves, DELETE forgets, and the summary follows', async () => {
    const put = await call('PUT', '/api/connectors/slack/shared-app', SHARED_CFG)
    expect(put.status).toBe(200)
    expect(put.json.shared_app).toMatchObject({ enabled: true, configured: true, client_id: 'shared-client-123', provider_label: 'Example Auth Inc.' })
    const bad = await call('PUT', '/api/connectors/slack/shared-app', { ...SHARED_CFG, issuer: 'http://x.example' })
    expect(bad.status).toBe(400)
    const del = await call('DELETE', '/api/connectors/slack/shared-app')
    expect(del.json.shared_app).toMatchObject({ enabled: false, configured: false })
    expect(shared.getStoredSharedAppConfig('slack')).toBeNull()
  })
})
