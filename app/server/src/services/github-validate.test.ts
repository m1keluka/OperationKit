import { describe, it, expect, afterEach } from 'vitest'
import { validatePat, __setFetchForTests } from './user-github-tokens.js'

// Build a fake Response with optional headers (x-oauth-scopes for classic PATs).
function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...(headers || {}) },
  })
}

afterEach(() => {
  __setFetchForTests(null)
})

describe('validatePat', () => {
  it('200 resolves login/id and a verified primary email from /user/emails', async () => {
    __setFetchForTests(async (url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization || ''
      expect(auth).toContain('Bearer ')
      if (url === 'https://api.github.com/user') {
        return jsonResponse(200, { login: 'eva-dev', id: 7777 }, { 'x-oauth-scopes': 'repo, read:org' })
      }
      if (url === 'https://api.github.com/user/emails') {
        return jsonResponse(200, [
          { email: 'old@x.com', primary: false, verified: true },
          { email: 'eva@example.com', primary: true, verified: true },
        ])
      }
      return jsonResponse(500, { error: 'unexpected ' + url })
    })

    const res = await validatePat('ghp_classicvalidtoken1234')
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.data.login).toBe('eva-dev')
    expect(res.data.id).toBe(7777)
    expect(res.data.email).toBe('eva@example.com')
    expect(res.data.scopes).toBe('repo, read:org')
    expect(res.data.type).toBe('pat_classic')
  })

  it('falls back to the noreply email when /user/emails is not readable (fine-grained PAT)', async () => {
    __setFetchForTests(async (url: string) => {
      if (url === 'https://api.github.com/user') {
        return jsonResponse(200, { login: 'eva-dev', id: 4242 }) // no x-oauth-scopes header
      }
      if (url === 'https://api.github.com/user/emails') {
        return jsonResponse(403, { message: 'Resource not accessible by personal access token' })
      }
      return jsonResponse(500, { error: 'unexpected ' + url })
    })

    const res = await validatePat('github_pat_finegrained_abc1234')
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.data.email).toBe('4242+eva-dev@users.noreply.github.com')
    expect(res.data.scopes).toBeNull()
    expect(res.data.type).toBe('pat_fine')
  })

  it('401 rejects with a clear message', async () => {
    __setFetchForTests(async () => jsonResponse(401, { message: 'Bad credentials' }))
    const res = await validatePat('ghp_bogus')
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error).toMatch(/invalid|401/i)
  })

  it('403 rejects and mentions SSO / org authorization', async () => {
    __setFetchForTests(async () => jsonResponse(403, { message: 'Forbidden' }))
    const res = await validatePat('ghp_ssoblocked')
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error).toMatch(/SSO|authorize|org/i)
  })

  it('rejects an empty token without hitting the network', async () => {
    let called = false
    __setFetchForTests(async () => {
      called = true
      return jsonResponse(200, {})
    })
    const res = await validatePat('   ')
    expect(res.ok).toBe(false)
    expect(called).toBe(false)
  })
})
