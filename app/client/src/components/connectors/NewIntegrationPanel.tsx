/**
 * Settings → Integrations → New Integration (obj 900682).
 *
 * Three ways in:
 *   - Browse: integrations that come with a guided setup — the account catalog
 *     from Sprint 7 (#900499; each has a docs/connectors/guides/<id>.md
 *     walkthrough) and, for entries that publish a remote MCP URL, the
 *     workspace MCP route from Sprint 7.8 (#900620). Connecting reuses the
 *     existing ConnectorCard and ConnectMcpServerDialog unchanged.
 *   - Add an MCP (obj 900745): paste any remote MCP server URL — opens the
 *     same ConnectMcpServerDialog (#900620 / #900649) with no catalog entry, so
 *     the custom-URL path is a first-class choice instead of a footer link
 *     inside Browse. Admin-only, like the dialog itself.
 *   - Make my own: the Integrations bot (MakeMyOwnIntegration).
 */
import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, BookOpen, Bot, ChevronDown, ChevronUp, Link2, Plug } from 'lucide-react'
import type { ConnectorSummary, McpCatalogEntry, McpServerSummary } from '@operationkit/shared'
import { api } from '../../lib/api'
import { Badge, Button, Card, EmptyState, SearchInput, cn } from '../ui'
import { ConnectorCard, type ConnectorActions } from './ConnectorCard'
import { ConnectMcpServerDialog } from './ConnectMcpServerDialog'
import { MakeMyOwnIntegration } from './MakeMyOwnIntegration'
import { browseEntries, type BrowseEntry, type NewIntegrationStep } from './integrationsView'

type Option = { value: string; label: string }

function ChoiceCard({
  icon: Icon,
  title,
  text,
  onClick,
  testId,
  disabled,
}: {
  icon: typeof Bot
  title: string
  text: string
  onClick: () => void
  testId: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      disabled={disabled}
      className="group flex min-h-[44px] w-full items-start gap-3 rounded-lg border border-line bg-surface-2 p-4 text-left transition-colors duration-fast ease-out hover:border-line-strong hover:bg-surface-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:border-line disabled:hover:bg-surface-2 sm:p-5"
    >
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-line bg-surface-3 text-fg-1 group-hover:text-fg-0">
        <Icon className="h-5 w-5" strokeWidth={1.75} />
      </span>
      <span className="min-w-0">
        <span className="block font-display text-[15px] font-semibold text-fg-0">{title}</span>
        <span className="mt-1 block text-[12.5px] leading-relaxed text-fg-2">{text}</span>
      </span>
    </button>
  )
}

function BrowseRow({
  entry: e,
  isAdmin,
  expanded,
  onToggle,
  onMcp,
  actions,
  agents,
  workspaces,
}: {
  entry: BrowseEntry
  isAdmin: boolean
  expanded: boolean
  onToggle: () => void
  onMcp: (m: McpCatalogEntry) => void
  actions: ConnectorActions
  agents: Option[]
  workspaces: Option[]
}) {
  return (
    <li className="rounded-lg border border-line bg-surface-2" data-testid={`browse-${e.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-3 p-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-[14.5px] font-semibold text-fg-0">{e.name}</h4>
            {e.setup_guide && <Badge tone="info">Setup guide</Badge>}
            {e.mcp && <Badge tone="neutral">MCP server</Badge>}
            {e.connector && !e.available && <Badge tone="neutral">Not set up</Badge>}
          </div>
          <p className="mt-1 max-w-prose text-[12.5px] leading-relaxed text-fg-2">{e.description}</p>
          {e.setup_guide && (
            <p className="mt-1 text-[12px] text-fg-3">
              Guide: <code className="font-mono text-fg-2">{e.setup_guide}</code>
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {e.connector && (
            <Button
              size="sm"
              variant={expanded ? 'ghost' : 'primary'}
              onClick={onToggle}
              aria-expanded={expanded}
              leftIcon={expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            >
              {expanded ? 'Close' : 'Set up'}
            </Button>
          )}
          {e.mcp && isAdmin && (
            <Button size="sm" variant={e.connector ? 'secondary' : 'primary'} onClick={() => onMcp(e.mcp!)}>
              Add as workspace MCP server
            </Button>
          )}
        </div>
      </div>
      {expanded && e.connector && (
        <div className="border-t border-line-soft p-3 sm:p-4">
          <ConnectorCard connector={e.connector} actions={actions} agents={agents} workspaces={workspaces} isAdmin={isAdmin} />
        </div>
      )}
    </li>
  )
}

export function NewIntegrationPanel({
  step,
  onStep,
  onBack,
  connectors,
  actions,
  agents,
  workspaces,
  defaultWorkspace,
  isAdmin,
  onMcpConnected,
}: {
  step: NewIntegrationStep
  onStep: (s: NewIntegrationStep) => void
  onBack: () => void
  connectors: ConnectorSummary[] | null
  actions: ConnectorActions
  agents: Option[]
  workspaces: Option[]
  defaultWorkspace: string
  isAdmin: boolean
  onMcpConnected: (s: McpServerSummary) => void
}) {
  const [catalog, setCatalog] = useState<McpCatalogEntry[] | null>(null)
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [mcpDialog, setMcpDialog] = useState<{ catalog: McpCatalogEntry | null } | null>(null)
  const [mcpConnected, setMcpConnected] = useState(false)

  useEffect(() => {
    if (step !== 'browse' || catalog) return
    api.get<McpCatalogEntry[]>('/mcp-servers/catalog').then(c => setCatalog(Array.isArray(c) ? c : [])).catch(() => setCatalog([]))
  }, [step, catalog])

  const entries = useMemo(() => browseEntries(connectors ?? [], catalog ?? [], query), [connectors, catalog, query])
  const guided = (connectors ?? []).filter(c => c.status.state === 'not_connected').length

  return (
    <section aria-labelledby="new-integration-title" className="space-y-4" data-testid="new-integration">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={step === 'choose' ? onBack : () => onStep('choose')}
            leftIcon={<ArrowLeft className="h-3.5 w-3.5" />}
          >
            {step === 'choose' ? 'Connected integrations' : 'Back'}
          </Button>
          <h3 id="new-integration-title" className="font-display text-[15px] font-semibold text-fg-0">
            {step === 'browse' ? 'Browse integrations' : step === 'make' ? 'Make my own' : 'New integration'}
          </h3>
        </div>
      </div>

      {step === 'choose' && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <ChoiceCard
            icon={BookOpen}
            testId="choose-browse"
            title="Browse integrations"
            text={`Ready-made integrations with a step-by-step setup guide${guided ? ` — ${guided} available` : ''}, plus remote MCP servers from the catalog.`}
            onClick={() => onStep('browse')}
          />
          <ChoiceCard
            icon={Plug}
            testId="choose-mcp"
            title="Add an MCP"
            text={
              isAdmin
                ? 'Have an MCP server URL? Paste it and we detect how it signs in, test it, and make its tools available to your agents.'
                : 'Paste any remote MCP server URL. Only an admin can add one — ask an admin to add it.'
            }
            disabled={!isAdmin}
            onClick={() => setMcpDialog({ catalog: null })}
          />
          <ChoiceCard
            icon={Bot}
            testId="choose-make"
            title="Make my own"
            text="Not in the list? The Integrations bot asks what to connect, reads the API docs, builds it and asks for keys in a secure form."
            onClick={() => onStep('make')}
          />
        </div>
      )}

      {step === 'browse' && (
        <div className="space-y-3">
          <SearchInput
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search integrations"
            aria-label="Search integrations"
          />
          {connectors === null || catalog === null ? (
            <p className="text-[12.5px] text-fg-3">Loading integrations…</p>
          ) : entries.length === 0 ? (
            <EmptyState
              compact
              title={query ? `Nothing matches “${query}”` : 'Everything in the catalog is connected'}
              description="Make your own with the Integrations bot instead."
              action={<Button size="sm" variant="primary" onClick={() => onStep('make')}>Make my own</Button>}
            />
          ) : (
            <ul className="space-y-2" aria-label="Integrations with a guided setup">
              {entries.map(e => (
                <BrowseRow
                  key={e.id}
                  entry={e}
                  isAdmin={isAdmin}
                  expanded={expanded === e.id}
                  onToggle={() => setExpanded(x => (x === e.id ? null : e.id))}
                  onMcp={m => setMcpDialog({ catalog: m })}
                  actions={actions}
                  agents={agents}
                  workspaces={workspaces}
                />
              ))}
            </ul>
          )}
          <Card inset className={cn('flex flex-wrap items-center justify-between gap-3 p-4')}>
            <div className="flex min-w-0 items-start gap-2">
              <Link2 className="mt-0.5 h-4 w-4 shrink-0 text-fg-2" strokeWidth={1.75} />
              <div className="min-w-0">
                <div className="text-[13.5px] font-semibold text-fg-0">Any remote MCP server</div>
                <p className="text-[12.5px] text-fg-2">Paste its URL; we detect how it signs in.</p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {isAdmin && <Button size="sm" variant="secondary" onClick={() => setMcpDialog({ catalog: null })}>Paste a URL</Button>}
              <Button size="sm" variant="ghost" onClick={() => onStep('make')}>Make my own instead</Button>
            </div>
          </Card>
        </div>
      )}

      {step === 'make' && (
        <MakeMyOwnIntegration isAdmin={isAdmin} workspaces={workspaces} defaultWorkspace={defaultWorkspace} />
      )}

      {isAdmin && mcpDialog && (
        <ConnectMcpServerDialog
          open
          onClose={() => {
            setMcpDialog(null)
            // Back to the connected list once the dialog (and its test result) is dismissed.
            if (mcpConnected) onBack()
          }}
          workspaces={workspaces}
          defaultWorkspace={defaultWorkspace}
          onConnected={s => { setMcpConnected(true); onMcpConnected(s) }}
          initial={mcpDialog.catalog ? { url: mcpDialog.catalog.mcp_url, name: mcpDialog.catalog.name, catalogId: mcpDialog.catalog.id } : undefined}
        />
      )}
    </section>
  )
}
