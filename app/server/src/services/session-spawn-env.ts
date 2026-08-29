/**
 * Spawn identity/secret env — extracted from session-manager.ts (behavior frozen).
 *
 * THE single place every session's identity/secret env is assembled. Previously
 * the same 8-key block was duplicated at all 5 spawn sites. `buildSpawnEnv`
 * consolidates it. With both scoping flags OFF (committed default) and the
 * default ADMIN tier, the env is byte-for-byte identical to the old inline block.
 */
import type { Objective } from '@command-center/shared'
import { getDb } from '../db/index.js'
import {
  GIT_SSH_COMMAND,
  SCOPE_SUPABASE_ACCESS_TOKEN,
  USE_SCOPED_SECRETS,
} from '../config.js'
import { getDecryptedForUser, getForUser } from './user-github-tokens.js'
import {
  getForUser as getGoogleConnectionForUser,
  getDecryptedRefreshToken as getGoogleRefreshToken,
  getOAuthClientById as getGoogleOAuthClientById,
  writeIsolatedGoogleCredsDir,
  writeEmptyGoogleCredsDir,
} from './user-google-connections.js'
import { resolveSecrets } from './secrets-store.js'

// ────────────────────────────────────────────────────────────────────────────
// Spawn-env construction (obj-2202 / onboarding gate B1–B4)
//
// THE single place every session's identity/secret env is assembled. Previously
// the same 8-key block was duplicated, verbatim, at all 5 spawn sites
// (startSession / arena / sendFollowUp / planner-respawn / reviewer). Duplication
// meant secret-scoping had to be edited in 5 places and was impossible to test as
// a unit. `buildSpawnEnv` consolidates it; every spawn site now calls it.
//
// SAFETY CONTRACT: with both scoping flags OFF (the committed default) and the
// default ADMIN tier, buildSpawnEnv returns a byte-for-byte identical env to the
// old inline block — see session-spawn-env.test.ts (no-regression assertion).
// The member tier and the scoped-token paths are additive/dormant until a
// Operator-gated cutover (SPAWN-ENV-SCOPING-CUTOVER.md) provisions real scoped tokens
// and flips the flags. This worker mints/rotates NOTHING.
// ────────────────────────────────────────────────────────────────────────────

/** Which spawn path is building the env. Lets the policy/seams differentiate
 *  (e.g. only Supabase-touching kinds keep the org token once scoping is on). */
export type SpawnSessionKind = 'worker' | 'arena' | 'followup' | 'planner' | 'reviewer'

/** The capability/secret grants for a spawn tier. ONE tested source of truth for
 *  the two-tier (admin vs member) decision. The env-expressible grants
 *  (adminDopplerToken, supabaseToken) take effect immediately behind their flags;
 *  the mount/group grants (dockerSocket, adminTokenFile, siblingHomeAccess) are
 *  enforced at cutover by the docker-compose mount changes + a non-docker-group
 *  runuser identity (they cannot be revoked from the env alone) and are surfaced
 *  here so the policy is auditable and testable in one spot. */
export interface SpawnSecurityPolicy {
  /** Docker host socket (= host root) reachable by the session. */
  dockerSocket: boolean
  /** The personal Doppler admin-token FILE is readable by the session. */
  adminTokenFile: boolean
  /** Sibling account homes (other ccuser / cc-accounts Claude/Codex OAuth) mounted. */
  siblingHomeAccess: boolean
  /** Broadcast Doppler ADMIN token injected as DOPPLER_TOKEN (vs a scoped token). */
  adminDopplerToken: boolean
  /** Org-wide SUPABASE_ACCESS_TOKEN injected. */
  supabaseToken: boolean
}

/** Two-tier spawn policy. ADMIN = unchanged current behavior (full host
 *  capabilities). MEMBER = the dormant, denied-by-default path for non-admin
 *  members (none exist yet; onboarding is gated on exactly this work). */
export function spawnSecurityPolicy(isAdminSpawn: boolean): SpawnSecurityPolicy {
  if (isAdminSpawn) {
    return {
      dockerSocket: true,
      adminTokenFile: true,
      siblingHomeAccess: true,
      adminDopplerToken: true,
      supabaseToken: true,
    }
  }
  // Member path: deny host-root + org-secret blast radius (audit T1–T4).
  return {
    dockerSocket: false,
    adminTokenFile: false,
    siblingHomeAccess: false,
    adminDopplerToken: false,
    supabaseToken: false,
  }
}

/**
 * Who this session is acting as. Assigned user wins (Ava working a card Operator
 * filed must send as Ava). Fall back to the creator. Never a third person.
 */
export function resolveActingUserId(
  objective: Pick<Objective, 'assigned_user_id' | 'created_by'> | null | undefined,
): number | null {
  if (!objective) return null
  const assigned = objective.assigned_user_id
  if (typeof assigned === 'number' && assigned > 0) return assigned
  const created = objective.created_by
  if (typeof created === 'number' && created > 0) return created
  return null
}

/** SEAM — decide whether an objective spawns on the ADMIN or MEMBER tier.
 *  Resolved from the acting user's GLOBAL role in `users`:
 *  a `member` owner ⇒ 'member' tier; anything else (admin, or no resolvable
 *  owner row) ⇒ 'admin'. This FAILS SAFE to 'admin' = today's behavior: a
 *  missing/unknown owner, or any DB error, keeps the full-capability tier rather
 *  than silently downgrading a real admin session.
 *
 *  NOTE: the tier only withholds SUPABASE_ACCESS_TOKEN when SCOPE_SUPABASE_ACCESS_TOKEN
 *  is ON. Secrets themselves come from the native store (USE_SCOPED_SECRETS, default ON). */
export function resolveSpawnTier(objective: Objective): 'admin' | 'member' {
  const ownerId = resolveActingUserId(objective)
  if (ownerId == null) return 'admin'
  try {
    const row = getDb()
      .prepare('SELECT role FROM users WHERE id = ?')
      .get(ownerId) as { role: 'admin' | 'member' } | undefined
    return row?.role === 'member' ? 'member' : 'admin'
  } catch {
    // Fail safe to today's full-capability tier; never block/alter a spawn on a
    // DB hiccup.
    return 'admin'
  }
}

/** Durable Vercel COMMIT_AUTHOR_REQUIRED guard (obj-701130).
 *
 *  The GitHub-LINKED identity every env-less spawn falls back to so its commits
 *  are always attributable. This is a GitHub `noreply` address for the
 *  `operator` account: it is guaranteed linked to a real GitHub account, leaks
 *  no private email, and is already the identity example2 deploys under.
 *
 *  WHY this exists: git resolves a commit's author by precedence
 *  (GIT_AUTHOR_* env > repo-local > --global HOME/.gitconfig > --system
 *  /etc/gitconfig). On this MULTI-USER box `/etc/gitconfig` is root-owned (no
 *  sudo) and POISONED with an UNLINKED identity (`Command Center
 *  <dev@example.com>`). When an objective owner has no linked GitHub token,
 *  `userGitIdentityEnv` returns `{}` and the spawn carries NO GIT_AUTHOR_* env
 *  — so a commit made in a fresh worktree with no repo-local user.* falls all
 *  the way through to that poisoned /etc/gitconfig, and Vercel Pro then blocks
 *  the pre-build with COMMIT_AUTHOR_REQUIRED ("No GitHub account was found
 *  matching the commit author email address"). Per-home ~/.gitconfig seeding
 *  mitigates it but is fragile (a container rebuild resets homes; a NEW ccuser
 *  home gets no identity). Injecting this identity as the GIT_AUTHOR / GIT_COMMITTER
 *  env vars — the TOP of git's precedence chain — makes EVERY spawn attributable
 *  regardless of HOME/.gitconfig/system state. */
export const SAFE_FALLBACK_GIT_IDENTITY = {
  name: 'oss-user',
  email: 'oss-user@users.noreply.github.com',
} as const

/** Per-user GitHub PR attribution (obj-2221 / W4).
 *
 *  Resolves the env that makes a session's commits AND opened PR attribute to the
 *  OBJECTIVE OWNER (`ownerId` = objective.created_by) on GitHub, per the PRD
 *  ("Per-User GitHub Token & PR Attribution", Part B0/B4). GitHub decides a PR's
 *  attribution from two INDEPENDENT levers, so we set both:
 *    - the PR "opened by" actor   ← the token that runs `gh pr create`  → GH_TOKEN
 *    - the commit author/committer ← the commit's author/committer email → GIT_*
 *  The SSH push transport (GIT_SSH_COMMAND, shared deploy key) is irrelevant to
 *  attribution and is left untouched by this hook.
 *
 *  We ALSO export GITHUB_TOKEN (alias of GH_TOKEN): `gh` prefers GH_TOKEN, but
 *  some git/CI tooling reads GITHUB_TOKEN — setting both guarantees every caller
 *  in the spawn authenticates as the user.
 *
 *  Fallback contract (NEVER block work): if the owner has no linked token, or
 *  anything goes wrong resolving it, return {} — the spawn then falls back to the
 *  shared bot identity (gh at /etc/gh + rotation-home .gitconfig) exactly as
 *  before. This makes the feature purely additive and decoupled from the
 *  scoped-Doppler cutover (USE_SCOPED_DOPPLER_TOKENS).
 *
 *  Invariants honored: stays PURE (only DB reads), MUST NOT throw, and NEVER logs
 *  the raw PAT — the decrypted token flows only into the returned env, which goes
 *  straight into the spawned child's process env. */
export function userGitIdentityEnv(ownerId: number | null | undefined): Record<string, string> {
  if (ownerId == null) return {}
  try {
    // Masked identity (login + author/committer email) — resolved + verified at
    // link time by W1's validatePat. No raw token here.
    const summary = getForUser(ownerId)
    if (!summary || !summary.github_login || !summary.github_email) return {}

    // Server-only seam: decrypt the PAT. Only reached when a row exists.
    const token = getDecryptedForUser(ownerId)
    if (!token) return {}

    const name = summary.github_login
    const email = summary.github_email
    return {
      GH_TOKEN: token,
      GITHUB_TOKEN: token,
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: name,
      GIT_COMMITTER_EMAIL: email,
    }
  } catch {
    // Any failure (DB, decrypt) ⇒ fall back to bot identity. Never block a spawn.
    return {}
  }
}

/** Per-user Google Workspace credential for a spawn (obj-706070).
 *
 *  Command Center's Google access was ONE shared credential (Operator's), so a
 *  session doing Workspace work for Ava wrote Docs as Operator. This resolver makes
 *  the credential follow the ACTING USER: the objective's owner. Ava's session
 *  gets Ava's refresh token; Operator's gets Operator's. There is no cross-user path —
 *  the lookup is keyed on `ownerId` and nothing else.
 *
 *  Connected ⇒ inject the owner's grant:
 *    GOOGLE_WORKSPACE_CONNECTION = 'user'
 *    USER_GOOGLE_EMAIL           = the connected Google account
 *    GOOGLE_REFRESH_TOKEN        = the owner's decrypted refresh token
 *    GOOGLE_OAUTH_CLIENT_ID/SECRET = the client the grant belongs to
 *
 *  NOT connected (or the OAuth client is unconfigured, or anything throws) ⇒
 *  EXPLICIT ABSENCE, never a silent fallback to another user's credential:
 *    GOOGLE_WORKSPACE_CONNECTION = 'absent'
 *  and ZERO token keys. A session that needs Workspace access reads that marker
 *  and tells the user to connect at Settings → Account, rather than silently
 *  acting as Operator. Operator is not special-cased: his credential was migrated to his
 *  own user row (scripts/migrate-google-credential.ts), so he takes the
 *  connected branch like everyone else.
 *
 *  Invariants, mirroring userGitIdentityEnv: PURE (DB reads only), MUST NOT
 *  throw, and NEVER logs token material — the decrypted refresh token flows only
 *  into the returned env, which goes straight into the spawned child's env. */
export function userGoogleCredentialEnv(ownerId: number | null | undefined): Record<string, string> {
  const absent = { GOOGLE_WORKSPACE_CONNECTION: 'absent' }
  if (ownerId == null) return absent
  try {
    // Masked summary first — identity + health, no token material.
    const summary = getGoogleConnectionForUser(ownerId)
    if (!summary) return absent

    // The client that ISSUED this user's grant — a refresh token only works
    // against its issuing client, and migrated credentials came from the legacy
    // one. Unknown/unconfigured client ⇒ the credential cannot be refreshed, so
    // report absence rather than handing the session a token that will 401.
    const client = getGoogleOAuthClientById(summary.client_id)
    if (!client) return absent

    // Server-only seam: decrypt. Only reached when a row exists.
    const refreshToken = getGoogleRefreshToken(ownerId)
    if (!refreshToken) return absent

    return {
      GOOGLE_WORKSPACE_CONNECTION: 'user',
      USER_GOOGLE_EMAIL: summary.google_email,
      GOOGLE_REFRESH_TOKEN: refreshToken,
      GOOGLE_OAUTH_CLIENT_ID: client.clientId,
      GOOGLE_OAUTH_CLIENT_SECRET: client.clientSecret,
    }
  } catch {
    // Any failure (DB, decrypt) ⇒ explicit absence. Never block a spawn, and
    // never degrade into somebody else's Google account.
    return absent
  }
}

/** Resolve SUPABASE_ACCESS_TOKEN for a spawn. Flag OFF (default) OR a tier that
 *  keeps Supabase ⇒ current behavior. Flag ON + member tier ⇒ withheld (''). */
function resolveSupabaseToken(policy: SpawnSecurityPolicy): string {
  const current = process.env.SUPABASE_ACCESS_TOKEN || ''
  if (!SCOPE_SUPABASE_ACCESS_TOKEN || policy.supabaseToken) return current
  return ''
}

/** Build the identity/secret env handed to a spawned session. Called by ALL 5
 *  spawn sites. `homeDir` differs per site (account home vs objective home) so it
 *  is a parameter. `isAdminSpawn` defaults to the objective's resolved tier (today
 *  always admin) but is overridable for tests / explicit member spawns. */
export function buildSpawnEnv(opts: {
  objective: Objective
  homeDir: string
  sessionKind: SpawnSessionKind
  isAdminSpawn?: boolean
}): Record<string, string> {
  const { objective, homeDir } = opts
  const isAdminSpawn = opts.isAdminSpawn ?? (resolveSpawnTier(objective) === 'admin')
  const policy = spawnSecurityPolicy(isAdminSpawn)

  // NOTE: key order below is load-bearing for the no-regression byte test — it
  // matches the old inline block exactly (the wrapper serializes via Object.entries).
  const env: Record<string, string> = {
    HOME: homeDir,
    USER: 'ccuser',
    TERM: 'dumb',
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    GIT_SSH_COMMAND,
    GH_CONFIG_DIR: '/etc/gh',
    SUPABASE_ACCESS_TOKEN: resolveSupabaseToken(policy),
  }

  const actingUserId = resolveActingUserId(objective)

  // W4 per-user GitHub identity. Assigned user wins over creator so Ava's
  // assigned card does not open PRs as the operator (and vice versa).
  Object.assign(env, userGitIdentityEnv(actingUserId))

  // Durable Vercel COMMIT_AUTHOR_REQUIRED guard (obj-701130). If the block above
  // injected NO commit-author identity (the owner has no linked GitHub token ⇒
  // userGitIdentityEnv returned {}), the spawn would otherwise fall through git's
  // author-precedence chain to the spawn HOME's ~/.gitconfig and finally the
  // root-owned, POISONED /etc/gitconfig (Command Center <dev@example.com>,
  // UNLINKED to any GitHub account) → Vercel Pro blocks the pre-build with
  // COMMIT_AUTHOR_REQUIRED. Fill GIT_AUTHOR_*/GIT_COMMITTER_* with the known-good
  // GitHub-LINKED operator noreply identity so EVERY spawn commits under an
  // attributable author regardless of HOME/.gitconfig/system state. Env is the TOP
  // of git's precedence chain, so this is bulletproof. Per-user identity (when the
  // owner IS linked) already set GIT_AUTHOR_EMAIL above and MUST take precedence —
  // we only fill when it is absent. See SAFE_FALLBACK_GIT_IDENTITY for the why.
  if (!env.GIT_AUTHOR_EMAIL) {
    env.GIT_AUTHOR_NAME = SAFE_FALLBACK_GIT_IDENTITY.name
    env.GIT_AUTHOR_EMAIL = SAFE_FALLBACK_GIT_IDENTITY.email
    env.GIT_COMMITTER_NAME = SAFE_FALLBACK_GIT_IDENTITY.name
    env.GIT_COMMITTER_EMAIL = SAFE_FALLBACK_GIT_IDENTITY.email
  }

  // obj-706070 per-user Google Workspace credential. ALWAYS adds at least
  // GOOGLE_WORKSPACE_CONNECTION ('user' | 'absent') so a session can always tell
  // "I have the acting user's Google account" from "there is none" — the explicit
  // -absence contract that replaces the old silent fallback to Operator's shared
  // credential. Token keys are added ONLY on the connected branch. This appends
  // after the git-identity block and BEFORE scoped secrets, so an explicit scoped
  // secret can still override a Google key if an operator ever needs to.
  Object.assign(env, userGoogleCredentialEnv(actingUserId))

  // Always isolate the Google MCP credential dir. The shared folder
  // `/home/operator/assistant/google-credentials` holds every user's JSON; workspace-mcp
  // reads the whole directory, which is how Ava's session sent as Operator.
  if (env.GOOGLE_WORKSPACE_CONNECTION === 'user' && actingUserId != null) {
    env.WORKSPACE_MCP_CREDENTIALS_DIR =
      writeIsolatedGoogleCredsDir(actingUserId) || writeEmptyGoogleCredsDir(String(actingUserId))
  } else {
    env.WORKSPACE_MCP_CREDENTIALS_DIR = writeEmptyGoogleCredsDir(String(actingUserId ?? 'none'))
  }
  if (actingUserId != null) env.CC_ACTING_USER_ID = String(actingUserId)

  // Native secrets store. ON by default. Set USE_SCOPED_SECRETS=0 to skip.
  // Most-specific-wins (global < workspace < user < workspace_user). Never
  // blocks a spawn: failure leaves the env as-is.
  if (USE_SCOPED_SECRETS) {
    try {
      Object.assign(
        env,
        resolveSecrets({
          workspace: objective.workspace,
          userId: actingUserId,
          audit: true,
          actorUserId: null,
        }),
      )
    } catch (err) {
      console.warn('[session-manager] scoped-secrets injection failed (env unchanged):', (err as Error).message)
    }
  }

  return env
}
