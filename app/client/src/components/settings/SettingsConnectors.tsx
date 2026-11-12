/**
 * Settings → Integrations (obj 720115, renamed sprint 4b / obj 900496). Outside
 * accounts — GitHub, Google Workspace, and whatever is added to the server's
 * connectors/defs folder — each with connect/disconnect, status, and who may
 * use it.
 *
 * obj 900682: the main view lists ONLY what is connected (accounts, the
 * workspace's MCP servers from #900620, Tools an Integrations bot built).
 * "New Integration" opens Browse (the #900499 catalog with setup guides + MCP
 * catalog) or Make my own (the Integrations bot). Deep link: `?new=browse|make`.
 *
 * Every integration here is the signed-in person's own. The server keeps the
 * credential encrypted and only ever sends back a description of it.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Plus } from 'lucide-react'
import type {
  ConnectorAccess,
  ConnectorConnectResponse,
  ConnectorStatus,
  ConnectorSummary,
  IntegrationBuildSummary,
  McpServerSummary,
} from '@operationkit/shared'
import { api, ApiError } from '../../lib/api'
import { useAuth } from '../../context/AuthContext'
import { useAgents } from '../../hooks/useAgents'
import { useWorkspaces } from '../../hooks/useWorkspaces'
import { Alert, Button, EmptyState, Skeleton, useConfirm } from '../ui'
import { ConnectorCard, type ConnectorActions } from '../connectors/ConnectorCard'
import { McpServersSection } from '../connectors/McpServersSection'
import { defaultWorkspace } from '../connectors/mcpServerCopy'
import { NewIntegrationPanel } from '../connectors/NewIntegrationPanel'
import { BuiltIntegrationsSection } from '../connectors/BuiltIntegrationsSection'
import { connectedConnectors, newIntegrationStep, type NewIntegrationStep } from '../connectors/integrationsView'

function errText(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return (err.body as { error?: string } | null)?.error || err.message || fallback
  return err instanceof Error ? err.message : fallback
}

/** Copy for the ?google=… outcome the sign-in round-trip lands with. */
export function signInReturnCopy(params: URLSearchParams): { ok: boolean; text: string } | null {
  const status = params.get('google')
  if (!status) return null
  if (status === 'connected') return { ok: true, text: 'Google Workspace connected.' }
  switch (params.get('google_error') || '') {
    case 'access_denied': return { ok: false, text: 'You declined the permission request at Google.' }
    case 'invalid_state': return { ok: false, text: 'The sign-in request expired. Please try again.' }
    case 'missing_code': return { ok: false, text: 'Google did not finish the sign-in. Please try again.' }
    case 'not_configured': return { ok: false, text: 'Google sign-in is not set up on this server yet.' }
    default: return { ok: false, text: 'Connecting your Google account failed. Please try again.' }
  }
}

function CardSkeleton() {
  return (
    <div className="rounded-lg border border-line bg-surface-2 p-5" aria-hidden="true">
      <Skeleton className="h-4 w-32" />
      <Skeleton className="mt-3 h-3 w-3/4" />
      <div className="mt-4 flex gap-1.5">
        <Skeleton className="h-5 w-14" />
        <Skeleton className="h-5 w-16" />
      </div>
      <Skeleton className="mt-6 h-9 w-40" />
    </div>
  )
}

export function SettingsConnectors() {
  const [connectors, setConnectors] = useState<ConnectorSummary[] | null>(null)
  const [loadError, setLoadError] = useState('')
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const { confirm, confirmDialog } = useConfirm()
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const { agents } = useAgents()
  const { slugs: wsSlugs, labelOf } = useWorkspaces()

  const agentOptions = useMemo(
    () => agents.filter(a => !a.archived).map(a => ({ value: a.slug, label: a.label || a.slug })),
    [agents],
  )
  // null = the connected list; otherwise which New Integration step is open.
  const [newStep, setNewStepState] = useState<NewIntegrationStep | null>(() => newIntegrationStep(window.location.search))
  const [mcpServers, setMcpServers] = useState<McpServerSummary[] | null>(null)
  const [builtTools, setBuiltTools] = useState<IntegrationBuildSummary[]>([])
  const [mcpWorkspace, setMcpWorkspace] = useState('')

  /** Keep `?new=` in the URL so a refresh (or a shared link) lands on the same step. */
  const setNewStep = useCallback((step: NewIntegrationStep | null) => {
    setNewStepState(step)
    const params = new URLSearchParams(window.location.search)
    if (step) params.set('new', step === 'choose' ? '1' : step)
    else params.delete('new')
    const qs = params.toString()
    window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : ''))
  }, [])

  const workspaceOptions = useMemo(
    () => wsSlugs.filter(s => s !== 'all').map(s => ({ value: s, label: labelOf(s) })),
    // labelOf is rebuilt every render; the slug list is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [wsSlugs.join('|')],
  )

  const load = useCallback(async () => {
    try {
      setConnectors(await api.get<ConnectorSummary[]>('/connectors'))
      setLoadError('')
    } catch (err) {
      setLoadError(errText(err, 'Could not load integrations.'))
      setConnectors(prev => prev ?? [])
    }
  }, [])

  useEffect(() => { void load() }, [load])

  // Show the sign-in outcome once, then drop the params so a refresh doesn't replay it.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const copy = signInReturnCopy(params)
    if (!copy) return
    setNotice(copy)
    params.delete('google')
    params.delete('google_error')
    const qs = params.toString()
    window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : ''))
  }, [])

  const patch = (id: string, change: Partial<ConnectorSummary>) =>
    setConnectors(list => (list ?? []).map(c => (c.id === id ? { ...c, ...change } : c)))

  const actions: ConnectorActions = {
    async connect(id, fields) {
      setNotice(null)
      try {
        const res = await api.post<ConnectorConnectResponse>(`/connectors/${id}/connect`, { fields: fields ?? {} })
        if ('redirect_url' in res) {
          window.location.assign(res.redirect_url)
          return true
        }
        patch(id, { status: res.status })
        setNotice({ ok: true, text: `Connected as ${res.status.account ?? 'your account'}.` })
        // Connected from New Integration → Browse: show it where it now lives.
        if (newStep) setNewStep(null)
        return true
      } catch (err) {
        setNotice({ ok: false, text: errText(err, 'Connecting failed.') })
        return false
      }
    },
    async check(id) {
      setNotice(null)
      try {
        const res = await api.post<{ status: ConnectorStatus }>(`/connectors/${id}/check`)
        patch(id, { status: res.status })
        setNotice({ ok: true, text: 'Connection works.' })
      } catch (err) {
        setNotice({ ok: false, text: errText(err, 'Checking failed.') })
      }
    },
    async disconnect(c) {
      const ok = await confirm({
        title: `Disconnect ${c.name}?`,
        message: `Agents will stop using your ${c.name} account. Your access settings are kept in case you connect again.`,
        confirmLabel: 'Disconnect',
        danger: true,
      })
      if (!ok) return
      setNotice(null)
      try {
        const res = await api.del<{ status: ConnectorStatus }>(`/connectors/${c.id}`)
        patch(c.id, { status: res.status })
        setNotice({ ok: true, text: `${c.name} disconnected.` })
      } catch (err) {
        setNotice({ ok: false, text: errText(err, 'Disconnecting failed.') })
      }
    },
    async saveAccess(id, access: ConnectorAccess) {
      setNotice(null)
      try {
        const res = await api.put<{ access: ConnectorAccess }>(`/connectors/${id}/access`, access)
        patch(id, { access: res.access })
        setNotice({ ok: true, text: 'Access saved.' })
      } catch (err) {
        setNotice({ ok: false, text: errText(err, 'Saving access failed.') })
      }
    },
    // Optional, opt-in shared third-party OAuth app (Sprint 7.7). Reload after a
    // change so availability ("Not set up" ↔ Connect) reflects the new setting.
    async saveSharedApp(id, input) {
      setNotice(null)
      try {
        await api.put(`/connectors/${id}/shared-app`, input)
        await load()
        setNotice({ ok: true, text: input.enabled ? 'Shared third-party app turned on.' : 'Shared third-party app saved (off).' })
        return true
      } catch (err) {
        setNotice({ ok: false, text: errText(err, 'Saving the shared app failed.') })
        return false
      }
    },
    async removeSharedApp(id) {
      setNotice(null)
      try {
        await api.del(`/connectors/${id}/shared-app`)
        await load()
        setNotice({ ok: true, text: 'Shared third-party app removed.' })
        return true
      } catch (err) {
        setNotice({ ok: false, text: errText(err, 'Removing the shared app failed.') })
        return false
      }
    },
  }

  const wsDefault = mcpWorkspace || defaultWorkspace(localStorage.getItem('cc-workspace'), workspaceOptions.map(w => w.value))
  const connected = connectedConnectors(connectors ?? [])
  const nothingConnected =
    connectors !== null && connected.length === 0 && builtTools.length === 0 &&
    (mcpServers === null ? workspaceOptions.length === 0 : mcpServers.length === 0)

  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="min-w-0 flex-1 text-[13px] leading-relaxed text-fg-2">
          Accounts and services agents can work in for you. Keys and sign-ins are stored encrypted on this server and
          are never shown again — not here, and not to agents.
        </p>
        {!newStep && (
          <Button variant="primary" size="sm" onClick={() => setNewStep('choose')} leftIcon={<Plus className="h-3.5 w-3.5" />}>
            New Integration
          </Button>
        )}
      </div>

      {notice && (
        <div aria-live="polite">
          <Alert tone={notice.ok ? 'verify' : 'alarm'}>{notice.text}</Alert>
        </div>
      )}
      {loadError && <Alert tone="alarm" title="Could not load integrations">{loadError}</Alert>}

      {newStep ? (
        <NewIntegrationPanel
          step={newStep}
          onStep={setNewStep}
          onBack={() => setNewStep(null)}
          connectors={connectors}
          actions={actions}
          agents={agentOptions}
          workspaces={workspaceOptions}
          defaultWorkspace={wsDefault}
          isAdmin={isAdmin}
          onMcpConnected={s => {
            setMcpWorkspace(s.workspace)
            setNotice({ ok: true, text: `${s.name} added to ${labelOf(s.workspace)}.` })
          }}
        />
      ) : (
        <>
          {nothingConnected && (
            <EmptyState
              title="No integrations connected yet"
              description="Connect an account from a setup guide, add an MCP server, or have the Integrations bot build one for you."
              action={<Button variant="primary" size="sm" onClick={() => setNewStep('choose')}>New Integration</Button>}
            />
          )}

          {connectors === null ? (
            <div className="space-y-4">
              <CardSkeleton />
            </div>
          ) : connected.length > 0 && (
            <section aria-labelledby="accounts-title" className="space-y-3">
              <h3 id="accounts-title" className="pt-2 font-display text-[15px] font-semibold text-fg-0">Accounts</h3>
              {connected.map(c => (
                <ConnectorCard
                  key={c.id}
                  connector={c}
                  actions={actions}
                  agents={agentOptions}
                  workspaces={workspaceOptions}
                  isAdmin={isAdmin}
                />
              ))}
            </section>
          )}

          {workspaceOptions.length > 0 && (
            <McpServersSection
              isAdmin={isAdmin}
              workspaces={workspaceOptions}
              defaultWorkspace={wsDefault}
              showConnectButton={false}
              onWorkspaceChange={setMcpWorkspace}
              onServersLoaded={setMcpServers}
            />
          )}

          {(mcpWorkspace || wsDefault) && (
            <BuiltIntegrationsSection workspace={mcpWorkspace || wsDefault} onLoaded={setBuiltTools} />
          )}
        </>
      )}
      {confirmDialog}
    </div>
  )
}
