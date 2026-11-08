/**
 * Per-user connector isolation (obj 900089).
 *
 * The property under test is one sentence: a connected account is usable only
 * by the person it belongs to, and by the keys and sessions acting for that
 * person. Everything here is an attempt to get user B's credential out of the
 * system while being somebody who is not user B — including being an
 * administrator, which earns nothing at all on this surface.
 *
 * Two users throughout: USER_A and USER_B, both ordinary. ADMIN is a third
 * account with the admin role, present only to prove the role buys nothing.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

process.env.TEST_CRED_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString('base64')
process.env.SECRETS_MASTER_KEY = Buffer.alloc(32, 12).toString('base64')
const TMP_DB = path.join(os.tmpdir(), `cc-connector-isolation-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
// A stored Google grant can only be refreshed by the client that issued it, so
// the resolver needs that client configured before it will hand the grant to a
// session. These are test values; nothing contacts Google here.
process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-client.apps.googleusercontent.test'
process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'test-client-secret'

const { initDb, getDb } = await import('../db/index.js')
const guard = await import('./connector-guard.js')
const github = await import('./user-github-tokens.js')
const google = await import('./user-google-connections.js')
const { setAccess } = await import('../connectors/access.js')
const { buildSpawnEnv } = await import('./session-spawn-env.js')
const { createAgentKey, updateAgentKeyConnectors, resolveAgentKey, listAgentKeys, revokeAgentKey } =
  await import('../lib/agent-keys.js')
const { initAgentKeysSchema } = await import('../db/schema/agent-keys.js')
const { setSecret, resolveSecrets, resolveSecretNames, SERVICE_ONLY_BY_DEFAULT } =
  await import('./secrets-store.js')

const USER_A = 101
const USER_B = 102
const ADMIN = 103

const A_PAT = 'github_pat_11AAAA_user_a_token_value_0001'
const B_PAT = 'github_pat_11BBBB_user_b_token_value_0002'
const B_REFRESH = '1//0gUSER_B_refresh_token_value_0002'

function seedUser(id: number, username: string, role: 'admin' | 'member'): void {
  getDb()
    .prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, 'x', ?)`)
    .run(id, username, role)
}

function linkGithub(userId: number, token: string, login: string): void {
  github.upsert(userId, {
    rawToken: token,
    login,
    githubUserId: userId,
    email: `${login}@users.noreply.github.test`,
    scopes: null,
    tokenType: 'pat_fine',
  })
}

function linkGoogle(userId: number, email: string, refresh: string): void {
  google.upsert(userId, {
    googleSub: `sub-${userId}`,
    googleEmail: email,
    refreshToken: refresh,
    accessToken: null,
    accessTokenExpiresAt: null,
    scopes: 'openid email',
    clientId: 'test-client.apps.googleusercontent.test',
  })
}

/** An objective owned by, and self-assigned to, `ownerId`. */
function cardFor(ownerId: number, extra: Record<string, unknown> = {}) {
  return {
    id: 900089,
    workspace: 'main',
    project: 'app',
    agent_context: 'builder',
    created_by: ownerId,
    assigned_user_id: ownerId,
    ...extra,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

function denials(): ReturnType<typeof guard.recentConnectorDenials> {
  return guard.recentConnectorDenials(200)
}

beforeAll(() => {
  initDb()
})

beforeEach(() => {
  const db = getDb()
  db.exec('DELETE FROM user_github_tokens; DELETE FROM user_google_connections; DELETE FROM users;')
  db.exec('DELETE FROM agent_api_keys; DELETE FROM secrets;')
  try { db.exec('DELETE FROM connector_access') } catch { /* created lazily */ }
  try { db.exec('DELETE FROM connector_access_log') } catch { /* created lazily */ }
  seedUser(USER_A, 'user-a', 'member')
  seedUser(USER_B, 'user-b', 'member')
  seedUser(ADMIN, 'admin-user', 'admin')
})

afterAll(() => {
  try { getDb().close() } catch { /* already closed */ }
  for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
    try { fs.unlinkSync(f) } catch { /* absent */ }
  }
})

// ── 1. One person's credential is not another person's ──────────────────────

describe("user A cannot reach user B's connected accounts", () => {
  beforeEach(() => {
    linkGithub(USER_B, B_PAT, 'user-b')
    linkGoogle(USER_B, 'user-b@example.test', B_REFRESH)
  })

  it("refuses A's agent key the Google credential of B, and B's key that of A", () => {
    const aKey = createAgentKey({ id: USER_A, role: 'member' }, { label: 'A key', connectors: ['google-workspace'] })
    const bKey = createAgentKey({ id: USER_B, role: 'member' }, { label: 'B key', connectors: ['google-workspace'] })
    expect(aKey.ok && bKey.ok).toBe(true)
    if (!aKey.ok || !bKey.ok) return

    const aPrincipal = resolveAgentKey(aKey.key.token)
    const bPrincipal = resolveAgentKey(bKey.key.token)
    expect(aPrincipal.status).toBe('ok')
    expect(bPrincipal.status).toBe('ok')
    if (aPrincipal.status !== 'ok' || bPrincipal.status !== 'ok') return

    const asA = { kind: 'agent_key' as const, userId: USER_A, keyId: aPrincipal.key.id, keyLabel: aPrincipal.key.label, connectors: aPrincipal.key.connectors }
    const asB = { kind: 'agent_key' as const, userId: USER_B, keyId: bPrincipal.key.id, keyLabel: bPrincipal.key.label, connectors: bPrincipal.key.connectors }

    // A's key asking for B's Google: refused, and no token comes back.
    expect(guard.canUseConnectorCredential({ connectorId: 'google-workspace', ownerUserId: USER_B, actor: asA }))
      .toEqual({ allowed: false, reason: 'cross_user', detail: expect.any(String) })
    expect(google.getDecryptedRefreshToken(USER_B, asA)).toBeNull()

    // And the reverse, with A connected too.
    linkGoogle(USER_A, 'user-a@example.test', '1//0gUSER_A_refresh_0001')
    expect(guard.canUseConnectorCredential({ connectorId: 'google-workspace', ownerUserId: USER_A, actor: asB }).allowed)
      .toBe(false)
    expect(google.getDecryptedRefreshToken(USER_A, asB)).toBeNull()

    // Each key still reaches its own owner.
    expect(google.getDecryptedRefreshToken(USER_B, asB)).toBe(B_REFRESH)
    expect(google.getDecryptedRefreshToken(USER_A, asA)).toBe('1//0gUSER_A_refresh_0001')
  })

  it("refuses A's agent key the GitHub token of B", () => {
    const aKey = createAgentKey({ id: USER_A, role: 'member' }, { label: 'A key', connectors: ['github'] })
    expect(aKey.ok).toBe(true)
    if (!aKey.ok) return
    const asA = { kind: 'agent_key' as const, userId: USER_A, keyId: aKey.key.id, keyLabel: aKey.key.label, connectors: ['github'] }
    expect(github.getDecryptedForUser(USER_B, asA)).toBeNull()
  })

  it('gives the admin ROLE nothing — it is not an identity-override', () => {
    const adminSession = { kind: 'user' as const, userId: ADMIN }
    expect(guard.canUseConnectorCredential({ connectorId: 'google-workspace', ownerUserId: USER_B, actor: adminSession }).allowed)
      .toBe(false)
    expect(google.getDecryptedRefreshToken(USER_B, adminSession)).toBeNull()
    expect(github.getDecryptedForUser(USER_B, adminSession)).toBeNull()

    // An admin's own agent key is narrower still, never wider.
    const adminKey = createAgentKey({ id: ADMIN, role: 'admin' }, { label: 'admin key', connectors: ['github', 'google-workspace'] })
    expect(adminKey.ok).toBe(true)
    if (!adminKey.ok) return
    const asAdminKey = { kind: 'agent_key' as const, userId: ADMIN, keyId: adminKey.key.id, keyLabel: adminKey.key.label, connectors: ['github', 'google-workspace'] }
    expect(github.getDecryptedForUser(USER_B, asAdminKey)).toBeNull()
    expect(google.getDecryptedRefreshToken(USER_B, asAdminKey)).toBeNull()
  })

  it('refuses when there is no owner at all rather than falling back to anyone', () => {
    expect(guard.canUseConnectorCredential({ connectorId: 'github', ownerUserId: null, actor: { kind: 'server' } }))
      .toEqual({ allowed: false, reason: 'no_owner', detail: expect.any(String) })
  })
})

// ── 2. Cards cannot be used to borrow somebody's identity ───────────────────

describe('a card does not lend out the assignee credential', () => {
  beforeEach(() => {
    linkGithub(USER_A, A_PAT, 'user-a')
    linkGithub(USER_B, B_PAT, 'user-b')
    linkGoogle(USER_B, 'user-b@example.test', B_REFRESH)
  })

  it("a session for A's own card never contains B's credentials", () => {
    const env = buildSpawnEnv({ objective: cardFor(USER_A), homeDir: '/home/session', sessionKind: 'worker' })
    expect(env.GH_TOKEN).toBe(A_PAT)
    expect(Object.values(env)).not.toContain(B_PAT)
    expect(Object.values(env)).not.toContain(B_REFRESH)
  })

  it("a card A filed and assigned to B runs as B WITHOUT B's credentials", () => {
    const env = buildSpawnEnv({
      objective: cardFor(USER_B, { created_by: USER_A }),
      homeDir: '/home/session',
      sessionKind: 'worker',
    })
    expect(env.CC_ACTING_USER_ID).toBe(String(USER_B))
    expect(env.GOOGLE_WORKSPACE_CONNECTION).toBe('absent')
    expect(Object.values(env)).not.toContain(B_PAT)
    expect(Object.values(env)).not.toContain(B_REFRESH)
    // Nor does it quietly fall back to the person who filed it.
    expect(Object.values(env)).not.toContain(A_PAT)
  })

  it('an ADMIN assigning the card changes nothing — the role is not consent', () => {
    const env = buildSpawnEnv({
      objective: cardFor(USER_B, { created_by: ADMIN }),
      homeDir: '/home/session',
      sessionKind: 'worker',
    })
    expect(env.GOOGLE_WORKSPACE_CONNECTION).toBe('absent')
    expect(Object.values(env)).not.toContain(B_REFRESH)
  })

  it('B opting in is what unlocks it, per connector', () => {
    setAccess('google-workspace', USER_B, { agents: null, workspaces: null, allow_delegated: true })
    const env = buildSpawnEnv({
      objective: cardFor(USER_B, { created_by: ADMIN }),
      homeDir: '/home/session',
      sessionKind: 'worker',
    })
    expect(env.GOOGLE_REFRESH_TOKEN).toBe(B_REFRESH)
    // GitHub was not opted in, so it stays withheld.
    expect(env.GH_TOKEN).toBeUndefined()
  })
})

// ── 3. The per-key connector allow-list ─────────────────────────────────────

describe('per-agent-key connector allow-list', () => {
  beforeEach(() => {
    linkGithub(USER_A, A_PAT, 'user-a')
  })

  // obj 900303 changed this default from deny-all to inherit-the-owner. The two
  // tests below pin BOTH halves of that change: what silence now means, and that
  // saying "none" out loud still means none.
  it('a new key inherits the connectors its owner is authorised for', () => {
    const key = createAgentKey({ id: USER_A, role: 'member' }, { label: 'fresh' })
    expect(key.ok).toBe(true)
    if (!key.ok) return
    expect(key.key.connectors).toEqual(['owner'])
    const actor = { kind: 'agent_key' as const, userId: USER_A, keyId: key.key.id, keyLabel: key.key.label, connectors: key.key.connectors }
    expect(guard.canUseConnectorCredential({ connectorId: 'github', ownerUserId: USER_A, actor }))
      .toEqual({ allowed: true })
    expect(github.getDecryptedForUser(USER_A, actor)).toBe(A_PAT)
  })

  it('an inheriting key still reaches only its OWN owner, never another person', () => {
    linkGithub(USER_B, B_PAT, 'user-b')
    const key = createAgentKey({ id: USER_A, role: 'member' }, { label: 'fresh' })
    expect(key.ok).toBe(true)
    if (!key.ok) return
    const actor = { kind: 'agent_key' as const, userId: USER_A, keyId: key.key.id, keyLabel: key.key.label, connectors: key.key.connectors }
    expect(github.getDecryptedForUser(USER_A, actor)).toBe(A_PAT)
    expect(github.getDecryptedForUser(USER_B, actor)).toBeNull()
    expect(denials().some(d => d.reason === 'cross_user')).toBe(true)
  })

  it('an explicit empty list is deny-all, and is NOT read as inherit', () => {
    const key = createAgentKey({ id: USER_A, role: 'member' }, { label: 'locked down', connectors: [] })
    expect(key.ok).toBe(true)
    if (!key.ok) return
    expect(key.key.connectors).toEqual([])
    const actor = { kind: 'agent_key' as const, userId: USER_A, keyId: key.key.id, keyLabel: key.key.label, connectors: [] }
    expect(guard.canUseConnectorCredential({ connectorId: 'github', ownerUserId: USER_A, actor }))
      .toEqual({ allowed: false, reason: 'key_connector', detail: expect.any(String) })
    expect(github.getDecryptedForUser(USER_A, actor)).toBeNull()
  })

  it('an explicit null is deny-all too — "none" never silently becomes "inherit"', () => {
    const key = createAgentKey({ id: USER_A, role: 'member' }, { label: 'null list', connectors: null })
    expect(key.ok).toBe(true)
    if (!key.ok) return
    expect(key.key.connectors).toEqual([])
  })

  it('a stored NULL (a key that predates obj 900303) still means deny-all', () => {
    const key = createAgentKey({ id: USER_A, role: 'member' }, { label: 'legacy row' })
    expect(key.ok).toBe(true)
    if (!key.ok) return
    // Reproduce a row written before the column had a default: connectors IS NULL.
    getDb().prepare('UPDATE agent_api_keys SET connectors = NULL WHERE id = ?').run(key.key.id)
    const reread = listAgentKeys(USER_A).find(k => k.id === key.key.id)
    expect(reread?.connectors).toEqual([])
    const actor = { kind: 'agent_key' as const, userId: USER_A, keyId: key.key.id, keyLabel: key.key.label, connectors: null }
    expect(github.getDecryptedForUser(USER_A, actor)).toBeNull()
  })

  it('inheritance tracks the owner: removing the connection removes the key\'s reach', () => {
    const key = createAgentKey({ id: USER_A, role: 'member' }, { label: 'follows me' })
    expect(key.ok).toBe(true)
    if (!key.ok) return
    const actor = { kind: 'agent_key' as const, userId: USER_A, keyId: key.key.id, keyLabel: key.key.label, connectors: key.key.connectors }
    expect(github.getDecryptedForUser(USER_A, actor)).toBe(A_PAT)
    github.deleteForUser(USER_A)
    expect(github.getDecryptedForUser(USER_A, actor)).toBeNull()
  })

  it('inheritance never exceeds the owner: their own access rule still denies the use', () => {
    const key = createAgentKey({ id: USER_A, role: 'member' }, { label: 'follows me' })
    expect(key.ok).toBe(true)
    if (!key.ok) return
    // The owner limits GitHub to one workspace. The inheriting key is measured
    // against that rule exactly as the owner would be.
    setAccess('github', USER_A, { agents: null, workspaces: ['other-workspace'], allow_delegated: false })
    const actor = { kind: 'agent_key' as const, userId: USER_A, keyId: key.key.id, keyLabel: key.key.label, connectors: key.key.connectors }
    expect(
      guard.canUseConnectorCredential({
        connectorId: 'github',
        ownerUserId: USER_A,
        actor,
        use: { agent: 'cto', workspace: 'this-workspace' },
      }),
    ).toEqual({ allowed: false, reason: 'access_rule', detail: expect.any(String) })
  })

  it('inheritance is not a delegation opt-in: another person\'s card still withholds it', () => {
    const key = createAgentKey({ id: USER_A, role: 'member' }, { label: 'follows me' })
    expect(key.ok).toBe(true)
    if (!key.ok) return
    const actor = { kind: 'agent_key' as const, userId: USER_A, keyId: key.key.id, keyLabel: key.key.label, connectors: key.key.connectors }
    expect(
      guard.canUseConnectorCredential({
        connectorId: 'github',
        ownerUserId: USER_A,
        actor,
        delegated: true,
      }),
    ).toEqual({ allowed: false, reason: 'delegated_card', detail: expect.any(String) })
  })

  it('granting the connector gives the key its OWNER\'s copy and nobody else\'s', () => {
    linkGithub(USER_B, B_PAT, 'user-b')
    const key = createAgentKey({ id: USER_A, role: 'member' }, { label: 'granted' })
    expect(key.ok).toBe(true)
    if (!key.ok) return
    const updated = updateAgentKeyConnectors(key.key.id, ['github'], USER_A)
    expect(updated.ok).toBe(true)
    if (!updated.ok) return
    expect(updated.key.connectors).toEqual(['github'])

    const actor = { kind: 'agent_key' as const, userId: USER_A, keyId: key.key.id, keyLabel: key.key.label, connectors: ['github'] }
    expect(github.getDecryptedForUser(USER_A, actor)).toBe(A_PAT)
    expect(github.getDecryptedForUser(USER_B, actor)).toBeNull()
  })

  it('a key granted one connector cannot use another', () => {
    linkGoogle(USER_A, 'user-a@example.test', '1//0gUSER_A_refresh_0001')
    const key = createAgentKey({ id: USER_A, role: 'member' }, { label: 'github only', connectors: ['github'] })
    expect(key.ok).toBe(true)
    if (!key.ok) return
    const actor = { kind: 'agent_key' as const, userId: USER_A, keyId: key.key.id, keyLabel: key.key.label, connectors: ['github'] }
    expect(github.getDecryptedForUser(USER_A, actor)).toBe(A_PAT)
    expect(google.getDecryptedRefreshToken(USER_A, actor)).toBeNull()
  })

  it('a card filed by a key inherits that key\'s list in its spawned session', () => {
    // Explicitly restricted to none, so the session gets nothing until the
    // owner grants it — the inherit default is covered separately above.
    const key = createAgentKey({ id: USER_A, role: 'member' }, { label: 'no connectors', connectors: [] })
    expect(key.ok).toBe(true)
    if (!key.ok) return
    const env = buildSpawnEnv({
      objective: cardFor(USER_A, { agent_key_id: key.key.id, agent_key_label: key.key.label }),
      homeDir: '/home/session',
      sessionKind: 'worker',
    })
    expect(env.GH_TOKEN).toBeUndefined()

    updateAgentKeyConnectors(key.key.id, ['github'], USER_A)
    const after = buildSpawnEnv({
      objective: cardFor(USER_A, { agent_key_id: key.key.id, agent_key_label: key.key.label }),
      homeDir: '/home/session',
      sessionKind: 'worker',
    })
    expect(after.GH_TOKEN).toBe(A_PAT)
  })

  it('refuses a malformed list rather than storing something it will mis-read later', () => {
    const key = createAgentKey({ id: USER_A, role: 'member' }, { label: 'k' })
    expect(key.ok).toBe(true)
    if (!key.ok) return
    expect(updateAgentKeyConnectors(key.key.id, ['../../etc'], USER_A)).toMatchObject({ ok: false, status: 400 })
    // The legacy wildcard is written by the migration, never accepted on the wire.
    expect(updateAgentKeyConnectors(key.key.id, ['*'], USER_A)).toMatchObject({ ok: false, status: 400 })
  })

  it("will not let one person edit another person's key", () => {
    const key = createAgentKey({ id: USER_A, role: 'member' }, { label: 'a key' })
    expect(key.ok).toBe(true)
    if (!key.ok) return
    expect(updateAgentKeyConnectors(key.key.id, ['github'], USER_B)).toMatchObject({ ok: false, status: 404 })
  })
})

// ── 4. The shared service secrets ───────────────────────────────────────────

describe('server-only secrets stay with the server', () => {
  it('keeps shared connector/service credentials out of a spawned session env', () => {
    for (const key of SERVICE_ONLY_BY_DEFAULT) {
      setSecret({ scope: { scopeType: 'global' }, key, value: `value-of-${key}` })
    }
    setSecret({ scope: { scopeType: 'global' }, key: 'AN_ORDINARY_AGENT_SECRET', value: 'agent-visible' })

    const env = buildSpawnEnv({ objective: cardFor(USER_A), homeDir: '/home/session', sessionKind: 'worker' })
    for (const key of SERVICE_ONLY_BY_DEFAULT) {
      expect(env[key]).not.toBe(`value-of-${key}`)
    }
    expect(env.AN_ORDINARY_AGENT_SECRET).toBe('agent-visible')
  })

  it('withholds them from the bulk resolver and from the names a session is told', () => {
    setSecret({ scope: { scopeType: 'global' }, key: 'GOOGLE_OAUTH_CLIENT_SECRET', value: 'shared-client-secret' })
    setSecret({ scope: { scopeType: 'global' }, key: 'AN_ORDINARY_AGENT_SECRET', value: 'agent-visible' })

    const forSession = resolveSecrets({ workspace: 'main', userId: USER_A })
    expect(forSession.GOOGLE_OAUTH_CLIENT_SECRET).toBeUndefined()
    expect(forSession.AN_ORDINARY_AGENT_SECRET).toBe('agent-visible')
    expect(resolveSecretNames({ workspace: 'main', userId: USER_A })).not.toContain('GOOGLE_OAUTH_CLIENT_SECRET')

    // The server's own boot hydration still gets them, so jobs keep working.
    const forServer = resolveSecrets({ includeServiceOnly: true })
    expect(forServer.GOOGLE_OAUTH_CLIENT_SECRET).toBe('shared-client-secret')
  })

  it('leaves a secret an operator stored for agents exactly as it was', () => {
    setSecret({ scope: { scopeType: 'workspace', workspace: 'main' }, key: 'GOOGLE_OAUTH_CLIENT_SECRET', value: 'workspace-level' })
    // Only GLOBAL scope is defaulted to service-only; a deliberately workspace-
    // scoped value is the operator's choice and is left alone.
    expect(resolveSecrets({ workspace: 'main', userId: USER_A }).GOOGLE_OAUTH_CLIENT_SECRET).toBe('workspace-level')
  })

  it('does not reopen a service-only secret when its value is re-pasted', () => {
    setSecret({ scope: { scopeType: 'global' }, key: 'GMAIL_REFRESH_TOKEN', value: 'v1' })
    setSecret({ scope: { scopeType: 'global' }, key: 'GMAIL_REFRESH_TOKEN', value: 'v2' })
    expect(resolveSecrets({ workspace: 'main', userId: USER_A }).GMAIL_REFRESH_TOKEN).toBeUndefined()
  })
})

// ── 5. Every refusal is on the record, and carries no credential ────────────

describe('denial audit', () => {
  beforeEach(() => {
    linkGithub(USER_B, B_PAT, 'user-b')
    linkGoogle(USER_B, 'user-b@example.test', B_REFRESH)
  })

  it('writes one entry per refusal, naming who, whose, which and why', () => {
    expect(denials()).toHaveLength(0)
    github.getDecryptedForUser(USER_B, { kind: 'user', userId: USER_A })
    const rows = denials()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      connector_id: 'github',
      owner_user_id: USER_B,
      actor_kind: 'user',
      actor_user_id: USER_A,
      reason: 'cross_user',
    })
    expect(typeof rows[0].at).toBe('string')
  })

  it('records the key label when an agent key is refused', () => {
    const key = createAgentKey({ id: USER_A, role: 'member' }, { label: 'reporting bot', connectors: ['github'] })
    expect(key.ok).toBe(true)
    if (!key.ok) return
    github.getDecryptedForUser(USER_B, {
      kind: 'agent_key', userId: USER_A, keyId: key.key.id, keyLabel: key.key.label, connectors: ['github'],
    })
    expect(denials()[0]).toMatchObject({ actor_kind: 'agent_key', key_label: 'reporting bot', reason: 'cross_user' })
  })

  it('records a withheld credential on a delegated card, with the card id', () => {
    buildSpawnEnv({
      objective: cardFor(USER_B, { created_by: USER_A }),
      homeDir: '/home/session',
      sessionKind: 'worker',
    })
    const reasons = denials().map(d => d.reason)
    expect(reasons).toContain('delegated_card')
    const row = denials().find(d => d.reason === 'delegated_card')
    expect(row).toMatchObject({ actor_kind: 'session', objective_id: 900089, owner_user_id: USER_B })
  })

  it('never stores credential material', () => {
    github.getDecryptedForUser(USER_B, { kind: 'user', userId: USER_A })
    google.getDecryptedRefreshToken(USER_B, { kind: 'user', userId: USER_A })
    buildSpawnEnv({ objective: cardFor(USER_B, { created_by: USER_A }), homeDir: '/home/session', sessionKind: 'worker' })
    const dump = JSON.stringify(denials())
    expect(dump.length).toBeGreaterThan(0)
    for (const secret of [A_PAT, B_PAT, B_REFRESH]) {
      expect(dump).not.toContain(secret)
    }
    // Not even a fragment long enough to be useful.
    expect(dump).not.toContain(B_PAT.slice(0, 16))
  })
})

// ── 6. obj 900331: end-to-end verification of the obj 900303 inherit default ─
//
// Every "use" below goes through resolveAgentKey(token) — the same read the
// request guard does — or through buildSpawnEnv, which re-reads the key row.
// Nothing is built from the value createAgentKey returned, so a grant that
// was cached anywhere between the write and the use would show up here.

describe('obj 900331: inherit-owner keys, verified end to end', () => {
  const A_REFRESH = '1//0gUSER_A_refresh_900331'
  const ADMIN_PAT = 'github_pat_11ADMN_admin_token_value_0003'

  beforeEach(() => {
    linkGithub(USER_A, A_PAT, 'user-a')
    linkGithub(USER_B, B_PAT, 'user-b')
    linkGithub(ADMIN, ADMIN_PAT, 'admin-user')
    linkGoogle(USER_A, 'user-a@example.test', A_REFRESH)
    linkGoogle(USER_B, 'user-b@example.test', B_REFRESH)
  })

  /** Resolve the token NOW, exactly as a request would, and act as that key. */
  function useKey(token: string) {
    const r = resolveAgentKey(token)
    if (r.status !== 'ok') return null
    return { kind: 'agent_key' as const, userId: r.user.id, keyId: r.key.id, keyLabel: r.key.label, connectors: r.key.connectors }
  }

  function mint(userId: number, role: 'admin' | 'member', input: Record<string, unknown> = {}) {
    const k = createAgentKey({ id: userId, role }, { label: `k-${userId}`, ...input })
    if (!k.ok) throw new Error(k.error)
    return k.key
  }

  /** A card filed by an agent key and owned by that key's owner. */
  function cardFiledBy(key: { id: number; label: string }, ownerId: number, extra: Record<string, unknown> = {}) {
    return cardFor(ownerId, { agent_key_id: key.id, agent_key_label: key.label, ...extra })
  }

  // Property 1 ───────────────────────────────────────────────────────────────

  it('P1: a key created with no connectors resolves to ["owner"] and reaches only its owner, on every connector', () => {
    const key = mint(USER_A, 'member')
    const asKey = useKey(key.token)!
    expect(asKey.connectors).toEqual(['owner'])
    expect(github.getDecryptedForUser(USER_A, asKey)).toBe(A_PAT)
    expect(google.getDecryptedRefreshToken(USER_A, asKey)).toBe(A_REFRESH)
    for (const other of [USER_B, ADMIN]) {
      expect(github.getDecryptedForUser(other, asKey)).toBeNull()
      expect(google.getDecryptedRefreshToken(other, asKey)).toBeNull()
    }
  })

  it("P1: an ADMIN's own inheriting key reaches the admin's accounts and nobody else's", () => {
    const key = mint(ADMIN, 'admin')
    const asKey = useKey(key.token)!
    expect(asKey.connectors).toEqual(['owner'])
    expect(github.getDecryptedForUser(ADMIN, asKey)).toBe(ADMIN_PAT)
    expect(github.getDecryptedForUser(USER_A, asKey)).toBeNull()
    expect(google.getDecryptedRefreshToken(USER_B, asKey)).toBeNull()
  })

  it("P1: an admin editing A's key to inherit binds it to A, never to the admin or to B", () => {
    const key = mint(USER_A, 'member', { connectors: [] })
    // ownerId null = the admin path of PATCH /api/auth/agent-keys/:id.
    const edited = updateAgentKeyConnectors(key.id, ['owner'], null)
    expect(edited).toMatchObject({ ok: true, key: { connectors: ['owner'] } })
    const asKey = useKey(key.token)!
    expect(asKey.userId).toBe(USER_A)
    expect(github.getDecryptedForUser(USER_A, asKey)).toBe(A_PAT)
    expect(github.getDecryptedForUser(ADMIN, asKey)).toBeNull()
    expect(github.getDecryptedForUser(USER_B, asKey)).toBeNull()
  })

  it("P1: a session for a card filed by A's inheriting key carries A's credentials only", () => {
    const key = mint(USER_A, 'member')
    const env = buildSpawnEnv({ objective: cardFiledBy(key, USER_A), homeDir: '/home/session', sessionKind: 'worker' })
    expect(env.GH_TOKEN).toBe(A_PAT)
    for (const v of [B_PAT, B_REFRESH, ADMIN_PAT]) expect(Object.values(env)).not.toContain(v)
  })

  // Property 2 ───────────────────────────────────────────────────────────────

  it('P2: [] stays deny-all through create, list, resolve and an unrelated re-save', () => {
    const key = mint(USER_A, 'member', { connectors: [] })
    expect(listAgentKeys(USER_A).find(k => k.id === key.id)?.connectors).toEqual([])
    expect(useKey(key.token)!.connectors).toEqual([])
    expect(github.getDecryptedForUser(USER_A, useKey(key.token)!)).toBeNull()
    expect(google.getDecryptedRefreshToken(USER_A, useKey(key.token)!)).toBeNull()
    // Re-saving "none" (null or []) must not drift to inherit.
    for (const none of [null, []]) {
      expect(updateAgentKeyConnectors(key.id, none, USER_A)).toMatchObject({ ok: true, key: { connectors: [] } })
      expect(useKey(key.token)!.connectors).toEqual([])
    }
    const env = buildSpawnEnv({ objective: cardFiledBy(key, USER_A), homeDir: '/home/session', sessionKind: 'worker' })
    expect(env.GH_TOKEN).toBeUndefined()
    expect(Object.values(env)).not.toContain(A_REFRESH)
  })

  it('P2: an explicit list narrows, survives reads and updates, and is distinct from inherit', () => {
    const key = mint(USER_A, 'member', { connectors: ['github'] })
    expect(useKey(key.token)!.connectors).toEqual(['github'])
    expect(github.getDecryptedForUser(USER_A, useKey(key.token)!)).toBe(A_PAT)
    expect(google.getDecryptedRefreshToken(USER_A, useKey(key.token)!)).toBeNull()

    // inherit → list → inherit round-trips exactly, with the reach following.
    updateAgentKeyConnectors(key.id, ['owner'], USER_A)
    expect(google.getDecryptedRefreshToken(USER_A, useKey(key.token)!)).toBe(A_REFRESH)
    updateAgentKeyConnectors(key.id, ['google-workspace'], USER_A)
    expect(useKey(key.token)!.connectors).toEqual(['google-workspace'])
    expect(github.getDecryptedForUser(USER_A, useKey(key.token)!)).toBeNull()
    expect(listAgentKeys(USER_A).find(k => k.id === key.id)?.connectors).toEqual(['google-workspace'])
  })

  // Property 3 ───────────────────────────────────────────────────────────────

  it('P3: re-running the schema migration and minting new keys backfills nothing', () => {
    const legacyNull = mint(USER_A, 'member')
    const legacyStar = mint(USER_A, 'member')
    const explicit = mint(USER_A, 'member', { connectors: ['github'] })
    const none = mint(USER_A, 'member', { connectors: [] })
    getDb().prepare('UPDATE agent_api_keys SET connectors = NULL WHERE id = ?').run(legacyNull.id)
    getDb().prepare(`UPDATE agent_api_keys SET connectors = '["*"]' WHERE id = ?`).run(legacyStar.id)
    const snapshot = () =>
      Object.fromEntries(
        (getDb().prepare('SELECT id, connectors FROM agent_api_keys ORDER BY id').all() as { id: number; connectors: string | null }[])
          .map(r => [r.id, r.connectors]),
      )
    const before = snapshot()

    initAgentKeysSchema(getDb()) // what every boot runs
    mint(USER_A, 'member') // a new inheriting key next to them
    const after = snapshot()
    for (const id of [legacyNull.id, legacyStar.id, explicit.id, none.id]) expect(after[id]).toBe(before[id])
    expect(after[legacyNull.id]).toBeNull()
    expect(after[legacyStar.id]).toBe('["*"]')
  })

  it('P3: a NULL row is still deny-all and a legacy ["*"] row still reaches its own owner only', () => {
    const nullKey = mint(USER_A, 'member')
    const starKey = mint(USER_A, 'member')
    getDb().prepare('UPDATE agent_api_keys SET connectors = NULL WHERE id = ?').run(nullKey.id)
    getDb().prepare(`UPDATE agent_api_keys SET connectors = '["*"]' WHERE id = ?`).run(starKey.id)

    const asNull = useKey(nullKey.token)!
    expect(asNull.connectors).toEqual([])
    expect(github.getDecryptedForUser(USER_A, asNull)).toBeNull()
    expect(google.getDecryptedRefreshToken(USER_A, asNull)).toBeNull()

    const asStar = useKey(starKey.token)!
    expect(asStar.connectors).toEqual(['*'])
    expect(github.getDecryptedForUser(USER_A, asStar)).toBe(A_PAT)
    expect(google.getDecryptedRefreshToken(USER_A, asStar)).toBe(A_REFRESH)
    expect(github.getDecryptedForUser(USER_B, asStar)).toBeNull()
    expect(google.getDecryptedRefreshToken(USER_B, asStar)).toBeNull()
  })

  // Property 4 ───────────────────────────────────────────────────────────────

  it('P4: revoking an inheriting key cuts it off on the very next resolve', () => {
    const key = mint(USER_A, 'member')
    expect(github.getDecryptedForUser(USER_A, useKey(key.token)!)).toBe(A_PAT)
    expect(revokeAgentKey(USER_A, key.id)).toBe(true)
    expect(resolveAgentKey(key.token)).toEqual({ status: 'revoked' })
  })

  it('P4: a card filed by a key that was later REVOKED gets no connector at its next spawn', () => {
    const key = mint(USER_A, 'member')
    const card = cardFiledBy(key, USER_A)
    expect(buildSpawnEnv({ objective: card, homeDir: '/home/session', sessionKind: 'worker' }).GH_TOKEN).toBe(A_PAT)

    revokeAgentKey(USER_A, key.id)
    const after = buildSpawnEnv({ objective: card, homeDir: '/home/session', sessionKind: 'worker' })
    // Same reading as a deleted key: the grant is gone.
    expect(after.GH_TOKEN).toBeUndefined()
    expect(Object.values(after)).not.toContain(A_PAT)
    expect(Object.values(after)).not.toContain(A_REFRESH)
    expect(after.GOOGLE_WORKSPACE_CONNECTION).toBe('absent')
  })

  it('P4: disconnecting Google or removing GitHub cuts an inheriting key on the next use, no key edit', () => {
    const key = mint(USER_A, 'member')
    expect(google.getDecryptedRefreshToken(USER_A, useKey(key.token)!)).toBe(A_REFRESH)
    google.deleteForUser(USER_A)
    expect(google.getDecryptedRefreshToken(USER_A, useKey(key.token)!)).toBeNull()
    expect(github.getDecryptedForUser(USER_A, useKey(key.token)!)).toBe(A_PAT)

    const card = cardFiledBy(key, USER_A)
    github.deleteForUser(USER_A)
    expect(github.getDecryptedForUser(USER_A, useKey(key.token)!)).toBeNull()
    const env = buildSpawnEnv({ objective: card, homeDir: '/home/session', sessionKind: 'worker' })
    expect(env.GH_TOKEN).toBeUndefined()
    expect(env.GOOGLE_WORKSPACE_CONNECTION).toBe('absent')
  })

  it('P4: narrowing an inheriting key applies to the next spawn of a card it already filed', () => {
    const key = mint(USER_A, 'member')
    const card = cardFiledBy(key, USER_A)
    expect(buildSpawnEnv({ objective: card, homeDir: '/home/session', sessionKind: 'worker' }).GH_TOKEN).toBe(A_PAT)
    updateAgentKeyConnectors(key.id, [], USER_A)
    expect(buildSpawnEnv({ objective: card, homeDir: '/home/session', sessionKind: 'worker' }).GH_TOKEN).toBeUndefined()
  })

  it("P4: the owner's per-connector rule still applies to an inheriting key's card session", () => {
    const key = mint(USER_A, 'member')
    setAccess('github', USER_A, { agents: ['some-other-agent'], workspaces: null, allow_delegated: false })
    const env = buildSpawnEnv({ objective: cardFiledBy(key, USER_A), homeDir: '/home/session', sessionKind: 'worker' })
    expect(env.GH_TOKEN).toBeUndefined()
    expect(denials().some(d => d.reason === 'access_rule')).toBe(true)
  })

  it("P4: a delegated or other-owner card filed by an inheriting key gets nothing of anyone's", () => {
    const key = mint(USER_A, 'member')
    // Filed by A's key, assigned to B: runs as B, B never opted in.
    const env = buildSpawnEnv({
      objective: cardFiledBy(key, USER_B, { created_by: USER_A }),
      homeDir: '/home/session',
      sessionKind: 'worker',
    })
    expect(env.CC_ACTING_USER_ID).toBe(String(USER_B))
    for (const v of [A_PAT, A_REFRESH, B_PAT, B_REFRESH, ADMIN_PAT]) expect(Object.values(env)).not.toContain(v)
    expect(denials().some(d => d.reason === 'delegated_card')).toBe(true)
  })

  // Property 5 ───────────────────────────────────────────────────────────────

  it('P5: inherit grants no board scope beyond the defaults and no service-only secret', () => {
    const key = mint(USER_A, 'member')
    const r = resolveAgentKey(key.token)
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(r.key.scopes).not.toContain('board:done')
    expect(r.key.scopes).not.toContain('board:delete')
    expect(r.key.workspaces).toBeNull()

    for (const name of SERVICE_ONLY_BY_DEFAULT) {
      setSecret({ scope: { scopeType: 'global' }, key: name, value: `value-of-${name}` })
    }
    const env = buildSpawnEnv({ objective: cardFiledBy(key, USER_A), homeDir: '/home/session', sessionKind: 'worker' })
    for (const name of SERVICE_ONLY_BY_DEFAULT) expect(env[name]).not.toBe(`value-of-${name}`)
  })
})
