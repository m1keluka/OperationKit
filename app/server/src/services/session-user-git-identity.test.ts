import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import os from 'os'
import path from 'path'
import type { Objective } from '@operationkit/shared'

// obj-2221 / W4 — per-user GitHub PR attribution wired into the spawn env.
//
// This is the payoff test for the W1+W3 integration: once a user links a GitHub
// token (W1), an objective they OWN must spawn a session whose commits AND opened
// PR attribute to THEM (W3's userGitIdentityEnv hook, filled by W4). When the
// owner has no linked token, the hook must return nothing so the spawn falls back
// to the shared bot identity — work is NEVER blocked.
//
// The encryption key + isolated DB must be set BEFORE importing the modules that
// read them at import/first-use time. Mirrors user-github-tokens.test.ts.
process.env.TEST_CRED_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64')
const TMP_DB = path.join(os.tmpdir(), `cc-w4-attr-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
// Hard-assert the scoped-Doppler cutover is NOT what makes attribution work.
delete process.env.USE_SCOPED_DOPPLER_TOKENS
delete process.env.SCOPE_SUPABASE_ACCESS_TOKEN

const { initDb, getDb } = await import('../db/index.js')
const tokens = await import('./user-github-tokens.js')
const { userGitIdentityEnv, buildSpawnEnv } = await import('./session-manager.js')

function seedUser(id: number, username: string): void {
  getDb()
    .prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, 'x', 'member')`)
    .run(id, username)
}

const RAW_PAT = 'github_pat_11WLINKED_evaTokenSecret_abcd1234'
const EVA_LOGIN = 'eva-example'
const EVA_EMAIL = '5150+eva-example@users.noreply.github.com'

/** Link a real (encrypted) token for `userId` exactly as the save route would. */
function linkEva(userId: number): void {
  tokens.upsert(userId, {
    rawToken: RAW_PAT,
    login: EVA_LOGIN,
    githubUserId: 5150,
    email: EVA_EMAIL,
    scopes: null,
    tokenType: 'pat_fine',
  })
}

function objectiveOwnedBy(ownerId: number | null): Objective {
  return { id: 2221, workspace: 'personal', project: 'command-center-infra', created_by: ownerId } as Objective
}

beforeAll(() => {
  initDb()
})
beforeEach(() => {
  getDb().exec('DELETE FROM user_github_tokens; DELETE FROM users;')
})

describe('userGitIdentityEnv — linked owner injects full per-user GitHub identity', () => {
  it('returns GH_TOKEN + GITHUB_TOKEN + GIT_AUTHOR_*/GIT_COMMITTER_* derived from the user', () => {
    seedUser(7, 'eva')
    linkEva(7)

    const env = userGitIdentityEnv(7)
    // PR "opened by" actor lever — the token that runs `gh pr create`.
    expect(env.GH_TOKEN).toBe(RAW_PAT)
    expect(env.GITHUB_TOKEN).toBe(RAW_PAT)
    // Commit author + committer lever — must be the user, both author AND committer.
    expect(env.GIT_AUTHOR_NAME).toBe(EVA_LOGIN)
    expect(env.GIT_AUTHOR_EMAIL).toBe(EVA_EMAIL)
    expect(env.GIT_COMMITTER_NAME).toBe(EVA_LOGIN)
    expect(env.GIT_COMMITTER_EMAIL).toBe(EVA_EMAIL)
    // Exactly these six keys, nothing else.
    expect(Object.keys(env).sort()).toEqual([
      'GH_TOKEN', 'GITHUB_TOKEN',
      'GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_NAME',
      'GIT_COMMITTER_EMAIL', 'GIT_COMMITTER_NAME',
    ].sort())
  })

  it('author and committer are the SAME identity (no "authored by Eva, committed by bot" split)', () => {
    seedUser(7, 'eva')
    linkEva(7)
    const env = userGitIdentityEnv(7)
    expect(env.GIT_AUTHOR_NAME).toBe(env.GIT_COMMITTER_NAME)
    expect(env.GIT_AUTHOR_EMAIL).toBe(env.GIT_COMMITTER_EMAIL)
  })
})

describe('userGitIdentityEnv — unlinked owner falls back to bot identity (never blocks)', () => {
  it('returns {} when the owner has no linked token', () => {
    seedUser(8, 'unlinked')
    expect(userGitIdentityEnv(8)).toEqual({})
  })
  it('returns {} for a null/undefined owner (automation / unowned)', () => {
    expect(userGitIdentityEnv(null)).toEqual({})
    expect(userGitIdentityEnv(undefined)).toEqual({})
  })
  it('returns {} for an owner id that does not exist at all', () => {
    expect(userGitIdentityEnv(999999)).toEqual({})
  })
})

describe('buildSpawnEnv — attribution rides on the spawn env, flags OFF (decoupled from Doppler cutover)', () => {
  it('LINKED owner: spawn env gains exactly the additive per-user identity keys, base unchanged', () => {
    seedUser(7, 'eva')
    linkEva(7)
    const linked = buildSpawnEnv({ objective: objectiveOwnedBy(7), homeDir: '/home/ccuser-a', sessionKind: 'worker' })

    // The additive keys are present and correct…
    expect(linked.GH_TOKEN).toBe(RAW_PAT)
    expect(linked.GIT_AUTHOR_EMAIL).toBe(EVA_EMAIL)
    expect(linked.GIT_COMMITTER_EMAIL).toBe(EVA_EMAIL)

    // …and the shared transport / base identity is untouched (push stays on the
    // shared SSH key; gh config dir unchanged). Attribution does NOT need the
    // scoped-Doppler cutover — flags are OFF here.
    expect(linked.GIT_SSH_COMMAND).toBeDefined()
    expect(linked.GH_CONFIG_DIR).toBe('/etc/gh')

    // obj-701130: an unlinked owner now ALSO carries a git-author identity — the
    // m1keluka noreply FALLBACK (not EVA's per-user id, and not a GH_TOKEN). So the
    // two envs share the same base ONCE each side's git-author keys are stripped:
    // the linked side loses its 6 per-user keys, the unlinked side loses its 4
    // fallback keys, and what remains is byte-identical.
    const unlinked = buildSpawnEnv({ objective: objectiveOwnedBy(8), homeDir: '/home/ccuser-a', sessionKind: 'worker' })
    const perUser = ['GH_TOKEN', 'GITHUB_TOKEN', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'CC_ACTING_USER_ID', 'WORKSPACE_MCP_CREDENTIALS_DIR']
    const fallbackKeys = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'CC_ACTING_USER_ID', 'WORKSPACE_MCP_CREDENTIALS_DIR']
    const strippedLinked = { ...linked }
    for (const k of perUser) delete strippedLinked[k]
    const strippedUnlinked = { ...unlinked }
    for (const k of fallbackKeys) delete strippedUnlinked[k]
    expect(strippedLinked).toEqual(strippedUnlinked)
  })

  it('UNLINKED owner: spawn env carries the m1keluka noreply git-author FALLBACK, no token, never cc@ (obj-701130)', () => {
    seedUser(8, 'unlinked')
    const env = buildSpawnEnv({ objective: objectiveOwnedBy(8), homeDir: '/home/ccuser-a', sessionKind: 'worker' })
    // No PR-actor token for an unlinked owner (PR auth rides the shared /etc/gh).
    expect(env.GH_TOKEN).toBeUndefined()
    expect(env.GITHUB_TOKEN).toBeUndefined()
    // Commit author/committer = the GitHub-linked m1keluka noreply fallback — the
    // durable guard against Vercel COMMIT_AUTHOR_REQUIRED. NEVER dev@example.com.
    expect(env.GIT_AUTHOR_EMAIL).toBe('255270713+m1keluka@users.noreply.github.com')
    expect(env.GIT_AUTHOR_NAME).toBe('m1keluka')
    expect(env.GIT_COMMITTER_EMAIL).toBe('255270713+m1keluka@users.noreply.github.com')
    expect(env.GIT_COMMITTER_NAME).toBe('m1keluka')
    expect(env.GIT_AUTHOR_EMAIL).not.toBe('dev@example.com')
    expect(Object.keys(env)).toEqual([
      'HOME', 'USER', 'TERM', 'PATH', 'GIT_SSH_COMMAND', 'GH_CONFIG_DIR',
      'SUPABASE_ACCESS_TOKEN',
      'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL',
      // obj-706070 — the per-user Google resolver ALWAYS appends an explicit
      // connection marker. This owner has no google connection row, so it is
      // 'absent' and contributes no token keys (no silent fallback to a shared
      // credential). Deliberate addition to the key contract; the connected
      // branch is proven in session-google-credential.test.ts.
      'GOOGLE_WORKSPACE_CONNECTION',
      'WORKSPACE_MCP_CREDENTIALS_DIR',
      'CC_ACTING_USER_ID',
    ])
  })

  it('LINKED owner identity takes PRECEDENCE over the fallback (per-user email wins, obj-701130)', () => {
    seedUser(7, 'eva')
    linkEva(7)
    const env = buildSpawnEnv({ objective: objectiveOwnedBy(7), homeDir: '/home/ccuser-a', sessionKind: 'worker' })
    // The per-user identity from userGitIdentityEnv must NOT be overwritten by the
    // fallback — obj-701130 only fills GIT_AUTHOR_EMAIL when it is absent.
    expect(env.GIT_AUTHOR_EMAIL).toBe(EVA_EMAIL)
    expect(env.GIT_AUTHOR_EMAIL).not.toBe('255270713+m1keluka@users.noreply.github.com')
    expect(env.GIT_COMMITTER_EMAIL).toBe(EVA_EMAIL)
    expect(env.GH_TOKEN).toBe(RAW_PAT)
  })

  it('assigned user wins over created_by for GitHub attribution', () => {
    seedUser(1, 'mike')
    seedUser(7, 'eva')
    linkEva(7)
    const env = buildSpawnEnv({
      objective: { ...objectiveOwnedBy(1), assigned_user_id: 7 } as Objective,
      homeDir: '/home/ccuser-a',
      sessionKind: 'worker',
    })
    expect(env.CC_ACTING_USER_ID).toBe('7')
    expect(env.GH_TOKEN).toBe(RAW_PAT)
    expect(env.GIT_AUTHOR_EMAIL).toBe(EVA_EMAIL)
  })

  it('attribution follows the OBJECTIVE OWNER, not the spawn — same linked user across all 5 spawn kinds', () => {
    seedUser(7, 'eva')
    linkEva(7)
    const kinds = ['worker', 'arena', 'followup', 'planner', 'reviewer'] as const
    for (const k of kinds) {
      const env = buildSpawnEnv({ objective: objectiveOwnedBy(7), homeDir: '/home/ccuser-a', sessionKind: k })
      expect(env.GH_TOKEN).toBe(RAW_PAT)
      expect(env.GIT_AUTHOR_EMAIL).toBe(EVA_EMAIL)
    }
  })
})

describe('E2E ATTRIBUTION PROOF (deterministic harness; live-push limitation stated)', () => {
  // The runnable, printed proof artifact for obj-2221 acceptance [e2e-attribution-proof].
  //
  // LIVE-PUSH LIMITATION (explicit, no faking): this sandbox has no real second-user
  // PAT / SSO-authorized token for your-org, so we do NOT perform a live
  // `git push` + `gh pr create`. The proof is the deterministic construction of the
  // exact attribution env the spawned child receives. The live confirmation step —
  // open a PR as a linked user, then read back the GitHub "opened by" actor and the
  // HEAD commit author via the API — is the OPERATOR step documented in
  // app/server/SPAWN-ENV-SCOPING-CUTOVER.md, which Mike runs once Eva links her token.
  const mask = (v: string | undefined) =>
    typeof v === 'string' && v.length > 8 ? `${v.slice(0, 11)}…${v.slice(-4)} (len ${v.length})` : String(v)

  it('builds the exact GH_TOKEN + GIT_AUTHOR_*/GIT_COMMITTER_* env for a linked owner', () => {
    seedUser(7, 'eva')
    linkEva(7)
    const env = buildSpawnEnv({ objective: objectiveOwnedBy(7), homeDir: '/home/ccuser-a', sessionKind: 'worker' })

    /* eslint-disable no-console */
    console.log('\n=== W4 E2E ATTRIBUTION PROOF — linked owner (user 7 = Eva) ===')
    console.log('  PR opened-by actor lever:')
    console.log('    GH_TOKEN            =', mask(env.GH_TOKEN))
    console.log('    GITHUB_TOKEN        =', mask(env.GITHUB_TOKEN))
    console.log('  commit author+committer lever:')
    console.log('    GIT_AUTHOR_NAME     =', env.GIT_AUTHOR_NAME)
    console.log('    GIT_AUTHOR_EMAIL    =', env.GIT_AUTHOR_EMAIL)
    console.log('    GIT_COMMITTER_NAME  =', env.GIT_COMMITTER_NAME)
    console.log('    GIT_COMMITTER_EMAIL =', env.GIT_COMMITTER_EMAIL)
    console.log('  shared transport unchanged: GH_CONFIG_DIR =', env.GH_CONFIG_DIR, '| GIT_SSH_COMMAND set =', !!env.GIT_SSH_COMMAND)
    console.log('  LIVE-PUSH LIMITATION: no real 2nd-user PAT in sandbox ⇒ no live `gh pr create`; operator step in SPAWN-ENV-SCOPING-CUTOVER.md')
    /* eslint-enable no-console */

    expect(env.GH_TOKEN).toBe(RAW_PAT)
    expect(env.GITHUB_TOKEN).toBe(RAW_PAT)
    expect(env.GIT_AUTHOR_NAME).toBe(EVA_LOGIN)
    expect(env.GIT_AUTHOR_EMAIL).toBe(EVA_EMAIL)
    expect(env.GIT_COMMITTER_NAME).toBe(EVA_LOGIN)
    expect(env.GIT_COMMITTER_EMAIL).toBe(EVA_EMAIL)
    // Transport (shared SSH key + bot gh config) is irrelevant to attribution and untouched.
    expect(env.GH_CONFIG_DIR).toBe('/etc/gh')
    expect(env.GIT_SSH_COMMAND).toBeTruthy()
  })
})
