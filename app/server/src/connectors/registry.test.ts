import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')

// Same defensive env setup as routes/connectors.test.ts.
process.env.TEST_CRED_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64')
process.env.JWT_SECRET = 'test-secret-connectors-registry'
process.env.DB_PATH = path.join(os.tmpdir(), `cc-connectors-registry-${process.pid}-${Date.now()}.db`)

const { listConnectors, __loadConnectorsFrom } = await import('./registry.js')

function fixtureDir(name: string, authPathLine: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cc-connector-registry-${name}-`))
  fs.writeFileSync(
    path.join(dir, 'fixture.mjs'),
    `export default {
      id: 'fixture-${name}', name: 'Fixture', description: 'A fixture connector.',
      ${authPathLine}
      connect: { kind: 'token', fields: [] },
      status: () => ({ state: 'not_connected', account: null, details: [], connected_at: null, checked_at: null, error: null }),
      disconnect: async () => {},
    }\n`,
  )
  return dir
}

afterEach(async () => {
  // Reset the module-level cache so other test files in the same process see
  // the real defs/ directory again.
  await __loadConnectorsFrom(null)
})

describe('connector registry', () => {
  it('loads every real connector def in connectors/defs/, each with a valid auth_path', async () => {
    const defs = await listConnectors()
    expect(defs.length).toBeGreaterThanOrEqual(2)
    const ids = defs.map(d => d.id).sort()
    expect(ids).toEqual(expect.arrayContaining(['github', 'google-workspace']))
    for (const d of defs) {
      expect(['dcr_mcp', 'oauth_guided', 'api_key', 'self_hosted_aggregator']).toContain(d.auth_path)
    }
  })

  it('tags github as api_key and google-workspace as oauth_guided', async () => {
    const defs = await listConnectors()
    const github = defs.find(d => d.id === 'github')
    const google = defs.find(d => d.id === 'google-workspace')
    expect(github?.auth_path).toBe('api_key')
    expect(google?.auth_path).toBe('oauth_guided')
  })

  // Sprint 7.4 catalog preload (obj 900508, PR #681 §3 / #900505 verification).
  it('loads all 20 preload catalog entries with the verified auth_path and a setup_guide on disk', async () => {
    const expected: Record<string, 'dcr_mcp' | 'oauth_guided' | 'api_key' | 'self_hosted_aggregator'> = {
      github: 'api_key',
      'google-workspace': 'oauth_guided',
      slack: 'oauth_guided',
      'microsoft-365': 'oauth_guided',
      hubspot: 'oauth_guided',
      discord: 'oauth_guided',
      intercom: 'oauth_guided',
      cloudflare: 'api_key',
      airtable: 'api_key',
      clickup: 'api_key',
      calendly: 'api_key',
      'cal-com': 'api_key',
      docuseal: 'api_key',
      supabase: 'api_key',
      // Sprint 7.5-verified: own auth server supports DCR/CIMD, but the shared
      // DCR client (Sprint 7.3) is out of scope for this card — see
      // connectors/lib/deferred-connector.ts.
      notion: 'dcr_mcp',
      linear: 'dcr_mcp',
      atlassian: 'dcr_mcp',
      sentry: 'dcr_mcp',
      stripe: 'oauth_guided',
    }
    const defs = await listConnectors()
    const byId = Object.fromEntries(defs.map(d => [d.id, d]))
    for (const [id, authPath] of Object.entries(expected)) {
      const def = byId[id]
      expect(def, `missing connector def for "${id}"`).toBeDefined()
      expect(def.auth_path, `"${id}" auth_path`).toBe(authPath)
      expect(def.setup_guide, `"${id}" setup_guide`).toBeTruthy()
      const guidePath = path.join(REPO_ROOT, def.setup_guide as string)
      expect(fs.existsSync(guidePath), `setup guide missing on disk: ${guidePath}`).toBe(true)
    }
    expect(defs.length).toBe(Object.keys(expected).length)
  })

  it('loads a fixture connector with a valid auth_path', async () => {
    const dir = fixtureDir('valid', "auth_path: 'api_key',")
    try {
      const defs = await __loadConnectorsFrom(dir)
      expect(defs.map(d => d.id)).toEqual(['fixture-valid'])
      expect(defs[0].auth_path).toBe('api_key')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects a connector with an invalid auth_path', async () => {
    const dir = fixtureDir('invalid', "auth_path: 'not_a_real_path',")
    try {
      const defs = await __loadConnectorsFrom(dir)
      expect(defs).toEqual([])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects a connector missing auth_path entirely', async () => {
    const dir = fixtureDir('missing', '')
    try {
      const defs = await __loadConnectorsFrom(dir)
      expect(defs).toEqual([])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
