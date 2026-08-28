import { describe, it, expect, vi } from 'vitest'
import path from 'node:path'

// Regression guard for the 2026-06-30 incident: a `vitest run` that inherited the
// production DB_PATH (=/app/data/command-center.db, set in the container env) opened the
// LIVE database, and suite teardowns (`DELETE FROM objectives`) wiped the entire board.
// Two independent layers must hold:
//   1. vitest.setup.ts steers DB_PATH onto a throwaway before any test imports the db module.
//   2. initDb() hard-refuses the production path under a test runner even if (1) is bypassed.
const PROD_DB = '/app/data/command-center.db'

describe('production DB safety guard (incident 2026-06-30)', () => {
  it('global test setup steers DB_PATH off the production database file', () => {
    expect(process.env.DB_PATH).toBeTruthy()
    expect(path.resolve(process.env.DB_PATH!)).not.toBe(PROD_DB)
  })

  it('initDb() throws instead of opening the production DB under a test runner', async () => {
    const prev = process.env.DB_PATH
    process.env.DB_PATH = PROD_DB // simulate inheriting the live container env
    vi.resetModules() // force the module-level `const DB_PATH` to re-capture the prod path
    try {
      const mod = await import('./index.js')
      expect(() => mod.initDb()).toThrow(/Refusing to open the production database/)
    } finally {
      process.env.DB_PATH = prev
      vi.resetModules()
    }
  })
})
