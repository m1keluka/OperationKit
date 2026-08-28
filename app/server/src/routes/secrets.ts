/**
 * Native scoped secrets store — REST surfaces (obj-2353 / W2).
 *
 * Thin authorization + validation layer over services/secrets-store.ts (W1).
 * The store owns crypto/versioning/audit; this router owns the wire contract
 * and the access matrix. It mirrors routes/test-credentials.ts: `requireAuth`,
 * `req.user`, scope-membership checks, UNIQUE→409, 400 validation.
 *
 * SECURITY CONTRACT (inherited from W1):
 *   - Every route returns a `SecretSummary` (metadata only) — NEVER a decrypted
 *     value, NEVER `value_encrypted`. The store's plaintext seams
 *     (`getSecretValue` / `resolveSecrets`) are deliberately NOT reachable from
 *     here, so "raw never returned after write" holds by construction.
 *
 * ACCESS MATRIX (enforced server-side on EVERY route via `canAccessScope`):
 *   - global         → global admin only (user.role === 'admin').
 *   - workspace(ws)  → global admin OR any member of ws (a user_workspaces row
 *                      for (user.id, ws), ANY role).
 *   - user(uid)      → global admin OR the user themselves (user.id === uid).
 *   - workspace_user → global admin OR (user.id === uid AND member of ws).
 */
import { Router } from 'express'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import { getDb } from '../db/index.js'
import {
  setSecret,
  listSecrets,
  deleteSecret,
  listVersions,
  rollbackSecret,
  recentAccessLog,
  moveSecret,
  type SecretScope,
  type SecretScopeType,
  type SecretSummary,
} from '../services/secrets-store.js'
import type { User } from '@command-center/shared'

const SCOPE_TYPES: SecretScopeType[] = ['global', 'workspace', 'user', 'workspace_user']

/** True if a user_workspaces row exists for (userId, ws) — ANY role. */
function isWorkspaceMember(userId: number, ws: string): boolean {
  const row = getDb()
    .prepare('SELECT 1 FROM user_workspaces WHERE user_id = ? AND workspace = ?')
    .get(userId, ws) as { 1: number } | undefined
  return !!row
}

/**
 * The single authorization gate. Returns true if `user` may read/write secrets
 * at `scope`. Global admins bypass everything.
 */
export function canAccessScope(user: User, scope: SecretScope): boolean {
  if (user.role === 'admin') return true
  switch (scope.scopeType) {
    case 'global':
      return false // global admin only
    case 'workspace':
      return !!scope.workspace && isWorkspaceMember(user.id, scope.workspace)
    case 'user':
      return scope.userId != null && user.id === scope.userId
    case 'workspace_user':
      return (
        scope.userId != null &&
        user.id === scope.userId &&
        !!scope.workspace &&
        isWorkspaceMember(user.id, scope.workspace)
      )
    default:
      return false
  }
}

/**
 * Validate + build a SecretScope from loose inputs (query or body). Returns the
 * scope on success, or an error string on a malformed scope (missing required
 * dimension / unknown type). Does NOT check access — call canAccessScope after.
 */
function parseScope(
  scopeType: unknown,
  workspace: unknown,
  userIdRaw: unknown,
): { scope: SecretScope } | { error: string } {
  if (typeof scopeType !== 'string' || !SCOPE_TYPES.includes(scopeType as SecretScopeType)) {
    return { error: `scopeType must be one of: ${SCOPE_TYPES.join(', ')}` }
  }
  const st = scopeType as SecretScopeType
  const ws = workspace == null || workspace === '' ? null : String(workspace)
  let uid: number | null = null
  if (userIdRaw != null && userIdRaw !== '') {
    const n = Number(userIdRaw)
    if (!Number.isInteger(n)) return { error: 'userId must be an integer' }
    uid = n
  }
  if ((st === 'workspace' || st === 'workspace_user') && !ws) {
    return { error: `scope '${st}' requires a workspace` }
  }
  if ((st === 'user' || st === 'workspace_user') && uid == null) {
    return { error: `scope '${st}' requires a userId` }
  }
  return { scope: { scopeType: st, workspace: ws, userId: uid } }
}

const router = Router()
router.use(requireAuth)

// GET /api/secrets — list masked summaries the caller may see.
//   - Admin, no filter → all secrets.
//   - Admin, with ?scopeType=&workspace=&userId= → that scope (validated).
//   - Member → every summary that passes canAccessScope.
router.get('/', (req: AuthRequest, res) => {
  const user = req.user!
  const { scopeType, workspace, userId } = req.query

  // Explicit scope filter (any caller): validate, access-check, return that bucket.
  if (scopeType !== undefined) {
    const parsed = parseScope(scopeType, workspace, userId)
    if ('error' in parsed) {
      res.status(400).json({ error: parsed.error })
      return
    }
    if (!canAccessScope(user, parsed.scope)) {
      res.status(403).json({ error: 'You do not have access to this scope' })
      return
    }
    res.json(listSecrets(parsed.scope))
    return
  }

  // No filter: admin sees everything; members see the subset they can access.
  const all = listSecrets()
  if (user.role === 'admin') {
    res.json(all)
    return
  }
  const visible = all.filter((s: SecretSummary) =>
    canAccessScope(user, { scopeType: s.scopeType, workspace: s.workspace, userId: s.userId }),
  )
  res.json(visible)
})

// GET /api/secrets/versions?scopeType=&workspace=&userId=&key= — version metadata.
router.get('/versions', (req: AuthRequest, res) => {
  const user = req.user!
  const { scopeType, workspace, userId, key } = req.query
  if (typeof key !== 'string' || !key.trim()) {
    res.status(400).json({ error: 'key is required' })
    return
  }
  const parsed = parseScope(scopeType, workspace, userId)
  if ('error' in parsed) {
    res.status(400).json({ error: parsed.error })
    return
  }
  if (!canAccessScope(user, parsed.scope)) {
    res.status(403).json({ error: 'You do not have access to this scope' })
    return
  }
  res.json(listVersions(parsed.scope, key))
})

// GET /api/secrets/access-log — global admin only.
router.get('/access-log', (req: AuthRequest, res) => {
  const user = req.user!
  if (user.role !== 'admin') {
    res.status(403).json({ error: 'Global admin role required' })
    return
  }
  res.json(recentAccessLog(100))
})

// GET /api/secrets/principals — the organizations + users the caller may target
// when picking a scope. Exists so the admin UI can offer real pickers instead of
// a raw numeric user-id box; it returns NO secret data of any kind.
//   - admin  → every workspace, every user, canUseGlobal true.
//   - member → only their own workspaces and only themselves (which is exactly
//              the set canAccessScope would let them write to anyway).
router.get('/principals', (req: AuthRequest, res) => {
  const user = req.user!
  const db = getDb()
  const isAdmin = user.role === 'admin'

  const organizations = (
    isAdmin
      ? (db
          .prepare(`SELECT slug, name FROM workspaces WHERE archived = 0 ORDER BY sort_order, slug`)
          .all() as { slug: string; name: string }[])
      : (db
          .prepare(
            `SELECT w.slug AS slug, w.name AS name
               FROM user_workspaces uw
               JOIN workspaces w ON w.slug = uw.workspace
              WHERE uw.user_id = ? AND w.archived = 0
              ORDER BY w.sort_order, w.slug`,
          )
          .all(user.id) as { slug: string; name: string }[])
  )

  const users = isAdmin
    ? (db.prepare(`SELECT id, username FROM users ORDER BY username`).all() as {
        id: number
        username: string
      }[])
    : (db.prepare(`SELECT id, username FROM users WHERE id = ?`).all(user.id) as {
        id: number
        username: string
      }[])

  res.json({ organizations, users, canUseGlobal: isAdmin })
})

// POST /api/secrets/move — re-scope an existing secret (e.g. promote a secret
// from one organization to Command-Center-wide, or hand it to a single user).
// The value is NEVER decrypted or re-entered: the store re-parents the row.
// Authorization requires access to BOTH the source and the destination scope, so
// a move can never be used to launder a secret into a scope the caller can't
// already write.
router.post('/move', (req: AuthRequest, res) => {
  const user = req.user!
  const body = (req.body ?? {}) as Record<string, unknown>
  const key = typeof body.key === 'string' ? body.key : ''
  if (!key.trim()) {
    res.status(400).json({ error: 'key is required' })
    return
  }
  const from = parseScope(body.scopeType, body.workspace, body.userId)
  if ('error' in from) {
    res.status(400).json({ error: `from: ${from.error}` })
    return
  }
  const toRaw = (body.to ?? {}) as Record<string, unknown>
  const to = parseScope(toRaw.scopeType, toRaw.workspace, toRaw.userId)
  if ('error' in to) {
    res.status(400).json({ error: `to: ${to.error}` })
    return
  }
  if (!canAccessScope(user, from.scope) || !canAccessScope(user, to.scope)) {
    res.status(403).json({ error: 'You do not have access to this scope' })
    return
  }
  const result = moveSecret(from.scope, key, to.scope, user.id)
  if (!result.ok) {
    if (result.reason === 'conflict') {
      res.status(409).json({ error: 'A secret with that key already exists at the target scope' })
      return
    }
    res.status(404).json({ error: 'secret not found' })
    return
  }
  res.json(result.summary)
})

// POST /api/secrets — create or update a secret at a scope.
router.post('/', (req: AuthRequest, res) => {
  const user = req.user!
  const body = (req.body ?? {}) as Record<string, unknown>
  const key = typeof body.key === 'string' ? body.key : ''
  if (!key.trim()) {
    res.status(400).json({ error: 'key is required' })
    return
  }
  if (typeof body.value !== 'string') {
    res.status(400).json({ error: 'value is required (string)' })
    return
  }
  const parsed = parseScope(body.scopeType, body.workspace, body.userId)
  if ('error' in parsed) {
    res.status(400).json({ error: parsed.error })
    return
  }
  if (!canAccessScope(user, parsed.scope)) {
    res.status(403).json({ error: 'You do not have access to this scope' })
    return
  }
  const summary = setSecret({ scope: parsed.scope, key, value: body.value, actorUserId: user.id })
  res.status(201).json(summary)
})

// POST /api/secrets/rollback — re-apply a prior version as a new version.
router.post('/rollback', (req: AuthRequest, res) => {
  const user = req.user!
  const body = (req.body ?? {}) as Record<string, unknown>
  const key = typeof body.key === 'string' ? body.key : ''
  if (!key.trim()) {
    res.status(400).json({ error: 'key is required' })
    return
  }
  const toVersion = Number(body.toVersion)
  if (!Number.isInteger(toVersion) || toVersion < 1) {
    res.status(400).json({ error: 'toVersion must be a positive integer' })
    return
  }
  const parsed = parseScope(body.scopeType, body.workspace, body.userId)
  if ('error' in parsed) {
    res.status(400).json({ error: parsed.error })
    return
  }
  if (!canAccessScope(user, parsed.scope)) {
    res.status(403).json({ error: 'You do not have access to this scope' })
    return
  }
  const summary = rollbackSecret(parsed.scope, key, toVersion, user.id)
  if (!summary) {
    res.status(404).json({ error: 'secret or target version not found' })
    return
  }
  res.json(summary)
})

// DELETE /api/secrets?scopeType=&workspace=&userId=&key=
router.delete('/', (req: AuthRequest, res) => {
  const user = req.user!
  const { scopeType, workspace, userId, key } = req.query
  if (typeof key !== 'string' || !key.trim()) {
    res.status(400).json({ error: 'key is required' })
    return
  }
  const parsed = parseScope(scopeType, workspace, userId)
  if ('error' in parsed) {
    res.status(400).json({ error: parsed.error })
    return
  }
  if (!canAccessScope(user, parsed.scope)) {
    res.status(403).json({ error: 'You do not have access to this scope' })
    return
  }
  const removed = deleteSecret(parsed.scope, key, user.id)
  if (!removed) {
    res.status(404).json({ error: 'secret not found' })
    return
  }
  res.status(204).end()
})

export default router
