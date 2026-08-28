import { describe, it, expect } from 'vitest'
import { parsePrNumberFromUrl } from './pr-url.js'

// Regression guard for the live incident (obj 1138 → PR #78): pr_url was set to
// .../pull/78 but pr_number was NULL, so harness/test-agent never posted and the PR
// sat BLOCKED. parsePrNumberFromUrl is the fallback that closes that hole.
describe('parsePrNumberFromUrl', () => {
  it('parses the number from a canonical GitHub PR URL (the obj-1138 / PR #78 case)', () => {
    expect(parsePrNumberFromUrl('https://github.com/your-org/command-center-infra/pull/78')).toBe(78)
  })

  it('parses with a trailing segment (/files, /commits)', () => {
    expect(parsePrNumberFromUrl('https://github.com/o/r/pull/123/files')).toBe(123)
    expect(parsePrNumberFromUrl('https://github.com/o/r/pull/9/commits')).toBe(9)
  })

  it('parses with a query string or fragment', () => {
    expect(parsePrNumberFromUrl('https://github.com/o/r/pull/45?diff=split')).toBe(45)
    expect(parsePrNumberFromUrl('https://github.com/o/r/pull/45#issuecomment-1')).toBe(45)
  })

  it('returns null for null / undefined / empty', () => {
    expect(parsePrNumberFromUrl(null)).toBeNull()
    expect(parsePrNumberFromUrl(undefined)).toBeNull()
    expect(parsePrNumberFromUrl('')).toBeNull()
  })

  it('returns null for non-PR or malformed URLs (no false positives)', () => {
    expect(parsePrNumberFromUrl('https://github.com/o/r/issues/78')).toBeNull()
    expect(parsePrNumberFromUrl('https://github.com/o/r/pull/abc')).toBeNull()
    expect(parsePrNumberFromUrl('https://github.com/o/r/pulls')).toBeNull()
    expect(parsePrNumberFromUrl('not a url')).toBeNull()
  })
})
