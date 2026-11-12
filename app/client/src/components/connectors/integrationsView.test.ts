import { describe, it, expect } from 'vitest'
import type { ConnectorSummary, McpCatalogEntry } from '@operationkit/shared'
import { browseEntries, connectedConnectors, isConnectedConnector, newIntegrationStep } from './integrationsView'

function c(id: string, state: 'connected' | 'not_connected' | 'error', over: Partial<ConnectorSummary> = {}): ConnectorSummary {
  return {
    id, name: id.toUpperCase(), description: `${id} things`, products: [], connect: { kind: 'oauth', button_label: 'Sign in' },
    available: true, unavailable_reason: null, can_check: false,
    status: { state, account: null, details: [], connected_at: null, checked_at: null, error: null },
    access: { agents: null, workspaces: null }, auth_path: 'api_key', oauth_setup: null, setup_guide: null, ...over,
  }
}
const mcp = (id: string): McpCatalogEntry => ({ id, name: id.toUpperCase(), description: `${id} mcp`, mcp_url: `https://${id}.test/mcp` })

describe('integrations view rules (obj 900682)', () => {
  it('connected = anything but not_connected (a broken connection stays visible to be fixed)', () => {
    expect(isConnectedConnector(c('a', 'connected'))).toBe(true)
    expect(isConnectedConnector(c('a', 'error'))).toBe(true)
    expect(isConnectedConnector(c('a', 'not_connected'))).toBe(false)
    expect(connectedConnectors([c('a', 'connected'), c('b', 'not_connected'), c('e', 'error')]).map(x => x.id)).toEqual(['a', 'e'])
  })

  it('Browse = not-connected catalog, guides first, MCP entries merged by id', () => {
    const list = [
      c('github', 'connected'),
      c('slack', 'not_connected', { setup_guide: 'docs/connectors/guides/slack.md' }),
      c('linear', 'not_connected', { setup_guide: 'docs/connectors/guides/linear.md' }),
      c('zeta', 'not_connected'),
    ]
    const out = browseEntries(list, [mcp('linear'), mcp('github')])
    expect(out.map(e => e.id)).toEqual(['linear', 'slack', 'github', 'zeta'])
    expect(out.find(e => e.id === 'linear')).toMatchObject({ connector: { id: 'linear' }, mcp: { id: 'linear' } })
    // A connected account is not offered again, but its workspace MCP server still is.
    expect(out.find(e => e.id === 'github')).toMatchObject({ connector: null, mcp: { id: 'github' } })
  })

  it('search matches name, id and description', () => {
    const list = [c('slack', 'not_connected'), c('stripe', 'not_connected', { description: 'payments and invoices' })]
    expect(browseEntries(list, [], 'invoice').map(e => e.id)).toEqual(['stripe'])
    expect(browseEntries(list, [], 'SLA').map(e => e.id)).toEqual(['slack'])
  })

  it('?new= deep link', () => {
    expect(newIntegrationStep('')).toBeNull()
    expect(newIntegrationStep('?new=1')).toBe('choose')
    expect(newIntegrationStep('?new=browse')).toBe('browse')
    expect(newIntegrationStep('?x=1&new=make')).toBe('make')
  })
})
