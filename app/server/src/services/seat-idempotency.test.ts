import { describe, it, expect } from 'vitest'
import { createOnce, parseIdempotencyKey } from './seat-idempotency.js'
import { claudeTokenUrl, CLAUDE_OAUTH } from './claude-oauth-login.js'

describe('createOnce (idempotent seat writes, obj 720330)', () => {
  it('concurrent calls with one key run fn once and share the result', async () => {
    const once = createOnce<number>(60_000)
    let runs = 0
    const fn = () => new Promise<number>(r => setTimeout(() => r(++runs), 20))
    const [a, b] = await Promise.all([once.run('k', fn, () => true), once.run('k', fn, () => true)])
    expect(runs).toBe(1)
    expect(a.value).toBe(1)
    expect(b.value).toBe(1)
    expect([a.replayed, b.replayed].sort()).toEqual([false, true])
  })

  it('replays a success within the TTL, forgets it after', async () => {
    let t = 0
    const once = createOnce<string>(1000, 10, () => t)
    let runs = 0
    const fn = async () => `run-${++runs}`
    expect((await once.run('k', fn, () => true)).value).toBe('run-1')
    t = 999
    expect(await once.run('k', fn, () => true)).toEqual({ value: 'run-1', replayed: true })
    t = 2001
    expect((await once.run('k', fn, () => true)).value).toBe('run-2')
  })

  it('does not remember failures, and a throw is not cached either', async () => {
    const once = createOnce<number>(60_000)
    let runs = 0
    await once.run('k', async () => ++runs, () => false)
    expect((await once.run('k', async () => ++runs, () => true)).value).toBe(2)
    const boom = createOnce<number>(60_000)
    await expect(boom.run('x', async () => { throw new Error('nope') }, () => true)).rejects.toThrow('nope')
    expect((await boom.run('x', async () => 7, () => true)).value).toBe(7)
  })

  it('is bounded', async () => {
    const once = createOnce<number>(60_000, 3)
    for (let i = 0; i < 10; i++) await once.run(`k${i}`, async () => i, () => true)
    await once.run('last', async () => 0, () => true)
    expect(once.size()).toBeLessThanOrEqual(4)
  })

  it('accepts only short URL-safe keys', () => {
    expect(parseIdempotencyKey('abcDEF12-_')).toBe('abcDEF12-_')
    for (const bad of [undefined, 1, '', 'short', 'has space here', 'x'.repeat(101), '../../etc/passwd']) {
      expect(parseIdempotencyKey(bad)).toBeNull()
    }
  })
})

describe('Claude token endpoint override (e2e stub only)', () => {
  const stub = 'http://127.0.0.1:4555/v1/oauth/token'
  it('production always talks to Claude', () => {
    expect(claudeTokenUrl({}, () => false)).toBe(CLAUDE_OAUTH.tokenUrl)
    expect(claudeTokenUrl({ CC_CLAUDE_OAUTH_TOKEN_URL: stub }, () => false)).toBe(CLAUDE_OAUTH.tokenUrl)
  })
  it('a scratch server may point at a LOOPBACK stub, never at another host', () => {
    expect(claudeTokenUrl({ CC_CLAUDE_OAUTH_TOKEN_URL: stub }, () => true)).toBe(stub)
    expect(claudeTokenUrl({ CC_CLAUDE_OAUTH_TOKEN_URL: 'http://localhost:9/t' }, () => true)).toBe('http://localhost:9/t')
    expect(claudeTokenUrl({ CC_CLAUDE_OAUTH_TOKEN_URL: 'https://evil.example/token' }, () => true)).toBe(CLAUDE_OAUTH.tokenUrl)
    expect(claudeTokenUrl({ CC_CLAUDE_OAUTH_TOKEN_URL: 'http://127.0.0.1.evil.example/t' }, () => true)).toBe(CLAUDE_OAUTH.tokenUrl)
    expect(claudeTokenUrl({ CC_CLAUDE_OAUTH_TOKEN_URL: 'not a url' }, () => true)).toBe(CLAUDE_OAUTH.tokenUrl)
  })
})
