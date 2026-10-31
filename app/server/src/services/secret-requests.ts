/**
 * Secret requests from chat (obj 719065) — builds on obj 718944's
 * `objectives.needs_secret` list, which stays the single source of truth for
 * "this card is waiting on NAME". This module adds:
 *
 *   - a stable request id per pending name (`sr-<objectiveId>-<NAME>`), so an
 *     outside managing agent can address one request over MCP;
 *   - a suggested scope per request (Command Center / organization / org+me);
 *   - ONE write path every fulfilment goes through (owner popup, "+ Add secret",
 *     agent upload token): store write at the chosen scope with `via`
 *     provenance on the version row → clear the request → wake the worker;
 *   - one-time, write-only upload tokens an agent with `board:secrets_request`
 *     mints for exactly one card + NAME + scope (15 min, single use, hashed).
 *
 * SECURITY CONTRACT: no function here returns, logs or records a secret value.
 * The value is handed to `setSecret` (encrypted at rest) and dropped. The wake
 * message names the secret only.
 */
import crypto from 'crypto'
import type Database from 'better-sqlite3'
import type {
  NeedsSecretItem,
  Objective,
  SecretRequestScope,
  SecretRequestView,
} from '@operationkit/shared'
import { SECRET_REQUEST_SCOPES } from '@operationkit/shared'
import { getDb } from '../db/index.js'
import { setSecret, scopeLabel, type SecretScope } from './secrets-store.js'
import { logActivity } from '../routes/feed.js'
import { broadcast } from '../ws/index.js'
import { mapObjective, parseNeedsSecret } from '../routes/objectives-helpers.js'
import { visibilityClause, type ControlUser } from '../lib/agent-control.js'
import { systemSender } from '../lib/message-provenance.js'
import { resolveFollowUpSessionId } from './objective-sessions.js'
import { recordFollowUpInJsonl, sendFollowUp } from './session-manager.js'
import { noteStartReason } from './session-start-reasons.js'
import { isLockedStatus, runMachineStatusUpdate } from '../lib/status-lock.js'

export const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/
export const UPLOAD_TOKEN_TTL_MS = 15 * 60 * 1000
export const UPLOAD_TOKEN_PREFIX = 'ccsu_'
/** A pasted value larger than this is not a credential. */
export const SECRET_VALUE_MAX = 16 * 1024

const REQUEST_ID_RE = /^sr-(\d+)-([A-Z][A-Z0-9_]{1,63})$/

export function requestIdFor(objectiveId: number, name: string): string {
  return `sr-${objectiveId}-${name}`
}

export function parseRequestId(id: unknown): { objectiveId: number; name: string } | null {
  const m = typeof id === 'string' ? REQUEST_ID_RE.exec(id.trim()) : null
  return m ? { objectiveId: Number(m[1]), name: m[2] } : null
}

export function parseRequestScope(raw: unknown): SecretRequestScope | null {
  return typeof raw === 'string' && (SECRET_REQUEST_SCOPES as string[]).includes(raw) ? (raw as SecretRequestScope) : null
}

/** The store bucket a request scope lands in for this card + person. */
export function storeScopeFor(scope: SecretRequestScope, workspace: string, userId: number | null): SecretScope {
  if (scope === 'global') return { scopeType: 'global' }
  if (scope === 'workspace_user') return { scopeType: 'workspace_user', workspace, userId }
  return { scopeType: 'workspace', workspace }
}

function cardWorkspace(objective: Pick<Objective, 'workspace'>): string {
  return objective.workspace || 'example'
}

/** Raw needs_secret column → items (tolerates both a parsed array and the JSON text). */
function pendingItems(objective: Objective): NeedsSecretItem[] {
  const raw = (objective as unknown as { needs_secret?: unknown }).needs_secret
  return Array.isArray(raw) ? (raw as NeedsSecretItem[]) : parseNeedsSecret(raw)
}

export function toSecretRequestViews(objective: Objective): SecretRequestView[] {
  return pendingItems(objective).map(i => ({
    request_id: requestIdFor(objective.id, i.name),
    objective_id: objective.id,
    workspace: cardWorkspace(objective),
    name: i.name,
    reason: i.reason,
    scope: i.scope ?? 'workspace',
    requested_at: i.requested_at,
  }))
}

/** Every open request on cards `user` may read (agent keys: their workspace allowlist). */
export function listOpenSecretRequests(
  db: Database.Database,
  user: ControlUser,
  opts: { workspace?: string; objectiveId?: number } = {},
): SecretRequestView[] {
  const vis = visibilityClause(user, opts.workspace)
  if (!vis) return []
  const rows = db
    .prepare(
      `SELECT * FROM objectives o
        WHERE o.needs_secret IS NOT NULL AND o.needs_secret != '[]' AND o.deleted_at IS NULL
          AND o.status NOT IN ('done', 'cancelled') AND ${vis.sql}
          ${opts.objectiveId ? 'AND o.id = ?' : ''}
        ORDER BY o.updated_at DESC LIMIT 100`,
    )
    .all(...vis.params, ...(opts.objectiveId ? [opts.objectiveId] : [])) as Objective[]
  return rows.flatMap(toSecretRequestViews)
}

function loadObjective(id: number): Objective | undefined {
  return getDb().prepare('SELECT * FROM objectives WHERE id = ?').get(id) as Objective | undefined
}

/** Persist the pending list and push the card to every board. */
export function saveNeedsSecret(objectiveId: number, items: NeedsSecretItem[]): Objective {
  getDb()
    .prepare("UPDATE objectives SET needs_secret = ?, updated_at = datetime('now') WHERE id = ?")
    .run(items.length ? JSON.stringify(items) : null, objectiveId)
  const updated = mapObjective(loadObjective(objectiveId)!)
  broadcast({ type: 'objective_updated', payload: updated })
  return updated
}

export interface FulfilInput {
  objective: Objective
  name: string
  value: string
  scope: SecretRequestScope
  /** CC user the write is attributed to (owner in the UI, or the agent key's owner). */
  actorUserId: number
  /** Human-readable actor for the activity row / wake attribution. */
  actorLabel: string
  /** Stored on the secret's History row. null = owner typed it in Command Center. */
  via?: string | null
  /** Tell + restart the worker even when the name was not requested ("+ Add secret"). */
  notifyUnrequested?: boolean
}

export type FulfilResult =
  | { ok: true; name: string; scope: string; requested: boolean; woke: boolean; needs_secret: NeedsSecretItem[] }
  | { ok: false; status: number; error: string }

/**
 * The one write path. Validates, stores (encrypted, versioned, `via` on the
 * History row), clears the request, records the activity, wakes the worker.
 */
export function fulfilSecret(input: FulfilInput): FulfilResult {
  const { objective, name, scope } = input
  const value = input.value.trim()
  if (!SECRET_NAME_RE.test(name)) {
    return { ok: false, status: 400, error: 'name must be UPPER_SNAKE_CASE (e.g. APIFY_API_TOKEN)' }
  }
  if (!value) return { ok: false, status: 400, error: 'value is required' }
  if (value.length > SECRET_VALUE_MAX) return { ok: false, status: 413, error: 'value is too large to be a credential' }

  const workspace = cardWorkspace(objective)
  const storeScope = storeScopeFor(scope, workspace, input.actorUserId)
  try {
    setSecret({ scope: storeScope, key: name, value, actorUserId: input.actorUserId, via: input.via ?? null })
  } catch (err) {
    console.error('[secret-requests] store write failed', err instanceof Error ? err.name : 'unknown')
    return { ok: false, status: 500, error: 'Could not save the secret' }
  }

  const fresh = loadObjective(objective.id) ?? objective
  const items = pendingItems(fresh)
  const requested = items.some(i => i.name === name)
  const remaining = items.filter(i => i.name !== name)
  const updated = requested ? saveNeedsSecret(objective.id, remaining) : mapObjective(fresh)
  const label = scopeLabel(storeScope)

  logActivity({
    project: objective.project || 'operationkit',
    workspace,
    objective_id: objective.id,
    event_type: 'milestone',
    title: `Secret ${name} added (${label})${input.via ? ` — ${input.via}` : ''}`,
    metadata: { secret_name: name, scope: label, by: input.actorLabel, via: input.via ?? null, requested },
  })

  const woke = requested || input.notifyUnrequested ? wakeWithSecret(fresh, name, label, input.actorLabel) : false
  return { ok: true, name, scope: label, requested, woke, needs_secret: updated.needs_secret ?? [] }
}

/** Respawn the worker so its env carries the new secret. Names only. Never fatal. */
function wakeWithSecret(objective: Objective, name: string, label: string, actor: string): boolean {
  if (isLockedStatus(objective.status)) return false
  try {
    const db = getDb()
    const sessionId = resolveFollowUpSessionId(db, objective)
    const text =
      `${name} is now available (secrets store, ${label}). It is in your environment as $${name} after this restart, ` +
      `and usable now through the secrets broker as {{secret:${name}}} — use it by name, never print it. Continue the work that was waiting on it.`
    const sender = systemSender(`secret ${name} added by ${actor}`)
    runMachineStatusUpdate(db, "UPDATE objectives SET status = 'working', session_id = ?, updated_at = datetime('now') WHERE id = ?", sessionId, objective.id)
    recordFollowUpInJsonl(sessionId, text, undefined, sender)
    setImmediate(() => {
      try {
        noteStartReason(objective.id, 'follow_up', actor, 'needs_secret_filled')
        sendFollowUp(sessionId, text, objective, { skipJsonl: true, sender })
      } catch (err) {
        console.error(`[secret-requests] wake failed for ${objective.id}:`, err instanceof Error ? err.message : 'unknown')
      }
    })
    return true
  } catch (err) {
    console.error(`[secret-requests] wake setup failed for ${objective.id}:`, err instanceof Error ? err.message : 'unknown')
    return false
  }
}

// ── One-time upload tokens (MCP relay) ──────────────────────────────────────

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

function sqlTime(d: Date): string {
  return d.toISOString().replace('T', ' ').slice(0, 19)
}

export interface MintInput {
  objective: Objective
  name: string
  scope: SecretRequestScope
  agentKeyId: number
  agentLabel: string
  /** The agent key's owning user — the write is attributed to them. */
  userId: number
  now?: Date
}

/** Mint a token for ONE pending request. The raw token is returned once and never stored. */
export function mintUploadToken(input: MintInput): { token: string; expires_at: string } | { error: string; status: number } {
  const items = pendingItems(input.objective)
  if (!items.some(i => i.name === input.name)) {
    return { status: 409, error: `${input.name} is not an open secret request on card #${input.objective.id}` }
  }
  const now = input.now ?? new Date()
  const expires = new Date(now.getTime() + UPLOAD_TOKEN_TTL_MS)
  const token = UPLOAD_TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url')
  getDb()
    .prepare(
      `INSERT INTO secret_upload_tokens
         (token_hash, objective_id, name, scope_type, workspace, user_id, agent_key_id, agent_label, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      hashToken(token),
      input.objective.id,
      input.name,
      input.scope,
      cardWorkspace(input.objective),
      input.userId,
      input.agentKeyId,
      input.agentLabel,
      sqlTime(now),
      sqlTime(expires),
    )
  logActivity({
    project: input.objective.project || 'operationkit',
    workspace: cardWorkspace(input.objective),
    objective_id: input.objective.id,
    event_type: 'milestone',
    title: `Secret request ${input.name}: one-time upload link issued to agent ${input.agentLabel}`,
    metadata: { secret_name: input.name, agent_key_id: input.agentKeyId, expires_at: expires.toISOString() },
  })
  return { token, expires_at: expires.toISOString() }
}

interface TokenRow {
  id: number
  objective_id: number
  name: string
  scope_type: string
  user_id: number
  agent_key_id: number | null
  agent_label: string | null
  expires_at: string
  used_at: string | null
}

export type RedeemResult = FulfilResult | { ok: false; status: number; error: string }

/**
 * Redeem a token: it must exist, be unexpired, unused, and match `name`. The
 * claim is an atomic UPDATE … WHERE used_at IS NULL, so two racing uploads
 * cannot both win. A wrong-name attempt does NOT consume the token.
 */
export function redeemUploadToken(token: string, name: string, value: string, now = new Date()): RedeemResult {
  if (typeof token !== 'string' || !token.startsWith(UPLOAD_TOKEN_PREFIX)) {
    return { ok: false, status: 401, error: 'Missing or malformed upload token' }
  }
  const db = getDb()
  const row = db.prepare('SELECT * FROM secret_upload_tokens WHERE token_hash = ?').get(hashToken(token)) as TokenRow | undefined
  if (!row) return { ok: false, status: 401, error: 'Unknown upload token' }
  if (row.used_at) return { ok: false, status: 410, error: 'This upload link was already used' }
  if (row.expires_at <= sqlTime(now)) return { ok: false, status: 410, error: 'This upload link has expired — mint a new one' }
  if (name !== row.name) {
    return { ok: false, status: 403, error: `This upload link is only for ${row.name}` }
  }
  if (!value.trim()) return { ok: false, status: 400, error: 'value is required' }

  const claimed = db
    .prepare('UPDATE secret_upload_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?')
    .run(sqlTime(now), row.id, sqlTime(now)).changes
  if (claimed !== 1) return { ok: false, status: 410, error: 'This upload link was already used' }

  const objective = loadObjective(row.objective_id)
  if (!objective) return { ok: false, status: 404, error: 'The card for this request no longer exists' }
  if (!pendingItems(objective).some(i => i.name === row.name)) {
    return { ok: false, status: 409, error: `${row.name} is no longer requested on card #${objective.id}` }
  }
  const scope = parseRequestScope(row.scope_type) ?? 'workspace'
  const agent = row.agent_label ?? 'unknown agent'
  return fulfilSecret({
    objective,
    name: row.name,
    value,
    scope,
    actorUserId: row.user_id,
    actorLabel: `agent ${agent}`,
    via: `agent ${agent}${row.agent_key_id ? ` (key #${row.agent_key_id})` : ''} relayed the request on card #${objective.id}`,
  })
}
