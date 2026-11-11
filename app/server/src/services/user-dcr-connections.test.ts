import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import os from 'os'
import path from 'path'

const SERVER_ACTOR = { kind: 'server' as const }

process.env.TEST_CRED_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64')
process.env.DB_PATH = path.join(os.tmpdir(), `cc-userdcr-test-${process.pid}-${Date.now()}.db`)

const { initDb, getDb } = await import('../db/index.js')
const svc = await import('./user-dcr-connections.js')

function seedUser(id: number, username: string): void {
  getDb()
    .prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, 'x', 'member')`)
    .run(id, username)
}

beforeAll(() => {
  initDb()
})

beforeEach(() => {
  getDb().exec('DELETE FROM user_dcr_connections; DELETE FROM users;')
})

describe('user-dcr-connections storage', () => {
  it('encrypt -> store -> decrypt round-trips an OAuth grant', () => {
    seedUser(1, 'alice')
    svc.upsertOAuth('notion', 1, {
      accountLabel: "Alice's Workspace",
      accessToken: 'at-raw-value',
      refreshToken: 'rt-raw-value',
      accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      scopes: 'read write',
    })
    expect(svc.getDecryptedAccessToken('notion', 1, SERVER_ACTOR)).toBe('at-raw-value')
    expect(svc.getDecryptedRefreshToken('notion', 1, SERVER_ACTOR)).toBe('rt-raw-value')
  })

  it('encrypt -> store -> decrypt round-trips an api_key fallback, with no refresh token', () => {
    seedUser(1, 'alice')
    svc.upsertApiKey('linear', 1, { accountLabel: null, apiKey: 'lin_api_raw_value' })
    expect(svc.getDecryptedAccessToken('linear', 1, SERVER_ACTOR)).toBe('lin_api_raw_value')
    expect(svc.getDecryptedRefreshToken('linear', 1, SERVER_ACTOR)).toBeNull()
  })

  it('masked summary exposes auth_method and account_label, never the credential', () => {
    seedUser(1, 'alice')
    svc.upsertOAuth('notion', 1, { accountLabel: 'Acme Co', accessToken: 'secret-at' })
    const summary = svc.getForUser('notion', 1)
    expect(summary).toMatchObject({ connector_id: 'notion', auth_method: 'oauth', account_label: 'Acme Co' })
    expect(JSON.stringify(summary)).not.toContain('secret-at')
  })

  it('one user can connect two different dcr_mcp connectors independently', () => {
    seedUser(1, 'alice')
    svc.upsertOAuth('notion', 1, { accountLabel: 'Notion WS', accessToken: 'notion-token' })
    svc.upsertApiKey('linear', 1, { accountLabel: null, apiKey: 'linear-key' })
    expect(svc.getForUser('notion', 1)?.auth_method).toBe('oauth')
    expect(svc.getForUser('linear', 1)?.auth_method).toBe('api_key')
    expect(svc.getDecryptedAccessToken('notion', 1, SERVER_ACTOR)).toBe('notion-token')
    expect(svc.getDecryptedAccessToken('linear', 1, SERVER_ACTOR)).toBe('linear-key')
  })

  it('a connection belongs to one person: another user acting for themself cannot read it', () => {
    seedUser(1, 'alice')
    seedUser(2, 'bob')
    svc.upsertOAuth('notion', 1, { accountLabel: null, accessToken: 'alice-secret' })
    expect(svc.getDecryptedAccessToken('notion', 1, { kind: 'user', userId: 2 })).toBeNull()
  })

  it('upsert replaces a prior connection for the same (connector, user)', () => {
    seedUser(1, 'alice')
    svc.upsertApiKey('linear', 1, { accountLabel: null, apiKey: 'old-key' })
    svc.upsertOAuth('linear', 1, { accountLabel: 'Linear WS', accessToken: 'new-token', refreshToken: 'new-refresh' })
    const summary = svc.getForUser('linear', 1)
    expect(summary?.auth_method).toBe('oauth')
    expect(svc.getDecryptedAccessToken('linear', 1, SERVER_ACTOR)).toBe('new-token')
  })

  it('recordError sets last_error without touching the stored credential', () => {
    seedUser(1, 'alice')
    svc.upsertOAuth('notion', 1, { accountLabel: null, accessToken: 'still-here' })
    svc.recordError('notion', 1, 'Notion rejected the refresh token.')
    expect(svc.getForUser('notion', 1)?.last_error).toBe('Notion rejected the refresh token.')
    expect(svc.getDecryptedAccessToken('notion', 1, SERVER_ACTOR)).toBe('still-here')
  })

  it('deleteForUser removes the row and reports whether one existed', () => {
    seedUser(1, 'alice')
    svc.upsertApiKey('linear', 1, { accountLabel: null, apiKey: 'key' })
    expect(svc.deleteForUser('linear', 1)).toBe(true)
    expect(svc.getForUser('linear', 1)).toBeNull()
    expect(svc.deleteForUser('linear', 1)).toBe(false)
  })
})
