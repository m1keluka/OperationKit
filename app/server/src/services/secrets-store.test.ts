import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import os from 'os'
import path from 'path'

// Key + isolated DB must be set BEFORE importing modules that read them at
// first use. Mirrors user-github-tokens.test.ts.
process.env.SECRETS_MASTER_KEY = Buffer.alloc(32, 11).toString('base64')
const TMP_DB = path.join(os.tmpdir(), `cc-secrets-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const store = await import('./secrets-store.js')

function seedUser(id: number, username: string): void {
  getDb()
    .prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, 'x', 'member')`)
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

describe('secrets-store CRUD + encryption at rest', () => {
  it('create stores ciphertext (no plaintext in DB) and returns a value-free summary', () => {
    const summary = store.setSecret({
      scope: { scopeType: 'global' },
      key: 'OPENAI_API_KEY',
      value: 'sk-plaintext-value',
      actorUserId: 1,
    })
    expect(summary.key).toBe('OPENAI_API_KEY')
    expect(summary.version).toBe(1)
    expect(summary.scopeType).toBe('global')
    expect(summary.workspace).toBeNull()
    expect(summary.userId).toBeNull()
    // The summary must not carry the value under any field.
    expect(JSON.stringify(summary)).not.toContain('sk-plaintext-value')

    // DB column holds ciphertext, never the plaintext.
    const raw = getDb()
      .prepare(`SELECT value_encrypted FROM secrets WHERE key = 'OPENAI_API_KEY'`)
      .get() as { value_encrypted: string }
    expect(raw.value_encrypted).not.toContain('sk-plaintext-value')
    expect(raw.value_encrypted.split('.')).toHaveLength(3)

    // Server-only seam decrypts back to the original.
    expect(store.getSecretValue({ scopeType: 'global' }, 'OPENAI_API_KEY')).toBe('sk-plaintext-value')
  })

  it('upsert (same scope+key) updates in place — no duplicate row — and bumps version', () => {
    const scope = { scopeType: 'workspace', workspace: 'example' } as const
    store.setSecret({ scope, key: 'K', value: 'v1', actorUserId: 1 })
    const s2 = store.setSecret({ scope, key: 'K', value: 'v2', actorUserId: 1 })
    expect(s2.version).toBe(2)
    const count = getDb().prepare(`SELECT COUNT(*) c FROM secrets WHERE key='K'`).get() as { c: number }
    expect(count.c).toBe(1)
    expect(store.getSecretValue(scope, 'K')).toBe('v2')
  })

  it('the same key at different scopes is independent (UNIQUE includes scope)', () => {
    store.setSecret({ scope: { scopeType: 'global' }, key: 'K', value: 'g' })
    store.setSecret({ scope: { scopeType: 'workspace', workspace: 'example' }, key: 'K', value: 'w' })
    expect(store.getSecretValue({ scopeType: 'global' }, 'K')).toBe('g')
    expect(store.getSecretValue({ scopeType: 'workspace', workspace: 'example' }, 'K')).toBe('w')
  })

  it('listSecrets returns metadata only, never values', () => {
    store.setSecret({ scope: { scopeType: 'global' }, key: 'A', value: 'secretA' })
    store.setSecret({ scope: { scopeType: 'global' }, key: 'B', value: 'secretB' })
    const list = store.listSecrets()
    expect(list.map(s => s.key)).toEqual(['A', 'B'])
    expect(JSON.stringify(list)).not.toContain('secretA')
    expect(JSON.stringify(list)).not.toContain('secretB')
  })

  it('delete removes the row and its versions', () => {
    const scope = { scopeType: 'user', userId: 7 } as const
    store.setSecret({ scope, key: 'K', value: 'v' })
    expect(store.deleteSecret(scope, 'K', 1)).toBe(true)
    expect(store.getSecret(scope, 'K')).toBeNull()
    expect(store.deleteSecret(scope, 'K', 1)).toBe(false) // already gone
  })

  it('rejects scopes missing a required dimension', () => {
    expect(() => store.setSecret({ scope: { scopeType: 'workspace' }, key: 'K', value: 'v' })).toThrow(/workspace/)
    expect(() => store.setSecret({ scope: { scopeType: 'user' }, key: 'K', value: 'v' })).toThrow(/userId/)
    expect(() =>
      store.setSecret({ scope: { scopeType: 'workspace_user', workspace: 'example' }, key: 'K', value: 'v' }),
    ).toThrow(/userId/)
  })
})

describe('secrets-store versioning', () => {
  it('snapshots every version and rolls back by re-applying an old value as a NEW version', () => {
    const scope = { scopeType: 'global' } as const
    store.setSecret({ scope, key: 'K', value: 'v1', actorUserId: 1 })
    store.setSecret({ scope, key: 'K', value: 'v2', actorUserId: 1 })
    store.setSecret({ scope, key: 'K', value: 'v3', actorUserId: 1 })

    const versions = store.listVersions(scope, 'K')
    expect(versions.map(v => v.version)).toEqual([3, 2, 1])

    const rolled = store.rollbackSecret(scope, 'K', 1, 7)
    expect(rolled?.version).toBe(4) // append-only history
    expect(store.getSecretValue(scope, 'K')).toBe('v1') // value restored
    expect(store.listVersions(scope, 'K').map(v => v.version)).toEqual([4, 3, 2, 1])
  })

  it('rollback to a non-existent version returns null', () => {
    const scope = { scopeType: 'global' } as const
    store.setSecret({ scope, key: 'K', value: 'v1' })
    expect(store.rollbackSecret(scope, 'K', 99, 1)).toBeNull()
  })
})

describe('secrets-store scoped resolution (global < workspace < user < workspace_user)', () => {
  it('most-specific scope wins for a shared key', () => {
    store.setSecret({ scope: { scopeType: 'global' }, key: 'TOK', value: 'global' })
    store.setSecret({ scope: { scopeType: 'workspace', workspace: 'example' }, key: 'TOK', value: 'ws' })
    store.setSecret({ scope: { scopeType: 'user', userId: 7 }, key: 'TOK', value: 'user' })
    store.setSecret({ scope: { scopeType: 'workspace_user', workspace: 'example', userId: 7 }, key: 'TOK', value: 'ws_user' })

    expect(store.resolveSecrets({ workspace: 'example', userId: 7 }).TOK).toBe('ws_user')
    expect(store.resolveSecrets({ workspace: 'example', userId: 99 }).TOK).toBe('ws') // no ws_user for 99 → workspace
    expect(store.resolveSecrets({ workspace: 'other', userId: 7 }).TOK).toBe('user') // no ws match → user
    expect(store.resolveSecrets({ workspace: 'other', userId: 99 }).TOK).toBe('global')
    expect(store.resolveSecrets({}).TOK).toBe('global')
  })

  it('merges distinct keys across scopes into one map', () => {
    store.setSecret({ scope: { scopeType: 'global' }, key: 'G', value: 'g' })
    store.setSecret({ scope: { scopeType: 'workspace', workspace: 'example' }, key: 'W', value: 'w' })
    store.setSecret({ scope: { scopeType: 'workspace_user', workspace: 'example', userId: 7 }, key: 'U', value: 'u' })
    const resolved = store.resolveSecrets({ workspace: 'example', userId: 7 })
    expect(resolved).toEqual({ G: 'g', W: 'w', U: 'u' })
  })

  it('does NOT leak workspace/user secrets when those dimensions are absent', () => {
    store.setSecret({ scope: { scopeType: 'workspace', workspace: 'example' }, key: 'WS_ONLY', value: 'w' })
    store.setSecret({ scope: { scopeType: 'user', userId: 7 }, key: 'USER_ONLY', value: 'u' })
    // No workspace, no user → only global-eligible keys (none here).
    expect(store.resolveSecrets({})).toEqual({})
    // Workspace given but a DIFFERENT user → no user_only leak.
    expect(store.resolveSecrets({ workspace: 'example', userId: 999 })).toEqual({ WS_ONLY: 'w' })
  })

  it('a sentinel-workspace ("") request never matches real workspace rows', () => {
    store.setSecret({ scope: { scopeType: 'workspace', workspace: 'example' }, key: 'K', value: 'w' })
    // workspace omitted resolves to sentinel internally — must not match 'example'.
    expect(store.resolveSecrets({ userId: 7 })).toEqual({})
  })

  it('a user-scoped secret resolves in EVERY organization (it belongs to the person, not the org)', () => {
    store.setSecret({ scope: { scopeType: 'user', userId: 7 }, key: 'PERSONAL_TOKEN', value: 'tok-eva-personal' })
    store.setSecret({ scope: { scopeType: 'workspace', workspace: 'example' }, key: 'EXAMPLE_ONLY', value: 'example-val' })
    store.setSecret({ scope: { scopeType: 'workspace', workspace: 'example2' }, key: 'EXAMPLE2_ONLY', value: 'example2-val' })

    const example = store.resolveSecrets({ workspace: 'example', userId: 7 })
    const example2 = store.resolveSecrets({ workspace: 'example2', userId: 7 })

    expect(example.PERSONAL_TOKEN).toBe('tok-eva-personal')
    expect(example2.PERSONAL_TOKEN).toBe('tok-eva-personal')
    expect(example2.PERSONAL_TOKEN).toBe(example.PERSONAL_TOKEN)

    // ...but the ORGANIZATION secrets stay in their own organization.
    expect(example).toEqual({ PERSONAL_TOKEN: 'tok-eva-personal', EXAMPLE_ONLY: 'example-val' })
    expect(example2).toEqual({ PERSONAL_TOKEN: 'tok-eva-personal', EXAMPLE2_ONLY: 'example2-val' })

    // A different user in the same organization gets no personal token.
    expect(store.resolveSecrets({ workspace: 'example', userId: 1 })).toEqual({ EXAMPLE_ONLY: 'example-val' })
  })
})

describe('secrets-store scope changes (moveSecret)', () => {
  const EXAMPLE = { scopeType: 'workspace', workspace: 'example' } as const
  const GLOBAL = { scopeType: 'global' } as const
  const USER7 = { scopeType: 'user', userId: 7 } as const

  it('re-parents the row (same id, same version) and the value still decrypts at the NEW scope', () => {
    const created = store.setSecret({ scope: EXAMPLE, key: 'MOVE_ME', value: 'original-plaintext', actorUserId: 1 })

    const moved = store.moveSecret(EXAMPLE, 'MOVE_ME', GLOBAL, 1)
    expect(moved.ok).toBe(true)
    if (!moved.ok) return
    expect(moved.summary.id).toBe(created.id) // same row, not a copy
    expect(moved.summary.version).toBe(created.version) // history untouched
    expect(moved.summary.scopeType).toBe('global')
    expect(moved.summary.workspace).toBeNull()

    // Ciphertext survived the re-parent: it decrypts to the ORIGINAL plaintext.
    expect(store.getSecretValue(GLOBAL, 'MOVE_ME')).toBe('original-plaintext')
    // ...and it is GONE from the old bucket.
    expect(store.getSecret(EXAMPLE, 'MOVE_ME')).toBeNull()
    expect(store.getSecretValue(EXAMPLE, 'MOVE_ME')).toBeNull()
  })

  it('moving global → user narrows resolution to that user only', () => {
    store.setSecret({ scope: GLOBAL, key: 'NARROW', value: 'v', actorUserId: 1 })
    expect(store.resolveSecrets({ workspace: 'example', userId: 1 }).NARROW).toBe('v') // everyone

    expect(store.moveSecret(GLOBAL, 'NARROW', USER7, 1).ok).toBe(true)

    expect(store.resolveSecrets({ workspace: 'example', userId: 7 }).NARROW).toBe('v')
    expect(store.resolveSecrets({ workspace: 'example2', userId: 7 }).NARROW).toBe('v') // follows the user
    expect(store.resolveSecrets({ workspace: 'example', userId: 1 }).NARROW).toBeUndefined()
    expect(store.resolveSecrets({}).NARROW).toBeUndefined()
  })

  it("returns {ok:false, reason:'conflict'} and leaves the SOURCE row untouched", () => {
    store.setSecret({ scope: EXAMPLE, key: 'DUP', value: 'example-value', actorUserId: 1 })
    store.setSecret({ scope: GLOBAL, key: 'DUP', value: 'global-value', actorUserId: 1 })

    const result = store.moveSecret(EXAMPLE, 'DUP', GLOBAL, 1)
    expect(result).toEqual({ ok: false, reason: 'conflict' })

    // Neither side was clobbered.
    expect(store.getSecretValue(EXAMPLE, 'DUP')).toBe('example-value')
    expect(store.getSecretValue(GLOBAL, 'DUP')).toBe('global-value')
    expect(store.getSecret(EXAMPLE, 'DUP')?.scopeType).toBe('workspace')
  })

  it("returns {ok:false, reason:'not_found'} for a missing key", () => {
    expect(store.moveSecret(EXAMPLE, 'GHOST', GLOBAL, 1)).toEqual({ ok: false, reason: 'not_found' })
  })

  it('a same-scope move is a no-op success', () => {
    const created = store.setSecret({ scope: EXAMPLE, key: 'SAME', value: 'v', actorUserId: 1 })
    const result = store.moveSecret(EXAMPLE, 'SAME', { scopeType: 'workspace', workspace: 'example' }, 1)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.summary).toEqual(created)
    expect(store.getSecretValue(EXAMPLE, 'SAME')).toBe('v')
  })

  it('writes paired move-from / move-to audit rows', () => {
    store.setSecret({ scope: EXAMPLE, key: 'AUDITED', value: 'audited-plaintext', actorUserId: 1 })
    getDb().exec('DELETE FROM secret_access_log;')

    store.moveSecret(EXAMPLE, 'AUDITED', USER7, 1)

    const scopes = store.recentAccessLog().map(r => r.scope)
    expect(scopes).toContain('move-from:workspace:example')
    expect(scopes).toContain('move-to:user:7')
    // The audit trail never carries the value.
    expect(JSON.stringify(store.recentAccessLog())).not.toContain('audited-plaintext')
  })
})

describe('secrets-store audit log', () => {
  it('writes create/update/delete/read/rollback rows', () => {
    const scope = { scopeType: 'global' } as const
    store.setSecret({ scope, key: 'K', value: 'v1', actorUserId: 1 }) // create
    store.setSecret({ scope, key: 'K', value: 'v2', actorUserId: 1 }) // update
    store.getSecretValue(scope, 'K', 1) // read
    store.rollbackSecret(scope, 'K', 1, 1) // rollback
    store.deleteSecret(scope, 'K', 1) // delete

    const actions = store.recentAccessLog().map(r => r.action)
    expect(actions).toContain('create')
    expect(actions).toContain('update')
    expect(actions).toContain('read')
    expect(actions).toContain('rollback')
    expect(actions).toContain('delete')
    // Never stores the value.
    expect(JSON.stringify(store.recentAccessLog())).not.toContain('v1')
  })

  it('resolveSecrets writes one inject row per key only when audit:true', () => {
    store.setSecret({ scope: { scopeType: 'global' }, key: 'A', value: 'a' })
    store.setSecret({ scope: { scopeType: 'global' }, key: 'B', value: 'b' })
    getDb().exec('DELETE FROM secret_access_log;')

    store.resolveSecrets({ workspace: 'example', userId: 7 }) // audit off (default)
    expect(store.recentAccessLog().length).toBe(0)

    store.resolveSecrets({ workspace: 'example', userId: 7, audit: true, actorUserId: null })
    const injects = store.recentAccessLog().filter(r => r.action === 'inject')
    expect(injects.map(r => r.key).sort()).toEqual(['A', 'B'])
  })

  it('hydrateProcessEnvFromSecretsStore fills missing keys and does not overwrite', () => {
    store.setSecret({ scope: { scopeType: 'global' }, key: 'HYDRATE_A', value: 'from-store', actorUserId: 1 })
    store.setSecret({ scope: { scopeType: 'global' }, key: 'HYDRATE_B', value: 'store-b', actorUserId: 1 })
    process.env.HYDRATE_A = 'already-set'
    delete process.env.HYDRATE_B
    const n = store.hydrateProcessEnvFromSecretsStore()
    expect(process.env.HYDRATE_A).toBe('already-set')
    expect(process.env.HYDRATE_B).toBe('store-b')
    expect(n).toBe(1)
    delete process.env.HYDRATE_A
    delete process.env.HYDRATE_B
  })
})
