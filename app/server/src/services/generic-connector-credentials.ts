/**
 * Generic store for `auth_path: 'api_key'` connectors (obj 900508, Sprint
 * 7.4 catalog preload). Backs every new api-key connector
 * (Cloudflare, Airtable, ClickUp, Calendly, Cal.com, DocuSeal, Supabase,
 * Notion/Linear's documented fallback, Stripe's agent key) through ONE table,
 * `connector_credentials` (db/schema/generic-connectors.ts) — the same
 * encrypt-at-rest posture as `user_github_tokens`, generalized to an
 * arbitrary field map instead of one hardcoded `token` column.
 *
 * Every read of the decrypted fields goes through `checkConnectorCredential`
 * (services/connector-guard.ts), exactly like the per-vendor stores — so a new
 * api-key connector is owner-scoped for free, without re-deriving that guard.
 */
import { getDb } from '../db/index.js'
import { checkConnectorCredential, type ConnectorActor } from './connector-guard.js'
import { encryptCredentialFields, decryptCredentialFields } from './crypto.js'

export interface GenericCredentialSummary {
  account_label: string | null
  last4: string | null
  connected_at: string
  checked_at: string | null
  last_error: string | null
}

interface Row {
  connector_id: string
  user_id: number
  fields_encrypted: string
  account_label: string | null
  last4: string | null
  connected_at: string
  checked_at: string | null
  last_error: string | null
}

function rowToSummary(row: Row): GenericCredentialSummary {
  return {
    account_label: row.account_label,
    last4: row.last4,
    connected_at: row.connected_at,
    checked_at: row.checked_at,
    last_error: row.last_error,
  }
}

/** Masked summary for a connector/user, or `null` if not connected. */
export function getForUser(connectorId: string, userId: number): GenericCredentialSummary | null {
  const row = getDb()
    .prepare('SELECT * FROM connector_credentials WHERE connector_id = ? AND user_id = ?')
    .get(connectorId, userId) as Row | undefined
  return row ? rowToSummary(row) : null
}

/** Last 4 characters of the "primary" field value, for masked display. */
export function last4(fields: Record<string, string>, primaryKey: string): string {
  const v = fields[primaryKey] ?? ''
  return v.length <= 4 ? v : v.slice(-4)
}

export interface UpsertInput {
  fields: Record<string, string>
  accountLabel: string | null
  last4: string | null
}

/** Encrypt + persist (replacing any existing row for this connector/user). */
export function upsert(connectorId: string, userId: number, input: UpsertInput): GenericCredentialSummary {
  getDb()
    .prepare(
      `INSERT INTO connector_credentials
         (connector_id, user_id, fields_encrypted, account_label, last4, checked_at, last_error)
       VALUES (?, ?, ?, ?, ?, datetime('now'), NULL)
       ON CONFLICT(connector_id, user_id) DO UPDATE SET
         fields_encrypted = excluded.fields_encrypted,
         account_label    = excluded.account_label,
         last4            = excluded.last4,
         checked_at       = excluded.checked_at,
         last_error       = NULL`,
    )
    .run(connectorId, userId, encryptCredentialFields(input.fields), input.accountLabel, input.last4)
  const saved = getForUser(connectorId, userId)
  if (!saved) throw new Error(`connector_credentials upsert returned no row for ${connectorId}`)
  return saved
}

/** Record a failed re-check without dropping the stored credential. */
export function recordError(connectorId: string, userId: number, error: string): void {
  getDb()
    .prepare(
      `UPDATE connector_credentials SET last_error = ?, checked_at = datetime('now')
       WHERE connector_id = ? AND user_id = ?`,
    )
    .run(error, connectorId, userId)
}

/** Delete the stored credential. Returns true if a row was removed. */
export function deleteForUser(connectorId: string, userId: number): boolean {
  const result = getDb()
    .prepare('DELETE FROM connector_credentials WHERE connector_id = ? AND user_id = ?')
    .run(connectorId, userId)
  return result.changes > 0
}

/**
 * SERVER-ONLY: decrypt and return the raw field map for a connector/user, or
 * `null` if none / not permitted. Never feed this into an API response or a
 * log line — it goes straight into a spawned session's env.
 */
export function getDecryptedForUser(
  connectorId: string,
  userId: number,
  actor: ConnectorActor,
): Record<string, string> | null {
  if (!checkConnectorCredential({ connectorId, ownerUserId: userId, actor }).allowed) return null
  const row = getDb()
    .prepare('SELECT fields_encrypted FROM connector_credentials WHERE connector_id = ? AND user_id = ?')
    .get(connectorId, userId) as { fields_encrypted: string } | undefined
  if (!row) return null
  return decryptCredentialFields(row.fields_encrypted)
}
