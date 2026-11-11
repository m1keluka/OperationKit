import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import os from 'os'
import path from 'path'

// Encryption key + isolated DB must be set BEFORE importing the modules that
// read them at import/first-use time. Mirrors services/user-github-tokens.test.ts.
process.env.TEST_CRED_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64')
process.env.DB_PATH = path.join(os.tmpdir(), `cc-dcrreg-test-${process.pid}-${Date.now()}.db`)

const { initDb, getDb } = await import('../db/index.js')
const svc = await import('./dcr-client-registrations.js')

beforeAll(() => {
  initDb()
})

beforeEach(() => {
  getDb().exec('DELETE FROM dcr_client_registrations;')
})

describe('dcr-client-registrations storage', () => {
  it('stores a CIMD registration with no client_secret', () => {
    const saved = svc.saveRegistration('notion', {
      issuer: 'https://mcp.notion.com',
      method: 'cimd',
      clientId: 'https://ai.example.com/api/connectors/dcr-client-metadata/notion.json',
      redirectUri: 'https://ai.example.com/api/user/dcr/notion/callback',
    })
    expect(saved.registration_method).toBe('cimd')
    expect(saved.has_client_secret).toBe(false)
    expect(svc.getDecryptedClientSecret('notion')).toBeNull()
  })

  it('encrypt -> store -> decrypt round-trips a DCR client_secret', () => {
    const saved = svc.saveRegistration('linear', {
      issuer: 'https://mcp.linear.app',
      method: 'dcr',
      clientId: 'registered-client-id',
      clientSecret: 'super-secret-value',
      redirectUri: 'https://ai.example.com/api/user/dcr/linear/callback',
    })
    expect(saved.has_client_secret).toBe(true)
    expect(svc.getDecryptedClientSecret('linear')).toBe('super-secret-value')
  })

  it('never exposes the secret in the masked summary', () => {
    svc.saveRegistration('linear', {
      issuer: 'https://mcp.linear.app',
      method: 'dcr',
      clientId: 'registered-client-id',
      clientSecret: 'super-secret-value',
      redirectUri: 'https://ai.example.com/cb',
    })
    const row = svc.getRegistration('linear')
    expect(row).not.toBeNull()
    expect(JSON.stringify(row)).not.toContain('super-secret-value')
  })

  it('getRegistration returns null when never registered', () => {
    expect(svc.getRegistration('ghost')).toBeNull()
  })

  it('upsert replaces a prior registration for the same connector', () => {
    svc.saveRegistration('notion', {
      issuer: 'https://mcp.notion.com',
      method: 'dcr',
      clientId: 'old-client',
      clientSecret: 'old-secret',
      redirectUri: 'https://ai.example.com/cb',
    })
    const updated = svc.saveRegistration('notion', {
      issuer: 'https://mcp.notion.com',
      method: 'cimd',
      clientId: 'https://ai.example.com/meta.json',
      redirectUri: 'https://ai.example.com/cb',
    })
    expect(updated.registration_method).toBe('cimd')
    expect(updated.client_id).toBe('https://ai.example.com/meta.json')
    expect(svc.getDecryptedClientSecret('notion')).toBeNull()
  })

  it('deleteRegistration removes the row and reports whether one existed', () => {
    svc.saveRegistration('notion', {
      issuer: 'https://mcp.notion.com',
      method: 'cimd',
      clientId: 'https://ai.example.com/meta.json',
      redirectUri: 'https://ai.example.com/cb',
    })
    expect(svc.deleteRegistration('notion')).toBe(true)
    expect(svc.getRegistration('notion')).toBeNull()
    expect(svc.deleteRegistration('notion')).toBe(false)
  })
})
