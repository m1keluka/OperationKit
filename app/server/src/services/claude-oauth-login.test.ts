import { describe, it, expect, vi } from 'vitest'
import crypto from 'crypto'
import {
  CLAUDE_OAUTH,
  LOGIN_TTL_MS,
  MAX_ATTEMPTS,
  cancelClaudeLogin,
  finishClaudeLogin,
  parsePastedCode,
  pendingLoginCount,
  pkceChallenge,
  startClaudeLogin,
  type FetchLike,
} from './claude-oauth-login.js'

// Fake values only — never a real token.
const FAKE_TOKEN = 'sk-ant-oat01-fake-token-for-tests-000000000000000000'

function stateOf(url: string): string {
  return new URL(url).searchParams.get('state') as string
}

/** A token endpoint double that records what it was sent. */
function tokenEndpoint(status: number, body: unknown) {
  const calls: { url: string; body: Record<string, unknown> }[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    return { status, json: async () => body }
  }
  return { calls, fetchImpl }
}

describe('Claude sign-in link (PKCE, same client + scopes as `claude setup-token`)', () => {
  it('builds the claude.ai authorize link with S256 PKCE and inference-only scope', () => {
    const { url, loginId, expiresAt } = startClaudeLogin({ now: 1_000 })
    const u = new URL(url)
    expect(u.origin + u.pathname).toBe(CLAUDE_OAUTH.authorizeUrl)
    expect(u.searchParams.get('code')).toBe('true')
    expect(u.searchParams.get('client_id')).toBe('9d1c250a-e61b-44d9-88ed-5944d1962f5e')
    expect(u.searchParams.get('response_type')).toBe('code')
    expect(u.searchParams.get('redirect_uri')).toBe('https://platform.claude.com/oauth/code/callback')
    expect(u.searchParams.get('scope')).toBe('user:inference')
    expect(u.searchParams.get('code_challenge_method')).toBe('S256')
    expect(u.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(stateOf(url)).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(loginId).toMatch(/^[0-9a-f]{32}$/)
    expect(Date.parse(expiresAt)).toBe(1_000 + LOGIN_TTL_MS)
    // The verifier itself is never handed out.
    expect(Object.keys({ url, loginId, expiresAt }).sort()).toEqual(['expiresAt', 'loginId', 'url'])
    cancelClaudeLogin(loginId)
  })

  it('pkceChallenge is base64url(sha256(verifier)), unpadded', () => {
    // Expected value computed independently with Python hashlib + urlsafe_b64encode.
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r-wW1gFWFOEjXk')).toBe('NPsYzawS-__wqk67X9gyb4dr3JBo3hnlEi5MNyD5jX0')
  })

  it('parses code#state, a bare code, and the full callback URL; strips pasted whitespace', () => {
    expect(parsePastedCode('abc#xyz')).toEqual({ code: 'abc', state: 'xyz' })
    expect(parsePastedCode('  ab c#x yz\n')).toEqual({ code: 'abc', state: 'xyz' })
    expect(parsePastedCode('abc')).toEqual({ code: 'abc', state: null })
    expect(parsePastedCode('https://platform.claude.com/oauth/code/callback?code=abc&state=xyz')).toEqual({ code: 'abc', state: 'xyz' })
    expect(parsePastedCode('')).toBeNull()
    expect(parsePastedCode('#xyz')).toBeNull()
  })
})

describe('finishing the sign-in', () => {
  it('exchanges code + verifier for a one-year subscription token, then forgets the verifier', async () => {
    const now = 5_000_000
    const { url, loginId } = startClaudeLogin({ actorUserId: 7, now })
    const state = stateOf(url)
    const ep = tokenEndpoint(200, { access_token: FAKE_TOKEN, expires_in: 31536000, scope: 'user:inference' })
    const res = await finishClaudeLogin({ loginId, pasted: `the-code#${state}`, now: now + 1000, fetchImpl: ep.fetchImpl })
    expect(res).toEqual({ ok: true, token: FAKE_TOKEN, expiresAt: new Date(now + 1000 + 31536000 * 1000).toISOString(), actorUserId: 7 })

    expect(ep.calls).toHaveLength(1)
    const sent = ep.calls[0]
    expect(sent.url).toBe('https://platform.claude.com/v1/oauth/token')
    expect(sent.body).toMatchObject({
      grant_type: 'authorization_code',
      code: 'the-code',
      state,
      client_id: CLAUDE_OAUTH.clientId,
      redirect_uri: CLAUDE_OAUTH.redirectUri,
      expires_in: 31536000,
    })
    // The verifier that was sent is the one whose challenge was in the link.
    expect(pkceChallenge(sent.body.code_verifier as string)).toBe(new URL(url).searchParams.get('code_challenge'))

    // Single use: the same link cannot be finished twice.
    const again = await finishClaudeLogin({ loginId, pasted: `the-code#${state}`, now: now + 2000, fetchImpl: ep.fetchImpl })
    expect(again).toMatchObject({ ok: false, error: 'unknown_login' })
  })

  it('state mismatch: refused before anything is sent to Claude', async () => {
    const { loginId } = startClaudeLogin()
    const ep = tokenEndpoint(200, { access_token: FAKE_TOKEN })
    const res = await finishClaudeLogin({ loginId, pasted: 'the-code#some-other-links-state', fetchImpl: ep.fetchImpl })
    expect(res).toMatchObject({ ok: false, error: 'state_mismatch' })
    expect(ep.calls).toHaveLength(0)
    cancelClaudeLogin(loginId)
  })

  it('expired verifier: refused after the TTL, nothing sent, and the pending login is dropped', async () => {
    const now = 9_000_000
    const { url, loginId } = startClaudeLogin({ now })
    const ep = tokenEndpoint(200, { access_token: FAKE_TOKEN })
    const before = pendingLoginCount()
    const res = await finishClaudeLogin({ loginId, pasted: `the-code#${stateOf(url)}`, now: now + LOGIN_TTL_MS, fetchImpl: ep.fetchImpl })
    expect(res).toMatchObject({ ok: false, error: 'expired' })
    expect(ep.calls).toHaveLength(0)
    expect(pendingLoginCount()).toBe(before - 1)
  })

  it('bad code: Claude rejects it → bad_code with a value-free reason; the link stays usable for a retry', async () => {
    const { url, loginId } = startClaudeLogin()
    const state = stateOf(url)
    const bad = tokenEndpoint(400, { error: 'invalid_grant', error_description: 'Invalid code sk-ant-oat01-echoed-secret' })
    const res = await finishClaudeLogin({ loginId, pasted: `typo#${state}`, fetchImpl: bad.fetchImpl })
    expect(res).toMatchObject({ ok: false, error: 'bad_code' })
    expect(JSON.stringify(res)).toContain('invalid_grant')
    expect(JSON.stringify(res)).not.toContain('sk-ant-oat01-echoed-secret')
    // Fix the paste and try again on the same link.
    const good = tokenEndpoint(200, { access_token: FAKE_TOKEN, expires_in: 60 })
    const retry = await finishClaudeLogin({ loginId, pasted: `right#${state}`, fetchImpl: good.fetchImpl })
    expect(retry).toMatchObject({ ok: true, token: FAKE_TOKEN })
    // Both attempts carried the same verifier.
    expect(bad.calls[0].body.code_verifier).toBe(good.calls[0].body.code_verifier)
  })

  it(`gives up after ${MAX_ATTEMPTS} attempts on one link`, async () => {
    const { loginId } = startClaudeLogin()
    const ep = tokenEndpoint(200, { access_token: FAKE_TOKEN })
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      expect(await finishClaudeLogin({ loginId, pasted: 'x#wrong', fetchImpl: ep.fetchImpl })).toMatchObject({ error: 'state_mismatch' })
    }
    expect(await finishClaudeLogin({ loginId, pasted: 'x#wrong', fetchImpl: ep.fetchImpl })).toMatchObject({ error: 'too_many_attempts' })
    expect(await finishClaudeLogin({ loginId, pasted: 'x#wrong', fetchImpl: ep.fetchImpl })).toMatchObject({ error: 'unknown_login' })
  })

  it('never stores a non-subscription credential (no metered API-key fallback)', async () => {
    const { url, loginId } = startClaudeLogin()
    const ep = tokenEndpoint(200, { access_token: 'sk-ant-api03-metered-key-for-tests' })
    const res = await finishClaudeLogin({ loginId, pasted: `c#${stateOf(url)}`, fetchImpl: ep.fetchImpl })
    expect(res).toMatchObject({ ok: false, error: 'not_subscription' })
    expect(JSON.stringify(res)).not.toContain('sk-ant-api03')
  })

  it('network failure or a 5xx is exchange_failed, not bad_code', async () => {
    const a = startClaudeLogin()
    const down: FetchLike = async () => { throw new Error('ECONNREFUSED') }
    expect(await finishClaudeLogin({ loginId: a.loginId, pasted: `c#${stateOf(a.url)}`, fetchImpl: down })).toMatchObject({ error: 'exchange_failed' })
    const five = tokenEndpoint(503, {})
    expect(await finishClaudeLogin({ loginId: a.loginId, pasted: `c#${stateOf(a.url)}`, fetchImpl: five.fetchImpl })).toMatchObject({ error: 'exchange_failed' })
    cancelClaudeLogin(a.loginId)
  })

  it('unknown login id and empty paste are refused', async () => {
    expect(await finishClaudeLogin({ loginId: crypto.randomBytes(16).toString('hex'), pasted: 'c#s' })).toMatchObject({ error: 'unknown_login' })
    const { loginId } = startClaudeLogin()
    expect(await finishClaudeLogin({ loginId, pasted: '   ' })).toMatchObject({ error: 'bad_input' })
    cancelClaudeLogin(loginId)
  })

  it('never logs the verifier, the code or the token', async () => {
    const lines: string[] = []
    const spies = (['log', 'warn', 'error', 'info', 'debug'] as const).map(fn =>
      vi.spyOn(console, fn).mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')) }))
    try {
      const { url, loginId } = startClaudeLogin()
      const ep = tokenEndpoint(200, { access_token: FAKE_TOKEN, expires_in: 60 })
      await finishClaudeLogin({ loginId, pasted: `secret-code-123#${stateOf(url)}`, fetchImpl: ep.fetchImpl })
      const verifier = ep.calls[0].body.code_verifier as string
      const all = lines.join('\n')
      for (const v of [verifier, 'secret-code-123', FAKE_TOKEN]) expect(all.includes(v)).toBe(false)
    } finally {
      spies.forEach(s => s.mockRestore())
    }
  })
})
