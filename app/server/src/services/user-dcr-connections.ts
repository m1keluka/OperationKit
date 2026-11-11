/**
 * Per-user grants for `auth_path: 'dcr_mcp'` connectors (Sprint 7.3, obj 900507).
 *
 * Mirrors services/user-google-connections.ts: the credential material lives
 * ONLY in `*_encrypted` columns (AES-256-GCM via services/crypto.ts — the same
 * primitive and key as every other connector credential; no new secrets
 * backend), every value that can reach an API response is the masked
 * `UserDcrConnectionSummary`, and a decrypt happens in exactly the seams below.
 *
 * One row per (connector_id, user_id) — a person connects Notion and Linear
 * independently, each with its own token. `auth_method` records which path
 * produced the stored credential:
 *   - 'oauth'   — DCR/CIMD + an authorization-code grant against the
 *                 provider's own auth server (access_token/refresh_token).
 *   - 'api_key' — the token/API-key fallback, used when registration failed at
 *                 runtime or the provider only partially supports DCR/CIMD.
 * Both are stored the same way (encrypted in access_token_encrypted) so a
 * connector's session-env injection does not need to care which path was used.
 */
import { getDb } from '../db/index.js'
import { checkConnectorCredential, type ConnectorActor } from './connector-guard.js'
import { encryptField, decryptField } from './crypto.js'

export type DcrAuthMethod = 'oauth' | 'api_key'

interface ConnectionRow {
  connector_id: string
  user_id: number
  auth_method: DcrAuthMethod
  account_label: string | null
  access_token_encrypted: string
  refresh_token_encrypted: string | null
  access_token_expires_at: string | null
  scopes: string | null
  connected_at: string
  last_refreshed_at: string | null
  last_error: string | null
}

export interface UserDcrConnectionSummary {
  connector_id: string
  auth_method: DcrAuthMethod
  /** Who/what this is connected as — never a secret (e.g. a workspace name or email). */
  account_label: string | null
  scopes: string | null
  connected_at: string
  last_refreshed_at: string | null
  last_error: string | null
}

function rowToSummary(row: ConnectionRow): UserDcrConnectionSummary {
  return {
    connector_id: row.connector_id,
    auth_method: row.auth_method,
    account_label: row.account_label,
    scopes: row.scopes,
    connected_at: row.connected_at,
    last_refreshed_at: row.last_refreshed_at,
    last_error: row.last_error,
  }
}

/** Masked summary of a user's connection to one connector, or null. */
export function getForUser(connectorId: string, userId: number): UserDcrConnectionSummary | null {
  const row = getDb()
    .prepare('SELECT * FROM user_dcr_connections WHERE connector_id = ? AND user_id = ?')
    .get(connectorId, userId) as ConnectionRow | undefined
  return row ? rowToSummary(row) : null
}

export interface UpsertOAuthInput {
  accountLabel: string | null
  accessToken: string
  refreshToken?: string | null
  accessTokenExpiresAt?: string | null
  scopes?: string | null
}

/** Store (or replace) an OAuth grant obtained via the DCR/CIMD flow. */
export function upsertOAuth(connectorId: string, userId: number, input: UpsertOAuthInput): UserDcrConnectionSummary {
  return upsert(connectorId, userId, {
    authMethod: 'oauth',
    accountLabel: input.accountLabel,
    accessToken: input.accessToken,
    refreshToken: input.refreshToken ?? null,
    accessTokenExpiresAt: input.accessTokenExpiresAt ?? null,
    scopes: input.scopes ?? null,
  })
}

export interface UpsertApiKeyInput {
  accountLabel: string | null
  apiKey: string
}

/** Store (or replace) the token/API-key fallback credential. */
export function upsertApiKey(connectorId: string, userId: number, input: UpsertApiKeyInput): UserDcrConnectionSummary {
  return upsert(connectorId, userId, {
    authMethod: 'api_key',
    accountLabel: input.accountLabel,
    accessToken: input.apiKey,
    refreshToken: null,
    accessTokenExpiresAt: null,
    scopes: null,
  })
}

function upsert(
  connectorId: string,
  userId: number,
  input: {
    authMethod: DcrAuthMethod
    accountLabel: string | null
    accessToken: string
    refreshToken: string | null
    accessTokenExpiresAt: string | null
    scopes: string | null
  },
): UserDcrConnectionSummary {
  getDb()
    .prepare(
      `INSERT INTO user_dcr_connections
         (connector_id, user_id, auth_method, account_label, access_token_encrypted,
          refresh_token_encrypted, access_token_expires_at, scopes,
          connected_at, last_refreshed_at, last_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), NULL)
       ON CONFLICT(connector_id, user_id) DO UPDATE SET
         auth_method              = excluded.auth_method,
         account_label            = excluded.account_label,
         access_token_encrypted   = excluded.access_token_encrypted,
         refresh_token_encrypted  = excluded.refresh_token_encrypted,
         access_token_expires_at  = excluded.access_token_expires_at,
         scopes                   = excluded.scopes,
         last_refreshed_at        = datetime('now'),
         last_error               = NULL`,
    )
    .run(
      connectorId,
      userId,
      input.authMethod,
      input.accountLabel,
      encryptField(input.accessToken),
      input.refreshToken ? encryptField(input.refreshToken) : null,
      input.accessTokenExpiresAt,
      input.scopes,
    )
  const saved = getForUser(connectorId, userId)
  if (!saved) throw new Error('user_dcr_connections upsert returned no row')
  return saved
}

/** Remove a user's connection to one connector. Returns true if a row was removed. */
export function deleteForUser(connectorId: string, userId: number): boolean {
  const result = getDb()
    .prepare('DELETE FROM user_dcr_connections WHERE connector_id = ? AND user_id = ?')
    .run(connectorId, userId)
  return result.changes > 0
}

/** Record a refresh/validation failure as connection health, never fatal. */
export function recordError(connectorId: string, userId: number, message: string): void {
  getDb()
    .prepare('UPDATE user_dcr_connections SET last_error = ? WHERE connector_id = ? AND user_id = ?')
    .run(message.slice(0, 300), connectorId, userId)
}

/**
 * SERVER-ONLY: decrypt and return the stored bearer credential (OAuth access
 * token or API key — callers do not need to care which) for a user, or null.
 * Must never feed an API response or a log line.
 */
export function getDecryptedAccessToken(connectorId: string, userId: number, actor: ConnectorActor): string | null {
  if (!checkConnectorCredential({ connectorId, ownerUserId: userId, actor }).allowed) return null
  const row = getDb()
    .prepare('SELECT access_token_encrypted FROM user_dcr_connections WHERE connector_id = ? AND user_id = ?')
    .get(connectorId, userId) as { access_token_encrypted: string } | undefined
  if (!row) return null
  return decryptField(row.access_token_encrypted)
}

/** SERVER-ONLY: decrypt and return the stored refresh token, or null (none, or api_key auth). */
export function getDecryptedRefreshToken(connectorId: string, userId: number, actor: ConnectorActor): string | null {
  if (!checkConnectorCredential({ connectorId, ownerUserId: userId, actor }).allowed) return null
  const row = getDb()
    .prepare('SELECT refresh_token_encrypted FROM user_dcr_connections WHERE connector_id = ? AND user_id = ?')
    .get(connectorId, userId) as { refresh_token_encrypted: string | null } | undefined
  if (!row?.refresh_token_encrypted) return null
  return decryptField(row.refresh_token_encrypted)
}
