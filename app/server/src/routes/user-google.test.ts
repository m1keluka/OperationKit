import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'
import type { UserGoogleConnectionSummary } from '@command-center/shared'

// obj-706070 — per-user Google Workspace connection API.
//
// Same harness shape as user-github-token.test.ts: encryption key + isolated DB
// + JWT secret set BEFORE importing anything that reads them at import time, an
// express app on an ephemeral port, and Google's HTTPS calls replaced by an
// injected fake fetch so exchange/refresh/revoke run deterministically offline.
process.env.TEST_CRED_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64')
process.env.JWT_SECRET = 'test-secret-ugoogle-route'
const TMP_DB = path.join(os.tmpdir(), `cc-ugoogle-route-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-client-id.apps.googleusercontent.com'
process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'GOCSPX-test-client-secret-zzz'
process.env.GOOGLE_OAUTH_REDIRECT_URI = 'https://ai.example.test/api/user/google/callback'
process.env.APP_BASE_URL = 'https://ai.example.test'

const { initDb, getDb } = await import('../db/index.js')
const { default: router } = await import('./user-google.js')
const { decryptField } = await import('../services/crypto.js')
const {
  __setFetchForTests,
  getDecryptedRefreshToken,
  getAccessTokenForUser,
  signState,
  upsert,
  TOKEN_ENDPOINT,
  REVOKE_ENDPOINT,
  USERINFO_ENDPOINT,
} = await import('../services/user-google-connections.js')

let server: http.Server
let baseUrl: string

const USER_ID = 10
const RAW_REFRESH = '1//0gREFRESHsecret_value_zzz999'
const RAW_ACCESS = 'ya29.ACCESSsecret_value_aaa111'
const REFRESHED_ACCESS = 'ya29.REFRESHEDsecret_value_bbb222'
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET as string
const GOOGLE_EMAIL = 'eva@example.com'
const GRANTED_SCOPES =
  'openid https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/drive'

/** Every URL the fake fetch was called with, in order — the revoke/refresh proof. */
let fetchCalls: string[] = []

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// Fake Google: token endpoint mints RAW_REFRESH/RAW_ACCESS on an auth-code
// exchange and REFRESHED_ACCESS on a refresh_token grant; userinfo resolves the
// consenting account; revoke succeeds.
function installFake() {
  fetchCalls = []
  __setFetchForTests(async (url: string, init?: RequestInit) => {
    fetchCalls.push(url)
    const body = typeof init?.body === 'string' ? init.body : ''
    if (url === TOKEN_ENDPOINT) {
      if (body.includes('grant_type=refresh_token')) {
        return jsonResponse(200, { access_token: REFRESHED_ACCESS, expires_in: 3600 })
      }
      return jsonResponse(200, {
        refresh_token: RAW_REFRESH,
        access_token: RAW_ACCESS,
        expires_in: 3600,
        scope: GRANTED_SCOPES,
      })
    }
    if (url === USERINFO_ENDPOINT) {
      return jsonResponse(200, { email: GOOGLE_EMAIL, sub: '11223344' })
    }
    if (url === REVOKE_ENDPOINT) return new Response('', { status: 200 })
    return jsonResponse(500, { error: 'unexpected ' + url })
  })
}

function cookieFor(id: number): string {
  return `token=${jwt.sign({ id, username: 'eva', role: 'member' }, process.env.JWT_SECRET as string, { expiresIn: '1h' })}`
}
const COOKIE = () => cookieFor(USER_ID)

/** Raw-text + parsed request against the router. `redirect: 'manual'` so the
 *  callback's 302 is observable instead of being chased into a 404. */
async function req(method: string, suffix = '', cookie?: string) {
  const res = await fetch(`${baseUrl}/api/user/google${suffix}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    redirect: 'manual',
  })
  const text = await res.text()
  let json: unknown = null
  try { json = JSON.parse(text) } catch { /* redirect/HTML body */ }
  return { status: res.status, text, json, location: res.headers.get('location') || '' }
}

/** Drive the full consent round-trip for USER_ID and return the callback response. */
async function completeCallback(state = signState(USER_ID)) {
  return req('GET', `/callback?code=auth-code-123&state=${encodeURIComponent(state)}`)
}

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  getDb().prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'eva', 'x', 'member')`).run(USER_ID)
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/user/google', router)
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
  getDb().exec('DELETE FROM user_google_connections')
  installFake()
})

describe('user-google routes — auth', () => {
  it('rejects GET / POST /connect / DELETE without auth (401)', async () => {
    expect((await req('GET')).status).toBe(401)
    expect((await req('POST', '/connect')).status).toBe(401)
    expect((await req('DELETE')).status).toBe(401)
  })
})

describe('GET /api/user/google — masked read', () => {
  it('returns { connection: null, configured } when the user has not connected', async () => {
    const r = await req('GET', '', COOKIE())
    expect(r.status).toBe(200)
    const body = r.json as { connection: unknown; configured: boolean }
    expect(body.connection).toBeNull()
    expect(typeof body.configured).toBe('boolean')
    // The OAuth client env is set in this suite, so the server IS configured.
    expect(body.configured).toBe(true)
  })
})

describe('POST /api/user/google/connect — consent URL', () => {
  it('returns an auth_url with offline access, forced consent, signed state, and ALL SIX Workspace surfaces', async () => {
    const r = await req('POST', '/connect', COOKIE())
    expect(r.status).toBe(200)
    const authUrl = (r.json as { auth_url: string }).auth_url
    expect(authUrl).toBeTruthy()

    const url = new URL(authUrl)
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    // Offline + forced consent are what guarantee a refresh_token comes back;
    // without them reconnects silently return no refresh token.
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('prompt')).toBe('consent')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('client_id')).toBe(process.env.GOOGLE_OAUTH_CLIENT_ID)

    // The requested scope must cover every surface the objective calls for.
    const scope = url.searchParams.get('scope') || ''
    for (const surface of ['gmail', 'drive', 'documents', 'spreadsheets', 'presentations', 'calendar']) {
      expect(scope, `scope must cover ${surface}`).toContain(`/auth/${surface}`)
    }

    // CSRF binding: state is a signed JWT that resolves back to THIS caller.
    const state = url.searchParams.get('state') || ''
    expect(state).toBeTruthy()
    const decoded = jwt.verify(state, process.env.JWT_SECRET as string) as { uid: number }
    expect(decoded.uid).toBe(USER_ID)

    // Client secret must never be in a URL we hand to the browser.
    expect(authUrl).not.toContain(CLIENT_SECRET)
  })
})

describe('GET /api/user/google/callback — full consent round-trip', () => {
  it('exchanges the code, persists the grant, and GET returns the masked summary', async () => {
    const cb = await completeCallback()
    expect(cb.status).toBe(302)
    expect(cb.location).toContain('google=connected')
    expect(fetchCalls).toContain(TOKEN_ENDPOINT)
    expect(fetchCalls).toContain(USERINFO_ENDPOINT)

    const r = await req('GET', '', COOKIE())
    const summary = (r.json as { connection: UserGoogleConnectionSummary }).connection
    expect(summary).not.toBeNull()
    expect(summary.google_email).toBe(GOOGLE_EMAIL)
    expect(summary.scopes).toBe(GRANTED_SCOPES)
    expect(summary.client_id).toBe(process.env.GOOGLE_OAUTH_CLIENT_ID)
    expect(summary.connected_at).toBeTruthy()
    expect(summary.last_error).toBeNull()
  })

  it('ENCRYPTED AT REST: the raw sqlite row holds ciphertext, and it round-trips back', async () => {
    await completeCallback()
    const row = getDb()
      .prepare('SELECT * FROM user_google_connections WHERE user_id = ?')
      .get(USER_ID) as {
        refresh_token_encrypted: string
        access_token_encrypted: string | null
        google_email: string
      }
    // What is actually on disk is NOT the token.
    expect(row.refresh_token_encrypted).not.toBe(RAW_REFRESH)
    expect(row.refresh_token_encrypted).not.toContain(RAW_REFRESH)
    expect(row.refresh_token_encrypted).not.toContain('secret_value')
    expect(row.access_token_encrypted).not.toBe(RAW_ACCESS)
    expect(row.access_token_encrypted).not.toContain('secret_value')
    // …but the server-only seams recover the originals.
    expect(decryptField(row.refresh_token_encrypted)).toBe(RAW_REFRESH)
    expect(decryptField(row.access_token_encrypted as string)).toBe(RAW_ACCESS)
    expect(getDecryptedRefreshToken(USER_ID)).toBe(RAW_REFRESH)
  })

  it('CSRF: a forged/garbage state creates NO row and redirects to an error', async () => {
    const forged = await completeCallback('not-a-real-jwt.garbage.value')
    expect(forged.status).toBe(302)
    expect(forged.location).toContain('google=error')
    expect(forged.location).toContain('invalid_state')
    expect(getDecryptedRefreshToken(USER_ID)).toBeNull()
    // A state signed with the WRONG secret is equally rejected.
    const wrongSecret = jwt.sign({ uid: USER_ID }, 'some-other-secret', { expiresIn: '15m' })
    const r2 = await completeCallback(wrongSecret)
    expect(r2.location).toContain('google=error')
    expect(getDecryptedRefreshToken(USER_ID)).toBeNull()
    // Nothing was even exchanged with Google.
    expect(fetchCalls).not.toContain(TOKEN_ENDPOINT)
  })

  it('a callback with no code redirects to an error and stores nothing', async () => {
    const r = await req('GET', `/callback?state=${encodeURIComponent(signState(USER_ID))}`)
    expect(r.status).toBe(302)
    expect(r.location).toContain('google=error')
    expect(getDecryptedRefreshToken(USER_ID)).toBeNull()
  })
})

describe('NO TOKEN EXPOSURE — no route body may carry credential material', () => {
  // The critical acceptance criterion: sweep EVERY response body of EVERY route
  // (before and after a connection exists) and assert none of them contains the
  // refresh token, the access token, the client secret, or even the names of the
  // encrypted columns (which would imply the raw row was serialized).
  const FORBIDDEN = [RAW_REFRESH, RAW_ACCESS, CLIENT_SECRET, 'refresh_token_encrypted', 'access_token_encrypted', 'secret_value']

  function assertClean(label: string, body: string) {
    for (const needle of FORBIDDEN) {
      expect(body, `${label} leaked ${needle.slice(0, 12)}…`).not.toContain(needle)
    }
  }

  it('GET, POST /connect and DELETE bodies are credential-free, connected and not', async () => {
    const bodies: Array<[string, string]> = []

    // Not connected yet.
    bodies.push(['GET (empty)', JSON.stringify((await req('GET', '', COOKIE())).json)])
    bodies.push(['POST /connect (empty)', JSON.stringify((await req('POST', '/connect', COOKIE())).json)])

    // Connected.
    const cb = await completeCallback()
    bodies.push(['callback redirect', cb.text + ' ' + cb.location])
    bodies.push(['GET (connected)', JSON.stringify((await req('GET', '', COOKIE())).json)])
    bodies.push(['POST /connect (connected)', JSON.stringify((await req('POST', '/connect', COOKIE())).json)])
    bodies.push(['DELETE', JSON.stringify((await req('DELETE', '', COOKIE())).json)])
    bodies.push(['GET (after delete)', JSON.stringify((await req('GET', '', COOKIE())).json)])

    for (const [label, body] of bodies) assertClean(label, body)
    // Sanity: the sweep actually saw real payloads, not a pile of nulls.
    expect(bodies.length).toBe(7)
    expect(bodies.some(([, b]) => b.includes(GOOGLE_EMAIL))).toBe(true)
  })
})

describe('DELETE /api/user/google — revoke + remove', () => {
  it('calls Google revoke, drops the row, and a later GET returns connection: null', async () => {
    await completeCallback()
    expect(getDecryptedRefreshToken(USER_ID)).toBe(RAW_REFRESH)

    const r = await req('DELETE', '', COOKIE())
    expect(r.status).toBe(200)
    const body = r.json as { removed: boolean; revoked: boolean }
    expect(body.removed).toBe(true)
    expect(body.revoked).toBe(true)
    // The grant was actually revoked upstream, not just forgotten locally.
    expect(fetchCalls).toContain(REVOKE_ENDPOINT)

    expect(getDecryptedRefreshToken(USER_ID)).toBeNull()
    const after = await req('GET', '', COOKIE())
    expect((after.json as { connection: unknown }).connection).toBeNull()
  })

  it('is a no-op (removed: false) when the user has no connection', async () => {
    const r = await req('DELETE', '', COOKIE())
    expect(r.status).toBe(200)
    expect((r.json as { removed: boolean }).removed).toBe(false)
    expect(fetchCalls).not.toContain(REVOKE_ENDPOINT)
  })
})

describe('getAccessTokenForUser — cache then refresh', () => {
  it('returns the CACHED access token while it is unexpired (no token-endpoint call)', async () => {
    upsert(USER_ID, {
      googleEmail: GOOGLE_EMAIL,
      googleSub: '11223344',
      refreshToken: RAW_REFRESH,
      accessToken: RAW_ACCESS,
      accessTokenExpiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      scopes: GRANTED_SCOPES,
      clientId: process.env.GOOGLE_OAUTH_CLIENT_ID as string,
    })
    installFake() // reset call log
    expect(await getAccessTokenForUser(USER_ID)).toBe(RAW_ACCESS)
    expect(fetchCalls).not.toContain(TOKEN_ENDPOINT)
  })

  it('REFRESHES via the token endpoint when the cached token is expired, persisting a NEW encrypted access token', async () => {
    upsert(USER_ID, {
      googleEmail: GOOGLE_EMAIL,
      googleSub: '11223344',
      refreshToken: RAW_REFRESH,
      accessToken: RAW_ACCESS,
      accessTokenExpiresAt: new Date(Date.now() - 60 * 60_000).toISOString(), // expired
      scopes: GRANTED_SCOPES,
      clientId: process.env.GOOGLE_OAUTH_CLIENT_ID as string,
    })
    installFake()
    expect(await getAccessTokenForUser(USER_ID)).toBe(REFRESHED_ACCESS)
    expect(fetchCalls).toContain(TOKEN_ENDPOINT)

    const row = getDb()
      .prepare('SELECT * FROM user_google_connections WHERE user_id = ?')
      .get(USER_ID) as { access_token_encrypted: string; access_token_expires_at: string; last_error: string | null }
    // Persisted, still ciphertext, and decrypts to the NEW token.
    expect(row.access_token_encrypted).not.toContain(REFRESHED_ACCESS)
    expect(decryptField(row.access_token_encrypted)).toBe(REFRESHED_ACCESS)
    expect(new Date(row.access_token_expires_at).getTime()).toBeGreaterThan(Date.now())
    expect(row.last_error).toBeNull()
    // The refresh token itself is untouched by a refresh.
    expect(getDecryptedRefreshToken(USER_ID)).toBe(RAW_REFRESH)
  })

  it('returns null for a user with no connection', async () => {
    expect(await getAccessTokenForUser(USER_ID)).toBeNull()
  })

  // A Google refresh token is only valid for the OAuth client that ISSUED it.
  // Credentials migrated off the old shared-credential setup were minted by the
  // LEGACY Desktop client (GMAIL_CLIENT_ID/SECRET), not the primary web client
  // new consent flows use — refreshing a migrated token against the primary
  // client returns 401 unauthorized_client. So the refresh path must select the
  // client by the ROW's stored client_id.
  it('refreshes a MIGRATED credential against the LEGACY client that issued it, not the primary', async () => {
    const LEGACY_ID = 'legacy-desktop-client.apps.googleusercontent.com'
    const LEGACY_SECRET = 'GOCSPX-legacy-desktop-secret'
    process.env.GMAIL_CLIENT_ID = LEGACY_ID
    process.env.GMAIL_CLIENT_SECRET = LEGACY_SECRET
    try {
      upsert(USER_ID, {
        googleEmail: GOOGLE_EMAIL,
        googleSub: '11223344',
        refreshToken: RAW_REFRESH,
        accessToken: null,
        accessTokenExpiresAt: null,
        scopes: GRANTED_SCOPES,
        clientId: LEGACY_ID, // migrated row: NOT the primary client
      })
      const bodies: string[] = []
      __setFetchForTests(async (url, init) => {
        fetchCalls.push(url)
        bodies.push(String(init?.body ?? ''))
        return new Response(
          JSON.stringify({ access_token: REFRESHED_ACCESS, expires_in: 3600 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      })
      expect(await getAccessTokenForUser(USER_ID)).toBe(REFRESHED_ACCESS)
      // The grant-issuing client's credentials were sent, NOT the primary's.
      const body = bodies.find((b) => b.includes('refresh_token')) as string
      expect(body).toContain(encodeURIComponent(LEGACY_ID))
      expect(body).toContain(encodeURIComponent(LEGACY_SECRET))
      expect(body).not.toContain(encodeURIComponent(process.env.GOOGLE_OAUTH_CLIENT_ID as string))
    } finally {
      delete process.env.GMAIL_CLIENT_ID
      delete process.env.GMAIL_CLIENT_SECRET
    }
  })

  it('records an actionable last_error (and fires NO request) when the issuing client is unknown', async () => {
    upsert(USER_ID, {
      googleEmail: GOOGLE_EMAIL,
      googleSub: '11223344',
      refreshToken: RAW_REFRESH,
      accessToken: null,
      accessTokenExpiresAt: null,
      scopes: GRANTED_SCOPES,
      clientId: 'some-client-nobody-configured.apps.googleusercontent.com',
    })
    installFake()
    expect(await getAccessTokenForUser(USER_ID)).toBeNull()
    // Guaranteed-401 request never sent.
    expect(fetchCalls).not.toContain(TOKEN_ENDPOINT)
    const row = getDb()
      .prepare('SELECT last_error FROM user_google_connections WHERE user_id = ?')
      .get(USER_ID) as { last_error: string | null }
    expect(row.last_error).toMatch(/not configured on this server/i)
  })
})
