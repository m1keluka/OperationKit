/**
 * Settings → Models → model registry. Lists models grouped by provider
 * (Anthropic / OpenAI / xAI) with enable/disable, plus the global default (new
 * objectives) and planner (planning step) — all registry-backed
 * (GET /api/models/all, PATCH /api/models/:id, admin only).
 *
 * obj 900679: the default and planner are now plain dropdowns at the top, and
 * "Refresh from providers" (POST /api/models/refresh) pulls each connected
 * provider's live model list so new models appear without a code change. The
 * server also refreshes on a schedule; the last result is shown per provider,
 * including why a provider could not be reached.
 */
import { useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import type { ModelRow } from '@operationkit/shared'
import { Card, CardHeader, CardBody, Alert, Badge, Button } from './ui'

const PROVIDERS: Array<{ engine: string; label: string }> = [
  { engine: 'claude', label: 'Anthropic Models' },
  { engine: 'codex', label: 'OpenAI Models' },
  { engine: 'grok', label: 'xAI Models' },
]

export interface ProviderRefreshResult {
  provider: string
  label: string
  engine: string | null
  status: 'ok' | 'error' | 'skipped'
  credential: string | null
  error: string | null
  http_status: number | null
  fetched: number
  added: string[]
  updated: string[]
  missing: string[]
  listed?: string[]
}

export interface ModelRefreshReport {
  trigger: 'manual' | 'scheduled'
  started_at: string
  finished_at: string
  providers: ProviderRefreshResult[]
}

function fmtWhen(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function ProviderStatusRow({ r }: { r: ProviderRefreshResult }) {
  const tone = r.status === 'ok' ? 'verify' : r.status === 'skipped' ? 'neutral' : 'alarm'
  const word = r.status === 'ok' ? 'Updated' : r.status === 'skipped' ? 'Not connected' : 'Failed'
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 gap-y-1 py-1.5" data-testid={`refresh-status-${r.provider}`}>
      <span className="min-w-[88px] text-[13px] text-fg-0">{r.label}</span>
      <Badge tone={tone}>{word}</Badge>
      {r.status === 'ok' && (
        <span className="text-[12.5px] text-fg-2">
          {r.fetched} model{r.fetched === 1 ? '' : 's'} listed
          {r.engine ? (r.added.length > 0 ? ` · ${r.added.length} new` : ' · nothing new') : ' · listed only (custom endpoints cannot run sessions yet)'}
          {r.credential && <span className="text-fg-3"> · via {r.credential}</span>}
        </span>
      )}
      {r.status !== 'ok' && r.error && (
        <span className={r.status === 'error' ? 'text-[12.5px] text-signal-alarm' : 'text-[12.5px] text-fg-3'}>
          {r.error}
          {r.status === 'error' && r.credential && <span className="text-fg-3"> (tried {r.credential})</span>}
        </span>
      )}
    </li>
  )
}

export function ModelsModule() {
  const [models, setModels] = useState<ModelRow[]>([])
  const [error, setError] = useState('')
  const [savingId, setSavingId] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [report, setReport] = useState<ModelRefreshReport | null>(null)
  const [autoHours, setAutoHours] = useState<number | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState('')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  async function reload() {
    try {
      const data = await api.get<{ models: ModelRow[] }>('/models/all')
      setModels(data.models)
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Load failed')
    } finally {
      setLoaded(true)
    }
    try {
      const r = await api.get<{ report: ModelRefreshReport | null; auto_refresh_hours: number }>('/models/refresh')
      setReport(r.report)
      setAutoHours(r.auto_refresh_hours)
    } catch {
      // Status is optional context; the registry still works without it.
    }
  }

  useEffect(() => { void reload() }, [])

  async function patch(id: string, body: { enabled?: boolean; is_default?: boolean; is_planner?: boolean }) {
    setSavingId(id)
    setError('')
    try {
      const data = await api.patch<{ models: ModelRow[] }>(`/models/${encodeURIComponent(id)}`, body)
      setModels(data.models)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Update failed')
    } finally {
      setSavingId(null)
    }
  }

  async function refresh() {
    setRefreshing(true)
    setRefreshError('')
    try {
      const data = await api.post<{ report: ModelRefreshReport; models: ModelRow[]; auto_refresh_hours: number }>('/models/refresh', {}, { timeoutMs: 120_000 })
      setReport(data.report)
      setModels(data.models)
      setAutoHours(data.auto_refresh_hours)
    } catch (err) {
      setRefreshError(err instanceof Error ? err.message : 'Refresh failed')
    } finally {
      setRefreshing(false)
    }
  }

  const justAdded = useMemo(() => new Set((report?.providers ?? []).flatMap(p => p.added)), [report])
  const notListed = useMemo(
    () => new Set((report?.providers ?? []).filter(p => p.status === 'ok').flatMap(p => p.missing)),
    [report],
  )

  // Admin-only data; if the fetch 403s for a non-admin, models stays empty — hide the module.
  if (!loaded || models.length === 0) return null

  const groups = PROVIDERS
    .map(p => ({ ...p, rows: models.filter(m => m.engine === p.engine) }))
    .filter(g => g.rows.length > 0)

  const current = models.find(m => m.is_default)
  const planner = models.find(m => m.is_planner)

  function modelSelect(kind: 'default' | 'planner', value: string | undefined) {
    const id = `models-${kind}-select`
    return (
      <div>
        <label htmlFor={id} className="mb-1 block text-[12px] font-semibold uppercase tracking-[0.06em] text-fg-3">
          {kind === 'default' ? 'Default model' : 'Planner model'}
        </label>
        <select
          id={id}
          value={value ?? ''}
          disabled={savingId !== null}
          onChange={e => {
            const next = e.target.value
            if (next && next !== value) void patch(next, kind === 'default' ? { is_default: true } : { is_planner: true })
          }}
          className="w-full rounded-md border border-line bg-surface-1 px-2.5 py-2 text-[13px] text-fg-0 disabled:opacity-60"
        >
          {!value && <option value="">— none —</option>}
          {groups.map(g => (
            <optgroup key={g.engine} label={g.label}>
              {g.rows.map(m => (
                <option key={m.id} value={m.id}>
                  {m.label} ({m.id}){m.enabled ? '' : ' — off, will be enabled'}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <p className="mt-1 text-[12px] text-fg-3">
          {kind === 'default' ? 'Used for new objectives when no model is picked.' : 'Used for the planning step.'}
        </p>
      </div>
    )
  }

  return (
    <Card inset>
      <CardHeader
        title="Models"
        eyebrow="Registry"
        actions={
          <Button size="sm" variant="secondary" loading={refreshing} onClick={() => void refresh()} data-testid="models-refresh">
            Refresh from providers
          </Button>
        }
      />
      <CardBody>
        <p className="mb-4 text-[12.5px] leading-relaxed text-fg-3">
          Pick the global <span className="text-fg-1">default</span> (new objectives) and{' '}
          <span className="text-fg-1">planner</span> (planning step), and enable or disable models per provider. Applies
          across all accounts.
        </p>

        {error && <Alert tone="alarm" className="mb-3">{error}</Alert>}

        <div className="mb-5 grid gap-4 sm:grid-cols-2">
          {modelSelect('default', current?.id)}
          {modelSelect('planner', planner?.id)}
        </div>

        <div className="mb-5 rounded-lg border border-line px-3 py-2.5" data-testid="models-refresh-panel">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div className="text-[12px] font-semibold uppercase tracking-[0.06em] text-fg-3">Provider model lists</div>
            <div className="text-[12px] text-fg-3">
              {report ? `Last refreshed ${fmtWhen(report.finished_at)} (${report.trigger})` : 'Never refreshed'}
              {autoHours !== null && (autoHours > 0 ? ` · refreshes automatically every ${autoHours}h` : ' · automatic refresh off')}
            </div>
          </div>
          {refreshError && <Alert tone="alarm" className="mt-2">{refreshError}</Alert>}
          {report ? (
            <ul className="mt-1 divide-y divide-line-soft">
              {report.providers.map(r => <ProviderStatusRow key={r.provider} r={r} />)}
            </ul>
          ) : (
            <p className="mt-1 text-[12.5px] text-fg-3">
              Pulls each connected provider's current models (Anthropic, OpenAI, xAI and any custom endpoint) so new
              models show up here without a code change.
            </p>
          )}
          <p className="mt-1.5 text-[12px] text-fg-3">
            New models are added switched off — enable one to make it selectable on cards.
          </p>
        </div>

        <div className="space-y-5">
          {groups.map(g => {
            // Provider-discovered models that are off and not new are tucked
            // away so a big OpenAI list doesn't bury the curated rows.
            const hidden = g.rows.filter(m => m.source === 'provider' && !m.enabled && !justAdded.has(m.id))
            const showAll = !!expanded[g.engine]
            const rows = showAll ? g.rows : g.rows.filter(m => !hidden.includes(m))
            return (
              <div key={g.engine}>
                <div className="mb-2 text-[12px] uppercase tracking-[0.1em] text-fg-3 font-semibold tracking-[0.06em]">{g.label}</div>
                <div className="overflow-hidden rounded-lg border border-line">
                  <table className="w-full text-[13px]">
                    <thead className="bg-surface-1 text-[12px] uppercase tracking-[0.1em] text-fg-3 font-semibold tracking-[0.06em]">
                      <tr>
                        <th className="px-3 py-2.5 text-left font-medium">Model</th>
                        <th className="px-3 py-2.5 text-center font-medium">Enabled</th>
                        <th className="px-3 py-2.5 text-center font-medium">Default</th>
                        <th className="px-3 py-2.5 text-center font-medium">Planner</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line-soft">
                      {rows.map(m => {
                        const lock = m.is_default || m.is_planner
                        const busy = savingId === m.id
                        return (
                          <tr key={m.id} className={busy ? 'opacity-50' : undefined}>
                            <td className="px-3 py-2.5">
                              <div className="flex flex-wrap items-center gap-1.5 text-fg-0">
                                {m.label}
                                {justAdded.has(m.id) && <Badge tone="accent">New</Badge>}
                                {notListed.has(m.id) && (
                                  <span title="The provider's model list no longer includes this id. It may be retired.">
                                    <Badge tone="amber">Not listed by provider</Badge>
                                  </span>
                                )}
                              </div>
                              <div className="font-mono text-[12px] text-fg-3">{m.id}</div>
                            </td>
                            <td className="px-3 py-2.5 text-center">
                              <input
                                type="checkbox"
                                checked={m.enabled}
                                disabled={busy || lock}
                                aria-label={`Enable ${m.label}`}
                                title={lock ? 'Reassign default/planner before disabling' : ''}
                                onChange={() => void patch(m.id, { enabled: !m.enabled })}
                                className="h-4 w-4 cursor-pointer accent-[color:var(--accent)] disabled:cursor-not-allowed"
                              />
                            </td>
                            <td className="px-3 py-2.5 text-center">
                              <input
                                type="radio"
                                name="dash-default-model"
                                checked={m.is_default}
                                disabled={busy || m.is_default}
                                aria-label={`Make ${m.label} the default`}
                                onChange={() => void patch(m.id, { is_default: true })}
                                className="h-4 w-4 cursor-pointer accent-[color:var(--accent)] disabled:cursor-not-allowed"
                              />
                            </td>
                            <td className="px-3 py-2.5 text-center">
                              <input
                                type="radio"
                                name="dash-planner-model"
                                checked={m.is_planner}
                                disabled={busy || m.is_planner}
                                aria-label={`Make ${m.label} the planner`}
                                onChange={() => void patch(m.id, { is_planner: true })}
                                className="h-4 w-4 cursor-pointer accent-[color:var(--accent)] disabled:cursor-not-allowed"
                              />
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
                {hidden.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setExpanded(e => ({ ...e, [g.engine]: !showAll }))}
                    className="mt-1.5 text-[12px] text-accent-hover hover:underline"
                  >
                    {showAll ? 'Hide older provider models' : `Show ${hidden.length} more model${hidden.length === 1 ? '' : 's'} from the provider`}
                  </button>
                )}
              </div>
            )
          })}
        </div>

        <p className="mt-3 text-[12px] text-fg-3">
          Setting a model as default or planner auto-enables it. The active default and planner can't be disabled —
          reassign the role first.
        </p>
      </CardBody>
    </Card>
  )
}
