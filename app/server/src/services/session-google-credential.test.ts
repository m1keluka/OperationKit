import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import os from 'os'
import path from 'path'
import type { Objective } from '@operationkit/shared'

// obj-706070 — the ACTING-USER resolution proof for per-user Google Workspace.
//
// Command Center used to hand every spawned session ONE shared Google credential
// (Operator's). This suite is the payoff test for replacing it: the Google identity a
// session receives is resolved from the OBJECTIVE'S OWNER, so Ava's objective
// spawns with Ava's refresh token and Operator's with Operator's — and neither env can
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

const { initDb, getDb } = await import('../db/index.js')
const google = await import('./user-google-connections.js')
const { userGoogleCredentialEnv, buildSpawnEnv } = await import('./session-manager.js')

const OWNER = { id: 1, username: 'admin', email: 'dev@example.com', refresh: '1//0gOWNER_refresh_secret_AAA111' }
const AVA = { id: 2, username: 'ava', email: 'ava@example.com', refresh: '1//0gAVA_refresh_secret_BBB222' }

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
  return { id: 706070, workspace: 'personal', project: 'command-center-infra', created_by: ownerId } as Objective
}

function envFor(ownerId: number | null): Record<string, string> {
  return buildSpawnEnv({ objective: objectiveOwnedBy(ownerId), homeDir: '/home/ccuser-a', sessionKind: 'worker' })
}

beforeAll(() => {
  initDb()
})

beforeEach(() => {
  getDb().exec('DELETE FROM user_google_connections; DELETE FROM users;')
  seedUser(OWNER.id, OWNER.username)
  seedUser(AVA.id, AVA.username)
})

afterAll(() => {
  try { getDb().close() } catch {}
})

describe('userGoogleCredentialEnv — resolves the ACTING USER, two distinct connected users', () => {
  it('owner 1 (admin) gets admin’s token + email, marked as a user connection', () => {
    connect(OWNER)
    connect(AVA)
    const env = userGoogleCredentialEnv(OWNER.id)
    expect(env.GOOGLE_WORKSPACE_CONNECTION).toBe('user')
    expect(env.GOOGLE_REFRESH_TOKEN).toBe(OWNER.refresh)
    expect(env.USER_GOOGLE_EMAIL).toBe(OWNER.email)
    expect(env.GOOGLE_OAUTH_CLIENT_ID).toBe(process.env.GOOGLE_OAUTH_CLIENT_ID)
    expect(env.GOOGLE_OAUTH_CLIENT_SECRET).toBe(process.env.GOOGLE_OAUTH_CLIENT_SECRET)
  })

  it('owner 2 (ava) gets ava’s token + email from the same DB', () => {
    connect(OWNER)
    connect(AVA)
    const env = userGoogleCredentialEnv(AVA.id)
    expect(env.GOOGLE_WORKSPACE_CONNECTION).toBe('user')
    expect(env.GOOGLE_REFRESH_TOKEN).toBe(AVA.refresh)
    expect(env.USER_GOOGLE_EMAIL).toBe(AVA.email)
  })
})

describe('buildSpawnEnv — CROSS-USER ISOLATION PROOF (the whole point of obj-706070)', () => {
  it('admin’s objective spawns with admin’s Google credential and NOT ava’s', () => {
    connect(OWNER)
    connect(AVA)
    const env = envFor(OWNER.id)
    expect(env.GOOGLE_WORKSPACE_CONNECTION).toBe('user')
    expect(env.GOOGLE_REFRESH_TOKEN).toBe(OWNER.refresh)
    expect(env.USER_GOOGLE_EMAIL).toBe(OWNER.email)
    // The isolation assertion: ava's material is nowhere in admin's env.
    expect(env.GOOGLE_REFRESH_TOKEN).not.toBe(AVA.refresh)
    expect(JSON.stringify(env)).not.toContain(AVA.refresh)
    expect(JSON.stringify(env)).not.toContain(AVA.email)
  })

  it('ava’s objective spawns with ava’s Google credential and NOT admin’s', () => {
    connect(OWNER)
    connect(AVA)
    const env = envFor(AVA.id)
    expect(env.GOOGLE_WORKSPACE_CONNECTION).toBe('user')
    expect(env.GOOGLE_REFRESH_TOKEN).toBe(AVA.refresh)
    expect(env.USER_GOOGLE_EMAIL).toBe(AVA.email)
    // …and admin's (the OLD shared credential) is nowhere in ava's env.
    expect(env.GOOGLE_REFRESH_TOKEN).not.toBe(OWNER.refresh)
    expect(JSON.stringify(env)).not.toContain(OWNER.refresh)
    expect(JSON.stringify(env)).not.toContain(OWNER.email)
  })

  it('the two envs differ ONLY in the per-user Google keys (same base spawn env)', () => {
    connect(OWNER)
    connect(AVA)
    const a = envFor(OWNER.id)
    const b = envFor(AVA.id)
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

  it('assigned user wins over created_by (Ava assigned to Operator’s card sends as Ava)', () => {
    connect(OWNER)
    connect(AVA)
    const env = buildSpawnEnv({
      objective: { ...objectiveOwnedBy(OWNER.id), assigned_user_id: AVA.id } as Objective,
      homeDir: '/home/ccuser-a',
      sessionKind: 'worker',
    })
    expect(env.CC_ACTING_USER_ID).toBe(String(AVA.id))
    expect(env.USER_GOOGLE_EMAIL).toBe(AVA.email)
    expect(env.GOOGLE_REFRESH_TOKEN).toBe(AVA.refresh)
    expect(env.GOOGLE_REFRESH_TOKEN).not.toBe(OWNER.refresh)
    expect(env.WORKSPACE_MCP_CREDENTIALS_DIR).toContain(`/google-creds/${AVA.id}`)
  })

  it('attribution follows the OWNER across all 5 spawn kinds', () => {
    connect(AVA)
    for (const k of ['worker', 'arena', 'followup', 'planner', 'reviewer'] as const) {
      const env = buildSpawnEnv({ objective: objectiveOwnedBy(AVA.id), homeDir: '/home/ccuser-a', sessionKind: k })
      expect(env.GOOGLE_REFRESH_TOKEN).toBe(AVA.refresh)
      expect(env.USER_GOOGLE_EMAIL).toBe(AVA.email)
    }
  })
})

describe('EXPLICIT ABSENCE — no silent fallback to the old shared (Operator) credential', () => {
  it('an owner with NO connection row gets ‘absent’ and NO Google token/email keys at all', () => {
    connect(OWNER) // admin IS connected — ava must still not inherit him
    const env = envFor(AVA.id)
    expect(env.GOOGLE_WORKSPACE_CONNECTION).toBe('absent')
    expect(env.GOOGLE_REFRESH_TOKEN).toBeUndefined()
    expect(env.USER_GOOGLE_EMAIL).toBeUndefined()
    expect('GOOGLE_REFRESH_TOKEN' in env).toBe(false)
    expect('USER_GOOGLE_EMAIL' in env).toBe(false)
    // The regression this objective exists to kill: admin's credential leaking
    // into a session run for somebody else.
    expect(JSON.stringify(env)).not.toContain(OWNER.refresh)
    expect(JSON.stringify(env)).not.toContain(OWNER.email)
  })

  it('created_by null (automation / unowned) ⇒ ‘absent’', () => {
    connect(OWNER)
    const env = envFor(null)
    expect(env.GOOGLE_WORKSPACE_CONNECTION).toBe('absent')
    expect(env.GOOGLE_REFRESH_TOKEN).toBeUndefined()
    expect(userGoogleCredentialEnv(null)).toEqual({ GOOGLE_WORKSPACE_CONNECTION: 'absent' })
    expect(userGoogleCredentialEnv(undefined)).toEqual({ GOOGLE_WORKSPACE_CONNECTION: 'absent' })
  })

  it('an owner id that does not exist at all ⇒ ‘absent’', () => {
    expect(userGoogleCredentialEnv(999999)).toEqual({ GOOGLE_WORKSPACE_CONNECTION: 'absent' })
  })

  it('NEVER THROWS when the OAuth client env vars are unset ⇒ ‘absent’ (spawn is never blocked)', () => {
    connect(OWNER)
    const savedId = process.env.GOOGLE_OAUTH_CLIENT_ID
    const savedSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET
    delete process.env.GOOGLE_OAUTH_CLIENT_ID
    delete process.env.GOOGLE_OAUTH_CLIENT_SECRET
    try {
      expect(() => userGoogleCredentialEnv(OWNER.id)).not.toThrow()
      expect(userGoogleCredentialEnv(OWNER.id)).toEqual({ GOOGLE_WORKSPACE_CONNECTION: 'absent' })
      const env = envFor(OWNER.id)
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
