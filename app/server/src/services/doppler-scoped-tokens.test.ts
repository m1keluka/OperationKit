import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import os from 'os'
import path from 'path'

// obj-2411 / Phase 0 — scoped read-only Doppler service-token map.
//
// The encryption key + isolated DB must be set BEFORE importing modules that read
// them at first use (mirrors secrets-store.test.ts / user-github-tokens.test.ts).
process.env.TEST_CRED_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64')
const TMP_DB = path.join(os.tmpdir(), `cc-doppler-scoped-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const mod = await import('./doppler-scoped-tokens.js')

beforeAll(() => {
  initDb()
})

beforeEach(() => {
  getDb().exec('DELETE FROM doppler_scoped_tokens;')
})

describe('doppler-scoped-tokens — set/get roundtrip + encryption-at-rest', () => {
  it('stores a token encrypted (raw never in the DB) and resolves it back', () => {
    const summary = mod.setScopedDopplerToken({
      workspace: 'example',
      token: 'dp.st.prd.SECRET_EXAMPLE_RO_abcd',
      dopplerProject: 'example-platform',
    })
    expect(summary.workspace).toBe('example')
    expect(summary.config).toBe('prd') // default
    expect(summary.token_last4).toBe('abcd')

    // Resolver returns the decrypted token for the workspace.
    expect(mod.getScopedDopplerTokenForWorkspace('example')).toBe('dp.st.prd.SECRET_EXAMPLE_RO_abcd')

    // At-rest the stored column is ciphertext, NOT the plaintext token.
    const row = getDb()
      .prepare('SELECT token_encrypted FROM doppler_scoped_tokens WHERE workspace = ?')
      .get('example') as { token_encrypted: string }
    expect(row.token_encrypted).not.toContain('SECRET_EXAMPLE_RO_abcd')
    expect(row.token_encrypted.split('.').length).toBe(3) // iv.tag.ct shape
  })

  it('returns "" for a workspace with no provisioned token (fail-closed)', () => {
    expect(mod.getScopedDopplerTokenForWorkspace('example2')).toBe('')
    expect(mod.getScopedDopplerTokenForWorkspace(null)).toBe('')
    expect(mod.getScopedDopplerTokenForWorkspace(undefined)).toBe('')
    expect(mod.getScopedDopplerTokenForWorkspace('')).toBe('')
  })

  it('upserts on (workspace, config) — a re-provision updates, never duplicates', () => {
    mod.setScopedDopplerToken({ workspace: 'example', token: 'tok-OLD0' })
    mod.setScopedDopplerToken({ workspace: 'example', token: 'tok-NEW1' })
    const rows = mod.listScopedDopplerTokens().filter(r => r.workspace === 'example')
    expect(rows.length).toBe(1)
    expect(mod.getScopedDopplerTokenForWorkspace('example')).toBe('tok-NEW1')
    expect(rows[0].token_last4).toBe('NEW1')
  })

  it('prefers the prd config when several configs exist for a workspace', () => {
    mod.setScopedDopplerToken({ workspace: 'example', config: 'stg', token: 'stg-token-1111' })
    mod.setScopedDopplerToken({ workspace: 'example', config: 'prd', token: 'prd-token-2222' })
    // No explicit config → prd wins.
    expect(mod.getScopedDopplerTokenForWorkspace('example')).toBe('prd-token-2222')
    // Explicit config still selectable.
    expect(mod.getScopedDopplerTokenForWorkspace('example', 'stg')).toBe('stg-token-1111')
  })

  it('listScopedDopplerTokens masks tokens (only last4, never raw)', () => {
    mod.setScopedDopplerToken({ workspace: 'example2', token: 'some-long-secret-WXYZ' })
    const list = mod.listScopedDopplerTokens()
    const ser = JSON.stringify(list)
    expect(ser).not.toContain('some-long-secret-WXYZ')
    expect(list.find(r => r.workspace === 'example2')?.token_last4).toBe('WXYZ')
  })

  it('deleteScopedDopplerToken removes the row (resolver then fails closed)', () => {
    mod.setScopedDopplerToken({ workspace: 'example', token: 'tok-DEL0' })
    expect(mod.deleteScopedDopplerToken('example')).toBe(true)
    expect(mod.getScopedDopplerTokenForWorkspace('example')).toBe('')
    expect(mod.deleteScopedDopplerToken('example')).toBe(false) // idempotent
  })
})
