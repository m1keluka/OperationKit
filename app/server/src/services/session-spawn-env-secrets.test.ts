import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import os from 'os'
import path from 'path'
import type { Objective } from '@command-center/shared'

// obj-2353 / W3 — native scoped-secrets injection into buildSpawnEnv.
//
// THE load-bearing guarantee (same contract as session-spawn-env.test.ts): with
// USE_SCOPED_SECRETS OFF (the committed default), the new flag-gated block does
// NOT run — buildSpawnEnv adds ZERO keys and the env is byte-for-byte identical to
// today. The flag-ON path then proves the scoped store's resolved set is merged.
//
// Key + isolated DB must be set BEFORE importing modules that read them at first
// use (mirrors secrets-store.test.ts / user-github-tokens.test.ts).
process.env.SECRETS_MASTER_KEY = Buffer.alloc(32, 11).toString('base64')
const TMP_DB = path.join(os.tmpdir(), `cc-w3-secrets-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const store = await import('./secrets-store.js')

function fakeObjective(over: Partial<Objective> = {}): Objective {
  return { id: 42, workspace: 'example', project: 'example-platform', created_by: 7, ...over } as Objective
}

function seedUser(id: number, username: string): void {
  getDb()
    .prepare(`INSERT OR IGNORE INTO users (id, username, password_hash, role) VALUES (?, ?, 'x', 'member')`)
    .run(id, username)
}

beforeAll(() => {
  initDb()
})

beforeEach(() => {
  getDb().exec(
    'DELETE FROM secret_access_log; DELETE FROM secret_versions; DELETE FROM secrets; DELETE FROM users;',
  )
  seedUser(1, 'admin')
  seedUser(7, 'eva')
})

describe('buildSpawnEnv — USE_SCOPED_SECRETS OFF: zero new keys', () => {
  it('adds NO native-store keys even when secrets exist in the store', async () => {
    store.setSecret({ scope: { scopeType: 'global' }, key: 'OPENAI_API_KEY', value: 'sk-global', actorUserId: 1 })
    store.setSecret({ scope: { scopeType: 'workspace', workspace: 'example' }, key: 'WS_ONLY', value: 'w', actorUserId: 1 })

    process.env.USE_SCOPED_SECRETS = '0'
    vi.resetModules()
    const freshDb = await import('../db/index.js')
    freshDb.initDb()
    const sm = await import('./session-manager.js')
    const env = sm.buildSpawnEnv({ objective: fakeObjective(), homeDir: '/home/ccuser-a', sessionKind: 'worker' })

    // The 8-key base contract PLUS the obj-701130 git-author fallback (4 keys,
    // same list locked by session-spawn-env.test.ts). USE_SCOPED_SECRETS OFF still
    // adds zero *secret-store* keys — the fallback is unrelated to the flag.
    expect(Object.keys(env)).toEqual([
      'HOME', 'USER', 'TERM', 'PATH', 'GIT_SSH_COMMAND', 'GH_CONFIG_DIR',
      'SUPABASE_ACCESS_TOKEN',
      'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL',
      // obj-706070: the per-user Google resolver ALWAYS appends this marker so a
      // session can distinguish "acting user's Google account" from "none". With
      // no connection seeded it is the only Google key ('absent'); the token keys
      // appear only on the connected branch (session-google-credential.test.ts).
      'GOOGLE_WORKSPACE_CONNECTION',
      'WORKSPACE_MCP_CREDENTIALS_DIR',
      'CC_ACTING_USER_ID',
    ])
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.WS_ONLY).toBeUndefined()
  })
})

describe('buildSpawnEnv — USE_SCOPED_SECRETS ON: scoped set merged', () => {
  // The flag is read at module import from process.env. Re-import a fresh module
  // graph with the flag ON to exercise the dormant cutover branch (same technique
  // session-spawn-env.test.ts uses for USE_SCOPED_DOPPLER_TOKENS).
  let savedFlag: string | undefined
  beforeEach(() => {
    savedFlag = process.env.USE_SCOPED_SECRETS
    process.env.USE_SCOPED_SECRETS = '1'
  })
  afterEach(() => {
    if (savedFlag === undefined) delete process.env.USE_SCOPED_SECRETS
    else process.env.USE_SCOPED_SECRETS = savedFlag
    vi.resetModules()
  })

  it('merges the resolved (global+workspace+user) secret set into the spawn env', async () => {
    store.setSecret({ scope: { scopeType: 'global' }, key: 'OPENAI_API_KEY', value: 'sk-global', actorUserId: 1 })
    store.setSecret({ scope: { scopeType: 'workspace', workspace: 'example' }, key: 'WS_KEY', value: 'ws-example', actorUserId: 1 })
    store.setSecret({ scope: { scopeType: 'user', userId: 7 }, key: 'USER_KEY', value: 'user-7', actorUserId: 1 })
    // workspace_user overrides a same-named global for this (workspace,user).
    store.setSecret({ scope: { scopeType: 'global' }, key: 'OVERRIDE', value: 'global-val', actorUserId: 1 })
    store.setSecret({ scope: { scopeType: 'workspace_user', workspace: 'example', userId: 7 }, key: 'OVERRIDE', value: 'wsuser-val', actorUserId: 1 })

    vi.resetModules()
    // The fresh module graph has its own uninitialized db handle pointing at the
    // SAME DB_PATH file; re-init it so resolveSecrets sees the rows seeded above.
    const freshDb = await import('../db/index.js')
    freshDb.initDb()
    const sm = await import('./session-manager.js')
    const env = sm.buildSpawnEnv({ objective: fakeObjective(), homeDir: '/home/ccuser-a', sessionKind: 'worker' })

    expect(env.OPENAI_API_KEY).toBe('sk-global')
    expect(env.WS_KEY).toBe('ws-example')
    expect(env.USER_KEY).toBe('user-7')
    expect(env.OVERRIDE).toBe('wsuser-val') // most-specific-wins
    // Base keys are still present (scoped set is additive over the base).
    expect(env.HOME).toBe('/home/ccuser-a')
    expect(env.USER).toBe('ccuser')
  })

  it('writes one inject audit row per resolved key', async () => {
    store.setSecret({ scope: { scopeType: 'global' }, key: 'A_KEY', value: 'a', actorUserId: 1 })
    store.setSecret({ scope: { scopeType: 'global' }, key: 'B_KEY', value: 'b', actorUserId: 1 })

    vi.resetModules()
    // The fresh module graph has its own uninitialized db handle pointing at the
    // SAME DB_PATH file; re-init it so resolveSecrets sees the rows seeded above.
    const freshDb = await import('../db/index.js')
    freshDb.initDb()
    const sm = await import('./session-manager.js')
    const freshStore = await import('./secrets-store.js')
    sm.buildSpawnEnv({ objective: fakeObjective(), homeDir: '/home/ccuser-a', sessionKind: 'worker' })

    const injects = freshStore.recentAccessLog(50).filter(r => r.action === 'inject')
    const keys = injects.map(r => r.key).sort()
    expect(keys).toEqual(['A_KEY', 'B_KEY'])
  })

  // THE cross-organization criterion: a `user`-scoped secret belongs to the
  // PERSON, so it must follow them into every organization they spawn in, while
  // `workspace`-scoped secrets stay pinned to their own organization. Both halves
  // are asserted together — a "carries everywhere" pass that also leaked the org
  // secrets would be a leak-everything bug, not real scoping.
  it('a user-scoped secret follows the user across organizations while workspace secrets stay pinned', async () => {
    store.setSecret({ scope: { scopeType: 'user', userId: 7 }, key: 'PERSONAL_TOKEN', value: 'tok-eva-personal', actorUserId: 7 })
    store.setSecret({ scope: { scopeType: 'workspace', workspace: 'example' }, key: 'EXAMPLE_ONLY', value: 'example-val', actorUserId: 1 })
    store.setSecret({ scope: { scopeType: 'workspace', workspace: 'example2' }, key: 'EXAMPLE2_ONLY', value: 'example2-val', actorUserId: 1 })

    vi.resetModules()
    // The fresh module graph has its own uninitialized db handle pointing at the
    // SAME DB_PATH file; re-init it so resolveSecrets sees the rows seeded above.
    const freshDb = await import('../db/index.js')
    freshDb.initDb()
    const sm = await import('./session-manager.js')

    const exampleEnv = sm.buildSpawnEnv({
      objective: fakeObjective({ id: 1, workspace: 'example', created_by: 7 }),
      homeDir: '/home/ccuser-a',
      sessionKind: 'worker',
    })
    const example2Env = sm.buildSpawnEnv({
      objective: fakeObjective({ id: 2, workspace: 'example2', created_by: 7 }),
      homeDir: '/home/ccuser-a',
      sessionKind: 'worker',
    })

    // The user's own secret crosses organizations, identically.
    expect(exampleEnv.PERSONAL_TOKEN).toBe('tok-eva-personal')
    expect(example2Env.PERSONAL_TOKEN).toBe('tok-eva-personal')
    expect(example2Env.PERSONAL_TOKEN).toBe(exampleEnv.PERSONAL_TOKEN)

    // Organization secrets do NOT cross over.
    expect(exampleEnv.EXAMPLE_ONLY).toBe('example-val')
    expect(exampleEnv.EXAMPLE2_ONLY).toBeUndefined()
    expect(example2Env.EXAMPLE2_ONLY).toBe('example2-val')
    expect(example2Env.EXAMPLE_ONLY).toBeUndefined()

    // A DIFFERENT user in the same organization gets the org secret but never
    // user 7's personal one.
    const otherUserEnv = sm.buildSpawnEnv({
      objective: fakeObjective({ id: 3, workspace: 'example', created_by: 1 }),
      homeDir: '/home/ccuser-a',
      sessionKind: 'worker',
    })
    expect(otherUserEnv.EXAMPLE_ONLY).toBe('example-val')
    expect(otherUserEnv.PERSONAL_TOKEN).toBeUndefined()
  })

  it('an empty store adds no scoped keys even with the flag ON (env = 8-key base + git-author fallback)', async () => {
    vi.resetModules()
    // The fresh module graph has its own uninitialized db handle pointing at the
    // SAME DB_PATH file; re-init it so resolveSecrets sees the rows seeded above.
    const freshDb = await import('../db/index.js')
    freshDb.initDb()
    const sm = await import('./session-manager.js')
    const env = sm.buildSpawnEnv({ objective: fakeObjective(), homeDir: '/home/ccuser-a', sessionKind: 'worker' })
    // No secret-store keys added; the trailing 4 keys are the obj-701130 fallback
    // (injected before the scoped-secrets block, independent of USE_SCOPED_SECRETS).
    expect(Object.keys(env)).toEqual([
      'HOME', 'USER', 'TERM', 'PATH', 'GIT_SSH_COMMAND', 'GH_CONFIG_DIR',
      'SUPABASE_ACCESS_TOKEN',
      'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL',
      // obj-706070: the per-user Google resolver ALWAYS appends this marker so a
      // session can distinguish "acting user's Google account" from "none". With
      // no connection seeded it is the only Google key ('absent'); the token keys
      // appear only on the connected branch (session-google-credential.test.ts).
      'GOOGLE_WORKSPACE_CONNECTION',
      'WORKSPACE_MCP_CREDENTIALS_DIR',
      'CC_ACTING_USER_ID',
    ])
  })
})
