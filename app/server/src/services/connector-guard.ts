/**
 * Owner-scoped connector credentials — the ONE place that decides whether a
 * principal may read or receive a per-user connector credential.
 *
 * A connection belongs to exactly one person. Everything else in this app may
 * only borrow it while acting AS that person. That rule used to live implicitly
 * in each call site ("pass the right userId"), which meant a caller that passed
 * the wrong id simply got the wrong person's token. This module inverts it: a
 * credential read states WHO it is for and WHO is asking, and the answer is a
 * deny by default.
 *
 * Deny reasons, in evaluation order:
 *   no_owner        the connection has no resolvable owner
 *   cross_user      the actor is acting for somebody other than the owner
 *                   (an admin role grants NOTHING here — see below)
 *   key_connector   the actor is an agent key whose allow-list omits this connector
 *   delegated_card  the card was assigned by somebody else and the owner has not
 *                   opted in to lending the connector to delegated work
 *   access_rule     the owner's own agent/workspace rules exclude this use
 *
 * WHY admin is not special: an administrator can already route work and read the
 * board. Letting the admin ROLE also unwrap another person's stored OAuth grant
 * turns "administers the install" into "is every user", and an admin's agent key
 * would inherit that silently. Administration is about the install; a connected
 * account is about a person.
 *
 * Every denial is written to `connector_access_log` (names and reasons only —
 * this module never sees, logs or returns credential material).
 */
import type { Database } from 'better-sqlite3'
import { getDb } from '../db/index.js'
import { getAccess, isConnectorAllowed } from '../connectors/access.js'

export type ConnectorDenyReason =
  | 'no_owner'
  | 'cross_user'
  | 'key_connector'
  | 'delegated_card'
  | 'access_rule'

/**
 * Who is asking. Every kind carries the user it is ACTING FOR, which is the only
 * identity that matters — a role is deliberately absent from the decision.
 *
 *  user       a signed-in person, or their legacy full-access key
 *  agent_key  a named API key; limited further by its own connector allow-list
 *  session    a spawned card session, acting for the card's resolved owner
 *  server     an internal job doing work on the owner's behalf (token refresh,
 *             scheduled delivery). Never reachable from a request.
 */
export type ConnectorActor =
  | { kind: 'user'; userId: number | null | undefined }
  | {
      kind: 'agent_key'
      userId: number | null | undefined
      keyId: number
      keyLabel: string
      /**
       * Allow-list. `null`/`[]` = no connectors. `['owner']` = inherit the owner
       * (obj 900303). `['*']` = legacy all (migrated keys).
       */
      connectors: string[] | null
    }
  | {
      kind: 'session'
      userId: number | null | undefined
      objectiveId?: number | null
      /** The key whose card this is, when the card was filed by an agent key. */
      agentKey?: { keyId: number; keyLabel: string; connectors: string[] | null } | null
    }
  | { kind: 'server'; reason?: string }

export interface ConnectorCredentialRequest {
  connectorId: string
  /** The person the credential belongs to. */
  ownerUserId: number | null | undefined
  actor: ConnectorActor
  /** Agent slug / workspace of the use, for the owner's own access rules. */
  use?: { agent?: string | null; workspace?: string | null }
  /** True when the work was assigned to the owner by somebody else. */
  delegated?: boolean
}

export type ConnectorDecision =
  | { allowed: true }
  | { allowed: false; reason: ConnectorDenyReason; detail: string }

/** The wildcard an existing key is migrated to so its behaviour is unchanged. */
export const LEGACY_ALL_CONNECTORS = '*'

/**
 * Inherit mode (obj 900303): the key does not narrow its owner.
 *
 * Read it as the ABSENCE of the per-key narrowing, not as a grant. The three
 * owner-level tests in canUseConnectorCredential() below — ownership, the
 * owner's delegated-work opt-in, and the owner's own agent/workspace rules —
 * are unchanged and still decide every use, so an inheriting key can never
 * reach past what its owner is authorised for AT THE MOMENT OF USE. Nothing is
 * cached: disconnect the account, revoke it upstream, or tighten the owner's
 * rules and the next use is denied without touching the key.
 */
export const INHERIT_OWNER_CONNECTORS = 'owner'

/** Is this list the inherit-the-owner mode rather than a list of ids? */
export function keyInheritsOwnerConnectors(connectors: string[] | null | undefined): boolean {
  return !!connectors && connectors.includes(INHERIT_OWNER_CONNECTORS)
}

/**
 * Does an agent key's allow-list cover this connector?
 *
 * Fails closed: null, empty and unparseable all mean no. `'owner'` (inherit)
 * and `'*'` (legacy) both mean "this key adds no narrowing of its own" — they
 * skip THIS test only, never the owner tests that follow it.
 */
export function keyAllowsConnector(connectors: string[] | null | undefined, connectorId: string): boolean {
  if (!connectors || connectors.length === 0) return false
  return (
    connectors.includes(LEGACY_ALL_CONNECTORS) ||
    connectors.includes(INHERIT_OWNER_CONNECTORS) ||
    connectors.includes(connectorId)
  )
}

function actingUserOf(actor: ConnectorActor): number | null {
  if (actor.kind === 'server') return null
  const id = actor.userId
  return typeof id === 'number' && id > 0 ? id : null
}

/**
 * THE check. Pure (reads only) and never throws: a failure to read the owner's
 * own rules falls back to those rules' documented default, but the ownership and
 * allow-list tests above it are unconditional.
 */
export function canUseConnectorCredential(req: ConnectorCredentialRequest): ConnectorDecision {
  const { connectorId, actor } = req
  const owner = typeof req.ownerUserId === 'number' && req.ownerUserId > 0 ? req.ownerUserId : null

  // An internal job acts for the owner by construction (it is not reachable from
  // a request), but it still needs an owner to act for.
  if (owner == null) {
    return { allowed: false, reason: 'no_owner', detail: 'the connection has no owner' }
  }
  // An internal job is not a principal with an identity of its own; it is the
  // server doing the owner's work, so it skips the "who are you" tests. It does
  // NOT skip the owner's own consent tests further down.
  const acting = actingUserOf(actor)
  if (actor.kind !== 'server' && (acting == null || acting !== owner)) {
    return {
      allowed: false,
      reason: 'cross_user',
      detail: 'the credential belongs to another person',
    }
  }

  // An agent key is at most as wide as its owner: it reaches only the connectors
  // it was granted, even though it is unmistakably acting for the owner. A key
  // in inherit mode (obj 900303) declines to narrow further — it is then exactly
  // as wide as its owner, never wider, because everything below still runs.
  const key =
    actor.kind === 'agent_key'
      ? { connectors: actor.connectors }
      : actor.kind === 'session' && actor.agentKey
        ? { connectors: actor.agentKey.connectors }
        : null
  if (key && !keyAllowsConnector(key.connectors, connectorId)) {
    return {
      allowed: false,
      reason: 'key_connector',
      detail: 'this key is not allowed to use this connector',
    }
  }

  // Work somebody else routed to the owner does not automatically borrow the
  // owner's outside accounts. Opt in per connector in Settings.
  if (req.delegated && !ownerAllowsDelegated(connectorId, owner)) {
    return {
      allowed: false,
      reason: 'delegated_card',
      detail: 'the owner has not allowed connectors on work assigned by others',
    }
  }

  // The owner's own agent/workspace rules describe a USE — which agent, in which
  // workspace. A read with no use context (the owner opening Settings, a server
  // job refreshing a token) is not such a use and is not measured against them;
  // measuring it would deny the owner their own connection the moment they
  // limited it to one agent.
  if (req.use && (req.use.agent !== undefined || req.use.workspace !== undefined)) {
    if (!isConnectorAllowed(connectorId, owner, req.use)) {
      return {
        allowed: false,
        reason: 'access_rule',
        detail: 'the owner limited this connector to other agents or workspaces',
      }
    }
  }

  return { allowed: true }
}

function ownerAllowsDelegated(connectorId: string, ownerUserId: number): boolean {
  try {
    return getAccess(connectorId, ownerUserId).allow_delegated === true
  } catch {
    // Unreadable rules must not widen access on the delegated path.
    return false
  }
}

// ── Denial audit ─────────────────────────────────────────────────────────────

export interface ConnectorDenialEntry {
  id: number
  connector_id: string
  owner_user_id: number | null
  actor_kind: string
  actor_user_id: number | null
  key_label: string | null
  objective_id: number | null
  reason: string
  detail: string
  at: string
}

let ensuredFor: Database | null = null

function db(): Database {
  const d = getDb()
  if (ensuredFor !== d) {
    // Created lazily, like connector_access, so no install needs a migration step.
    d.exec(`
      CREATE TABLE IF NOT EXISTS connector_access_log (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        connector_id  TEXT    NOT NULL,
        owner_user_id INTEGER,
        actor_kind    TEXT    NOT NULL,
        actor_user_id INTEGER,
        key_label     TEXT,
        objective_id  INTEGER,
        reason        TEXT    NOT NULL,
        detail        TEXT    NOT NULL DEFAULT '',
        at            TEXT    NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_connector_access_log_at ON connector_access_log(at DESC);
    `)
    ensuredFor = d
  }
  return d
}

/** Test hook: forget the "table already ensured" memo between in-memory DBs. */
export function resetConnectorAuditMemo(): void {
  ensuredFor = null
}

function keyLabelOf(actor: ConnectorActor): string | null {
  if (actor.kind === 'agent_key') return actor.keyLabel
  if (actor.kind === 'session') return actor.agentKey?.keyLabel ?? null
  return null
}

/**
 * Record one withheld credential. Writes names, ids and a plain reason — never a
 * token, and never the credential's value in any form. Audit failure is logged
 * and swallowed: a broken audit table must not hand out a credential, and must
 * not break the request that was already being denied.
 */
export function logConnectorDenial(
  req: ConnectorCredentialRequest,
  decision: { reason: ConnectorDenyReason; detail: string },
): void {
  try {
    db()
      .prepare(
        `INSERT INTO connector_access_log
           (connector_id, owner_user_id, actor_kind, actor_user_id, key_label, objective_id, reason, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        req.connectorId,
        typeof req.ownerUserId === 'number' ? req.ownerUserId : null,
        req.actor.kind,
        actingUserOf(req.actor),
        keyLabelOf(req.actor),
        req.actor.kind === 'session' ? (req.actor.objectiveId ?? null) : null,
        decision.reason,
        decision.detail,
      )
  } catch (err) {
    console.warn('[connector-guard] denial audit write failed:', (err as Error).message)
  }
}

/**
 * Decide AND audit in one call. This is what call sites should use: forgetting
 * the audit line is then impossible.
 */
export function checkConnectorCredential(req: ConnectorCredentialRequest): ConnectorDecision {
  const decision = canUseConnectorCredential(req)
  if (!decision.allowed) logConnectorDenial(req, decision)
  return decision
}

/**
 * Run `read` only when the actor owns the credential. Returns null on a denial,
 * having audited it. Connector definitions should obtain credentials through
 * this so a new connector is owner-scoped without having to remember to be.
 */
export function withConnectorOwner<T>(req: ConnectorCredentialRequest, read: () => T): T | null {
  return checkConnectorCredential(req).allowed ? read() : null
}

/** Newest-first denial tail for the admin audit view. */
export function recentConnectorDenials(limit = 100): ConnectorDenialEntry[] {
  const n = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 500) : 100
  return db()
    .prepare(`SELECT * FROM connector_access_log ORDER BY at DESC, id DESC LIMIT ?`)
    .all(n) as ConnectorDenialEntry[]
}
