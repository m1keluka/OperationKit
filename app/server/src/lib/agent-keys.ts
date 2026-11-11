/**
 * Agent API keys (obj 714090) — many named, scoped keys per user.
 *
 * Same `cc_live_` prefix and SHA-256-only storage as the legacy single key in
 * api-keys.ts, so an agent cannot tell them apart and nothing on the wire
 * changes. What differs is the principal: a row here carries a label
 * ("Grok: Example"), a scope set and an optional workspace allowlist, and every
 * request it makes is enforced by middleware/agent-key-guard.ts.
 *
 * The legacy users.api_token_hash key is untouched and resolves first — it is
 * the full-access key Operator's live Grok Bots use today.
 */
import { getDb } from '../db/index.js'
import { hashApiKey, isApiKey, mintApiKey } from './api-keys.js'
import { getUserWorkspaces } from '../middleware/workspace.js'
import {
  AGENT_SCOPES,
  DEFAULT_AGENT_SCOPES,
  DEFAULT_NEW_KEY_CONNECTORS,
  INHERIT_OWNER_CONNECTORS,
  LEGACY_ALL_CONNECTORS,
  type AgentApiKeyIssued,
  type AgentApiKeySummary,
  type AgentScope,
  type User,
} from '@operationkit/shared'

export const MAX_KEYS_PER_USER = 50
export const MAX_LABEL_LEN = 80
/** last_used_at is bumped at most once per this many ms per key. */
export const LAST_USED_THROTTLE_MS = 60_000

/** The identity attached to req.agentKey for a request made with an agent key. */
export interface AgentKeyPrincipal {
  id: number
  label: string
  scopes: AgentScope[]
  /** null = every workspace the owning user can see. */
  workspaces: string[] | null
  /**
   * Connector ids this key may use — and only its OWNER's connections, which
   * services/connector-guard.ts enforces separately. [] = none. ['owner'] =
   * inherit the owner's authorised connectors, which is what a key created
   * after obj 900303 gets unless its owner says otherwise.
   */
  connectors: string[]
}

interface AgentKeyRow {
  id: number
  user_id: number
  label: string
  last4: string
  scopes: string
  workspaces: string | null
  connectors: string | null
  created_at: string
  last_used_at: string | null
  revoked_at: string | null
}

function parseScopes(raw: string): AgentScope[] {
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((s): s is AgentScope => (AGENT_SCOPES as readonly string[]).includes(s)) : []
  } catch {
    return []
  }
}

function parseWorkspaces(raw: string | null): string[] | null {
  if (raw == null) return null
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []
  } catch {
    // Unparseable allowlist fails CLOSED (no workspaces), never open.
    return []
  }
}

/**
 * Connector allow-list for a stored row. NULL (a key created before obj 900303,
 * or one whose list was cleared) and anything unparseable both mean NO
 * connectors — this list only ever widens access, so it fails closed.
 *
 * obj 900303 deliberately did NOT change this reading. A stored NULL keeps
 * meaning deny-all, so no key that exists today silently gains a connector; the
 * new inherit default is written at CREATE time only, as an explicit
 * `["owner"]`, and an existing key moves to it only when its owner chooses to.
 */
export function parseConnectors(raw: string | null): string[] {
  if (raw == null) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []
  } catch {
    return []
  }
}

const CONNECTOR_ID = /^[a-z0-9][a-z0-9-]{0,40}$/

/**
 * Validate a caller-supplied connector list. Returns a sentence on bad input.
 *
 * Three shapes, and the difference between them is the whole point (obj 900303):
 *
 *   undefined  the caller said nothing      → `whenOmitted` (see below)
 *   null / []  the caller said "none"       → `[]`, an explicit deny-all
 *   [...ids]   the caller named connectors  → exactly those, sorted
 *   ['owner']  inherit the owner            → `['owner']`, mode, must stand alone
 *
 * `whenOmitted` exists so CREATE and PATCH can disagree about silence without
 * either of them guessing: a new key omitting the field opts into inheritance,
 * while an update omitting it changes nothing (the route rejects it earlier).
 * It is NEVER applied to an explicit `null`/`[]` — saying "none" out loud must
 * keep meaning none, or every restricted key would widen on its next save.
 */
export function parseConnectorsInput(
  value: unknown,
  whenOmitted: readonly string[] = [],
): string[] | { error: string } {
  if (value === undefined) return [...whenOmitted]
  if (value === null) return []
  if (!Array.isArray(value)) return { error: 'connectors must be an array of connector ids, or null for none' }
  const ids = [...new Set(value.map(v => (typeof v === 'string' ? v.trim() : '')).filter(Boolean))]
  // Inherit is a MODE, not an id: mixing it with ids would read as "these ids
  // PLUS everything", which is a grant nobody asked for. Make it say one thing.
  if (ids.includes(INHERIT_OWNER_CONNECTORS)) {
    if (ids.length > 1) {
      return {
        error: `"${INHERIT_OWNER_CONNECTORS}" means inherit every connector you are authorised for, so it cannot be combined with specific connector ids`,
      }
    }
    return [INHERIT_OWNER_CONNECTORS]
  }
  // The legacy wildcard is written only by the migration. A caller that wants a
  // key to reach everything either names the connectors or asks to inherit, so
  // the grant stays readable.
  const bad = ids.filter(id => id === LEGACY_ALL_CONNECTORS || !CONNECTOR_ID.test(id))
  if (bad.length > 0) return { error: `invalid connector id(s): ${bad.join(', ')}` }
  return ids.sort()
}

function toSummary(row: AgentKeyRow): AgentApiKeySummary {
  return {
    id: row.id,
    label: row.label,
    last4: row.last4,
    scopes: parseScopes(row.scopes),
    workspaces: parseWorkspaces(row.workspaces),
    connectors: parseConnectors(row.connectors),
    created_at: row.created_at,
    last_used_at: row.last_used_at,
    revoked_at: row.revoked_at,
  }
}

export function isAgentScope(s: unknown): s is AgentScope {
  return typeof s === 'string' && (AGENT_SCOPES as readonly string[]).includes(s)
}

export function listAgentKeys(userId: number): AgentApiKeySummary[] {
  const rows = getDb()
    .prepare('SELECT * FROM agent_api_keys WHERE user_id = ? ORDER BY revoked_at IS NOT NULL, id DESC')
    .all(userId) as AgentKeyRow[]
  return rows.map(toSummary)
}

export type CreateAgentKeyResult =
  | { ok: true; key: AgentApiKeyIssued }
  | { ok: false; status: number; error: string }

/**
 * Validate + mint. Scopes default to DEFAULT_AGENT_SCOPES (no board:done, no
 * board:delete — "done is a human signature"). A workspace allowlist may only
 * name workspaces the user is a member of; admins (who see every workspace)
 * may name any well-formed slug.
 */
export function createAgentKey(
  user: Pick<User, 'id' | 'role'>,
  input: { label?: unknown; scopes?: unknown; workspaces?: unknown; connectors?: unknown },
): CreateAgentKeyResult {
  const label = typeof input.label === 'string' ? input.label.trim() : ''
  if (!label) return { ok: false, status: 400, error: 'label is required' }
  if (label.length > MAX_LABEL_LEN) {
    return { ok: false, status: 400, error: `label must be at most ${MAX_LABEL_LEN} characters` }
  }

  let scopes: AgentScope[]
  if (input.scopes === undefined) {
    scopes = [...DEFAULT_AGENT_SCOPES]
  } else if (Array.isArray(input.scopes)) {
    const bad = input.scopes.filter(s => !isAgentScope(s))
    if (bad.length > 0) {
      return { ok: false, status: 400, error: `unknown scope(s): ${bad.map(String).join(', ')}` }
    }
    // Keep the canonical order; drop duplicates.
    scopes = AGENT_SCOPES.filter(s => (input.scopes as unknown[]).includes(s))
    if (scopes.length === 0) return { ok: false, status: 400, error: 'at least one scope is required' }
  } else {
    return { ok: false, status: 400, error: 'scopes must be an array' }
  }

  let workspaces: string[] | null
  if (input.workspaces === undefined || input.workspaces === null) {
    workspaces = null
  } else if (Array.isArray(input.workspaces)) {
    const slugs = [...new Set(input.workspaces.map(w => (typeof w === 'string' ? w.trim() : '')).filter(Boolean))]
    if (slugs.length === 0) {
      return { ok: false, status: 400, error: 'workspaces must name at least one workspace, or be null for all' }
    }
    const malformed = slugs.filter(s => !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(s))
    if (malformed.length > 0) {
      return { ok: false, status: 400, error: `invalid workspace slug(s): ${malformed.join(', ')}` }
    }
    if (user.role !== 'admin') {
      const mine = new Set(getUserWorkspaces(user.id).map(w => w.workspace))
      const notMine = slugs.filter(s => !mine.has(s))
      if (notMine.length > 0) {
        return { ok: false, status: 403, error: `No access to workspace(s): ${notMine.join(', ')}` }
      }
    }
    workspaces = slugs
  } else {
    return { ok: false, status: 400, error: 'workspaces must be an array of slugs or null' }
  }

  // obj 900303: a new key DEFAULTS to inheriting the connected accounts its
  // owner is authorised for, so the common case needs no per-key ticking. The
  // key is still not a copy of its owner — it carries its own scopes and
  // workspace list, it reaches nobody else's connections, and it is re-measured
  // against the owner's current authorisation on every single use. A caller
  // that wants a narrower key says so: `connectors: []` / `null` for none, or
  // an explicit list of ids.
  const connectorsParsed = parseConnectorsInput(input.connectors, DEFAULT_NEW_KEY_CONNECTORS)
  if (!Array.isArray(connectorsParsed)) {
    return { ok: false, status: 400, error: connectorsParsed.error }
  }
  const connectors = connectorsParsed

  const db = getDb()
  const active = db
    .prepare('SELECT COUNT(*) AS n FROM agent_api_keys WHERE user_id = ? AND revoked_at IS NULL')
    .get(user.id) as { n: number }
  if (active.n >= MAX_KEYS_PER_USER) {
    return { ok: false, status: 409, error: `At most ${MAX_KEYS_PER_USER} active agent keys per user — revoke one first` }
  }

  const token = mintApiKey()
  const result = db
    .prepare(
      `INSERT INTO agent_api_keys (user_id, label, key_hash, last4, scopes, workspaces, connectors)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      user.id,
      label,
      hashApiKey(token),
      token.slice(-4),
      JSON.stringify(scopes),
      workspaces ? JSON.stringify(workspaces) : null,
      JSON.stringify(connectors),
    )
  const row = db.prepare('SELECT * FROM agent_api_keys WHERE id = ?').get(result.lastInsertRowid) as AgentKeyRow
  return { ok: true, key: { ...toSummary(row), token } }
}

export type UpdateAgentKeyResult =
  | { ok: true; key: AgentApiKeySummary }
  | { ok: false; status: number; error: string }

/**
 * Replace a key's connector allow-list. `ownerId` is null when an admin is
 * editing somebody else's key, which is allowed (an admin administers the
 * install's keys) — note that it still grants the admin nothing: the key keeps
 * reaching only its OWN owner's connections.
 *
 * This is also the opt-in migration path for an existing key (obj 900303): its
 * owner moves it to inherit mode by saving `["owner"]` here. Nothing moves a key
 * there on its own — omitting the field is rejected by the route, so a key's
 * restriction can only change because somebody chose to change it.
 */
export function updateAgentKeyConnectors(
  keyId: number,
  connectors: unknown,
  ownerId: number | null,
): UpdateAgentKeyResult {
  const parsed = parseConnectorsInput(connectors)
  if (!Array.isArray(parsed)) return { ok: false, status: 400, error: parsed.error }
  const db = getDb()
  const row = db.prepare('SELECT * FROM agent_api_keys WHERE id = ?').get(keyId) as AgentKeyRow | undefined
  if (!row) return { ok: false, status: 404, error: 'Agent key not found' }
  if (ownerId != null && row.user_id !== ownerId) {
    return { ok: false, status: 404, error: 'Agent key not found' }
  }
  db.prepare('UPDATE agent_api_keys SET connectors = ? WHERE id = ?').run(JSON.stringify(parsed), keyId)
  const updated = db.prepare('SELECT * FROM agent_api_keys WHERE id = ?').get(keyId) as AgentKeyRow
  return { ok: true, key: toSummary(updated) }
}

/** Revoke one of the caller's keys. Returns false when it is not theirs / not found. */
export function revokeAgentKey(userId: number, keyId: number): boolean {
  const result = getDb()
    .prepare(
      `UPDATE agent_api_keys SET revoked_at = COALESCE(revoked_at, datetime('now'))
        WHERE id = ? AND user_id = ?`,
    )
    .run(keyId, userId)
  return result.changes > 0
}

const lastTouched = new Map<number, number>()

/** Throttled last_used_at bump — at most once per LAST_USED_THROTTLE_MS per key. */
export function touchAgentKey(keyId: number, now = Date.now()): void {
  const prev = lastTouched.get(keyId)
  if (prev != null && now - prev < LAST_USED_THROTTLE_MS) return
  lastTouched.set(keyId, now)
  try {
    getDb().prepare("UPDATE agent_api_keys SET last_used_at = datetime('now') WHERE id = ?").run(keyId)
  } catch (err) {
    // Telemetry only — never fail the request over it.
    console.error('[agent-keys] last_used_at update failed:', err)
  }
}

/** Test hook: forget the throttle so a test can observe a fresh bump. */
export function resetAgentKeyTouchThrottle(): void {
  lastTouched.clear()
}

export type AgentKeyResolution =
  | { status: 'ok'; user: User; key: AgentKeyPrincipal }
  | { status: 'revoked' }
  | { status: 'unknown' }

/**
 * Resolve a bearer token against agent_api_keys. 'unknown' means "not an agent
 * key" (it may still be the legacy key, or garbage) — callers decide.
 */
export function resolveAgentKey(token: string): AgentKeyResolution {
  if (!isApiKey(token)) return { status: 'unknown' }
  const row = getDb()
    .prepare(
      `SELECT k.*, u.username, u.role, u.created_at AS user_created_at
         FROM agent_api_keys k JOIN users u ON u.id = k.user_id
        WHERE k.key_hash = ?`,
    )
    .get(hashApiKey(token)) as
    | (AgentKeyRow & { username: string; role: User['role']; user_created_at: string })
    | undefined
  if (!row) return { status: 'unknown' }
  if (row.revoked_at) return { status: 'revoked' }
  return {
    status: 'ok',
    user: { id: row.user_id, username: row.username, role: row.role, created_at: row.user_created_at },
    key: {
      id: row.id,
      label: row.label,
      scopes: parseScopes(row.scopes),
      workspaces: parseWorkspaces(row.workspaces),
      connectors: parseConnectors(row.connectors),
    },
  }
}
