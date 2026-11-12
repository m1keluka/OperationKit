/**
 * Settings → Integrations view rules (obj 900682). Pure, so the "only connected
 * on the main view" rule and the Browse list are tested without a DOM.
 *
 * - Main view: only what is connected — accounts whose state is not
 *   `not_connected` (an `error` account is connected-but-broken and stays, so its
 *   owner can fix or disconnect it), every MCP server added to the workspace
 *   (#900620; a row only exists once someone connected it), and Tools an
 *   Integrations bot built.
 * - New Integration → Browse: everything NOT yet connected that has a guided
 *   setup — the account catalog (#900499) — plus, for a catalog entry that
 *   publishes a remote MCP URL, a "workspace MCP server" route into the
 *   existing 900620 dialog.
 */
import type { ConnectorSummary, McpCatalogEntry } from '@operationkit/shared'

export function isConnectedConnector(c: Pick<ConnectorSummary, 'status'>): boolean {
  return c.status.state !== 'not_connected'
}

export function connectedConnectors(list: ConnectorSummary[]): ConnectorSummary[] {
  return list.filter(isConnectedConnector)
}

export interface BrowseEntry {
  id: string
  name: string
  description: string
  /** Personal account connect flow (ConnectorCard). null when the account is already connected. */
  connector: ConnectorSummary | null
  /** Workspace MCP route (#900620 dialog). */
  mcp: McpCatalogEntry | null
  /** Has a written walkthrough (docs/connectors/guides/<id>.md). */
  setup_guide: string | null
  /** The server is ready for it (else the card explains what an admin must set up). */
  available: boolean
}

function matches(e: { name: string; description: string; id: string }, q: string): boolean {
  if (!q) return true
  const hay = `${e.name} ${e.id} ${e.description}`.toLowerCase()
  return q.toLowerCase().split(/\s+/).filter(Boolean).every(t => hay.includes(t))
}

/**
 * Everything you can set up from a guide, minus what is already connected.
 * An MCP catalog entry is offered even when its account twin is connected —
 * a workspace MCP server is a different (shared) connection.
 */
export function browseEntries(connectors: ConnectorSummary[], catalog: McpCatalogEntry[], query = ''): BrowseEntry[] {
  const byId = new Map<string, BrowseEntry>()
  for (const c of connectors) {
    if (isConnectedConnector(c)) continue
    byId.set(c.id, {
      id: c.id, name: c.name, description: c.description, connector: c, mcp: null,
      setup_guide: c.setup_guide, available: c.available,
    })
  }
  for (const m of catalog) {
    const existing = byId.get(m.id)
    if (existing) {
      existing.mcp = m
      continue
    }
    const twin = connectors.find(c => c.id === m.id)
    byId.set(m.id, {
      id: m.id, name: m.name, description: m.description, connector: null, mcp: m,
      setup_guide: twin?.setup_guide ?? null, available: true,
    })
  }
  return [...byId.values()]
    .filter(e => matches(e, query.trim()))
    .sort((a, b) => Number(!!b.setup_guide) - Number(!!a.setup_guide) || a.name.localeCompare(b.name))
}

/** `?new=` deep link: `1`/`choose` → the two choices, `browse`, `make`. */
export type NewIntegrationStep = 'choose' | 'browse' | 'make'

export function newIntegrationStep(search: string): NewIntegrationStep | null {
  const v = new URLSearchParams(search).get('new')
  if (v === null) return null
  return v === 'browse' || v === 'make' ? v : 'choose'
}
