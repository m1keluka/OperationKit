/**
 * Native scoped secrets store — service layer (obj-2353 / W1 foundation).
 *
 * The Doppler-replacement primitive. Owns CRUD, scoped resolution, versioning,
 * and the audit log over the `secrets` / `secret_versions` / `secret_access_log`
 * tables (see db/index.ts). Values are encrypted at rest with AES-256-GCM under
 * the DEDICATED `SECRETS_MASTER_KEY` (services/secrets-crypto.ts).
 *
 * SECURITY CONTRACT:
 *   - The raw value is encrypted on write and decrypted in EXACTLY ONE public
 *     seam: `getSecretValue` (and the bulk `resolveSecrets`, which W3's session
 *     injection calls). Neither feeds an API response or a log line.
 *   - Every other read returns a `SecretSummary` — metadata only (scope, key,
 *     version, timestamps, actors). The summary type has NO value field, so
 *     "raw never returned after write" is guaranteed by construction. W2's
 *     routes surface only summaries.
 *   - Every mutating + reading operation writes a `secret_access_log` row.
 *
 * SCOPING: a secret lives at one of four scopes. Resolution at injection is
 * most-specific-wins, merged in this order (later overrides earlier):
 *     global  <  workspace  <  user  <  workspace_user
 *
 * This module is FLAG-FREE and behavior-neutral on its own: it adds tables +
 * functions but nothing calls `resolveSecrets` into a spawn yet (that is W3,
 * flag-gated). Creating it changes zero existing behavior.
 */
import { getDb } from '../db/index.js'
import { encryptSecret, decryptSecret } from './secrets-crypto.js'

// ── Types ────────────────────────────────────────────────────────────────────

export type SecretScopeType = 'global' | 'workspace' | 'user' | 'workspace_user'

export type SecretAction = 'create' | 'update' | 'delete' | 'read' | 'inject' | 'rollback'

/**
 * Addresses a single scope bucket. `workspace` is required for `workspace` and
 * `workspace_user`; `userId` is required for `user` and `workspace_user`. The
 * non-applicable dimensions are normalized to the DB sentinels ('' / 0) so the
 * UNIQUE constraint behaves (SQLite treats NULL as distinct).
 */
export interface SecretScope {
  scopeType: SecretScopeType
  workspace?: string | null
  userId?: number | null
}

/** Metadata-only view of a stored secret. NEVER carries the value. */
export interface SecretSummary {
  id: number
  scopeType: SecretScopeType
  workspace: string | null
  userId: number | null
  key: string
  version: number
  createdBy: number | null
  updatedBy: number | null
  createdAt: string
  updatedAt: string
}

export interface SecretVersionSummary {
  version: number
  changedBy: number | null
  changedAt: string
}

interface SecretRow {
  id: number
  scope_type: SecretScopeType
  workspace: string
  user_id: number
  key: string
  value_encrypted: string
  version: number
  created_by: number | null
  updated_by: number | null
  created_at: string
  updated_at: string
}

const WS_SENTINEL = ''
const USER_SENTINEL = 0

// ── Scope normalization / validation ──────────────────────────────────────────

interface NormalizedScope {
  scopeType: SecretScopeType
  workspace: string // sentinel-normalized
  userId: number // sentinel-normalized
}

/**
 * Validate + normalize a scope to its DB representation, throwing on a scope
 * that omits a required dimension (e.g. a `workspace` secret with no workspace).
 * Extra dimensions are dropped to the sentinel so they can't smuggle data into
 * the UNIQUE key.
 */
function normalizeScope(scope: SecretScope): NormalizedScope {
  const { scopeType } = scope
  const ws = scope.workspace ?? null
  const uid = scope.userId ?? null

  switch (scopeType) {
    case 'global':
      return { scopeType, workspace: WS_SENTINEL, userId: USER_SENTINEL }
    case 'workspace':
      if (!ws) throw new Error("secrets: scope 'workspace' requires a workspace")
      return { scopeType, workspace: ws, userId: USER_SENTINEL }
    case 'user':
      if (uid == null) throw new Error("secrets: scope 'user' requires a userId")
      return { scopeType, workspace: WS_SENTINEL, userId: uid }
    case 'workspace_user':
      if (!ws) throw new Error("secrets: scope 'workspace_user' requires a workspace")
      if (uid == null) throw new Error("secrets: scope 'workspace_user' requires a userId")
      return { scopeType, workspace: ws, userId: uid }
    default:
      throw new Error(`secrets: unknown scope_type '${String(scopeType)}'`)
  }
}

/** Human-readable scope label for the audit log, e.g. 'global', 'workspace:example',
 *  'user:7', 'workspace_user:example/7'. */
export function scopeLabel(scope: SecretScope): string {
  const n = normalizeScope(scope)
  switch (n.scopeType) {
    case 'global':
      return 'global'
    case 'workspace':
      return `workspace:${n.workspace}`
    case 'user':
      return `user:${n.userId}`
    case 'workspace_user':
      return `workspace_user:${n.workspace}/${n.userId}`
  }
}

function rowToSummary(row: SecretRow): SecretSummary {
  return {
    id: row.id,
    scopeType: row.scope_type,
    workspace: row.workspace === WS_SENTINEL ? null : row.workspace,
    userId: row.user_id === USER_SENTINEL ? null : row.user_id,
    key: row.key,
    version: row.version,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// ── Audit log ──────────────────────────────────────────────────────────────--

/**
 * Append a `secret_access_log` row. Never throws into the caller's mutation —
 * audit failure must not silently roll back a write, but it also must not crash
 * a spawn; we surface it as a warning. Value is NEVER passed here.
 */
export function logAccess(
  actorUserId: number | null | undefined,
  action: SecretAction,
  scope: string,
  key: string,
): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO secret_access_log (actor_user_id, action, scope, key) VALUES (?, ?, ?, ?)`,
      )
      .run(actorUserId ?? null, action, scope, key)
  } catch (err) {
    console.warn('[secrets-store] failed to write access log:', (err as Error).message)
  }
}

// ── CRUD ───────────────────────────────────────────────────────────────────--

function findRow(n: NormalizedScope, key: string): SecretRow | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM secrets WHERE scope_type = ? AND workspace = ? AND user_id = ? AND key = ?`,
    )
    .get(n.scopeType, n.workspace, n.userId, key) as SecretRow | undefined
}

export interface SetSecretInput {
  scope: SecretScope
  key: string
  value: string
  actorUserId?: number | null
}

/**
 * Create or update a secret at a scope. On update the version is bumped and the
 * NEW value snapshotted into `secret_versions`; on create version 1 is
 * snapshotted too (so the full history is always reconstructable). Returns the
 * masked summary — never the value.
 */
export function setSecret(input: SetSecretInput): SecretSummary {
  const { key, value } = input
  if (!key || !key.trim()) throw new Error('secrets: key is required')
  const n = normalizeScope(input.scope)
  const actor = input.actorUserId ?? null
  const encrypted = encryptSecret(value)
  const db = getDb()

  const existing = findRow(n, key)
  const tx = db.transaction(() => {
    let row: SecretRow
    let action: SecretAction
    if (existing) {
      const nextVersion = existing.version + 1
      db.prepare(
        `UPDATE secrets
           SET value_encrypted = ?, version = ?, updated_by = ?, updated_at = datetime('now')
         WHERE id = ?`,
      ).run(encrypted, nextVersion, actor, existing.id)
      db.prepare(
        `INSERT INTO secret_versions (secret_id, version, value_encrypted, changed_by)
         VALUES (?, ?, ?, ?)`,
      ).run(existing.id, nextVersion, encrypted, actor)
      row = findRow(n, key)!
      action = 'update'
    } else {
      const info = db
        .prepare(
          `INSERT INTO secrets (scope_type, workspace, user_id, key, value_encrypted, version, created_by, updated_by)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(n.scopeType, n.workspace, n.userId, key, encrypted, actor, actor)
      const id = Number(info.lastInsertRowid)
      db.prepare(
        `INSERT INTO secret_versions (secret_id, version, value_encrypted, changed_by)
         VALUES (?, 1, ?, ?)`,
      ).run(id, encrypted, actor)
      row = db.prepare(`SELECT * FROM secrets WHERE id = ?`).get(id) as SecretRow
      action = 'create'
    }
    return { row, action }
  })

  const { row, action } = tx()
  logAccess(actor, action, scopeLabel(input.scope), key)
  return rowToSummary(row)
}

/** Masked summary for a single secret at a scope, or null if absent. */
export function getSecret(scope: SecretScope, key: string): SecretSummary | null {
  const row = findRow(normalizeScope(scope), key)
  return row ? rowToSummary(row) : null
}

/**
 * SERVER-ONLY: decrypt and return the raw value at a scope, or null if absent.
 * Writes a `read` audit row. This is one of only two seams that ever returns
 * plaintext — its result must go to a process env or an authorized server path,
 * NEVER to an API body or a log.
 */
export function getSecretValue(
  scope: SecretScope,
  key: string,
  actorUserId?: number | null,
): string | null {
  const row = findRow(normalizeScope(scope), key)
  if (!row) return null
  logAccess(actorUserId ?? null, 'read', scopeLabel(scope), key)
  return decryptSecret(row.value_encrypted)
}

/** List masked summaries. With no scope, lists everything (admin surface); with
 *  a scope, only that bucket. Ordered by key for stable UI rendering. */
export function listSecrets(scope?: SecretScope): SecretSummary[] {
  const db = getDb()
  let rows: SecretRow[]
  if (scope) {
    const n = normalizeScope(scope)
    rows = db
      .prepare(
        `SELECT * FROM secrets WHERE scope_type = ? AND workspace = ? AND user_id = ? ORDER BY key`,
      )
      .all(n.scopeType, n.workspace, n.userId) as SecretRow[]
  } else {
    rows = db.prepare(`SELECT * FROM secrets ORDER BY scope_type, workspace, user_id, key`).all() as SecretRow[]
  }
  return rows.map(rowToSummary)
}

/** Delete a secret at a scope (cascades its versions). Returns true if removed.
 *  Writes a `delete` audit row only when something was removed. */
export function deleteSecret(scope: SecretScope, key: string, actorUserId?: number | null): boolean {
  const n = normalizeScope(scope)
  const result = getDb()
    .prepare(`DELETE FROM secrets WHERE scope_type = ? AND workspace = ? AND user_id = ? AND key = ?`)
    .run(n.scopeType, n.workspace, n.userId, key)
  const removed = result.changes > 0
  if (removed) logAccess(actorUserId ?? null, 'delete', scopeLabel(scope), key)
  return removed
}

/**
 * Re-scope an existing secret: move (scope_type, workspace, user_id) for `key`
 * from `from` to `to`, keeping the SAME ciphertext, id, and version history.
 *
 * The value is deliberately NOT decrypted — a scope change is a re-parent of the
 * row, not a re-write of the secret, so the plaintext never enters this process.
 * That also means the admin UI can offer "change scope" without ever asking the
 * operator to re-enter a value they cannot read back.
 *
 * Returns a discriminated result rather than throwing, because both failure modes
 * are ordinary user input, not bugs:
 *   - 'not_found' — nothing lives at `from`/key.
 *   - 'conflict'  — `to`/key is already occupied; moving would violate the
 *                   UNIQUE(scope_type, workspace, user_id, key) constraint. We
 *                   refuse rather than silently clobbering another scope's value.
 * A no-op move (from === to) succeeds and returns the unchanged summary.
 */
export type MoveSecretResult =
  | { ok: true; summary: SecretSummary }
  | { ok: false; reason: 'not_found' | 'conflict' }

export function moveSecret(
  from: SecretScope,
  key: string,
  to: SecretScope,
  actorUserId?: number | null,
): MoveSecretResult {
  const nFrom = normalizeScope(from)
  const nTo = normalizeScope(to)
  const db = getDb()

  const row = findRow(nFrom, key)
  if (!row) return { ok: false, reason: 'not_found' }

  const sameBucket =
    nFrom.scopeType === nTo.scopeType &&
    nFrom.workspace === nTo.workspace &&
    nFrom.userId === nTo.userId
  if (sameBucket) return { ok: true, summary: rowToSummary(row) }

  if (findRow(nTo, key)) return { ok: false, reason: 'conflict' }

  db.prepare(
    `UPDATE secrets
        SET scope_type = ?, workspace = ?, user_id = ?, updated_by = ?, updated_at = datetime('now')
      WHERE id = ?`,
  ).run(nTo.scopeType, nTo.workspace, nTo.userId, actorUserId ?? null, row.id)

  // One audit row per side so the tail reads as a move, not an orphaned update.
  logAccess(actorUserId ?? null, 'update', `move-from:${scopeLabel(from)}`, key)
  logAccess(actorUserId ?? null, 'update', `move-to:${scopeLabel(to)}`, key)

  return { ok: true, summary: rowToSummary(findRow(nTo, key)!) }
}

// ── Versioning ─────────────────────────────────────────────────────────────--

/** Version history (metadata only) for a secret at a scope, newest first. */
export function listVersions(scope: SecretScope, key: string): SecretVersionSummary[] {
  const row = findRow(normalizeScope(scope), key)
  if (!row) return []
  const rows = getDb()
    .prepare(
      `SELECT version, changed_by, changed_at FROM secret_versions WHERE secret_id = ? ORDER BY version DESC`,
    )
    .all(row.id) as { version: number; changed_by: number | null; changed_at: string }[]
  return rows.map(r => ({ version: r.version, changedBy: r.changed_by, changedAt: r.changed_at }))
}

/**
 * Roll a secret back to a prior version: re-applies that version's stored
 * (encrypted) value as a NEW version (history is append-only — rollback never
 * rewrites the past). Returns the resulting summary, or null if the scope/key
 * or target version doesn't exist. Writes a `rollback` audit row.
 */
export function rollbackSecret(
  scope: SecretScope,
  key: string,
  toVersion: number,
  actorUserId?: number | null,
): SecretSummary | null {
  const n = normalizeScope(scope)
  const db = getDb()
  const row = findRow(n, key)
  if (!row) return null
  const target = db
    .prepare(`SELECT value_encrypted FROM secret_versions WHERE secret_id = ? AND version = ?`)
    .get(row.id, toVersion) as { value_encrypted: string } | undefined
  if (!target) return null
  const actor = actorUserId ?? null

  const tx = db.transaction(() => {
    const nextVersion = row.version + 1
    db.prepare(
      `UPDATE secrets SET value_encrypted = ?, version = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(target.value_encrypted, nextVersion, actor, row.id)
    db.prepare(
      `INSERT INTO secret_versions (secret_id, version, value_encrypted, changed_by) VALUES (?, ?, ?, ?)`,
    ).run(row.id, nextVersion, target.value_encrypted, actor)
    return findRow(n, key)!
  })
  const updated = tx()
  logAccess(actor, 'rollback', scopeLabel(scope), key)
  return rowToSummary(updated)
}

// ── Scoped resolution (the injection primitive W3 consumes) ────────────────────

export interface ResolveOptions {
  workspace?: string | null
  userId?: number | null
  /** When set, write one `inject` audit row per resolved key under this actor
   *  (0/system at spawn time). Off by default so plain reads don't spam audit. */
  audit?: boolean
  actorUserId?: number | null
}

/**
 * Resolve the effective secret set for a (workspace, user) pair, applying
 * most-specific-wins precedence: global < workspace < user < workspace_user.
 * Returns a plaintext `{ key: value }` map.
 *
 * SERVER-ONLY (decrypts). This is the primitive W3's `buildSpawnEnv` extension
 * will call, flag-gated, to inject only the secrets a given objective's
 * (workspace, owner) is entitled to — replacing the broadcast admin token.
 */
export function resolveSecrets(opts: ResolveOptions = {}): Record<string, string> {
  const ws = opts.workspace ?? null
  const uid = opts.userId ?? null
  const db = getDb()

  // Pull every row that could apply, then merge in precedence order. A single
  // query keyed on the four buckets keeps this O(matching rows).
  const rows = db
    .prepare(
      `SELECT * FROM secrets WHERE
         (scope_type = 'global')
         OR (scope_type = 'workspace' AND workspace = @ws)
         OR (scope_type = 'user' AND user_id = @uid)
         OR (scope_type = 'workspace_user' AND workspace = @ws AND user_id = @uid)`,
    )
    .all({ ws: ws ?? WS_SENTINEL, uid: uid ?? USER_SENTINEL }) as SecretRow[]

  const PRECEDENCE: Record<SecretScopeType, number> = {
    global: 0,
    workspace: 1,
    user: 2,
    workspace_user: 3,
  }

  // Guard the @ws/@uid match: when no workspace/user was requested, the sentinel
  // would spuriously match real-but-sentinel rows. Filter those impossible
  // buckets out explicitly.
  const applicable = rows.filter(r => {
    if (r.scope_type === 'workspace' || r.scope_type === 'workspace_user') {
      if (ws == null) return false
    }
    if (r.scope_type === 'user' || r.scope_type === 'workspace_user') {
      if (uid == null) return false
    }
    return true
  })

  const winners = new Map<string, SecretRow>()
  for (const r of applicable) {
    const cur = winners.get(r.key)
    if (!cur || PRECEDENCE[r.scope_type] >= PRECEDENCE[cur.scope_type]) {
      winners.set(r.key, r)
    }
  }

  const out: Record<string, string> = {}
  for (const [key, r] of winners) {
    out[key] = decryptSecret(r.value_encrypted)
    if (opts.audit) {
      logAccess(opts.actorUserId ?? null, 'inject', `${r.scope_type}`, key)
    }
  }
  return out
}

/**
 * Fill process.env from the global store for keys that are not already set.
 * Compose / existing env wins. Used at server boot so the Node process no
 * longer shells out to `doppler secrets get`. Swallows store errors — a
 * missing master key must not crash boot for compose-only setups.
 */
export function hydrateProcessEnvFromSecretsStore(): number {
  let n = 0
  try {
    const resolved = resolveSecrets({ audit: false })
    for (const [key, value] of Object.entries(resolved)) {
      if (!key || !value) continue
      if (process.env[key]) continue
      process.env[key] = value
      n++
    }
  } catch (err) {
    console.warn(
      '[startup] secrets store hydrate failed:',
      err instanceof Error ? err.message : err,
    )
  }
  return n
}

/** Read-only audit tail (newest first) for surfacing in an admin UI / tests. */
export function recentAccessLog(limit = 100): {
  actorUserId: number | null
  action: string
  scope: string
  key: string
  at: string
}[] {
  const rows = getDb()
    .prepare(
      `SELECT actor_user_id, action, scope, key, at FROM secret_access_log ORDER BY at DESC, id DESC LIMIT ?`,
    )
    .all(limit) as { actor_user_id: number | null; action: string; scope: string; key: string; at: string }[]
  return rows.map(r => ({ actorUserId: r.actor_user_id, action: r.action, scope: r.scope, key: r.key, at: r.at }))
}
