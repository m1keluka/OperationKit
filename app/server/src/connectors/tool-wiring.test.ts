/**
 * Sprint 7.6 (obj 900509) — proves the Tools-layer wiring fixtures in
 * `docs/connectors/tool-wiring/*.tool.json` are not a parallel, invented
 * credential path: every `auth.secrets[].env` name they declare is a real env
 * var that the existing connector credential path (`readCredential` →
 * `canUseConnectorCredential` → session env, or the connector-specific
 * `buildSpawnEnv()`) actually sets, and every fixture's `connector_id` /
 * `auth_path` matches a real, loaded `ConnectorDefinition`.
 *
 * See docs/connectors/TOOLS-LAYER-WIRING.md.
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

process.env.TEST_CRED_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64')
process.env.JWT_SECRET = 'test-secret-tool-wiring'
process.env.DB_PATH = path.join(os.tmpdir(), `cc-tool-wiring-${process.pid}-${Date.now()}.db`)

const { listConnectors } = await import('./registry.js')
const { CONNECTOR_AUTH_PATHS } = await import('./types.js')

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../')
const FIXTURES_DIR = path.join(REPO_ROOT, 'docs/connectors/tool-wiring')
const SPAWN_ENV_SRC = fs.readFileSync(
  path.join(REPO_ROOT, 'app/server/src/services/session-spawn-env.ts'),
  'utf8',
)

interface ToolSecret {
  env: string
  source: string
  note?: string
}

interface ToolFixture {
  frontmatter: {
    name: string
    connector_id: string
    auth_path: string
    auth: { secrets: ToolSecret[] }
  }
  body: string
}

function loadFixture(file: string): ToolFixture {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, file), 'utf8'))
}

const FIXTURE_FILES = ['github.tool.json', 'google-workspace.tool.json']

describe('Tools-layer wiring fixtures (docs/connectors/tool-wiring)', () => {
  it('ship exactly the two representative auth_paths this card wires (api_key, oauth_guided)', () => {
    expect(fs.readdirSync(FIXTURES_DIR).filter(f => f.endsWith('.tool.json')).sort()).toEqual(
      [...FIXTURE_FILES].sort(),
    )
  })

  for (const file of FIXTURE_FILES) {
    it(`${file}: declares a valid auth_path and at least one named secret`, () => {
      const fixture = loadFixture(file)
      expect(CONNECTOR_AUTH_PATHS as string[]).toContain(fixture.frontmatter.auth_path)
      expect(fixture.frontmatter.auth.secrets.length).toBeGreaterThan(0)
      for (const secret of fixture.frontmatter.auth.secrets) {
        expect(secret.env).toMatch(/^[A-Z][A-Z0-9_]*$/)
        expect(secret).not.toHaveProperty('value')
      }
    })

    it(`${file}: connector_id + auth_path match a real, loaded ConnectorDefinition`, async () => {
      const fixture = loadFixture(file)
      const defs = await listConnectors()
      const def = defs.find(d => d.id === fixture.frontmatter.connector_id)
      expect(def, `no connector def with id "${fixture.frontmatter.connector_id}"`).toBeTruthy()
      expect(def!.auth_path).toBe(fixture.frontmatter.auth_path)
    })

    it(`${file}: every declared env var is actually set by the real credential path (session-spawn-env.ts)`, () => {
      const fixture = loadFixture(file)
      for (const secret of fixture.frontmatter.auth.secrets) {
        expect(
          SPAWN_ENV_SRC.includes(secret.env),
          `"${secret.env}" (declared in ${file}) does not appear in session-spawn-env.ts — ` +
            `this would be an invented env var, not a real one`,
        ).toBe(true)
      }
    })
  }

  it('github fixture declares GH_TOKEN and its GITHUB_TOKEN alias (both set together in session-spawn-env.ts)', () => {
    const names = loadFixture('github.tool.json').frontmatter.auth.secrets.map(s => s.env)
    expect(names).toEqual(expect.arrayContaining(['GH_TOKEN', 'GITHUB_TOKEN']))
  })

  it('google-workspace fixture declares the connection-state var and the scoped-account var', () => {
    const names = loadFixture('google-workspace.tool.json').frontmatter.auth.secrets.map(s => s.env)
    expect(names).toEqual(expect.arrayContaining(['GOOGLE_WORKSPACE_CONNECTION', 'USER_GOOGLE_EMAIL']))
  })

  it('the rendered example TOOL.md for each fixture exists under examples/workspace/tools/', () => {
    for (const file of FIXTURE_FILES) {
      const fixture = loadFixture(file)
      const rendered = path.join(REPO_ROOT, 'examples/workspace/tools', fixture.frontmatter.name, 'TOOL.md')
      expect(fs.existsSync(rendered), `missing rendered Tool for ${file} at ${rendered}`).toBe(true)
      const content = fs.readFileSync(rendered, 'utf8')
      for (const secret of fixture.frontmatter.auth.secrets) {
        expect(content.includes(secret.env), `${rendered} does not mention ${secret.env}`).toBe(true)
      }
    }
  })
})
