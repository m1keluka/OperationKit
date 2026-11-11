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
import { recentConnectorDenials } from '../services/connector-guard.js'
import { getDb } from '../db/index.js'
import { kekStatus } from '../services/secrets-kek.js'
import {
  addAllowlistEntry,
  envUsageReport,
  getSessionEnvMode,
  isSessionEnvMode,
  listAllowlist,
  removeAllowlistEntry,
  setSessionEnvMode,
  type AllowlistSubjectType,
} from '../services/secret-env-policy.js'
import { listRotationFlags, resolveRotationFlag } from '../services/chat-secret-capture.js'
import {
  setSecret,
  listSecrets,
  deleteSecret,
  listVersions,
  rollbackSecret,
  recentAccessLog,
  moveSecret,
  rotateSecret,
  updateSecretMetadata,
  getSecret,
  queryAccessLog,
  logAccess,
  scopeLabel,
  SECRET_DESCRIPTION_MAX,
  type SecretAuditSource,
  type SecretScope,
  type SecretScopeType,
  type SecretSummary,
} from '../services/secrets-store.js'
import type { User } from '@operationkit/shared'

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

/**
 * 'ui' when the request rode the browser's httpOnly session cookie, 'api' for a
 * bearer token / agent key. Recorded on the audit row; never trusted for access.
 */
function auditSource(req: AuthRequest): SecretAuditSource {
  return req.cookies?.token ? 'ui' : 'api'
}

/**
 * Optional `description` on a write body. undefined = not sent (leave as is);
 * a string is trimmed and capped server-side. Anything else is a 400.
 */
function parseDescription(raw: unknown): { ok: true; value: string | null | undefined } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, value: undefined }
  if (raw === null) return { ok: true, value: null }
  if (typeof raw !== 'string') return { ok: false, error: 'description must be a string' }
  if (raw.length > SECRET_DESCRIPTION_MAX) {
    return { ok: false, error: `description must be at most ${SECRET_DESCRIPTION_MAX} characters` }
  }
  return { ok: true, value: raw }
}

/**
 * Message returned by POST /reveal. Decision D1 (Operator, 2026-11-10, obj 900540):
 * values are write-only FOREVER — there is no reveal path, no "revealable"
 * class and no flag that turns one on. This route exists only as an audited
 * tripwire so a probe shows up in the log; it can never return a value.
 * To change a value, rotate it (replace-only).
 */
export const REVEAL_DISABLED_MESSAGE =
  'Secret values are write-only. They are never shown after they are saved; to change one, rotate it with a new value.'

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

// GET /api/secrets/connector-denials — every per-user connector credential that
// was withheld: who asked, who it belonged to, which key, and why. Names and
// reasons only; no credential material is stored or returned. Global admin only,
// alongside the secrets access log.
router.get('/connector-denials', (req: AuthRequest, res) => {
  if (req.user!.role !== 'admin') {
    res.status(403).json({ error: 'Global admin role required' })
    return
  }
  const limit = Number(req.query.limit)
  res.json(recentConnectorDenials(Number.isFinite(limit) && limit > 0 ? limit : 100))
})

// GET /api/secrets/access-log — global admin only. Legacy tail (newest 100);
// kept for backward compatibility. New callers use /audit.
router.get('/access-log', (req: AuthRequest, res) => {
  const user = req.user!
  if (user.role !== 'admin') {
    res.status(403).json({ error: 'Global admin role required' })
    return
  }
  res.json(recentAccessLog(100))
})

// GET /api/secrets/audit — the append-only audit log, filtered + paginated.
//   Whole log (no scope): global admin only. ?key=&action=&beforeId=&limit=
//   One secret: ?scopeType=&workspace=&userId=&key= — anyone with access to
//   that scope sees that secret's own history (same gate as /versions).
// Returns { entries, nextBeforeId }. Entries are metadata only; the log never
// holds a value.
router.get('/audit', (req: AuthRequest, res) => {
  const user = req.user!
  const { scopeType, workspace, userId, key, action, beforeId, limit } = req.query
  const lim = limit === undefined ? 100 : Number(limit)
  const before = beforeId === undefined ? undefined : Number(beforeId)
  if (!Number.isFinite(lim) || lim < 1) {
    res.status(400).json({ error: 'limit must be a positive number' })
    return
  }
  if (before !== undefined && !Number.isInteger(before)) {
    res.status(400).json({ error: 'beforeId must be an integer' })
    return
  }
  const act = typeof action === 'string' && action ? action : undefined

  if (scopeType !== undefined) {
    if (typeof key !== 'string' || !key.trim()) {
      res.status(400).json({ error: 'key is required with a scope' })
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
    const s = getSecret(parsed.scope, key)
    if (!s) {
      // Deleted secret: its rows remain (append-only) and are reachable by key
      // from the admin view. A member gets an empty page rather than another
      // scope's history.
      res.json({ entries: [], nextBeforeId: null })
      return
    }
    res.json(queryAccessLog({
      secretId: s.id,
      key,
      scopeLabel: scopeLabel(parsed.scope),
      action: act,
      beforeId: before,
      limit: lim,
    }))
    return
  }

  if (user.role !== 'admin') {
    res.status(403).json({ error: 'Global admin role required' })
    return
  }
  res.json(queryAccessLog({
    key: typeof key === 'string' && key.trim() ? key.trim() : undefined,
    action: act,
    beforeId: before,
    limit: lim,
  }))
})

// POST /api/secrets/reveal — always refused (403), always audited.
// D1: write-only by decision, permanently. There is no code path that returns a
// value, and no setting/env flag to enable one (secrets-d1-write-only.test.ts).
// The attempt is recorded even when the caller lacks access to the scope, so
// probing shows up in the log.
router.post('/reveal', (req: AuthRequest, res) => {
  const user = req.user!
  const body = (req.body ?? {}) as Record<string, unknown>
  const key = typeof body.key === 'string' ? body.key.trim() : ''
  if (!key) {
    res.status(400).json({ error: 'key is required' })
    return
  }
  const parsed = parseScope(body.scopeType, body.workspace, body.userId)
  if ('error' in parsed) {
    res.status(400).json({ error: parsed.error })
    return
  }
  const allowed = canAccessScope(user, parsed.scope)
  const existing = allowed ? getSecret(parsed.scope, key) : null
  logAccess(user.id, 'reveal_attempt', scopeLabel(parsed.scope), key, {
    secretId: existing?.id ?? null,
    source: auditSource(req),
    detail: allowed ? 'refused:write-only' : 'refused:no-scope-access',
  })
  res.status(403).json({ error: 'reveal_disabled', message: REVEAL_DISABLED_MESSAGE })
})

// POST /api/secrets/rotate — replace the value of an EXISTING secret.
// Body: { scopeType, workspace?, userId?, key, value, description? }
// 404 if it does not exist (rotation never creates); otherwise 200 +
// the masked summary. The old value is never read back; it stays in version
// history (encrypted) so a bad rotation can be rolled back.
router.post('/rotate', (req: AuthRequest, res) => {
  const user = req.user!
  const body = (req.body ?? {}) as Record<string, unknown>
  const key = typeof body.key === 'string' ? body.key : ''
  if (!key.trim()) {
    res.status(400).json({ error: 'key is required' })
    return
  }
  if (typeof body.value !== 'string' || body.value.length === 0) {
    res.status(400).json({ error: 'value is required (non-empty string)' })
    return
  }
  const desc = parseDescription(body.description)
  if (!desc.ok) {
    res.status(400).json({ error: desc.error })
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
  const summary = rotateSecret({
    scope: parsed.scope,
    key,
    value: body.value,
    description: desc.value,
    actorUserId: user.id,
    source: auditSource(req),
  })
  if (!summary) {
    res.status(404).json({ error: 'secret not found — rotation only replaces an existing secret' })
    return
  }
  res.json(summary)
})

// PATCH /api/secrets/metadata — change a secret's description without touching
// its value. Body: { scopeType, workspace?, userId?, key, description }
router.patch('/metadata', (req: AuthRequest, res) => {
  const user = req.user!
  const body = (req.body ?? {}) as Record<string, unknown>
  const key = typeof body.key === 'string' ? body.key : ''
  if (!key.trim()) {
    res.status(400).json({ error: 'key is required' })
    return
  }
  if (!('description' in body)) {
    res.status(400).json({ error: 'description is required (string, or null to clear)' })
    return
  }
  const desc = parseDescription(body.description)
  if (!desc.ok) {
    res.status(400).json({ error: desc.error })
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
  const summary = updateSecretMetadata(parsed.scope, key, { description: desc.value ?? null }, user.id, auditSource(req))
  if (!summary) {
    res.status(404).json({ error: 'secret not found' })
    return
  }
  res.json(summary)
})

// GET /api/secrets/kek-status — D2 (obj 900540). Global admin only. Says WHICH
// provider supplies the key-encryption key and WHERE (a path or env:NAME), and
// warns when that place is legacy or session-visible. Never loads or returns key
// material: kekStatus() only stats the file.
router.get('/kek-status', (req: AuthRequest, res) => {
  if (req.user!.role !== 'admin') {
    res.status(403).json({ error: 'Global admin role required' })
    return
  }
  res.json(kekStatus())
})

// ── D4 (obj 900540): session env allowlist ──────────────────────────────────
// Global admin only. Names and counts only — no route here touches a value.

// GET /api/secrets/env-policy?days=30&minSessions=1
//   { mode, allowlist[], report: { rows[], suggestions{agent: keys[]} } }
router.get('/env-policy', (req: AuthRequest, res) => {
  if (req.user!.role !== 'admin') {
    res.status(403).json({ error: 'Global admin role required' })
    return
  }
  const days = Number(req.query.days ?? 30)
  const minSessions = Number(req.query.minSessions ?? 1)
  res.json({
    mode: getSessionEnvMode(),
    allowlist: listAllowlist(),
    report: envUsageReport({
      sinceDays: Number.isFinite(days) ? days : 30,
      minSessions: Number.isFinite(minSessions) ? minSessions : 1,
    }),
  })
})

// PUT /api/secrets/env-policy/mode  { mode: 'migration' | 'enforce' }
router.put('/env-policy/mode', (req: AuthRequest, res) => {
  if (req.user!.role !== 'admin') {
    res.status(403).json({ error: 'Global admin role required' })
    return
  }
  const mode = (req.body ?? {}).mode
  if (!isSessionEnvMode(mode)) {
    res.status(400).json({ error: "mode must be 'migration' or 'enforce'" })
    return
  }
  setSessionEnvMode(mode, req.user!.id, auditSource(req))
  res.json({ mode: getSessionEnvMode() })
})

// POST/DELETE /api/secrets/env-policy/allowlist  { subjectType: 'agent'|'skill', subject, key }
for (const method of ['post', 'delete'] as const) {
  router[method]('/env-policy/allowlist', (req: AuthRequest, res) => {
    if (req.user!.role !== 'admin') {
      res.status(403).json({ error: 'Global admin role required' })
      return
    }
    const b = (req.body ?? {}) as Record<string, unknown>
    const subjectType = b.subjectType as AllowlistSubjectType
    const subject = typeof b.subject === 'string' ? b.subject.trim() : ''
    const key = typeof b.key === 'string' ? b.key.trim() : ''
    try {
      const changed = method === 'post'
        ? addAllowlistEntry(subjectType, subject, key, req.user!.id, auditSource(req))
        : removeAllowlistEntry(subjectType, subject, key, req.user!.id, auditSource(req))
      res.json({ changed, allowlist: listAllowlist() })
    } catch (err) {
      res.status(400).json({ error: (err as Error).message })
    }
  })
}

// GET /api/secrets/rotation-flags — secrets the owner pasted into a card chat
// (obj 718944). Moved into the store at capture time; listed here so they get
// rotated later. Names only. Global admin only.
router.get('/rotation-flags', (req: AuthRequest, res) => {
  if (req.user!.role !== 'admin') {
    res.status(403).json({ error: 'Global admin role required' })
    return
  }
  res.json(listRotationFlags({ includeResolved: req.query.all === '1' }))
})

// POST /api/secrets/rotation-flags/:id/resolve — "rotated", drops it off the list.
router.post('/rotation-flags/:id/resolve', (req: AuthRequest, res) => {
  if (req.user!.role !== 'admin') {
    res.status(403).json({ error: 'Global admin role required' })
    return
  }
  const ok = resolveRotationFlag(Number(req.params.id))
  res.status(ok ? 200 : 404).json({ ok })
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
  const desc = parseDescription(body.description)
  if (!desc.ok) {
    res.status(400).json({ error: desc.error })
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
  const summary = setSecret({
    scope: parsed.scope,
    key,
    value: body.value,
    description: desc.value,
    actorUserId: user.id,
    source: auditSource(req),
  })
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
  const removed = deleteSecret(parsed.scope, key, user.id, auditSource(req))
  if (!removed) {
    res.status(404).json({ error: 'secret not found' })
    return
  }
  res.status(204).end()
})

export default router
