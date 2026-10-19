import { describe, it, expect, beforeEach } from 'vitest'
import {
  inspectLoginRateLimit,
  recordLoginFailure,
  clearLoginFailures,
  resetLoginRateLimit,
  LOGIN_RATE_LIMIT,
} from './login-rate-limit.js'

beforeEach(() => {
  resetLoginRateLimit()
})

describe('login-rate-limit', () => {
  it('allows the first attempts', () => {
    expect(inspectLoginRateLimit('1.1.1.1', 'mike')).toEqual({ ok: true })
  })

  it('locks one identity after MAX_PER_IDENTITY failures and returns retry-after', () => {
    for (let i = 0; i < LOGIN_RATE_LIMIT.MAX_PER_IDENTITY; i++) {
      recordLoginFailure('1.1.1.1', 'mike')
    }
    const blocked = inspectLoginRateLimit('1.1.1.1', 'mike')
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) {
      expect(blocked.retryAfterSec).toBeGreaterThan(0)
      expect(blocked.retryAfterSec).toBeLessThanOrEqual(LOGIN_RATE_LIMIT.WINDOW_MS / 1000)
    }
  })

  it('does not lock a different username on the same IP at the identity cap', () => {
    for (let i = 0; i < LOGIN_RATE_LIMIT.MAX_PER_IDENTITY; i++) {
      recordLoginFailure('1.1.1.1', 'mike')
    }
    expect(inspectLoginRateLimit('1.1.1.1', 'ava')).toEqual({ ok: true })
  })

  it('locks the IP after MAX_PER_IP failures across usernames', () => {
    for (let i = 0; i < LOGIN_RATE_LIMIT.MAX_PER_IP; i++) {
      recordLoginFailure('9.9.9.9', `user${i}`)
    }
    expect(inspectLoginRateLimit('9.9.9.9', 'fresh').ok).toBe(false)
    expect(inspectLoginRateLimit('8.8.8.8', 'fresh').ok).toBe(true)
  })

  it('clears both buckets on success', () => {
    for (let i = 0; i < LOGIN_RATE_LIMIT.MAX_PER_IDENTITY; i++) {
      recordLoginFailure('1.1.1.1', 'mike')
    }
    clearLoginFailures('1.1.1.1', 'mike')
    expect(inspectLoginRateLimit('1.1.1.1', 'mike')).toEqual({ ok: true })
  })

  it('treats usernames case-insensitively', () => {
    for (let i = 0; i < LOGIN_RATE_LIMIT.MAX_PER_IDENTITY; i++) {
      recordLoginFailure('1.1.1.1', 'Mike')
    }
    expect(inspectLoginRateLimit('1.1.1.1', 'mike').ok).toBe(false)
  })
})
