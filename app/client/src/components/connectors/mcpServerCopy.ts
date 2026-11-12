/**
 * Plain-language copy for Settings → Integrations → MCP servers (obj 900620).
 * Pure functions so the wording is unit-tested without rendering.
 */
import type { McpErrorKind, McpServerStatus, McpServerSummary } from '@operationkit/shared'

export type BadgeTone = 'neutral' | 'accent' | 'verify' | 'amber' | 'alarm' | 'info'

export function statusBadge(s: Pick<McpServerSummary, 'status' | 'enabled'> & Partial<Pick<McpServerSummary, 'auth_type'>>): { tone: BadgeTone; label: string } {
  if (!s.enabled) return { tone: 'neutral', label: 'Turned off' }
  if (s.status === 'needs_auth' && s.auth_type === 'api_key') return { tone: 'amber', label: 'Key rejected' }
  const map: Record<McpServerStatus, { tone: BadgeTone; label: string }> = {
    connected: { tone: 'verify', label: 'Connected' },
    needs_auth: { tone: 'amber', label: 'Needs sign-in' },
    error: { tone: 'alarm', label: 'Error' },
    pending: { tone: 'neutral', label: 'Not tested' },
  }
  return map[s.status]
}

export function authLabel(s: Pick<McpServerSummary, 'auth_type' | 'oauth_registration' | 'auth_header_name'>): string {
  if (s.auth_type === 'none') return 'No auth'
  if (s.auth_type === 'api_key') return s.auth_header_name && s.auth_header_name.toLowerCase() !== 'authorization' ? `API key (${s.auth_header_name})` : 'API key'
  if (s.oauth_registration === 'manual') return 'OAuth (your app)'
  return 'OAuth'
}

const KIND_TITLE: Record<McpErrorKind, string> = {
  unreachable: 'Server unreachable',
  blocked: 'Address not allowed',
  auth_required: 'Sign-in required',
  auth_failed: 'Authentication failed',
  protocol: 'Not a compatible MCP server',
  server_error: 'The server had an error',
}

export function errorTitle(kind: McpErrorKind | undefined): string {
  return kind ? KIND_TITLE[kind] : 'Connection failed'
}

/** One-line hint on what to do next, by failure kind. */
export function errorHint(kind: McpErrorKind | undefined): string {
  switch (kind) {
    case 'unreachable': return 'Check the URL and that the server is online and reachable from this server.'
    case 'blocked': return 'Only public https addresses can be connected. Private, local and cloud-metadata addresses are refused.'
    case 'auth_required': return 'This server needs credentials. Sign in, or add an API key.'
    case 'auth_failed': return 'The key or sign-in was rejected. Paste a new key or sign in again.'
    case 'protocol': return 'The URL answered, but not as an MCP server this app can talk to. Check you pasted the MCP endpoint (often ending in /mcp or /sse).'
    case 'server_error': return 'Try again in a minute. If it keeps failing, check the provider’s status page.'
    default: return ''
  }
}

/** The one-line summary under a server's URL. */
export function serverInfoLine(s: Pick<McpServerSummary, 'server_name' | 'server_version' | 'tools' | 'last_tested_at'>): string {
  if (!s.server_name) return s.last_tested_at ? 'Last test failed' : 'Not tested yet'
  const on = s.tools.filter(t => t.enabled).length
  return `${s.server_name}${s.server_version ? ` ${s.server_version}` : ''} · ${on} of ${s.tools.length} ${s.tools.length === 1 ? 'tool' : 'tools'} on`
}

/** Copy for the ?mcp_oauth=… outcome the sign-in round-trip lands with. */
export function mcpOAuthReturnCopy(params: URLSearchParams): { ok: boolean; text: string } | null {
  const status = params.get('mcp_oauth')
  if (!status) return null
  if (status === 'connected') return { ok: true, text: 'MCP server signed in and connected.' }
  const err = params.get('mcp_error') || ''
  if (err === 'access_denied') return { ok: false, text: 'You declined the permission request.' }
  if (err === 'invalid_state') return { ok: false, text: 'The sign-in request expired. Please try again.' }
  if (err === 'server_removed') return { ok: false, text: 'That MCP server was removed before sign-in finished.' }
  return { ok: false, text: 'Signing in to the MCP server failed. Please try again.' }
}

/** Which workspace the section opens on: the board's single selected one, else the first. */
export function defaultWorkspace(stored: string | null, slugs: string[]): string {
  const real = slugs.filter(s => s !== 'all')
  if (stored && stored !== 'all' && real.includes(stored)) return stored
  return real[0] ?? ''
}

/** Suggest a display name from a URL: `https://mcp.notion.com/mcp` → `Notion`. */
export function nameFromUrl(raw: string): string {
  try {
    const host = new URL(raw).hostname.replace(/^(www|mcp|api)\./, '')
    const first = host.split('.')[0] ?? ''
    return first ? first.charAt(0).toUpperCase() + first.slice(1) : ''
  } catch {
    return ''
  }
}
