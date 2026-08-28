import { describe, it, expect } from 'vitest'
import { isRateLimitMessage, isAuthFailureMessage, isSpendCapMessage, parseResetTime, isOAuthTokenUsable } from './account-router.js'

// Regression guard for objective 337: the monthly/org spend-cap exit message
// must be classified as a rate limit so the account gets cooled down and the
// session auto-rotates instead of stopping for a manual resume.
describe('isRateLimitMessage — spend-cap detection (obj 337)', () => {
  it('detects the exact screenshot string (monthly spend limit)', () => {
    expect(
      isRateLimitMessage(
        "You've hit your monthly spend limit - raise it at claude.ai/admin-settings/usage"
      )
    ).toBe(true)
  })

  it("detects the org's monthly spend limit variant", () => {
    expect(
      isRateLimitMessage(
        "You've hit your org's monthly spend limit · ask your admin to raise it at claude.ai/admin-settings/usage"
      )
    ).toBe(true)
  })

  it('detects the admin-settings/usage URL even if wording changes', () => {
    expect(isRateLimitMessage('Raise your cap at claude.ai/admin-settings/usage')).toBe(true)
  })

  it('still detects the classic per-window limit message', () => {
    expect(isRateLimitMessage("You've hit your limit · resets 6:50pm (UTC)")).toBe(true)
  })

  it('detects qualified session/weekly/daily limit wording', () => {
    expect(isRateLimitMessage("You've hit your session limit · resets 6:40pm (UTC)")).toBe(true)
    expect(isRateLimitMessage("You've hit your weekly limit")).toBe(true)
    expect(isRateLimitMessage("You've hit your daily limit")).toBe(true)
  })

  it('still detects HTTP 429 / too many requests phrasing', () => {
    expect(isRateLimitMessage('Error: 429 Too Many Requests')).toBe(true)
    expect(isRateLimitMessage('rate limit exceeded')).toBe(true)
  })

  it('does not match an empty string', () => {
    expect(isRateLimitMessage('')).toBe(false)
  })
})

describe('isSpendCapMessage — non-recoverable spend cap', () => {
  it('detects the org monthly spend-limit exit', () => {
    expect(
      isSpendCapMessage(
        "You've hit your org's monthly spend limit · ask your admin to raise it at claude.ai/admin-settings/usage"
      )
    ).toBe(true)
  })

  it('detects the personal monthly spend-limit exit', () => {
    expect(
      isSpendCapMessage(
        "You've hit your monthly spend limit - raise it at claude.ai/admin-settings/usage"
      )
    ).toBe(true)
  })

  it('detects the admin-settings/usage URL on its own', () => {
    expect(isSpendCapMessage('Raise your cap at claude.ai/admin-settings/usage')).toBe(true)
  })

  it('does NOT classify a recoverable per-window rate limit as a spend cap', () => {
    expect(isSpendCapMessage("You've hit your limit · resets 6:50pm (UTC)")).toBe(false)
    expect(isSpendCapMessage("You've hit your session limit · resets 6:40pm (UTC)")).toBe(false)
    expect(isSpendCapMessage('Error: 429 Too Many Requests')).toBe(false)
  })

  it('does not match an empty string', () => {
    expect(isSpendCapMessage('')).toBe(false)
  })
})

// Regression guard for obj 1286 (distill 2026-06-22): an API 401 credential
// outage was falling through the 429/529 branches and masquerading as a no-op
// work failure, re-spawned ~100× across 16 objectives. isAuthFailureMessage is
// the text fallback that lets session-manager bench the credential instead.
describe('isAuthFailureMessage — 401 credential-outage detection (obj 1286)', () => {
  it('detects the exact CLI 401 exit string', () => {
    expect(
      isAuthFailureMessage('Failed to authenticate. API Error: 401 Invalid authentication credentials')
    ).toBe(true)
  })

  it('detects the raw stream authentication_failed marker', () => {
    expect(isAuthFailureMessage('authentication_failed')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(isAuthFailureMessage('invalid authentication credentials')).toBe(true)
  })

  it('does not false-positive on normal text mentioning authentication', () => {
    // Narrow on purpose: must not trip on assistant output discussing auth.
    expect(isAuthFailureMessage('We added authentication to the login route.')).toBe(false)
    expect(isAuthFailureMessage('rate limit exceeded')).toBe(false)
    expect(isAuthFailureMessage('')).toBe(false)
  })
})

// The CLI's session-limit exit ("resets 6:40pm (UTC)") never matched the old
// "resets AT ..." regex, so it fell back to now+5h and benched a working account
// for hours past its real reset. These lock in the corrected parse.
describe('parseResetTime — session-limit wire format', () => {
  it('parses "resets 6:40pm (UTC)" (no "at", 12h, explicit UTC)', () => {
    const d = parseResetTime("You've hit your session limit · resets 6:40pm (UTC)")
    expect(d).not.toBeNull()
    expect(d!.getUTCHours()).toBe(18)
    expect(d!.getUTCMinutes()).toBe(40)
  })

  it('parses "resets 6:50pm (UTC)" from the classic limit message', () => {
    const d = parseResetTime("You've hit your limit · resets 6:50pm (UTC)")
    expect(d).not.toBeNull()
    expect(d!.getUTCHours()).toBe(18)
    expect(d!.getUTCMinutes()).toBe(50)
  })

  it('parses a bare hour "resets 6pm (UTC)"', () => {
    const d = parseResetTime('resets 6pm (UTC)')
    expect(d).not.toBeNull()
    expect(d!.getUTCHours()).toBe(18)
    expect(d!.getUTCMinutes()).toBe(0)
  })

  it('still parses the legacy "resets at 14:00" 24h form', () => {
    const d = parseResetTime('resets at 14:00 (UTC)')
    expect(d).not.toBeNull()
    expect(d!.getUTCHours()).toBe(14)
    expect(d!.getUTCMinutes()).toBe(0)
  })

  it('parses "try again in 30 minutes" relative form', () => {
    const before = Date.now()
    const d = parseResetTime('Please try again in 30 minutes')
    expect(d).not.toBeNull()
    const deltaMin = (d!.getTime() - before) / 60000
    expect(deltaMin).toBeGreaterThan(29)
    expect(deltaMin).toBeLessThan(31)
  })

  it('returns null when no reset hint is present', () => {
    expect(parseResetTime('something went wrong')).toBeNull()
  })
})

// Regression guard for objective 913: slot c's OAuth access token expired with
// NO refresh token, so spawned sessions (which run with ANTHROPIC_API_KEY unset)
// could not authenticate and died with 401. isAccountAvailable must treat such
// an account as unavailable so it leaves rotation and pinned --resume objectives
// rotate to a healthy account instead of crash-looping.
describe('isOAuthTokenUsable — expired-without-refresh detection (obj 913)', () => {
  const NOW = 1_781_966_400_000 // fixed reference instant

  const creds = (o: Record<string, unknown>) => JSON.stringify({ claudeAiOauth: o })

  it('rejects an expired access token with no refresh token (the obj 913 case)', () => {
    expect(
      isOAuthTokenUsable(creds({ accessToken: 'x', expiresAt: NOW - 1000, refreshToken: '' }), NOW)
    ).toBe(false)
    expect(
      isOAuthTokenUsable(creds({ accessToken: 'x', expiresAt: NOW - 1000 }), NOW)
    ).toBe(false)
  })

  it('accepts an expired access token WHEN a refresh token is present (CLI can refresh)', () => {
    expect(
      isOAuthTokenUsable(creds({ accessToken: 'x', expiresAt: NOW - 1000, refreshToken: 'r' }), NOW)
    ).toBe(true)
  })

  it('accepts a still-valid access token regardless of refresh token', () => {
    expect(
      isOAuthTokenUsable(creds({ accessToken: 'x', expiresAt: NOW + 60_000, refreshToken: '' }), NOW)
    ).toBe(true)
  })

  it('accepts top-level (non-nested) oauth shape', () => {
    expect(
      isOAuthTokenUsable(JSON.stringify({ expiresAt: NOW - 1000, refreshToken: 'r' }), NOW)
    ).toBe(true)
  })

  it('is permissive on unknown/unparseable input (never false-benches)', () => {
    expect(isOAuthTokenUsable('not json', NOW)).toBe(true)
    expect(isOAuthTokenUsable(JSON.stringify({ claudeAiOauth: { accessToken: 'x' } }), NOW)).toBe(true)
  })
})
