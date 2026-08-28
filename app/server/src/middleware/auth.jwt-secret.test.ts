import { describe, it, expect, afterEach } from 'vitest'
import { getJwtSecret, assertJwtSecret } from './auth.js'

const ORIGINAL = process.env.JWT_SECRET

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.JWT_SECRET
  else process.env.JWT_SECRET = ORIGINAL
})

describe('getJwtSecret / assertJwtSecret', () => {
  it('returns a sufficiently long env secret', () => {
    process.env.JWT_SECRET = 'sixteen-chars-ok'
    expect(getJwtSecret()).toBe('sixteen-chars-ok')
    expect(() => assertJwtSecret()).not.toThrow()
  })

  it('throws when unset', () => {
    delete process.env.JWT_SECRET
    expect(() => getJwtSecret()).toThrow(/JWT_SECRET is required/)
    expect(() => assertJwtSecret()).toThrow(/JWT_SECRET is required/)
  })

  it('throws when shorter than 16 characters', () => {
    process.env.JWT_SECRET = 'short'
    expect(() => getJwtSecret()).toThrow(/min 16/)
    expect(() => assertJwtSecret()).toThrow(/min 16/)
  })

  it('rejects the old git-committed fallback and other placeholders', () => {
    process.env.JWT_SECRET = 'command-center-dev-secret-change-in-prod'
    // getJwtSecret still returns it (length is fine) so existing tokens can
    // be verified during a rotation window; boot assertion refuses to start
    // with a known public value.
    expect(getJwtSecret()).toBe('command-center-dev-secret-change-in-prod')
    expect(() => assertJwtSecret()).toThrow(/placeholder/)
  })
})
