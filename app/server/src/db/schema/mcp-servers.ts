/**
 * Workspace MCP servers (Sprint 7.8, obj 900620). Additive only.
 *
 * One row per remote MCP server connected from Settings → Integrations. A row
 * belongs to exactly ONE workspace: only sessions and chat bots running in that
 * workspace ever see it. No credential lives in this table — access tokens,
 * refresh tokens, API keys and DCR client secrets are in the native secrets
 * store (`secrets`, workspace scope, keys `CC_MCP_SERVER_<id>_*`), encrypted
 * and server-only. `tools_json` caches the last successful tools/list (name,
 * description, input schema) and `disabled_tools_json` is the per-tool
 * opt-out list.
 */
import type Database from 'better-sqlite3'

export function initMcpServersSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_mcp_servers (
      id                           INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace                    TEXT    NOT NULL,
      slug                         TEXT    NOT NULL,
      name                         TEXT    NOT NULL,
      url                          TEXT    NOT NULL,
      transport                    TEXT    NOT NULL DEFAULT 'auto'
                                     CHECK (transport IN ('auto', 'streamable_http', 'sse')),
      auth_type                    TEXT    NOT NULL DEFAULT 'none'
                                     CHECK (auth_type IN ('none', 'api_key', 'oauth')),
      auth_header_name             TEXT,
      catalog_id                   TEXT,
      oauth_registration           TEXT
                                     CHECK (oauth_registration IS NULL OR oauth_registration IN ('cimd', 'dcr', 'manual')),
      oauth_issuer                 TEXT,
      oauth_authorization_endpoint TEXT,
      oauth_token_endpoint         TEXT,
      oauth_client_id              TEXT,
      oauth_scope                  TEXT,
      oauth_resource               TEXT,
      token_expires_at             TEXT,
      status                       TEXT    NOT NULL DEFAULT 'pending'
                                     CHECK (status IN ('pending', 'needs_auth', 'connected', 'error')),
      server_name                  TEXT,
      server_version               TEXT,
      protocol_version             TEXT,
      detected_transport           TEXT,
      tools_json                   TEXT    NOT NULL DEFAULT '[]',
      disabled_tools_json          TEXT    NOT NULL DEFAULT '[]',
      enabled                      INTEGER NOT NULL DEFAULT 1,
      last_tested_at               TEXT,
      last_error                   TEXT,
      created_by                   INTEGER,
      created_at                   TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at                   TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE (workspace, slug)
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_mcp_servers_ws ON workspace_mcp_servers(workspace);
  `)
}
