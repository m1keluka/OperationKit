/**
 * "Connect an MCP server" dialog (obj 900620). Paste a remote MCP URL or pick a
 * catalog entry, let the server tell us how it wants to be authenticated
 * (Detect), then connect: no auth, API key / bearer header, OAuth with
 * automatic client registration (DCR/CIMD), or OAuth with an app the admin
 * registered by hand (guided). Keys are sent once and never shown again.
 */
import { useEffect, useId, useState } from 'react'
import type {
  McpCatalogEntry,
  McpDetectResponse,
  McpErrorKind,
  McpOAuthStartResponse,
  McpServerAuthType,
  McpServerCreateRequest,
  McpServerSummary,
} from '@operationkit/shared'
import { api, ApiError } from '../../lib/api'
import { Alert, Badge, Button, CopyButton, Modal, cn } from '../ui'
import { errorHint, errorTitle, nameFromUrl } from './mcpServerCopy'
import { McpToolList } from './McpToolList'

const INPUT =
  'min-h-[44px] w-full rounded-md border border-line bg-surface-1 px-3 text-[13px] text-fg-0 outline-none transition-colors duration-fast ease-out placeholder:text-fg-3 hover:border-line-strong focus:border-accent focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-[36px]'
const LABEL = 'mb-1 block text-[12px] font-medium text-fg-1'

function errText(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return (err.body as { error?: string } | null)?.error || err.message || fallback
  return err instanceof Error ? err.message : fallback
}

function hostOf(u: string): string {
  try { return new URL(u).host } catch { return u }
}

type Source = 'url' | 'catalog'
type CreateResult = { server: McpServerSummary; test: { ok: boolean; kind?: McpErrorKind; error?: string } | null }

export function ConnectMcpServerDialog({
  open,
  onClose,
  workspaces,
  defaultWorkspace,
  onConnected,
  initial,
}: {
  open: boolean
  onClose: () => void
  workspaces: Array<{ value: string; label: string }>
  defaultWorkspace: string
  onConnected: (server: McpServerSummary) => void
  /** Pre-fill (screenshots / deep links). */
  initial?: { url?: string; name?: string; detect?: McpDetectResponse | null; catalogId?: string }
}) {
  const titleId = useId()
  const [source, setSource] = useState<Source>('url')
  const [catalog, setCatalog] = useState<McpCatalogEntry[] | null>(null)
  // obj 900682: New Integration → Browse opens this dialog pre-filled from a catalog entry.
  const [catalogId, setCatalogId] = useState<string | null>(initial?.catalogId ?? null)
  const [url, setUrl] = useState(initial?.url ?? '')
  const [name, setName] = useState(initial?.name ?? '')
  const [nameTouched, setNameTouched] = useState(!!initial?.name)
  const [workspace, setWorkspace] = useState(defaultWorkspace)
  const [detect, setDetect] = useState<McpDetectResponse | null>(initial?.detect ?? null)
  const [auth, setAuth] = useState<McpServerAuthType | null>(null)
  const [headerName, setHeaderName] = useState('Authorization')
  const [apiKey, setApiKey] = useState('')
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [busy, setBusy] = useState<'detect' | 'connect' | null>(null)
  const [error, setError] = useState('')
  const [result, setResult] = useState<CreateResult | null>(null)

  useEffect(() => { if (open) setWorkspace(w => w || defaultWorkspace) }, [open, defaultWorkspace])
  useEffect(() => {
    if (!open || source !== 'catalog' || catalog) return
    api.get<McpCatalogEntry[]>('/mcp-servers/catalog').then(setCatalog).catch(() => setCatalog([]))
  }, [open, source, catalog])
  useEffect(() => {
    if (!detect || !detect.ok) return
    setAuth(detect.auth)
  }, [detect])

  const reset = () => {
    setDetect(null); setAuth(null); setApiKey(''); setClientId(''); setClientSecret(''); setError(''); setResult(null)
  }
  const close = () => { reset(); setUrl(''); setName(''); setNameTouched(false); setCatalogId(null); onClose() }

  const onUrl = (v: string) => {
    setUrl(v)
    setDetect(null); setAuth(null); setResult(null); setError('')
    if (!nameTouched) setName(nameFromUrl(v))
  }

  const runDetect = async () => {
    setBusy('detect'); setError(''); setResult(null)
    try {
      setDetect(await api.post<McpDetectResponse>('/mcp-servers/detect', { url: url.trim() }))
    } catch (err) {
      setError(errText(err, 'Detection failed.'))
    } finally {
      setBusy(null)
    }
  }

  const manualOAuth = detect?.ok && detect.auth === 'oauth' && detect.registration === 'manual'
  const canConnect =
    !!url.trim() && !!name.trim() && !!workspace && !!auth &&
    (auth !== 'api_key' || !!apiKey.trim()) &&
    (auth !== 'oauth' || (detect?.ok && detect.auth === 'oauth' && (!manualOAuth || !!clientId.trim())))

  const connect = async () => {
    if (!auth) return
    setBusy('connect'); setError('')
    const body: McpServerCreateRequest = {
      workspace,
      name: name.trim(),
      url: url.trim(),
      auth_type: auth,
      ...(catalogId ? { catalog_id: catalogId } : {}),
      ...(auth === 'api_key' ? { auth_header_name: headerName.trim() || 'Authorization', api_key: apiKey } : {}),
      ...(auth === 'oauth' && manualOAuth ? { oauth_client_id: clientId.trim(), ...(clientSecret ? { oauth_client_secret: clientSecret } : {}) } : {}),
    }
    try {
      const res = await api.post<CreateResult>('/mcp-servers', body)
      setApiKey(''); setClientSecret('')
      onConnected(res.server)
      if (auth === 'oauth') {
        const start = await api.post<McpOAuthStartResponse>(`/mcp-servers/${res.server.id}/oauth/start`)
        window.location.assign(start.redirect_url)
        return
      }
      setResult(res)
    } catch (err) {
      setError(errText(err, 'Connecting failed.'))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Modal open={open} onClose={close} labelledBy={titleId} panelClassName="max-w-xl">
      <div className="max-h-[85vh] overflow-y-auto p-5 sm:p-6">
        <h2 id={titleId} className="font-display text-[17px] font-semibold tracking-[-0.01em] text-fg-0">
          Connect an MCP server
        </h2>
        <p className="mt-1 text-[13px] leading-relaxed text-fg-2">
          Add a remote MCP server so agents and chat bots in one workspace can use its tools. Keys and sign-ins are
          stored encrypted and never shown again.
        </p>

        {result ? (
          <div className="mt-5 space-y-4" data-testid="mcp-connect-result">
            {result.test?.ok ? (
              <Alert tone="verify" title={`${result.server.name} is connected`}>
                {result.server.server_name ?? 'The server'}
                {result.server.server_version ? ` ${result.server.server_version}` : ''} answered with {result.server.tools.length}{' '}
                {result.server.tools.length === 1 ? 'tool' : 'tools'}.
              </Alert>
            ) : (
              <Alert tone="alarm" title={errorTitle(result.test?.kind)}>
                {result.test?.error} {errorHint(result.test?.kind)} The server was saved; fix it and use Test connection.
              </Alert>
            )}
            {result.server.tools.length > 0 && <McpToolList tools={result.server.tools} />}
            <div className="flex justify-end">
              <Button variant="primary" onClick={close}>Done</Button>
            </div>
          </div>
        ) : (
          <form
            className="mt-5 space-y-4"
            onSubmit={e => { e.preventDefault(); if (canConnect) void connect() }}
          >
            <div role="tablist" aria-label="Where the server comes from" className="inline-flex rounded-md border border-line bg-surface-1 p-0.5">
              {(['url', 'catalog'] as Source[]).map(s => (
                <button
                  key={s}
                  type="button"
                  role="tab"
                  aria-selected={source === s}
                  onClick={() => setSource(s)}
                  className={cn(
                    'min-h-[36px] rounded px-3 text-[12.5px] font-medium transition-colors duration-fast ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
                    source === s ? 'bg-surface-3 text-fg-0' : 'text-fg-2 hover:text-fg-1',
                  )}
                >
                  {s === 'url' ? 'Paste a URL' : 'From the catalog'}
                </button>
              ))}
            </div>

            {source === 'catalog' && (
              <div className="grid gap-2 sm:grid-cols-2" aria-label="Catalog MCP servers">
                {catalog === null && <p className="text-[12.5px] text-fg-3">Loading catalog…</p>}
                {catalog?.length === 0 && <p className="text-[12.5px] text-fg-3">No catalog entries publish a remote MCP URL.</p>}
                {catalog?.map(c => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => { setCatalogId(c.id); onUrl(c.mcp_url); setName(c.name); setNameTouched(true); setSource('url') }}
                    className={cn(
                      'rounded-md border px-3 py-2 text-left transition-colors duration-fast ease-out hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
                      catalogId === c.id ? 'border-accent bg-surface-3' : 'border-line bg-surface-1',
                    )}
                  >
                    <span className="block text-[13px] font-medium text-fg-0">{c.name}</span>
                    <span className="block truncate font-mono text-xs text-fg-3">{c.mcp_url}</span>
                  </button>
                ))}
              </div>
            )}

            <div>
              <label htmlFor={`${titleId}-url`} className={LABEL}>Server URL</label>
              <div className="flex gap-2">
                <input
                  id={`${titleId}-url`}
                  type="url"
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  value={url}
                  onChange={e => { setCatalogId(null); onUrl(e.target.value) }}
                  placeholder="https://mcp.example.com/mcp"
                  className={cn(INPUT, 'font-mono')}
                />
                <Button type="button" variant="secondary" loading={busy === 'detect'} disabled={!url.trim()} onClick={() => void runDetect()}>
                  Detect
                </Button>
              </div>
              <p className="mt-1 text-[12px] leading-relaxed text-fg-3">
                Streamable HTTP or SSE. Must be a public https address.
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor={`${titleId}-name`} className={LABEL}>Name</label>
                <input
                  id={`${titleId}-name`}
                  value={name}
                  onChange={e => { setName(e.target.value); setNameTouched(true) }}
                  placeholder="e.g. Docs search"
                  className={INPUT}
                  maxLength={80}
                />
              </div>
              <div>
                <label htmlFor={`${titleId}-ws`} className={LABEL}>Workspace</label>
                <select id={`${titleId}-ws`} value={workspace} onChange={e => setWorkspace(e.target.value)} className={INPUT}>
                  {workspaces.map(w => <option key={w.value} value={w.value}>{w.label}</option>)}
                </select>
              </div>
            </div>
            <p className="-mt-2 text-[12px] leading-relaxed text-fg-3">
              Only cards and chat bots in this workspace will see the server and its credentials.
            </p>

            {detect && !detect.ok && (
              <Alert tone="alarm" title={errorTitle(detect.kind)}>
                {detect.error} {errorHint(detect.kind)}
              </Alert>
            )}
            {detect?.ok && (
              <div className="rounded-md border border-line bg-surface-1 px-3 py-2.5 text-[12.5px] leading-relaxed text-fg-1" data-testid="mcp-detect-result">
                <div className="mb-1 flex flex-wrap items-center gap-1.5">
                  <span className="font-medium text-fg-0">Detected:</span>
                  {detect.auth === 'none' && <Badge tone="verify">No sign-in needed</Badge>}
                  {detect.auth === 'api_key' && <Badge tone="amber">API key or token</Badge>}
                  {detect.auth === 'oauth' && <Badge tone="info">OAuth 2.1</Badge>}
                  {detect.auth === 'oauth' && (
                    <Badge tone="neutral">
                      {detect.registration === 'cimd' ? 'Client ID metadata (automatic)' : detect.registration === 'dcr' ? 'Dynamic registration (automatic)' : 'Register an app (guided)'}
                    </Badge>
                  )}
                </div>
                {detect.auth === 'none' && (
                  <>
                    {detect.server_name ?? 'The server'}{detect.server_version ? ` ${detect.server_version}` : ''} answered with {detect.tool_count}{' '}
                    {detect.tool_count === 1 ? 'tool' : 'tools'}.
                  </>
                )}
                {detect.auth === 'api_key' && detect.reason}
                {detect.auth === 'oauth' && !manualOAuth && <>You will sign in at {hostOf(detect.issuer)} after connecting.</>}
              </div>
            )}

            {(detect || error) && (
              <div>
                <label htmlFor={`${titleId}-auth`} className={LABEL}>Authentication</label>
                <select
                  id={`${titleId}-auth`}
                  value={auth ?? ''}
                  onChange={e => setAuth((e.target.value || null) as McpServerAuthType | null)}
                  className={INPUT}
                >
                  <option value="" disabled>Choose…</option>
                  <option value="none">No auth</option>
                  <option value="api_key">API key / bearer token</option>
                  <option value="oauth" disabled={!(detect?.ok && detect.auth === 'oauth')}>OAuth (sign in)</option>
                </select>
              </div>
            )}

            {auth === 'api_key' && (
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
                <div>
                  <label htmlFor={`${titleId}-hdr`} className={LABEL}>Header</label>
                  <input id={`${titleId}-hdr`} value={headerName} onChange={e => setHeaderName(e.target.value)} className={cn(INPUT, 'font-mono')} spellCheck={false} />
                </div>
                <div>
                  <label htmlFor={`${titleId}-key`} className={LABEL}>API key or token</label>
                  <input
                    id={`${titleId}-key`}
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={apiKey}
                    onChange={e => setApiKey(e.target.value)}
                    placeholder="Paste the key"
                    className={cn(INPUT, 'font-mono')}
                  />
                </div>
                <p className="text-[12px] leading-relaxed text-fg-3 sm:col-span-2">
                  With the Authorization header a bare key is sent as <code className="font-mono">Bearer &lt;key&gt;</code>.
                </p>
              </div>
            )}

            {auth === 'oauth' && manualOAuth && detect?.ok && detect.auth === 'oauth' && (
              <div className="space-y-3 rounded-md border border-line bg-surface-1 p-3">
                <p className="text-[12.5px] leading-relaxed text-fg-1">
                  This server uses OAuth but does not let apps register themselves. Create an OAuth app at the provider,
                  add this redirect URI, then paste the app’s client ID{detect.scopes_supported.length ? ' and grant the scopes below' : ''}.
                </p>
                <div>
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <span className="text-[12px] font-medium uppercase tracking-wider text-fg-3">Redirect URI</span>
                    <CopyButton value={detect.redirect_uri} />
                  </div>
                  <code className="block break-all rounded-md border border-line bg-surface-2 px-3 py-2 text-[12px] text-fg-0">{detect.redirect_uri}</code>
                </div>
                {detect.scopes_supported.length > 0 && (
                  <p className="font-mono text-[12px] text-fg-2">{detect.scopes_supported.join(' ')}</p>
                )}
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label htmlFor={`${titleId}-cid`} className={LABEL}>Client ID</label>
                    <input id={`${titleId}-cid`} value={clientId} onChange={e => setClientId(e.target.value)} className={cn(INPUT, 'font-mono')} spellCheck={false} autoComplete="off" />
                  </div>
                  <div>
                    <label htmlFor={`${titleId}-csec`} className={LABEL}>Client secret (optional)</label>
                    <input id={`${titleId}-csec`} type="password" value={clientSecret} onChange={e => setClientSecret(e.target.value)} className={cn(INPUT, 'font-mono')} spellCheck={false} autoComplete="off" />
                  </div>
                </div>
              </div>
            )}

            {error && <Alert tone="alarm">{error}</Alert>}

            <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
              <Button type="button" variant="ghost" onClick={close}>Cancel</Button>
              {!detect && !error ? (
                <Button type="button" variant="primary" loading={busy === 'detect'} disabled={!url.trim()} onClick={() => void runDetect()}>
                  Detect authentication
                </Button>
              ) : (
                <Button type="submit" variant="primary" loading={busy === 'connect'} disabled={!canConnect}>
                  {auth === 'oauth' ? 'Connect and sign in' : 'Connect and test'}
                </Button>
              )}
            </div>
          </form>
        )}
      </div>
    </Modal>
  )
}
