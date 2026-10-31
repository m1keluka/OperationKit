/**
 * Connector access rules (obj 720115): which agents, in which workspaces, may
 * receive a person's connection when a session starts.
 *
 * No row = everyone may use it. That keeps every connection made before this
 * existed working exactly as before. A stored list is an allow-list; an empty
 * list means no agent gets the credential (it stays stored and connected).
 *
 * The table is created lazily, so no schema migration is needed. Removing a
 * connection does not remove its rules — reconnecting keeps them.
 */
import type { Database } from 'better-sqlite3'
import type { ConnectorAccess } from '@operationkit/shared'
import { getDb } from '../db/index.js'

export const DEFAULT_ACCESS: ConnectorAccess = { agents: null, workspaces: null }

let ensuredFor: Database | null = null

function db(): Database {
  const d = getDb()
  if (ensuredFor !== d) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS connector_access (
        connector_id TEXT    NOT NULL,
        user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        agents       TEXT,   -- JSON array of agent slugs; NULL = all agents
        workspaces   TEXT,   -- JSON array of workspace slugs; NULL = all workspaces
        updated_at   TEXT    NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (connector_id, user_id)
      );
    `)
    ensuredFor = d
  }
  return d
}

function parseList(raw: string | null): string[] | null {
  if (raw == null) return null
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null
  } catch {
    // A corrupt rule must not silently widen access.
    return []
  }
}

export function getAccess(connectorId: string, userId: number): ConnectorAccess {
  const row = db()
    .prepare('SELECT agents, workspaces FROM connector_access WHERE connector_id = ? AND user_id = ?')
    .get(connectorId, userId) as { agents: string | null; workspaces: string | null } | undefined
  if (!row) return { ...DEFAULT_ACCESS }
  return { agents: parseList(row.agents), workspaces: parseList(row.workspaces) }
}

const SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/i

/** Validate a request body into a ConnectorAccess. Returns an error sentence on bad input. */
export function parseAccessBody(body: unknown): ConnectorAccess | { error: string } {
  const b = (body ?? {}) as Record<string, unknown>
  const out: ConnectorAccess = { agents: null, workspaces: null }
  for (const key of ['agents', 'workspaces'] as const) {
    const v = b[key]
    if (v === null || v === undefined) continue
    if (!Array.isArray(v) || !v.every(x => typeof x === 'string' && SLUG.test(x))) {
      return { error: `${key} must be null (everyone) or a list of names.` }
    }
    out[key] = Array.from(new Set(v as string[])).sort()
  }
  return out
}

export function setAccess(connectorId: string, userId: number, access: ConnectorAccess): ConnectorAccess {
  const d = db()
  if (access.agents === null && access.workspaces === null) {
    d.prepare('DELETE FROM connector_access WHERE connector_id = ? AND user_id = ?').run(connectorId, userId)
  } else {
    d.prepare(
      `INSERT INTO connector_access (connector_id, user_id, agents, workspaces, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(connector_id, user_id) DO UPDATE SET
         agents = excluded.agents, workspaces = excluded.workspaces, updated_at = excluded.updated_at`,
    ).run(
      connectorId,
      userId,
      access.agents === null ? null : JSON.stringify(access.agents),
      access.workspaces === null ? null : JSON.stringify(access.workspaces),
    )
  }
  return getAccess(connectorId, userId)
}

/**
 * May a session for this agent, in this workspace, receive the person's
 * connection? Used at spawn. Never throws: on a read failure it answers true,
 * matching the "no rule = allowed" default so a DB hiccup cannot strip a
 * person's own credential from their own session.
 */
export function isConnectorAllowed(
  connectorId: string,
  userId: number | null | undefined,
  use: { agent?: string | null; workspace?: string | null },
): boolean {
  if (userId == null) return true
  let access: ConnectorAccess
  try {
    access = getAccess(connectorId, userId)
  } catch {
    return true
  }
  if (access.agents !== null && !(use.agent && access.agents.includes(use.agent))) return false
  if (access.workspaces !== null && !(use.workspace && access.workspaces.includes(use.workspace))) return false
  return true
}
