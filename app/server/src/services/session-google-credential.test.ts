import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import os from 'os'
import path from 'path'
import type { Objective } from '@operationkit/shared'

// These tests exercise the owner's own credential, so they read it as the
// server acting for that owner (services/connector-guard.ts).
const SERVER_ACTOR = { kind: 'server' as const }

// obj-706070 — the ACTING-USER resolution proof for per-user Google Workspace.
//
// Command Center used to hand every spawned session ONE shared Google credential
// (Operator's). This suite is the payoff test for replacing it: the Google identity a
// session receives is resolved from the OBJECTIVE'S OWNER, so Casey's objective
// spawns with Casey's refresh token and Operator's with Operator's — and neither env can
// ever contain the other's. When the owner has no grant the resolver emits an
// EXPLICIT absence marker rather than silently falling back to anyone.
//
// Encryption key + isolated DB must be set BEFORE importing the modules that read
// them at import/first-use time (mirrors session-user-git-identity.test.ts).
process.env.TEST_CRED_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64')
const TMP_DB = path.join(os.tmpdir(), `cc-google-cred-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
// buildSpawnEnv's connected branch needs a configured OAuth client; without it
// the resolver correctly degrades to 'absent' (asserted explicitly below).
process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-client-id.apps.googleusercontent.com'
process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'GOCSPX-test-client-secret-zzz'
// Hard-assert this is decoupled from the scoped-Doppler cutover.
delete process.env.USE_SCOPED_DOPPLER_TOKENS
delete process.env.SCOPE_SUPABASE_ACCESS_TOKEN

// obj 900204: `session_kb_access` defaults ON and adds CC_SESSION_TOKEN /
// CC_OBJECTIVE_ID / CC_STRIP_SIGNING_SECRETS to every spawn env. These cases are
// about the obj-718944 flags and the legacy base block, so pin it OFF; the
// default-ON behaviour is covered in lib/session-trust.test.ts and by the
// dedicated describe in session-spawn-env.test.ts.
process.env.CC_SESSION_KB_ACCESS = '0'

const { initDb, getDb } = await import('../db/index.js')
const google = await import('./user-google-connections.js')
const { userGoogleCredentialEnv, buildSpawnEnv } = await import('./session-manager.js')
const { setAccess } = await import('../connectors/access.js')

const OPERATOR = { id: 1, username: 'operator', email: 'dev@example.com', refresh: '1//0gMIKE_refresh_secret_AAA111' }
const CASEY = { id: 2, username: 'casey', email: 'casey@example.com', refresh: '1//0gAVA_refresh_secret_BBB222' }

function seedUser(id: number, username: string): void {
  getDb()
    .prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, 'x', 'member')`)
    .run(id, username)
}

/** Store a real (encrypted) connection for a user exactly as the callback would. */
function connect(u: { id: number; email: string; refresh: string }): void {
  google.upsert(u.id, {
    googleEmail: u.email,
    googleSub: `sub-${u.id}`,
    refreshToken: u.refresh,
    accessToken: `ya29.access-${u.id}`,
    accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    scopes: google.GOOGLE_SCOPES.join(' '),
    clientId: process.env.GOOGLE_OAUTH_CLIENT_ID as string,
  })
}

function objectiveOwnedBy(ownerId: number | null): Objective {
  return { id: 706070, workspace: 'operator', project: 'operationkit', created_by: ownerId } as Objective
}

function envFor(ownerId: number | null): Record<string, string> {
  return buildSpawnEnv({ objective: objectiveOwnedBy(ownerId), homeDir: '/home/ccuser-a', sessionKind: 'worker' })
}

beforeAll(() => {
  initDb()
})

beforeEach(() => {
  getDb().exec('DELETE FROM user_google_connections; DELETE FROM users;')
  try { getDb().exec('DELETE FROM connector_access') } catch { /* created lazily */ }
  seedUser(OPERATOR.id, OPERATOR.username)
  seedUser(CASEY.id, CASEY.username)
})

afterAll(() => {
  try { getDb().close() } catch {}
})

describe('userGoogleCredentialEnv — resolves the ACTING USER, two distinct connected users', () => {
  it('owner 1 (operator) gets operator’s token + email, marked as a user connection', () => {
    connect(OPERATOR)
    connect(CASEY)
    const env = userGoogleCredentialEnv(OPERATOR.id, SERVER_ACTOR)
    expect(env.GOOGLE_WORKSPACE_CONNECTION).toBe('user')
    expect(env.GOOGLE_REFRESH_TOKEN).toBe(OPERATOR.refresh)
    expect(env.USER_GOOGLE_EMAIL).toBe(OPERATOR.email)
    expect(env.GOOGLE_OAUTH_CLIENT_ID).toBe(process.env.GOOGLE_OAUTH_CLIENT_ID)
    expect(env.GOOGLE_OAUTH_CLIENT_SECRET).toBe(process.env.GOOGLE_OAUTH_CLIENT_SECRET)
  })

  it('owner 2 (casey) gets casey’s token + email from the same DB', () => {
    connect(OPERATOR)
    connect(CASEY)
    const env = userGoogleCredentialEnv(CASEY.id, SERVER_ACTOR)
    expect(env.GOOGLE_WORKSPACE_CONNECTION).toBe('user')
    expect(env.GOOGLE_REFRESH_TOKEN).toBe(CASEY.refresh)
    expect(env.USER_GOOGLE_EMAIL).toBe(CASEY.email)
  })
})

describe('buildSpawnEnv — CROSS-USER ISOLATION PROOF (the whole point of obj-706070)', () => {
  it('operator’s objective spawns with operator’s Google credential and NOT casey’s', () => {
    connect(OPERATOR)
    connect(CASEY)
    const env = envFor(OPERATOR.id)
    expect(env.GOOGLE_WORKSPACE_CONNECTION).toBe('user')
    expect(env.GOOGLE_REFRESH_TOKEN).toBe(OPERATOR.refresh)
    expect(env.USER_GOOGLE_EMAIL).toBe(OPERATOR.email)
    // The isolation assertion: casey's material is nowhere in operator's env.
    expect(env.GOOGLE_REFRESH_TOKEN).not.toBe(CASEY.refresh)
    expect(JSON.stringify(env)).not.toContain(CASEY.refresh)
    expect(JSON.stringify(env)).not.toContain(CASEY.email)
  })

  it('casey’s objective spawns with casey’s Google credential and NOT operator’s', () => {
    connect(OPERATOR)
    connect(CASEY)
    const env = envFor(CASEY.id)
    expect(env.GOOGLE_WORKSPACE_CONNECTION).toBe('user')
    expect(env.GOOGLE_REFRESH_TOKEN).toBe(CASEY.refresh)
    expect(env.USER_GOOGLE_EMAIL).toBe(CASEY.email)
    // …and operator's (the OLD shared credential) is nowhere in casey's env.
    expect(env.GOOGLE_REFRESH_TOKEN).not.toBe(OPERATOR.refresh)
    expect(JSON.stringify(env)).not.toContain(OPERATOR.refresh)
    expect(JSON.stringify(env)).not.toContain(OPERATOR.email)
  })

  it('the two envs differ ONLY in the per-user Google keys (same base spawn env)', () => {
    connect(OPERATOR)
    connect(CASEY)
    const a = envFor(OPERATOR.id)
    const b = envFor(CASEY.id)
    const perUser = ['GOOGLE_REFRESH_TOKEN', 'USER_GOOGLE_EMAIL', 'WORKSPACE_MCP_CREDENTIALS_DIR', 'CC_ACTING_USER_ID', 'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET']
    const strip = (e: Record<string, string>) => {
      const c = { ...e }
      for (const k of perUser) delete c[k]
      return c
    }
    expect(strip(a)).toEqual(strip(b))
    expect(a.GOOGLE_REFRESH_TOKEN).not.toBe(b.GOOGLE_REFRESH_TOKEN)
    expect(a.USER_GOOGLE_EMAIL).not.toBe(b.USER_GOOGLE_EMAIL)
  })

  // A card one person files and assigns to ANOTHER runs as the assignee — but
  // it does not reach into the assignee's connected account, because the person
  // who chose the assignee would then be acting as them. The assignee opts in
  // per connector; until they do, the session sees plain absence.
  it('a card assigned by someone else runs as the assignee WITHOUT their Google credential', () => {
    connect(OPERATOR)
    connect(CASEY)
    const env = buildSpawnEnv({
      objective: { ...objectiveOwnedBy(OPERATOR.id), assigned_user_id: CASEY.id } as Objective,
      homeDir: '/home/ccuser-a',
      sessionKind: 'worker',
    })
    expect(env.CC_ACTING_USER_ID).toBe(String(CASEY.id))
    expect(env.GOOGLE_WORKSPACE_CONNECTION).toBe('absent')
    expect(env.GOOGLE_REFRESH_TOKEN).toBeUndefined()
    // Emphatically not a fallback to the person who filed the card, either.
    expect(env.USER_GOOGLE_EMAIL).toBeUndefined()
    expect(Object.values(env)).not.toContain(OPERATOR.refresh)
  })

  it('the same card DOES get the credential once the assignee allows delegated work', () => {
    connect(OPERATOR)
    connect(CASEY)
    setAccess('google-workspace', CASEY.id, { agents: null, workspaces: null, allow_delegated: true })
    const env = buildSpawnEnv({
      objective: { ...objectiveOwnedBy(OPERATOR.id), assigned_user_id: CASEY.id } as Objective,
      homeDir: '/home/ccuser-a',
      sessionKind: 'worker',
    })
    expect(env.USER_GOOGLE_EMAIL).toBe(CASEY.email)
    expect(env.GOOGLE_REFRESH_TOKEN).toBe(CASEY.refresh)
    expect(env.GOOGLE_REFRESH_TOKEN).not.toBe(OPERATOR.refresh)
    expect(env.WORKSPACE_MCP_CREDENTIALS_DIR).toContain(`/google-creds/${CASEY.id}`)
  })

  it('attribution follows the OWNER across all 5 spawn kinds', () => {
    connect(CASEY)
    for (const k of ['worker', 'arena', 'followup', 'planner', 'reviewer'] as const) {
      const env = buildSpawnEnv({ objective: objectiveOwnedBy(CASEY.id), homeDir: '/home/ccuser-a', sessionKind: k })
      expect(env.GOOGLE_REFRESH_TOKEN).toBe(CASEY.refresh)
      expect(env.USER_GOOGLE_EMAIL).toBe(CASEY.email)
    }
  })
})

describe('EXPLICIT ABSENCE — no silent fallback to the old shared (Operator) credential', () => {
  it('an owner with NO connection row gets ‘absent’ and NO Google token/email keys at all', () => {
    connect(OPERATOR) // operator IS connected — casey must still not inherit him
    const env = envFor(CASEY.id)
    expect(env.GOOGLE_WORKSPACE_CONNECTION).toBe('absent')
    expect(env.GOOGLE_REFRESH_TOKEN).toBeUndefined()
    expect(env.USER_GOOGLE_EMAIL).toBeUndefined()
    expect('GOOGLE_REFRESH_TOKEN' in env).toBe(false)
    expect('USER_GOOGLE_EMAIL' in env).toBe(false)
    // The regression this objective exists to kill: operator's credential leaking
    // into a session run for somebody else.
    expect(JSON.stringify(env)).not.toContain(OPERATOR.refresh)
    expect(JSON.stringify(env)).not.toContain(OPERATOR.email)
  })

  it('created_by null (automation / unowned) ⇒ ‘absent’', () => {
    connect(OPERATOR)
    const env = envFor(null)
    expect(env.GOOGLE_WORKSPACE_CONNECTION).toBe('absent')
    expect(env.GOOGLE_REFRESH_TOKEN).toBeUndefined()
    expect(userGoogleCredentialEnv(null, SERVER_ACTOR)).toEqual({ GOOGLE_WORKSPACE_CONNECTION: 'absent' })
    expect(userGoogleCredentialEnv(undefined, SERVER_ACTOR)).toEqual({ GOOGLE_WORKSPACE_CONNECTION: 'absent' })
  })

  it('an owner id that does not exist at all ⇒ ‘absent’', () => {
    expect(userGoogleCredentialEnv(999999, SERVER_ACTOR)).toEqual({ GOOGLE_WORKSPACE_CONNECTION: 'absent' })
  })

  it('NEVER THROWS when the OAuth client env vars are unset ⇒ ‘absent’ (spawn is never blocked)', () => {
    connect(OPERATOR)
    const savedId = process.env.GOOGLE_OAUTH_CLIENT_ID
    const savedSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET
    delete process.env.GOOGLE_OAUTH_CLIENT_ID
    delete process.env.GOOGLE_OAUTH_CLIENT_SECRET
    try {
      expect(() => userGoogleCredentialEnv(OPERATOR.id, SERVER_ACTOR)).not.toThrow()
      expect(userGoogleCredentialEnv(OPERATOR.id, SERVER_ACTOR)).toEqual({ GOOGLE_WORKSPACE_CONNECTION: 'absent' })
      const env = envFor(OPERATOR.id)
      expect(env.GOOGLE_WORKSPACE_CONNECTION).toBe('absent')
      expect(env.GOOGLE_REFRESH_TOKEN).toBeUndefined()
      // A connected user still gets a working spawn env — just without Google.
      expect(env.HOME).toBe('/home/ccuser-a')
    } finally {
      if (savedId === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_ID
      else process.env.GOOGLE_OAUTH_CLIENT_ID = savedId
      if (savedSecret === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_SECRET
      else process.env.GOOGLE_OAUTH_CLIENT_SECRET = savedSecret
    }
  })
})
