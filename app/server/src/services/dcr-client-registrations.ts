/**
 * Per-install DCR/CIMD client registrations (Sprint 7.3, obj 900507).
 *
 * `auth_path: 'dcr_mcp'` connectors (Notion, Linear) register THIS INSTALL as
 * an OAuth client against the provider's own authorization server — once, not
 * once per Command Center user. This table is that one row: it is deliberately
 * keyed by `connector_id` alone, not `(connector_id, user_id)`, mirroring how a
 * guided-OAuth connector reuses one `GOOGLE_OAUTH_CLIENT_ID` for every user.
 *
 * For a CIMD registration there is no secret: `client_id` is the install's own
 * https metadata-document URL and the client is public (PKCE-only). For a DCR
 * registration the provider may issue a confidential client_secret, encrypted
 * at rest the same way every other connector secret is (services/crypto.ts,
 * AES-256-GCM) — never returned raw outside `getDecryptedClientSecret`.
 */
import { getDb } from '../db/index.js'
import { encryptField, decryptField } from './crypto.js'

export type DcrRegistrationMethod = 'cimd' | 'dcr'

interface RegistrationRow {
  connector_id: string
  issuer: string
  registration_method: DcrRegistrationMethod
  client_id: string
  client_secret_encrypted: string | null
  redirect_uri: string
  registered_at: string
}

export interface DcrClientRegistrationSummary {
  connector_id: string
  issuer: string
  registration_method: DcrRegistrationMethod
  client_id: string
  redirect_uri: string
  registered_at: string
  /** True when a client_secret is on file (DCR only — CIMD clients are public). */
  has_client_secret: boolean
}

function toSummary(row: RegistrationRow): DcrClientRegistrationSummary {
  return {
    connector_id: row.connector_id,
    issuer: row.issuer,
    registration_method: row.registration_method,
    client_id: row.client_id,
    redirect_uri: row.redirect_uri,
    registered_at: row.registered_at,
    has_client_secret: row.client_secret_encrypted != null,
  }
}

/** The masked registration for a connector, or null if never registered. */
export function getRegistration(connectorId: string): DcrClientRegistrationSummary | null {
  const row = getDb()
    .prepare('SELECT * FROM dcr_client_registrations WHERE connector_id = ?')
    .get(connectorId) as RegistrationRow | undefined
  return row ? toSummary(row) : null
}

export interface SaveRegistrationInput {
  issuer: string
  method: DcrRegistrationMethod
  clientId: string
  clientSecret?: string | null
  redirectUri: string
}

/** Persist (or replace) this install's registration for one connector. */
export function saveRegistration(connectorId: string, input: SaveRegistrationInput): DcrClientRegistrationSummary {
  getDb()
    .prepare(
      `INSERT INTO dcr_client_registrations
         (connector_id, issuer, registration_method, client_id, client_secret_encrypted, redirect_uri, registered_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(connector_id) DO UPDATE SET
         issuer                  = excluded.issuer,
         registration_method     = excluded.registration_method,
         client_id               = excluded.client_id,
         client_secret_encrypted = excluded.client_secret_encrypted,
         redirect_uri            = excluded.redirect_uri,
         registered_at           = datetime('now')`,
    )
    .run(
      connectorId,
      input.issuer,
      input.method,
      input.clientId,
      input.clientSecret ? encryptField(input.clientSecret) : null,
      input.redirectUri,
    )
  const saved = getRegistration(connectorId)
  if (!saved) throw new Error('dcr_client_registrations upsert returned no row')
  return saved
}

/** Drop a stale registration (e.g. the provider revoked it). */
export function deleteRegistration(connectorId: string): boolean {
  const result = getDb().prepare('DELETE FROM dcr_client_registrations WHERE connector_id = ?').run(connectorId)
  return result.changes > 0
}

/**
 * SERVER-ONLY: decrypt and return the client_secret for a connector's
 * registration, or null if there is none (CIMD, or never registered). This is
 * an install-level credential, not a per-user one — there is no connector-guard
 * owner check here, same as reading GOOGLE_OAUTH_CLIENT_SECRET from env. It
 * must never feed an API response or a log line.
 */
export function getDecryptedClientSecret(connectorId: string): string | null {
  const row = getDb()
    .prepare('SELECT client_secret_encrypted FROM dcr_client_registrations WHERE connector_id = ?')
    .get(connectorId) as { client_secret_encrypted: string | null } | undefined
  if (!row?.client_secret_encrypted) return null
  return decryptField(row.client_secret_encrypted)
}
