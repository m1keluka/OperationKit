import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  buildSpawnEnv,
  spawnSecurityPolicy,
  resolveSpawnTier,
  userGitIdentityEnv,
  SAFE_FALLBACK_GIT_IDENTITY,
} from './session-manager.js'
import { GIT_SSH_COMMAND } from '../config.js'
import type { Objective } from '@command-center/shared'

// obj-2202 / onboarding gate B1–B4 — spawn-env scoping refactor.
//
// THE load-bearing guarantee: with both scoping flags OFF (the committed default)
// and the default ADMIN tier, buildSpawnEnv() returns a BYTE-FOR-BYTE identical env
// to the old duplicated inline block at every spawn site. If this ever drifts, an
// admin session's runtime secret/identity env has silently changed — a regression
// the moment it ships. We also lock the two-tier policy and the W4 extension hook.

// A minimal objective — buildSpawnEnv only reads created_by (W4 hook) and, on the
// scoped seam, workspace/project (which return '' today). Cast a partial.
function fakeObjective(over: Partial<Objective> = {}): Objective {
  return { id: 42, workspace: 'example', project: 'example-platform', created_by: 7, ...over } as Objective
}

function legacyInlineEnv(homeDir: string): Record<string, string> {
  return {
    HOME: homeDir,
    USER: 'ccuser',
    TERM: 'dumb',
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    GIT_SSH_COMMAND,
    GH_CONFIG_DIR: '/etc/gh',
    SUPABASE_ACCESS_TOKEN: process.env.SUPABASE_ACCESS_TOKEN || '',
  }
}

// obj-701130 — the base env above is NO LONGER the whole story for an UNLINKED
// owner. buildSpawnEnv now ALWAYS appends the GitHub-linked m1keluka noreply
// fallback (GIT_AUTHOR_*/GIT_COMMITTER_*) after the base block whenever no
// per-user identity was injected, so an env-less spawn can never fall through to
// the poisoned root /etc/gitconfig (dev@example.com) and trip Vercel's
// COMMIT_AUTHOR_REQUIRED. These 4 keys append in this exact order (after the base
// keys, before any flag-gated scoped secrets) — the byte/key-order contract below
// was updated DELIBERATELY to include them.
function expectedEnv(homeDir: string): Record<string, string> {
  return {
    ...legacyInlineEnv(homeDir),
    GIT_AUTHOR_NAME: SAFE_FALLBACK_GIT_IDENTITY.name,
    GIT_AUTHOR_EMAIL: SAFE_FALLBACK_GIT_IDENTITY.email,
    GIT_COMMITTER_NAME: SAFE_FALLBACK_GIT_IDENTITY.name,
    GIT_COMMITTER_EMAIL: SAFE_FALLBACK_GIT_IDENTITY.email,
    // obj-706070 — per-user Google Workspace. With no connection row for the
    // objective's owner the resolver contributes exactly ONE key: the explicit
    // -absence marker. No token keys, and specifically no fallback to anyone
    // else's Google credential. Deliberate addition to the key contract.
    GOOGLE_WORKSPACE_CONNECTION: 'absent',
    WORKSPACE_MCP_CREDENTIALS_DIR: `${process.env.CC_SCRIPT_DIR || '/tmp/cc-scripts'}/google-creds/absent-7`,
    CC_ACTING_USER_ID: '7',
  }
}

describe('buildSpawnEnv — no-regression base block + obj-701130 git-author fallback (flags OFF default + admin tier)', () => {
  const HOME = '/home/ccuser-a'

  it('base block equals the legacy inline literal, PLUS the linked git-author fallback (obj-701130)', () => {
    // Was: expect(env).toEqual(legacyInlineEnv(HOME)). DELIBERATELY CHANGED —
    // buildSpawnEnv now always appends the m1keluka noreply fallback for an
    // unlinked owner so no spawn can hit the poisoned /etc/gitconfig. The base 8
    // keys are still byte-identical; the 4 fallback keys are the intended addition.
    const env = buildSpawnEnv({ objective: fakeObjective(), homeDir: HOME, sessionKind: 'worker' })
    expect(env).toEqual(expectedEnv(HOME))
  })

  it('preserves the exact key set AND key order the wrapper serializes', () => {
    // The wrapper script does Object.entries(env).map(export ...). Order is part of
    // the byte-for-byte contract, so assert the ordered key list explicitly. The 4
    // GIT_AUTHOR_*/GIT_COMMITTER_* fallback keys (obj-701130) append after the base
    // block, in the order the code assigns them.
    const env = buildSpawnEnv({ objective: fakeObjective(), homeDir: HOME, sessionKind: 'worker' })
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

  it('is identical across all 5 spawn kinds for a given homeDir (single source of truth)', () => {
    const kinds = ['worker', 'arena', 'followup', 'planner', 'reviewer'] as const
    const envs = kinds.map((k) => buildSpawnEnv({ objective: fakeObjective(), homeDir: HOME, sessionKind: k }))
    for (const env of envs) expect(env).toEqual(expectedEnv(HOME))
  })

  it('threads the per-site homeDir through unchanged (HOME differs, nothing else)', () => {
    const a = buildSpawnEnv({ objective: fakeObjective(), homeDir: '/home/ccuser-a', sessionKind: 'worker' })
    const b = buildSpawnEnv({ objective: fakeObjective(), homeDir: '/home/ccuser-b', sessionKind: 'planner' })
    expect(a.HOME).toBe('/home/ccuser-a')
    expect(b.HOME).toBe('/home/ccuser-b')
    expect({ ...a, HOME: 'x' }).toEqual({ ...b, HOME: 'x' })
  })

  it('passes SUPABASE_ACCESS_TOKEN through verbatim when present (flag off)', () => {
    const prev = process.env.SUPABASE_ACCESS_TOKEN
    process.env.SUPABASE_ACCESS_TOKEN = 'org-supabase-token-xyz'
    try {
      const env = buildSpawnEnv({ objective: fakeObjective(), homeDir: HOME, sessionKind: 'worker' })
      expect(env.SUPABASE_ACCESS_TOKEN).toBe('org-supabase-token-xyz')
    } finally {
      if (prev === undefined) delete process.env.SUPABASE_ACCESS_TOKEN
      else process.env.SUPABASE_ACCESS_TOKEN = prev
    }
  })
})

describe('userGitIdentityEnv — W4 hook, UNLINKED-owner fallback (filled by obj-2221)', () => {
  // The hook itself is unchanged: for an owner with no linked token it still
  // returns {} (fakeObjective().created_by = 7 has no token row in this test DB).
  // What changed (obj-701130) is what buildSpawnEnv does with that {}: it now
  // injects the m1keluka noreply GIT_AUTHOR_*/GIT_COMMITTER_* fallback so the
  // spawn never inherits the poisoned /etc/gitconfig. The LINKED path (token
  // present ⇒ GH_TOKEN + per-user GIT_AUTHOR_*/GIT_COMMITTER_*) is proven in
  // session-user-git-identity.test.ts against a seeded, encrypted token row.
  it('the hook still returns {} for an owner with no linked token (fallback is applied by buildSpawnEnv, not here)', () => {
    expect(userGitIdentityEnv(7)).toEqual({})
    expect(userGitIdentityEnv(null)).toEqual({})
    expect(userGitIdentityEnv(undefined)).toEqual({})
  })

  it('spawn env for an unlinked owner carries the linked noreply git-author fallback, NOT a token or dev@example.com', () => {
    const env = buildSpawnEnv({ objective: fakeObjective(), homeDir: '/home/ccuser-a', sessionKind: 'worker' })
    // No PR-actor token for an unlinked owner — PR auth still rides the shared /etc/gh.
    expect(env.GH_TOKEN).toBeUndefined()
    expect(env.GITHUB_TOKEN).toBeUndefined()
    // But the commit author/committer are now the GitHub-linked m1keluka noreply id…
    expect(env.GIT_AUTHOR_EMAIL).toBe('255270713+m1keluka@users.noreply.github.com')
    expect(env.GIT_AUTHOR_NAME).toBe('m1keluka')
    expect(env.GIT_COMMITTER_EMAIL).toBe('255270713+m1keluka@users.noreply.github.com')
    expect(env.GIT_COMMITTER_NAME).toBe('m1keluka')
    // …and NEVER the poisoned unlinked identity that trips Vercel COMMIT_AUTHOR_REQUIRED.
    expect(env.GIT_AUTHOR_EMAIL).not.toBe('dev@example.com')
    expect(env.GIT_AUTHOR_EMAIL).toBe(SAFE_FALLBACK_GIT_IDENTITY.email)
  })
})

describe('spawnSecurityPolicy — two-tier (admin vs member)', () => {
  it('ADMIN tier grants every capability (unchanged current behavior)', () => {
    expect(spawnSecurityPolicy(true)).toEqual({
      dockerSocket: true,
      adminTokenFile: true,
      siblingHomeAccess: true,
      adminDopplerToken: true,
      supabaseToken: true,
    })
  })

  it('MEMBER tier denies docker socket, admin-token file, sibling homes, and org secrets', () => {
    const p = spawnSecurityPolicy(false)
    expect(p.dockerSocket).toBe(false)
    expect(p.adminTokenFile).toBe(false)
    expect(p.siblingHomeAccess).toBe(false)
    expect(p.adminDopplerToken).toBe(false)
    expect(p.supabaseToken).toBe(false)
  })

  it('resolveSpawnTier fails safe to admin for an unknown/unseeded owner (role-resolved seam, obj-2411)', () => {
    // The seam now resolves from the owner's GLOBAL role (member ⇒ 'member', else
    // admin). With no users row for this owner in the ambient test DB it must fail
    // SAFE to 'admin' = today's full-capability behavior — never silently downgrade.
    // The positive member-tier case is proven in session-spawn-env-doppler.test.ts
    // against a seeded member user + isolated DB.
    expect(resolveSpawnTier(fakeObjective({ created_by: 987654 }))).toBe('admin')
    expect(resolveSpawnTier(fakeObjective({ created_by: null as unknown as number }))).toBe('admin')
  })
})

describe('buildSpawnEnv — member tier with flags OFF still == current behavior', () => {
  // The FLAG, not the tier alone, gates the change. With flags off, even an
  // explicit member spawn gets today's env — proving zero behavior change ships
  // until the cutover flips a flag.
  it('member spawn (flags off) still receives org Supabase and never a DOPPLER_TOKEN', () => {
    const prev = process.env.SUPABASE_ACCESS_TOKEN
    process.env.SUPABASE_ACCESS_TOKEN = 'org-supabase-token-xyz'
    try {
      const env = buildSpawnEnv({ objective: fakeObjective(), homeDir: '/home/ccuser-a', sessionKind: 'worker', isAdminSpawn: false })
      expect(env.DOPPLER_TOKEN).toBeUndefined()
      expect(env.SUPABASE_ACCESS_TOKEN).toBe('org-supabase-token-xyz')
    } finally {
      if (prev === undefined) delete process.env.SUPABASE_ACCESS_TOKEN
      else process.env.SUPABASE_ACCESS_TOKEN = prev
    }
  })
})

describe('buildSpawnEnv — flags ON cutover behavior (member scoped, admin unchanged)', () => {
  // Flags are read at module import from process.env. Re-import a fresh module
  // graph with the flags set ON to exercise the dormant cutover branch without
  // touching the committed defaults.
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

  it('member spawn: no DOPPLER_TOKEN; Supabase withheld when SCOPE_SUPABASE_ACCESS_TOKEN is on', async () => {
    vi.resetModules()
    const sm = await import('./session-manager.js')
    const obj = { id: 42, workspace: 'example', project: 'example-platform', created_by: 7 } as Objective
    const env = sm.buildSpawnEnv({ objective: obj, homeDir: '/home/ccuser-a', sessionKind: 'worker', isAdminSpawn: false })
    expect(env.DOPPLER_TOKEN).toBeUndefined()
    expect(env.SUPABASE_ACCESS_TOKEN).toBe('')
  })

  it('admin spawn: no DOPPLER_TOKEN; keeps org Supabase', async () => {
    vi.resetModules()
    const sm = await import('./session-manager.js')
    const obj = { id: 42, workspace: 'example', project: 'example-platform', created_by: 7 } as Objective
    const env = sm.buildSpawnEnv({ objective: obj, homeDir: '/home/ccuser-a', sessionKind: 'worker', isAdminSpawn: true })
    expect(env.DOPPLER_TOKEN).toBeUndefined()
    expect(env.SUPABASE_ACCESS_TOKEN).toBe('org-supabase-token-xyz')
  })
})
