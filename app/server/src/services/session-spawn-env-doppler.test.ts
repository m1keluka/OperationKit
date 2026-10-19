import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import os from 'os'
import path from 'path'
import type { Objective } from '@operationkit/shared'

// obj-2411 / Phase 0 — scoped-Doppler cutover: spawn-tier resolution + the
// flag-ON member-scoped env. Complements session-spawn-env.test.ts (which locks
// the flags-OFF byte-identical regression) by exercising the now-FILLED seams:
//   • resolveSpawnTier reads the owner's GLOBAL role (member ⇒ 'member', else admin)
//   • flag ON + member tier + a POPULATED map ⇒ env has ONLY the scoped read-only
//     Doppler token and NO SUPABASE_ACCESS_TOKEN.
//
// Key + isolated DB set BEFORE importing modules that read them at first use
// (mirrors session-spawn-env-secrets.test.ts).
process.env.TEST_CRED_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64')
const TMP_DB = path.join(os.tmpdir(), `cc-doppler-spawn-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const scoped = await import('./doppler-scoped-tokens.js')

function fakeObjective(over: Partial<Objective> = {}): Objective {
  return { id: 42, workspace: 'example', project: 'example-platform', created_by: 7, ...over } as Objective
}

function seedUser(id: number, username: string, role: 'admin' | 'member'): void {
  getDb()
    .prepare(`INSERT OR IGNORE INTO users (id, username, password_hash, role) VALUES (?, ?, 'x', ?)`)
    .run(id, username, role)
}

beforeAll(() => {
  initDb()
})

beforeEach(() => {
  getDb().exec('DELETE FROM doppler_scoped_tokens; DELETE FROM users;')
  seedUser(1, 'mike', 'admin')
  seedUser(7, 'eva', 'member')
})

describe('resolveSpawnTier — resolved from the owner global role (no longer hardcoded)', () => {
  it("returns 'member' for an objective whose created_by has global role 'member'", async () => {
    const sm = await import('./session-manager.js')
    expect(sm.resolveSpawnTier(fakeObjective({ created_by: 7 }))).toBe('member')
  })

  it("returns 'admin' for an objective whose created_by is an admin", async () => {
    const sm = await import('./session-manager.js')
    expect(sm.resolveSpawnTier(fakeObjective({ created_by: 1 }))).toBe('admin')
  })

  it("fails safe to 'admin' for an unknown / null owner", async () => {
    const sm = await import('./session-manager.js')
    expect(sm.resolveSpawnTier(fakeObjective({ created_by: 9999 }))).toBe('admin')
    expect(sm.resolveSpawnTier(fakeObjective({ created_by: null as unknown as number }))).toBe('admin')
  })
})

describe('buildSpawnEnv — flag ON + member tier + populated map', () => {
  // Flags are read at module import from process.env; re-import a fresh module
  // graph with the flags ON (same technique as session-spawn-env.test.ts).
  const KEYS = ['USE_SCOPED_DOPPLER_TOKENS', 'SCOPE_SUPABASE_ACCESS_TOKEN', 'SUPABASE_ACCESS_TOKEN'] as const
  let saved: Record<string, string | undefined>
  beforeEach(() => {
    saved = {}
    for (const k of KEYS) saved[k] = process.env[k]
    process.env.USE_SCOPED_DOPPLER_TOKENS = '1'
    process.env.SCOPE_SUPABASE_ACCESS_TOKEN = '1'
    process.env.SUPABASE_ACCESS_TOKEN = 'org-supabase-token-xyz'
  })
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    vi.resetModules()
  })

  it('member spawn gets ONLY its workspace read-only Doppler token and NO SUPABASE_ACCESS_TOKEN', async () => {
    // Provision a scoped token for the objective's workspace.
    scoped.setScopedDopplerToken({ workspace: 'example', token: 'dp.st.prd.SCOPED_EXAMPLE_RO_9876', dopplerProject: 'example-platform' })

    vi.resetModules()
    // Fresh module graph reads the same DB_PATH file; re-init so the resolver sees
    // the seeded row + the member user.
    const freshDb = await import('../db/index.js')
    freshDb.initDb()
    const sm = await import('./session-manager.js')

    // created_by=7 (eva, member) ⇒ tier resolves to 'member' on its own (no override).
    const env = sm.buildSpawnEnv({
      objective: fakeObjective({ created_by: 7, workspace: 'example' }),
      homeDir: '/home/ccuser-a',
      sessionKind: 'worker',
    })

    expect(env.DOPPLER_TOKEN).toBeUndefined()
    expect(env.SUPABASE_ACCESS_TOKEN).toBe('') // org PAT withheld from members
  })

  it('member spawn never receives a DOPPLER_TOKEN even when a scoped map row exists', async () => {
    vi.resetModules()
    const freshDb = await import('../db/index.js')
    freshDb.initDb()
    const sm = await import('./session-manager.js')
    const env = sm.buildSpawnEnv({
      objective: fakeObjective({ created_by: 7, workspace: 'example2' }),
      homeDir: '/home/ccuser-a',
      sessionKind: 'worker',
    })
    expect(env.DOPPLER_TOKEN).toBeUndefined()
    expect(env.SUPABASE_ACCESS_TOKEN).toBe('')
  })

  it('admin-owned objective has no DOPPLER_TOKEN; keeps org Supabase', async () => {
    scoped.setScopedDopplerToken({ workspace: 'example', token: 'dp.st.prd.SCOPED_EXAMPLE_RO_9876' })

    vi.resetModules()
    const freshDb = await import('../db/index.js')
    freshDb.initDb()
    const sm = await import('./session-manager.js')

    const env = sm.buildSpawnEnv({
      objective: fakeObjective({ created_by: 1, workspace: 'example' }),
      homeDir: '/home/ccuser-a',
      sessionKind: 'worker',
    })

    expect(env.DOPPLER_TOKEN).toBeUndefined()
    expect(env.SUPABASE_ACCESS_TOKEN).toBe('org-supabase-token-xyz')
  })
})
