import { describe, it, expect, beforeAll, beforeEach, vi, afterEach } from 'vitest'
import os from 'os'
import path from 'path'

// Encryption key + isolated DB + JWT secret must be set BEFORE importing the
// modules that read them at import/first-use time. Mirrors
// services/user-github-tokens.test.ts.
process.env.TEST_CRED_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64')
process.env.JWT_SECRET = 'test-secret-dcr-connectors'
process.env.DB_PATH = path.join(os.tmpdir(), `cc-dcrconnectors-test-${process.pid}-${Date.now()}.db`)

const { initDb, getDb } = await import('../db/index.js')
const notion = (await import('./defs/notion.js')).default
const linear = (await import('./defs/linear.js')).default
const { getForUser } = await import('../services/user-dcr-connections.js')
const { getRegistration } = await import('../services/dcr-client-registrations.js')

function seedUser(id: number, username: string): void {
  getDb()
    .prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, 'x', 'member')`)
    .run(id, username)
}

function jsonResponse(body: unknown, init?: { status?: number }): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

beforeAll(() => {
  initDb()
})

beforeEach(() => {
  getDb().exec('DELETE FROM user_dcr_connections; DELETE FROM dcr_client_registrations; DELETE FROM users;')
  seedUser(1, 'alice')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('notion connector (auth_path: dcr_mcp)', () => {
  it('startOAuth uses CIMD and returns a PKCE-bound authorize URL', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        expect(url).toBe('https://mcp.notion.com/.well-known/oauth-authorization-server')
        return jsonResponse({
          issuer: 'https://mcp.notion.com',
          authorization_endpoint: 'https://mcp.notion.com/authorize',
          token_endpoint: 'https://mcp.notion.com/token',
          registration_endpoint: 'https://mcp.notion.com/register',
          client_id_metadata_document_supported: true,
        })
      }),
    )
    const outcome = await notion.startOAuth!({ userId: 1 })
    expect(outcome.ok).toBe(true)
    if (outcome.ok && 'redirectUrl' in outcome) {
      const url = new URL(outcome.redirectUrl)
      expect(url.origin + url.pathname).toBe('https://mcp.notion.com/authorize')
      expect(url.searchParams.get('client_id')).toContain('/api/connectors/dcr-client-metadata/notion')
      expect(url.searchParams.get('code_challenge_method')).toBe('S256')
      expect(url.searchParams.get('state')).toBeTruthy()
    }
    // Registered once, as CIMD (public client — no secret).
    const reg = getRegistration('notion')
    expect(reg?.registration_method).toBe('cimd')
    expect(reg?.has_client_secret).toBe(false)
  })

  it('startOAuth fails with a fallback hint when the provider supports neither DCR nor CIMD', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          issuer: 'https://mcp.notion.com',
          authorization_endpoint: 'https://mcp.notion.com/authorize',
          token_endpoint: 'https://mcp.notion.com/token',
        }),
      ),
    )
    const outcome = await notion.startOAuth!({ userId: 1 })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toMatch(/Notion MCP token/)
  })

  it('connectWithFields (token fallback) stores the credential and reports connected', async () => {
    const outcome = await notion.connectWithFields!({ userId: 1 }, { mcp_token: 'notion-mcp-token-raw' })
    expect(outcome.ok).toBe(true)
    const status = await notion.status({ userId: 1 })
    expect(status.state).toBe('connected')
    expect(getForUser('notion', 1)?.auth_method).toBe('api_key')
  })

  it('connectWithFields rejects an empty token', async () => {
    const outcome = await notion.connectWithFields!({ userId: 1 }, { mcp_token: '  ' })
    expect(outcome.ok).toBe(false)
  })

  it('status is not_connected before any connect attempt, and disconnect clears a stored grant', async () => {
    expect((await notion.status({ userId: 1 })).state).toBe('not_connected')
    await notion.connectWithFields!({ userId: 1 }, { mcp_token: 'x' })
    expect((await notion.status({ userId: 1 })).state).toBe('connected')
    await notion.disconnect({ userId: 1 })
    expect((await notion.status({ userId: 1 })).state).toBe('not_connected')
  })
})

describe('linear connector (auth_path: dcr_mcp)', () => {
  it('startOAuth falls back to DCR when the provider does not advertise CIMD', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/.well-known/oauth-authorization-server')) {
          return jsonResponse({
            issuer: 'https://mcp.linear.app',
            authorization_endpoint: 'https://mcp.linear.app/authorize',
            token_endpoint: 'https://mcp.linear.app/token',
            registration_endpoint: 'https://mcp.linear.app/register',
          })
        }
        expect(url).toBe('https://mcp.linear.app/register')
        const body = JSON.parse(String(init?.body))
        expect(body.redirect_uris[0]).toContain('/api/user/dcr/linear/callback')
        return jsonResponse({ client_id: 'linear-registered-client', client_secret: 'linear-secret' })
      }),
    )
    const outcome = await linear.startOAuth!({ userId: 1 })
    expect(outcome.ok).toBe(true)
    if (outcome.ok && 'redirectUrl' in outcome) {
      const url = new URL(outcome.redirectUrl)
      expect(url.searchParams.get('client_id')).toBe('linear-registered-client')
    }
    const reg = getRegistration('linear')
    expect(reg?.registration_method).toBe('dcr')
    expect(reg?.has_client_secret).toBe(true)
  })

  it('connectWithFields (api key fallback) stores the credential and reports connected', async () => {
    const outcome = await linear.connectWithFields!({ userId: 1 }, { api_key: 'lin_api_raw' })
    expect(outcome.ok).toBe(true)
    expect(getForUser('linear', 1)?.auth_method).toBe('api_key')
  })

  it("a user's Notion and Linear connections are independent of each other", async () => {
    await notion.connectWithFields!({ userId: 1 }, { mcp_token: 'notion-token' })
    await linear.connectWithFields!({ userId: 1 }, { api_key: 'linear-key' })
    expect((await notion.status({ userId: 1 })).state).toBe('connected')
    expect((await linear.status({ userId: 1 })).state).toBe('connected')
    await linear.disconnect({ userId: 1 })
    expect((await notion.status({ userId: 1 })).state).toBe('connected')
    expect((await linear.status({ userId: 1 })).state).toBe('not_connected')
  })
})
