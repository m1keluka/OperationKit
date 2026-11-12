import { describe, it, expect } from 'vitest'
import { authLabel, defaultWorkspace, errorHint, errorTitle, mcpOAuthReturnCopy, nameFromUrl, statusBadge } from './mcpServerCopy'

describe('MCP server copy (obj 900620)', () => {
  it('status badge reflects enabled + status', () => {
    expect(statusBadge({ status: 'connected', enabled: true })).toEqual({ tone: 'verify', label: 'Connected' })
    expect(statusBadge({ status: 'needs_auth', enabled: true }).label).toBe('Needs sign-in')
    expect(statusBadge({ status: 'connected', enabled: false }).label).toBe('Turned off')
  })

  it('auth label', () => {
    expect(authLabel({ auth_type: 'none', oauth_registration: null, auth_header_name: null })).toBe('No auth')
    expect(authLabel({ auth_type: 'api_key', oauth_registration: null, auth_header_name: 'X-Api-Key' })).toBe('API key (X-Api-Key)')
    expect(authLabel({ auth_type: 'oauth', oauth_registration: 'manual', auth_header_name: null })).toBe('OAuth (your app)')
  })

  it('every error kind has a title and a hint', () => {
    for (const k of ['unreachable', 'blocked', 'auth_required', 'auth_failed', 'protocol', 'server_error'] as const) {
      expect(errorTitle(k)).not.toBe('Connection failed')
      expect(errorHint(k).length).toBeGreaterThan(10)
    }
  })

  it('OAuth return copy', () => {
    expect(mcpOAuthReturnCopy(new URLSearchParams('mcp_oauth=connected'))).toEqual({ ok: true, text: 'MCP server signed in and connected.' })
    expect(mcpOAuthReturnCopy(new URLSearchParams('mcp_oauth=error&mcp_error=access_denied'))?.ok).toBe(false)
    expect(mcpOAuthReturnCopy(new URLSearchParams(''))).toBeNull()
  })

  it('default workspace prefers the board selection when it is real', () => {
    expect(defaultWorkspace('beta', ['all', 'alpha', 'beta'])).toBe('beta')
    expect(defaultWorkspace('all', ['all', 'alpha', 'beta'])).toBe('alpha')
    expect(defaultWorkspace('gone', ['alpha'])).toBe('alpha')
    expect(defaultWorkspace(null, [])).toBe('')
  })

  it('suggests a name from a URL', () => {
    expect(nameFromUrl('https://mcp.notion.com/mcp')).toBe('Notion')
    expect(nameFromUrl('nope')).toBe('')
  })
})
