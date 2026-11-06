/**
 * obj 900208 — coding sessions use the GitHub connection from Settings →
 * Connectors; a GH_TOKEN secret is an optional override, not the only path.
 *
 * Covers the three gaps that made Example Project cards ask for a GH_TOKEN secret:
 *   1. plain `git push` over https had no credential helper → GIT_CONFIG_* env
 *   2. the prompt never named the connector token → buildGithubAccessLines
 *   3. ownerless child cards → internal-create-ownership.test.ts
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { Objective } from '@operationkit/shared'

process.env.TEST_CRED_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64')
const TMP_DB = path.join(os.tmpdir(), `cc-gh-connector-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.CC_SESSION_KB_ACCESS = '0'

const { initDb, getDb } = await import('../db/index.js')
const tokens = await import('./user-github-tokens.js')
const {
  buildSpawnEnv,
  githubPushHelperEnv,
  githubSessionAccess,
  GITHUB_HELPER_CONFIG_KEY,
  GITHUB_HELPER_CONFIG_VALUE,
} = await import('./session-spawn-env.js')
const { buildGithubAccessLines } = await import('./session-trust-prompt.js')
const { setAccess } = await import('../connectors/access.js')

const OWNER = 11
const OTHER = 12
const PAT = 'github_pat_11CONNECTOR_ownerSecret_9999'

function seedUser(id: number, username: string): void {
  getDb().prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, 'x', 'member')`).run(id, username)
}
function connect(userId: number): void {
  tokens.upsert(userId, { rawToken: PAT, login: 'owner-gh', githubUserId: 1, email: '1+owner-gh@users.noreply.github.com', scopes: null, tokenType: 'pat_fine' })
}
function card(over: Partial<Objective> & { agent_key_id?: number | null; agent_key_label?: string | null } = {}): Objective {
  return { id: 900208, workspace: 'ws-a', agent_context: 'cto', project: 'x', created_by: OWNER, ...over } as Objective
}
function addKey(userId: number, connectors: string[]): number {
  const r = getDb()
    .prepare(`INSERT INTO agent_api_keys (user_id, label, key_hash, last4, scopes, connectors) VALUES (?, 'cos-bot', ?, 'abcd', '[]', ?)`)
    .run(userId, `h${Math.random()}`, JSON.stringify(connectors))
  return Number(r.lastInsertRowid)
}

beforeAll(() => { initDb() })
beforeEach(() => {
  getDb().exec('DELETE FROM user_github_tokens; DELETE FROM agent_api_keys; DELETE FROM users;')
  try { getDb().exec('DELETE FROM connector_access') } catch { /* lazy */ }
  seedUser(OWNER, 'owner')
  seedUser(OTHER, 'other')
})

describe('githubPushHelperEnv', () => {
  it('adds nothing without a GitHub token', () => {
    expect(githubPushHelperEnv({})).toEqual({})
    expect(githubPushHelperEnv({ GH_TOKEN: '' })).toEqual({})
  })
  it('adds an env-scoped github.com helper when a token is present (GH_TOKEN or GITHUB_TOKEN)', () => {
    const expected = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: GITHUB_HELPER_CONFIG_KEY, GIT_CONFIG_VALUE_0: GITHUB_HELPER_CONFIG_VALUE }
    expect(githubPushHelperEnv({ GH_TOKEN: 't' })).toEqual(expected)
    expect(githubPushHelperEnv({ GITHUB_TOKEN: 't' })).toEqual(expected)
  })
  it('appends after GIT_CONFIG entries that are already set', () => {
    expect(githubPushHelperEnv({ GH_TOKEN: 't', GIT_CONFIG_COUNT: '2' })).toEqual({
      GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_2: GITHUB_HELPER_CONFIG_KEY, GIT_CONFIG_VALUE_2: GITHUB_HELPER_CONFIG_VALUE,
    })
  })
  it('never carries the token or a `$` (the tmux wrapper exports values in double quotes)', () => {
    const env = githubPushHelperEnv({ GH_TOKEN: PAT })
    for (const v of Object.values(env)) {
      expect(v).not.toContain(PAT)
      expect(v).not.toContain('$')
    }
  })
})

describe('buildSpawnEnv — GitHub connector reaches coding sessions', () => {
  it('connected owner: GH_TOKEN from the connector + the push helper', () => {
    connect(OWNER)
    const env = buildSpawnEnv({ objective: card(), homeDir: '/tmp/h', sessionKind: 'worker' })
    expect(env.GH_TOKEN).toBe(PAT)
    expect(env.GITHUB_TOKEN).toBe(PAT)
    expect(env.GIT_CONFIG_COUNT).toBe('1')
    expect(env.GIT_CONFIG_KEY_0).toBe(GITHUB_HELPER_CONFIG_KEY)
    expect(env.GIT_CONFIG_VALUE_0).toBe(GITHUB_HELPER_CONFIG_VALUE)
  })
  it('not connected: no token and no helper (env unchanged)', () => {
    const env = buildSpawnEnv({ objective: card(), homeDir: '/tmp/h', sessionKind: 'worker' })
    expect(env.GH_TOKEN).toBeUndefined()
    expect(env.GIT_CONFIG_COUNT).toBeUndefined()
  })
  it('scoping: another user\'s connection never reaches this card', () => {
    connect(OTHER)
    const env = buildSpawnEnv({ objective: card(), homeDir: '/tmp/h', sessionKind: 'worker' })
    expect(env.GH_TOKEN).toBeUndefined()
  })
})

const ghAvailable = (() => { try { execFileSync('gh', ['--version'], { stdio: 'pipe' }); return true } catch { return false } })()

describe.skipIf(!ghAvailable)('the helper answers git\'s real credential protocol from the env', () => {
  it('git credential fill returns the session token for github.com, nothing for other hosts', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gh-helper-'))
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      GH_CONFIG_DIR: home,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      GH_TOKEN: 'ghp_fakeTokenForHelperTest',
      ...githubPushHelperEnv({ GH_TOKEN: 'x' }),
    }
    const out = execFileSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n', env, encoding: 'utf8' })
    expect(out).toContain('password=ghp_fakeTokenForHelperTest')
    expect(() =>
      execFileSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=gitlab.example\n\n', env, encoding: 'utf8', stdio: 'pipe' }),
    ).toThrow()
  })
})

describe('githubSessionAccess + buildGithubAccessLines — the prompt names the real fix', () => {
  const none = new Set<string>()
  it('connected: names the account and says not to ask for a GH_TOKEN secret', () => {
    connect(OWNER)
    expect(githubSessionAccess(card())).toMatchObject({ state: 'connected', login: 'owner-gh' })
    const text = buildGithubAccessLines(card(), none).join('\n')
    expect(text).toContain('connected as `owner-gh`')
    expect(text).toContain('Settings → Connectors')
    expect(text).toContain('Do NOT ask for a `GH_TOKEN` secret')
    expect(text).not.toContain(PAT)
  })
  it('not connected: points at Settings → Connectors, Secrets only as an optional override', () => {
    expect(githubSessionAccess(card())).toMatchObject({ state: 'unavailable', reason: 'not_connected' })
    const text = buildGithubAccessLines(card(), none).join('\n')
    expect(text).toContain('Settings → Connectors → GitHub')
    expect(text).toContain('only an optional override')
  })
  it('no owner: says so instead of asking for a secret', () => {
    const c = card({ created_by: null } as Partial<Objective>)
    expect(githubSessionAccess(c)).toMatchObject({ state: 'unavailable', reason: 'no_owner' })
    expect(buildGithubAccessLines(c, none).join('\n')).toContain('this card has no owner')
  })
  it('agent key without GitHub: names the key and Settings → API keys', () => {
    connect(OWNER)
    const keyId = addKey(OWNER, [])
    const c = card({ agent_key_id: keyId, agent_key_label: 'cos-bot' })
    expect(githubSessionAccess(c)).toMatchObject({ state: 'unavailable', reason: 'key_connector' })
    expect(buildGithubAccessLines(c, none).join('\n')).toContain('API key "cos-bot"')
    // …and the spawn env agrees: the key's limit is honoured.
    expect(buildSpawnEnv({ objective: c, homeDir: '/tmp/h', sessionKind: 'worker' }).GH_TOKEN).toBeUndefined()
  })
  it('agent key WITH GitHub: connected', () => {
    connect(OWNER)
    const keyId = addKey(OWNER, ['github'])
    expect(githubSessionAccess(card({ agent_key_id: keyId }))).toMatchObject({ state: 'connected' })
  })
  it('delegated card: names the opt-in, and the opt-in turns it on', () => {
    connect(OWNER)
    const c = card({ created_by: OTHER, assigned_user_id: OWNER } as Partial<Objective>)
    expect(githubSessionAccess(c)).toMatchObject({ state: 'unavailable', reason: 'delegated_card' })
    expect(buildGithubAccessLines(c, none).join('\n')).toContain('work assigned by others')
    setAccess('github', OWNER, { agents: null, workspaces: null, allow_delegated: true })
    expect(githubSessionAccess(c)).toMatchObject({ state: 'connected' })
  })
  it('a GH_TOKEN secret is reported as an override', () => {
    const text = buildGithubAccessLines(card(), new Set(['GH_TOKEN'])).join('\n')
    expect(text).toContain('overrides any GitHub connection')
  })
  it('the decision is the same one buildSpawnEnv makes (token present ⇔ connected)', () => {
    connect(OWNER)
    for (const c of [card(), card({ created_by: null } as Partial<Objective>), card({ created_by: OTHER, assigned_user_id: OWNER } as Partial<Objective>)]) {
      const hasToken = !!buildSpawnEnv({ objective: c, homeDir: '/tmp/h', sessionKind: 'worker' }).GH_TOKEN
      expect(githubSessionAccess(c).state === 'connected').toBe(hasToken)
    }
  })
})
