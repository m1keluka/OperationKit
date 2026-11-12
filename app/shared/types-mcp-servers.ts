/**
 * Workspace MCP servers (Sprint 7.8, obj 900620) — API contract shared by
 * server and client. Nothing here ever carries a credential: the client sees
 * whether one is stored (`has_credential`), never its value.
 */

export type McpServerAuthType = 'none' | 'api_key' | 'oauth'
export type McpServerTransport = 'auto' | 'streamable_http' | 'sse'
export type McpServerStatus = 'pending' | 'needs_auth' | 'connected' | 'error'
export type McpOAuthRegistration = 'cimd' | 'dcr' | 'manual'
export type McpErrorKind = 'unreachable' | 'blocked' | 'auth_required' | 'auth_failed' | 'protocol' | 'server_error'

export interface McpServerTool {
  name: string
  description: string
  enabled: boolean
}

export interface McpServerSummary {
  id: number
  workspace: string
  /** Key used in session configs: tools appear as `mcp__<slug>__<tool>`. */
  slug: string
  name: string
  url: string
  transport: McpServerTransport
  detected_transport: 'streamable_http' | 'sse' | null
  auth_type: McpServerAuthType
  /** Header the API key is sent in (api_key only). */
  auth_header_name: string | null
  oauth_registration: McpOAuthRegistration | null
  oauth_issuer: string | null
  oauth_client_id: string | null
  /** A token / key is stored (the value itself is never returned). */
  has_credential: boolean
  has_refresh_token: boolean
  token_expires_at: string | null
  catalog_id: string | null
  status: McpServerStatus
  enabled: boolean
  server_name: string | null
  server_version: string | null
  protocol_version: string | null
  tools: McpServerTool[]
  last_tested_at: string | null
  last_error: string | null
  created_at: string
  updated_at: string
}

/** POST /api/mcp-servers/detect — what the server at a URL wants. */
export type McpDetectResponse =
  | {
      ok: true
      auth: 'none'
      server_name: string | null
      server_version: string | null
      tool_count: number
    }
  | {
      ok: true
      auth: 'oauth'
      registration: McpOAuthRegistration
      issuer: string
      scopes_supported: string[]
      /** Pre-filled callback for the guided (manual registration) path. */
      redirect_uri: string
    }
  | { ok: true; auth: 'api_key'; reason: string }
  | { ok: false; kind: McpErrorKind; error: string }

export interface McpServerCreateRequest {
  workspace: string
  name: string
  url: string
  transport?: McpServerTransport
  auth_type: McpServerAuthType
  /** api_key: header name (default `Authorization`, value sent as `Bearer <key>`). */
  auth_header_name?: string
  /** api_key: the key. Write-only. */
  api_key?: string
  /** oauth + manual registration: the client the admin registered at the provider. */
  oauth_client_id?: string
  /** Write-only. */
  oauth_client_secret?: string
  oauth_scope?: string
  catalog_id?: string
}

export interface McpServerTestResult {
  ok: boolean
  kind?: McpErrorKind
  error?: string
  server: McpServerSummary
}

/** POST /api/mcp-servers/:id/oauth/start — where to send the browser. */
export interface McpOAuthStartResponse {
  redirect_url: string
}

/** A catalog connector that publishes a remote MCP endpoint. */
export interface McpCatalogEntry {
  id: string
  name: string
  description: string
  mcp_url: string
}
