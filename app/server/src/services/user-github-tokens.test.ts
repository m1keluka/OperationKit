import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import os from 'os'
import path from 'path'

// Encryption key + isolated DB must be set BEFORE importing the modules that
// read them at import/first-use time. Mirrors the existing route tests.
process.env.TEST_CRED_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64')
const TMP_DB = path.join(os.tmpdir(), `cc-ughtok-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const svc = await import('./user-github-tokens.js')

function seedUser(id: number, username: string): void {
  getDb()
    .prepare(
      `INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, 'x', 'member')`,
    )
    .run(id, username)
}

beforeAll(() => {
  initDb()
})

beforeEach(() => {
  // Clean slate each test.
  getDb().exec('DELETE FROM user_github_tokens; DELETE FROM users;')
})

describe('user-github-tokens storage', () => {
  it('encrypt → store → decrypt round-trips the raw PAT', () => {
    seedUser(1, 'alice')
    const raw = 'github_pat_11ABCDE_secretvalue_xyz789'
    svc.upsert(1, {
      rawToken: raw,
      login: 'alice-gh',
      githubUserId: 4242,
      email: '4242+alice-gh@users.noreply.github.com',
      scopes: null,
      tokenType: 'pat_fine',
    })
    expect(svc.getDecryptedForUser(1)).toBe(raw)
  })

  it('masked summary exposes only last-4 and resolved identity, never the raw token', () => {
    seedUser(1, 'alice')
    const raw = 'ghp_abcdefghijklmnop1234'
    svc.upsert(1, {
      rawToken: raw,
      login: 'alice-gh',
      githubUserId: 99,
      email: 'alice@example.com',
      scopes: 'repo,read:org',
      tokenType: 'pat_classic',
    })
    const summary = svc.getForUser(1)
    expect(summary).not.toBeNull()
    expect(summary!.token_last4).toBe('1234')
    expect(summary!.github_login).toBe('alice-gh')
    expect(summary!.github_email).toBe('alice@example.com')
    expect(summary!.token_type).toBe('pat_classic')
    // The raw token must not appear anywhere in the serialized summary.
    expect(JSON.stringify(summary)).not.toContain(raw)
    expect(JSON.stringify(summary)).not.toContain('abcdefghijklmnop')
  })

  it('upsert replaces an existing token for the same user (one row per user)', () => {
    seedUser(1, 'alice')
    svc.upsert(1, { rawToken: 'ghp_first0000aaaa', login: 'a', githubUserId: 1, email: 'a@x.com', scopes: null, tokenType: 'pat_classic' })
    svc.upsert(1, { rawToken: 'ghp_second111bbbb', login: 'a2', githubUserId: 2, email: 'a2@x.com', scopes: null, tokenType: 'pat_classic' })
    const rows = getDb().prepare('SELECT COUNT(*) AS n FROM user_github_tokens WHERE user_id = 1').get() as { n: number }
    expect(rows.n).toBe(1)
    expect(svc.getDecryptedForUser(1)).toBe('ghp_second111bbbb')
    expect(svc.getForUser(1)!.github_login).toBe('a2')
  })

  it('getForUser / getDecryptedForUser return null when nothing is linked', () => {
    seedUser(2, 'bob')
    expect(svc.getForUser(2)).toBeNull()
    expect(svc.getDecryptedForUser(2)).toBeNull()
  })

  it('deleteForUser revokes the row', () => {
    seedUser(1, 'alice')
    svc.upsert(1, { rawToken: 'ghp_deletetest123x', login: 'a', githubUserId: 1, email: 'a@x.com', scopes: null, tokenType: 'pat_classic' })
    expect(svc.deleteForUser(1)).toBe(true)
    expect(svc.getForUser(1)).toBeNull()
    expect(svc.deleteForUser(1)).toBe(false) // idempotent
  })

  it('deleting the user cascades to their token row (ON DELETE CASCADE)', () => {
    seedUser(1, 'alice')
    svc.upsert(1, { rawToken: 'ghp_cascadetest99x', login: 'a', githubUserId: 1, email: 'a@x.com', scopes: null, tokenType: 'pat_classic' })
    getDb().prepare('DELETE FROM users WHERE id = ?').run(1)
    const rows = getDb().prepare('SELECT COUNT(*) AS n FROM user_github_tokens WHERE user_id = 1').get() as { n: number }
    expect(rows.n).toBe(0)
  })
})
