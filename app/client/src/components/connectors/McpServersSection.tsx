/**
 * Settings → Integrations → MCP servers (obj 900620).
 *
 * Remote MCP servers connected for ONE workspace at a time. Cards and chat bots
 * in that workspace get the server's tools; no other workspace sees it. Admins
 * connect, test, sign in, toggle tools and disconnect; members can look.
 */
import { useCallback, useEffect, useState } from 'react'
import type { McpErrorKind, McpOAuthStartResponse, McpServerSummary } from '@operationkit/shared'
import { api, ApiError } from '../../lib/api'
import { Alert, Badge, Button, Card, EmptyState, Skeleton, useConfirm } from '../ui'
import { ConnectMcpServerDialog } from './ConnectMcpServerDialog'
import { McpToolList } from './McpToolList'
import { authLabel, errorHint, errorTitle, mcpOAuthReturnCopy, serverInfoLine, statusBadge } from './mcpServerCopy'

function errText(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return (err.body as { error?: string } | null)?.error || err.message || fallback
  return err instanceof Error ? err.message : fallback
}

type TestOutcome = { ok: boolean; kind?: McpErrorKind; error?: string }

function ServerCard({
  server: s,
  isAdmin,
  onChange,
  onRemove,
  notify,
}: {
  server: McpServerSummary
  isAdmin: boolean
  onChange: (s: McpServerSummary) => void
  onRemove: (s: McpServerSummary) => void
  notify: (n: { ok: boolean; text: string }) => void
}) {
  const [busy, setBusy] = useState<'test' | 'signin' | 'toggle' | 'key' | null>(null)
  const [replacing, setReplacing] = useState(false)
  const [newKey, setNewKey] = useState('')
  const [busyTool, setBusyTool] = useState<string | null>(null)
  const [showTools, setShowTools] = useState(false)
  const [test, setTest] = useState<TestOutcome | null>(null)
  const badge = statusBadge(s)

  const runTest = async () => {
    setBusy('test'); setTest(null)
    try {
      const res = await api.post<TestOutcome & { server: McpServerSummary }>(`/mcp-servers/${s.id}/test`)
      onChange(res.server)
      setTest({ ok: res.ok, kind: res.kind, error: res.error })
      if (res.ok) setShowTools(true)
    } catch (err) {
      setTest({ ok: false, error: errText(err, 'Testing failed.') })
    } finally {
      setBusy(null)
    }
  }

  const signIn = async () => {
    setBusy('signin')
    try {
      const res = await api.post<McpOAuthStartResponse>(`/mcp-servers/${s.id}/oauth/start`)
      window.location.assign(res.redirect_url)
    } catch (err) {
      notify({ ok: false, text: errText(err, 'Could not start sign-in.') })
      setBusy(null)
    }
  }

  const patch = async (body: Record<string, unknown>, what: string) => {
    try {
      onChange(await api.patch<McpServerSummary>(`/mcp-servers/${s.id}`, body))
    } catch (err) {
      notify({ ok: false, text: errText(err, `${what} failed.`) })
    }
  }

  const replaceKey = async () => {
    setBusy('key')
    try {
      onChange(await api.patch<McpServerSummary>(`/mcp-servers/${s.id}`, { api_key: newKey }))
      setNewKey(''); setReplacing(false)
      setBusy(null)
      await runTest()
    } catch (err) {
      notify({ ok: false, text: errText(err, 'Saving the key failed.') })
      setBusy(null)
    }
  }

  const toggleTool = async (name: string, enabled: boolean) => {
    setBusyTool(name)
    const disabled = s.tools.filter(t => (t.name === name ? !enabled : !t.enabled)).map(t => t.name)
    await patch({ disabled_tools: disabled }, 'Saving the tool setting')
    setBusyTool(null)
  }

  return (
    <Card inset className="overflow-hidden" data-testid={`mcp-server-${s.slug}`}>
      <div className="p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="text-[14.5px] font-semibold text-fg-0">{s.name}</h4>
              <Badge tone={badge.tone}>{badge.label}</Badge>
              <Badge tone="neutral">{authLabel(s)}</Badge>
              {s.detected_transport && <Badge tone="neutral">{s.detected_transport === 'sse' ? 'SSE' : 'Streamable HTTP'}</Badge>}
            </div>
            <div className="mt-1 truncate font-mono text-[12px] text-fg-3" title={s.url}>{s.url}</div>
            <div className="mt-1.5 text-[12.5px] text-fg-2">
              {serverInfoLine(s)}
              <span className="text-fg-3"> · tools appear as <code className="font-mono">mcp__{s.slug}__…</code></span>
            </div>
          </div>
          {isAdmin && (
            <div className="flex flex-wrap gap-2">
              {s.auth_type === 'oauth' && s.status === 'needs_auth' && (
                <Button size="sm" variant="primary" loading={busy === 'signin'} onClick={() => void signIn()}>Sign in</Button>
              )}
              {s.auth_type === 'api_key' && (
                <Button size="sm" variant="ghost" onClick={() => setReplacing(v => !v)} aria-expanded={replacing}>Replace key</Button>
              )}
              <Button size="sm" variant="secondary" loading={busy === 'test'} onClick={() => void runTest()}>Test connection</Button>
              <Button size="sm" variant="ghost" onClick={() => void patch({ enabled: !s.enabled }, 'Saving')}>
                {s.enabled ? 'Turn off' : 'Turn on'}
              </Button>
              <Button size="sm" variant="danger" onClick={() => onRemove(s)}>Disconnect</Button>
            </div>
          )}
        </div>

        {replacing && (
          <form
            className="mt-3 flex flex-wrap items-end gap-2"
            onSubmit={e => { e.preventDefault(); if (newKey.trim()) void replaceKey() }}
          >
            <div className="min-w-[240px] flex-1">
              <label htmlFor={`mcp-key-${s.id}`} className="mb-1 block text-[12px] font-medium text-fg-1">New API key ({s.auth_header_name ?? 'Authorization'})</label>
              <input
                id={`mcp-key-${s.id}`}
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={newKey}
                onChange={e => setNewKey(e.target.value)}
                className="min-h-[44px] w-full rounded-md border border-line bg-surface-1 px-3 font-mono text-[13px] text-fg-0 outline-none hover:border-line-strong focus:border-accent focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-[36px]"
              />
            </div>
            <Button type="submit" size="sm" variant="primary" loading={busy === 'key'} disabled={!newKey.trim()}>Save and test</Button>
          </form>
        )}

        {test && (
          <div className="mt-3" aria-live="polite">
            {test.ok ? (
              <Alert tone="verify" title="Connection works">
                {s.server_name ?? 'The server'}{s.server_version ? ` ${s.server_version}` : ''} answered with {s.tools.length}{' '}
                {s.tools.length === 1 ? 'tool' : 'tools'}.
              </Alert>
            ) : (
              <Alert tone="alarm" title={errorTitle(test.kind)}>
                {test.error} {errorHint(test.kind)}
              </Alert>
            )}
          </div>
        )}
        {!test && s.last_error && s.status !== 'connected' && (
          <p className="mt-2 text-[12.5px] leading-relaxed text-signal-alarm">{s.last_error}</p>
        )}
      </div>

      {s.tools.length > 0 && (
        <div className="border-t border-line-soft">
          <button
            type="button"
            aria-expanded={showTools}
            onClick={() => setShowTools(v => !v)}
            className="flex min-h-[44px] w-full items-center justify-between gap-3 px-4 py-2 text-left text-[12.5px] font-medium text-fg-1 transition-colors duration-fast ease-out hover:bg-surface-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/50 sm:px-5"
          >
            <span>Tools ({s.tools.length})</span>
            <span className="text-fg-3">{showTools ? 'Hide' : 'Show'}</span>
          </button>
          {showTools && (
            <div className="px-4 pb-4 sm:px-5">
              <McpToolList tools={s.tools} onToggle={isAdmin ? (n, e) => void toggleTool(n, e) : undefined} busyTool={busyTool} />
            </div>
          )}
        </div>
      )}
    </Card>
  )
}

export function McpServersSection({
  isAdmin,
  workspaces,
  defaultWorkspace,
  showConnectButton = true,
  onWorkspaceChange,
  onServersLoaded,
}: {
  isAdmin: boolean
  workspaces: Array<{ value: string; label: string }>
  defaultWorkspace: string
  /** obj 900682: false on the "connected only" Integrations view, where New Integration is the way in. */
  showConnectButton?: boolean
  onWorkspaceChange?: (workspace: string) => void
  onServersLoaded?: (servers: McpServerSummary[]) => void
}) {
  const [workspace, setWorkspace] = useState(defaultWorkspace)
  const [servers, setServers] = useState<McpServerSummary[] | null>(null)
  const [loadError, setLoadError] = useState('')
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const { confirm, confirmDialog } = useConfirm()

  useEffect(() => { if (!workspace && defaultWorkspace) setWorkspace(defaultWorkspace) }, [workspace, defaultWorkspace])

  const load = useCallback(async () => {
    if (!workspace) return
    try {
      setServers(await api.get<McpServerSummary[]>(`/mcp-servers?workspace=${encodeURIComponent(workspace)}`))
      setLoadError('')
    } catch (err) {
      setLoadError(errText(err, 'Could not load MCP servers.'))
      setServers([])
    }
  }, [workspace])

  useEffect(() => { setServers(null); void load() }, [load])
  useEffect(() => { if (workspace) onWorkspaceChange?.(workspace) }, [workspace]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (servers) onServersLoaded?.(servers) }, [servers]) // eslint-disable-line react-hooks/exhaustive-deps

  // OAuth round-trip outcome, shown once.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const copy = mcpOAuthReturnCopy(params)
    if (!copy) return
    setNotice(copy)
    for (const k of ['mcp_oauth', 'mcp_error', 'mcp_server']) params.delete(k)
    const qs = params.toString()
    window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : ''))
  }, [])

  const upsert = (s: McpServerSummary) => {
    if (s.workspace !== workspace) {
      setWorkspace(s.workspace)
      return
    }
    setServers(list => {
      const l = list ?? []
      return l.some(x => x.id === s.id) ? l.map(x => (x.id === s.id ? s : x)) : [...l, s]
    })
  }

  const remove = async (s: McpServerSummary) => {
    const ok = await confirm({
      title: `Disconnect ${s.name}?`,
      message: `Cards and chat bots in this workspace stop getting its tools, and the stored ${s.auth_type === 'oauth' ? 'sign-in tokens are' : s.auth_type === 'api_key' ? 'API key is' : 'settings are'} deleted from this server.`,
      confirmLabel: 'Disconnect',
      danger: true,
    })
    if (!ok) return
    try {
      await api.del(`/mcp-servers/${s.id}`)
      setServers(list => (list ?? []).filter(x => x.id !== s.id))
      setNotice({ ok: true, text: `${s.name} disconnected and its credentials deleted.` })
    } catch (err) {
      setNotice({ ok: false, text: errText(err, 'Disconnecting failed.') })
    }
  }

  return (
    <section aria-labelledby="mcp-servers-title" className="space-y-3" data-testid="mcp-servers-section">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h3 id="mcp-servers-title" className="font-display text-[15px] font-semibold text-fg-0">MCP servers</h3>
          <p className="mt-0.5 text-[12.5px] leading-relaxed text-fg-2">
            Remote MCP servers give agents and chat bots extra tools. Each server belongs to one workspace.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor="mcp-ws-picker">Workspace</label>
          <select
            id="mcp-ws-picker"
            value={workspace}
            onChange={e => setWorkspace(e.target.value)}
            className="min-h-[36px] rounded-md border border-line bg-surface-1 px-2.5 text-[12.5px] text-fg-1 outline-none hover:border-line-strong focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            {workspaces.map(w => <option key={w.value} value={w.value}>{w.label}</option>)}
          </select>
          {isAdmin && showConnectButton && (
            <Button variant="primary" size="sm" onClick={() => setDialogOpen(true)} disabled={!workspace}>
              Connect an MCP server
            </Button>
          )}
        </div>
      </div>

      {notice && (
        <div aria-live="polite">
          <Alert tone={notice.ok ? 'verify' : 'alarm'}>{notice.text}</Alert>
        </div>
      )}
      {loadError && <Alert tone="alarm" title="Could not load MCP servers">{loadError}</Alert>}

      {servers === null ? (
        <div className="rounded-lg border border-line bg-surface-2 p-5" aria-hidden="true">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="mt-3 h-3 w-2/3" />
        </div>
      ) : servers.length === 0 && !loadError ? (
        showConnectButton ? (
          <EmptyState
            title="No MCP servers in this workspace"
            description={isAdmin ? 'Paste a remote MCP server URL or pick one from the catalog.' : 'An admin can connect one.'}
          />
        ) : (
          <p className="rounded-lg border border-dashed border-line px-4 py-3 text-[12.5px] text-fg-3">
            No MCP servers connected in this workspace{isAdmin ? ' — add one from New Integration.' : '.'}
          </p>
        )
      ) : (
        servers.map(s => (
          <ServerCard key={s.id} server={s} isAdmin={isAdmin} onChange={upsert} onRemove={x => void remove(x)} notify={setNotice} />
        ))
      )}

      {isAdmin && (
        <ConnectMcpServerDialog
          open={dialogOpen}
          onClose={() => setDialogOpen(false)}
          workspaces={workspaces}
          defaultWorkspace={workspace}
          onConnected={upsert}
        />
      )}
      {confirmDialog}
    </section>
  )
}
