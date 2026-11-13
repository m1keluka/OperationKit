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
import { invalidateSecretRegistry } from './secret-redaction.js'
import { SERVICE_ONLY_BY_DEFAULT, isServiceOnlyByDefault } from './secrets-store-keys.js'

export { SERVICE_ONLY_BY_DEFAULT, isServiceOnlyByDefault }

// ── Types ────────────────────────────────────────────────────────────────────

export type SecretScopeType = 'global' | 'workspace' | 'user' | 'workspace_user'

/** `use` = injected server-side by the secrets broker (obj 715532); never revealed. */
export type SecretAction =
  | 'create'
  | 'update'
  | 'delete'
  | 'read'
  | 'inject'
  | 'rollback'
  | 'use'
  /** Value replaced on an EXISTING secret via the rotate flow (obj 900498). */
  | 'rotate'
  /** Metadata-only change (description). The value is untouched. */
  | 'describe'
  /** Someone asked to see a value. Reveal is not enabled, so this is always refused. */
  | 'reveal_attempt'
  /** D4 (obj 900540): session-env allowlist or mode changed. key = the name, or * for the mode. */
  | 'env_policy'
  /** D5 (obj 900540): the retention job exported and pruned rows older than the window. */
  | 'audit_prune'
  /** obj 900749: a secret's bot-access (broker host allowlist) entry was set or cleared. Never touches the value. */
  | 'bot_access'

/** How an audited action reached the store. Free-form on disk; these are the ones the server writes. */
export type SecretAuditSource = 'ui' | 'api' | 'spawn' | 'broker' | 'server' | 'chat' | 'relay' | 'cli' | 'retention' | 'policy'

/** Optional context for an audit row. NEVER a value, a fragment of one, or a hash of one. */
export interface SecretAuditExtra {
  secretId?: number | null
  source?: SecretAuditSource | string | null
  detail?: string | null
}

/** Longest description we store. It is a note, not a document. */
export const SECRET_DESCRIPTION_MAX = 500

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
  /** Server-process only: hydrated into the server's env, never into a session. */
  serviceOnly: boolean
  scopeType: SecretScopeType
  workspace: string | null
  userId: number | null
  key: string
  version: number
  createdBy: number | null
  updatedBy: number | null
  createdAt: string
  updatedAt: string
  /** Operator note about what this secret is for. Never part of the value. */
  description: string | null
  /** Last time the server decrypted it for a real use (spawn injection, broker, server read). */
  lastUsedAt: string | null
}

export interface SecretVersionSummary {
  version: number
  changedBy: number | null
  changedAt: string
  /** obj 719065: relay provenance for this version (null = Settings / owner UI). */
  via: string | null
}

interface SecretRow {
  id: number
  service_only: number
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
  description?: string | null
  last_used_at?: string | null
}

/**
 * Seat credentials (seat pool v2) live in this store under this reserved key
 * prefix. They are handed ONLY to the one session assigned to that seat
 * (seat-credentials.ts), so the bulk resolvers below never inject them into
 * every session's env, and boot never hydrates them into process.env.
 */
export const SEAT_SECRET_PREFIX = 'CC_SEAT_'
export function isSeatSecretKey(key: string): boolean {
  return key.startsWith(SEAT_SECRET_PREFIX)
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
    serviceOnly: Number(row.service_only) > 0,
    scopeType: row.scope_type,
    workspace: row.workspace === WS_SENTINEL ? null : row.workspace,
    userId: row.user_id === USER_SENTINEL ? null : row.user_id,
    key: row.key,
    version: row.version,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    description: row.description ?? null,
    lastUsedAt: row.last_used_at ?? null,
  }
}

/** Trim + cap a description. '' and whitespace become null (= cleared). */
export function normalizeDescription(raw: unknown): string | null {
  if (raw == null) return null
  const s = String(raw).trim()
  if (!s) return null
  return s.slice(0, SECRET_DESCRIPTION_MAX)
}

/**
 * Stamp `last_used_at` on the rows the server just decrypted for a real use.
 * Best-effort: a failed stamp must never break a spawn or a broker call.
 */
export function touchLastUsed(ids: number[]): void {
  if (ids.length === 0) return
  try {
    const db = getDb()
    const stmt = db.prepare(`UPDATE secrets SET last_used_at = datetime('now') WHERE id = ?`)
    db.transaction((xs: number[]) => { for (const id of xs) stmt.run(id) })(ids)
  } catch (err) {
    console.warn('[secrets-store] failed to stamp last_used_at:', (err as Error).message)
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
  extra: SecretAuditExtra = {},
): void {
  // Any value change must reach the redactor before the next text leaves the server.
  if (action === 'create' || action === 'update' || action === 'delete' || action === 'rollback' || action === 'rotate') {
    invalidateSecretRegistry()
  }
  try {
    getDb()
      .prepare(
        `INSERT INTO secret_access_log (actor_user_id, action, scope, key, secret_id, source, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        actorUserId ?? null,
        action,
        scope,
        key,
        extra.secretId ?? null,
        extra.source ?? null,
        extra.detail == null ? null : String(extra.detail).slice(0, 200),
      )
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
  /**
   * Keep this out of session envs. Omitted on CREATE = the default for the key
   * (see SERVICE_ONLY_BY_DEFAULT; global scope only). Omitted on UPDATE = leave
   * the existing choice alone, so re-pasting a value never silently reopens it.
   */
  serviceOnly?: boolean
  actorUserId?: number | null
  /** obj 719065: recorded on the version row so History shows who relayed it. Never a value. */
  via?: string | null
  /**
   * Operator note (obj 900498). Omitted = leave the existing description alone
   * (so every existing caller keeps its exact behaviour); null/'' = clear it.
   */
  description?: string | null
  /** Audit source for this write. Omitted = 'api'. */
  source?: SecretAuditSource
  /** Internal: audit as 'rotate' instead of 'update' (set by rotateSecret). */
  auditAction?: 'rotate'
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
  const via = input.via ?? null
  const encrypted = encryptSecret(value)
  const db = getDb()

  const existing = findRow(n, key)
  const tx = db.transaction(() => {
    let row: SecretRow
    let action: SecretAction
    if (existing) {
      const nextVersion = existing.version + 1
      const keepServiceOnly =
        input.serviceOnly === undefined ? Number(existing.service_only) > 0 : input.serviceOnly
      const description =
        input.description === undefined ? existing.description ?? null : normalizeDescription(input.description)
      db.prepare(
        `UPDATE secrets
           SET value_encrypted = ?, version = ?, service_only = ?, description = ?, updated_by = ?, updated_at = datetime('now')
         WHERE id = ?`,
      ).run(encrypted, nextVersion, keepServiceOnly ? 1 : 0, description, actor, existing.id)
      db.prepare(
        `INSERT INTO secret_versions (secret_id, version, value_encrypted, changed_by, via)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(existing.id, nextVersion, encrypted, actor, via)
      row = findRow(n, key)!
      action = input.auditAction ?? 'update'
    } else {
      // A newly stored shared credential is service-only from the start, so a
      // fresh install never has a window where sessions receive it.
      const serviceOnly =
        input.serviceOnly ?? (n.scopeType === 'global' && isServiceOnlyByDefault(key))
      const info = db
        .prepare(
          `INSERT INTO secrets (scope_type, workspace, user_id, key, value_encrypted, version, service_only, description, created_by, updated_by)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
        )
        .run(
          n.scopeType, n.workspace, n.userId, key, encrypted, serviceOnly ? 1 : 0,
          normalizeDescription(input.description), actor, actor,
        )
      const id = Number(info.lastInsertRowid)
      db.prepare(
        `INSERT INTO secret_versions (secret_id, version, value_encrypted, changed_by, via)
         VALUES (?, 1, ?, ?, ?)`,
      ).run(id, encrypted, actor, via)
      row = db.prepare(`SELECT * FROM secrets WHERE id = ?`).get(id) as SecretRow
      action = 'create'
    }
    return { row, action }
  })

  const { row, action } = tx()
  logAccess(actor, action, scopeLabel(input.scope), key, {
    secretId: row.id,
    source: input.source ?? 'api',
    detail: via ? `via:${via}` : null,
  })
  return rowToSummary(row)
}

/**
 * Rotate: replace the value of an EXISTING secret without ever reading the old
 * one back. Same write path as setSecret (new version, old ciphertext kept in
 * history for rollback), but refuses to CREATE — a typo in the key name during
 * a rotation must fail loudly instead of quietly minting a second secret while
 * the real one keeps its compromised value. Returns null if nothing is there.
 */
export function rotateSecret(input: Omit<SetSecretInput, 'auditAction'>): SecretSummary | null {
  if (!findRow(normalizeScope(input.scope), input.key)) return null
  return setSecret({ ...input, auditAction: 'rotate' })
}

/**
 * Change a secret's metadata (description) without touching its value,
 * version or ciphertext. Returns null if the secret does not exist.
 */
export function updateSecretMetadata(
  scope: SecretScope,
  key: string,
  patch: { description?: string | null },
  actorUserId?: number | null,
  source: SecretAuditSource = 'api',
): SecretSummary | null {
  const n = normalizeScope(scope)
  const row = findRow(n, key)
  if (!row) return null
  if (patch.description !== undefined) {
    getDb()
      .prepare(`UPDATE secrets SET description = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(normalizeDescription(patch.description), actorUserId ?? null, row.id)
    logAccess(actorUserId ?? null, 'describe', scopeLabel(scope), key, { secretId: row.id, source })
  }
  return rowToSummary(findRow(n, key)!)
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
  source: SecretAuditSource = 'server',
): string | null {
  const row = findRow(normalizeScope(scope), key)
  if (!row) return null
  logAccess(actorUserId ?? null, 'read', scopeLabel(scope), key, { secretId: row.id, source })
  touchLastUsed([row.id])
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
export function deleteSecret(
  scope: SecretScope,
  key: string,
  actorUserId?: number | null,
  source: SecretAuditSource = 'api',
): boolean {
  const n = normalizeScope(scope)
  const existing = findRow(n, key)
  const result = getDb()
    .prepare(`DELETE FROM secrets WHERE scope_type = ? AND workspace = ? AND user_id = ? AND key = ?`)
    .run(n.scopeType, n.workspace, n.userId, key)
  const removed = result.changes > 0
  if (removed) logAccess(actorUserId ?? null, 'delete', scopeLabel(scope), key, { secretId: existing?.id ?? null, source })
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
  logAccess(actorUserId ?? null, 'update', `move-from:${scopeLabel(from)}`, key, { secretId: row.id, detail: 'move' })
  logAccess(actorUserId ?? null, 'update', `move-to:${scopeLabel(to)}`, key, { secretId: row.id, detail: 'move' })

  return { ok: true, summary: rowToSummary(findRow(nTo, key)!) }
}

// ── Versioning ─────────────────────────────────────────────────────────────--

/** Version history (metadata only) for a secret at a scope, newest first. */
export function listVersions(scope: SecretScope, key: string): SecretVersionSummary[] {
  const row = findRow(normalizeScope(scope), key)
  if (!row) return []
  const rows = getDb()
    .prepare(
      `SELECT version, changed_by, changed_at, via FROM secret_versions WHERE secret_id = ? ORDER BY version DESC`,
    )
    .all(row.id) as { version: number; changed_by: number | null; changed_at: string; via: string | null }[]
  return rows.map(r => ({ version: r.version, changedBy: r.changed_by, changedAt: r.changed_at, via: r.via ?? null }))
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
  logAccess(actor, 'rollback', scopeLabel(scope), key, { secretId: row.id, detail: `to-version:${toVersion}` })
  return rowToSummary(updated)
}

// ── Scoped resolution (the injection primitive W3 consumes) ────────────────────

/**
 * obj 719278: keys the SERVER uses on a user's behalf and no session may hold —
 * an agent key's webhook sender key would let a session forge "card changed"
 * calls to the owner's bot. Kept in the store (encrypted, versioned, masked in
 * Settings → Secrets) but never resolved into a spawn env or the broker.
 */
export const SERVER_ONLY_SECRET_PREFIX = 'CC_AGENT_WEBHOOK_KEY_'
/**
 * obj 900620: credentials of a workspace MCP server (access/refresh token, API
 * key, DCR client secret). The server hands a session only the ONE access token
 * its workspace's MCP config references (services/workspace-mcp-servers.ts) —
 * never the refresh token or client secret — so the bulk resolvers and the
 * broker must not hand these out by name either.
 */
export const MCP_SERVER_SECRET_PREFIX = 'CC_MCP_SERVER_'
export function isServerOnlySecretKey(key: string): boolean {
  return key.startsWith(SERVER_ONLY_SECRET_PREFIX) || key.startsWith(MCP_SERVER_SECRET_PREFIX)
}

export interface ResolveOptions {
  workspace?: string | null
  userId?: number | null
  /** When set, write one `inject` audit row per resolved key under this actor
   *  (0/system at spawn time). Off by default so plain reads don't spam audit. */
  audit?: boolean
  actorUserId?: number | null
  /**
   * Include secrets marked service-only. ONLY the server's own boot hydration
   * passes this. Every session-facing caller leaves it off, which is why the
   * default is off: a new caller that forgets to think about it gets the safe
   * answer.
   */
  includeServiceOnly?: boolean
  /**
   * D4 (obj 900540): keep only keys this returns true for. Applied BEFORE
   * decryption and audit, so a withheld key is never decrypted, never written
   * as `inject` and never stamped last-used. Omitted = every key.
   */
  keyFilter?: (key: string) => boolean
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
    if (isSeatSecretKey(r.key)) continue
    // Server-process credentials are not an agent's to hold.
    if (!opts.includeServiceOnly && Number(r.service_only) > 0) continue
    if (isServerOnlySecretKey(r.key)) continue
    if (opts.keyFilter && !opts.keyFilter(r.key)) continue
    const cur = winners.get(r.key)
    if (!cur || PRECEDENCE[r.scope_type] >= PRECEDENCE[cur.scope_type]) {
      winners.set(r.key, r)
    }
  }

  const out: Record<string, string> = {}
  for (const [key, r] of winners) {
    out[key] = decryptSecret(r.value_encrypted)
    if (opts.audit) {
      const label = scopeLabel({
        scopeType: r.scope_type,
        workspace: r.workspace === WS_SENTINEL ? null : r.workspace,
        userId: r.user_id === USER_SENTINEL ? null : r.user_id,
      })
      logAccess(opts.actorUserId ?? null, 'inject', label, key, { secretId: r.id, source: 'spawn' })
    }
  }
  // Only an audited resolve is a real use (session spawn). Boot hydration and
  // plain lookups pass audit:false and must not make every secret look "used".
  if (opts.audit) touchLastUsed([...winners.values()].map(r => r.id))
  return out
}

/**
 * NAMES ONLY of the effective secret set `resolveSecrets` would inject for this
 * (workspace, user) — same buckets, no decryption, no audit row (obj 718944).
 * Used to tell a session which names it already holds; never returns a value.
 */
export function resolveSecretNames(opts: { workspace?: string | null; userId?: number | null } = {}): string[] {
  const ws = opts.workspace ?? null
  const uid = opts.userId ?? null
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT key, service_only FROM secrets WHERE
         (scope_type = 'global')
         OR (scope_type = 'workspace' AND workspace = @ws AND @hasWs = 1)
         OR (scope_type = 'user' AND user_id = @uid AND @hasUid = 1)
         OR (scope_type = 'workspace_user' AND workspace = @ws AND user_id = @uid AND @hasWs = 1 AND @hasUid = 1)
       ORDER BY key`,
    )
    .all({ ws: ws ?? WS_SENTINEL, uid: uid ?? USER_SENTINEL, hasWs: ws == null ? 0 : 1, hasUid: uid == null ? 0 : 1 }) as { key: string; service_only: number }[]
  // Mirrors resolveSecrets: a session is told the names it actually holds, so
  // the server's own service-only credentials are absent here too.
  return rows
    .filter(r => Number(r.service_only) === 0)
    .map(r => r.key)
    .filter(k => !isSeatSecretKey(k))
    .filter(k => !isServerOnlySecretKey(k))
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
    // Boot hydration IS the server process, so it takes the service-only rows
    // too — that is what keeps background jobs working after sessions stop
    // receiving them.
    const resolved = resolveSecrets({ audit: false, includeServiceOnly: true })
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
export function recentAccessLog(limit = 100): SecretAuditEntry[] {
  return queryAccessLog({ limit }).entries
}

/** One row of the append-only secrets audit log. Metadata only — there is no value field. */
export interface SecretAuditEntry {
  id: number
  actorUserId: number | null
  /** Resolved username, or null for system/session actors (or a deleted user). */
  actorUsername: string | null
  action: string
  scope: string
  key: string
  at: string
  secretId: number | null
  source: string | null
  detail: string | null
}

export interface AccessLogQuery {
  /** Rows tied to this secret id (new rows), OR legacy rows (no id) with this key + scope label. */
  secretId?: number
  key?: string
  /** Exact scope label, e.g. 'workspace:example'. Used with key for legacy rows. */
  scopeLabel?: string
  action?: string
  /** Keyset pagination: only rows with id < beforeId. */
  beforeId?: number
  limit?: number
}

export const ACCESS_LOG_MAX_LIMIT = 500

/**
 * Filtered, paginated read of the audit log, newest first. Pure SELECT: the
 * table is append-only (db/schema/secrets.ts triggers), so there is no write
 * path here and none anywhere else.
 */
export function queryAccessLog(q: AccessLogQuery = {}): { entries: SecretAuditEntry[]; nextBeforeId: number | null } {
  const where: string[] = []
  const params: Record<string, unknown> = {}
  if (q.secretId != null) {
    // Newer rows carry secret_id. Older rows (before obj 900498) only have the
    // key + scope label, so a per-secret view also matches those.
    if (q.key && q.scopeLabel) {
      where.push('(l.secret_id = @sid OR (l.secret_id IS NULL AND l.key = @key AND l.scope = @scope))')
      params.key = q.key
      params.scope = q.scopeLabel
    } else {
      where.push('l.secret_id = @sid')
    }
    params.sid = q.secretId
  } else if (q.key) {
    where.push('l.key = @key')
    params.key = q.key
  }
  if (q.action) {
    where.push('l.action = @action')
    params.action = q.action
  }
  if (q.beforeId != null) {
    where.push('l.id < @beforeId')
    params.beforeId = q.beforeId
  }
  const limit = Math.max(1, Math.min(ACCESS_LOG_MAX_LIMIT, Math.floor(q.limit ?? 100)))
  params.limit = limit + 1
  const rows = getDb()
    .prepare(
      `SELECT l.id, l.actor_user_id, u.username AS actor_username, l.action, l.scope, l.key, l.at,
              l.secret_id, l.source, l.detail
         FROM secret_access_log l
         LEFT JOIN users u ON u.id = l.actor_user_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY l.id DESC
        LIMIT @limit`,
    )
    .all(params) as {
      id: number; actor_user_id: number | null; actor_username: string | null; action: string; scope: string
      key: string; at: string; secret_id: number | null; source: string | null; detail: string | null
    }[]
  const page = rows.slice(0, limit)
  return {
    entries: page.map(r => ({
      id: r.id,
      actorUserId: r.actor_user_id,
      actorUsername: r.actor_username ?? null,
      action: r.action,
      scope: r.scope,
      key: r.key,
      at: r.at,
      secretId: r.secret_id ?? null,
      source: r.source ?? null,
      detail: r.detail ?? null,
    })),
    nextBeforeId: rows.length > limit ? page[page.length - 1]!.id : null,
  }
}
