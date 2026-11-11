/**
 * Generic backing stores for the Sprint 7.4 catalog preload (obj 900508).
 *
 * The catalog adds ~18 new connectors (Slack, Microsoft 365, Cloudflare,
 * Airtable, ...). Hand-writing a bespoke per-vendor table/service for each one
 * — the pattern `user_github_tokens` / `user_google_connections` used — would
 * mean 18 near-identical tables. Instead, every `auth_path: 'api_key'`
 * connector shares ONE table (`connector_credentials`) and every
 * `auth_path: 'oauth_guided'` connector shares ONE table
 * (`connector_oauth_grants`), both keyed by `(connector_id, user_id)`. A
 * connector that later needs bespoke columns can still graduate to its own
 * table — nothing here forecloses that.
 *
 * Same crypto posture as the existing per-vendor tables: values are
 * AES-256-GCM via `services/crypto.ts` and never leave this layer in the
 * clear; only masked summaries reach a route response.
 */
import type Database from 'better-sqlite3'

export function initGenericConnectorsSchema(db: Database.Database): void {
  db.exec(`
    -- Generic 'api_key' connector credential store (obj 900508). One row per
    -- (connector, user): the pasted field values (e.g. { api_key: '...' }),
    -- encrypted as a JSON blob via crypto.encryptCredentialFields. account_label
    -- and last4 are resolved at connect time (e.g. a workspace name returned by
    -- the vendor's own "who am I" endpoint) purely for display — never a secret.
    CREATE TABLE IF NOT EXISTS connector_credentials (
      connector_id     TEXT    NOT NULL,
      user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      fields_encrypted TEXT    NOT NULL,
      account_label    TEXT,
      last4            TEXT,
      connected_at     TEXT    NOT NULL DEFAULT (datetime('now')),
      checked_at       TEXT,
      last_error       TEXT,
      PRIMARY KEY (connector_id, user_id)
    );

    -- Generic 'oauth_guided' connector grant store (obj 900508). Mirrors
    -- user_google_connections, minus the Google-specific columns: one row per
    -- (connector, user), refresh/access tokens encrypted, never returned raw.
    CREATE TABLE IF NOT EXISTS connector_oauth_grants (
      connector_id            TEXT    NOT NULL,
      user_id                 INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      account_label           TEXT,
      refresh_token_encrypted TEXT,
      access_token_encrypted  TEXT,
      access_token_expires_at TEXT,
      scopes                  TEXT    NOT NULL DEFAULT '',
      connected_at            TEXT    NOT NULL DEFAULT (datetime('now')),
      last_refreshed_at       TEXT,
      last_error              TEXT,
      PRIMARY KEY (connector_id, user_id)
    );
  `)
}
