/**
 * Dashboard module: model configuration. Replaces the standalone /models page.
 * Lists models grouped by provider (Anthropic / OpenAI), with enable/disable
 * plus the global default (new objectives) and planner (planning step) — all
 * registry-backed (GET /api/models/all, PATCH /api/models/:id, admin only).
 */
import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import type { ModelRow } from '@operationkit/shared'
import { Card, CardHeader, CardBody, Alert } from './ui'

const PROVIDERS: Array<{ engine: string; label: string }> = [
  { engine: 'claude', label: 'Anthropic Models' },
  { engine: 'codex', label: 'OpenAI Models' },
  { engine: 'grok', label: 'xAI Models' },
]

export function ModelsModule() {
  const [models, setModels] = useState<ModelRow[]>([])
  const [error, setError] = useState('')
  const [savingId, setSavingId] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

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

  // Admin-only data; if the fetch 403s for a non-admin, models stays empty — hide the module.
  if (!loaded || models.length === 0) return null

  const groups = PROVIDERS
    .map(p => ({ ...p, rows: models.filter(m => m.engine === p.engine) }))
    .filter(g => g.rows.length > 0)

  return (
    <Card inset>
      <CardHeader title="Models" eyebrow="Registry" />
      <CardBody>
        <p className="mb-4 text-[12.5px] leading-relaxed text-fg-3">
          Enable or disable models per provider, and set the global <span className="text-fg-1">default</span> (new
          objectives) and <span className="text-fg-1">planner</span> (planning step). Applies across all accounts.
        </p>

        {error && <Alert tone="alarm" className="mb-3">{error}</Alert>}

        <div className="space-y-5">
          {groups.map(g => (
            <div key={g.engine}>
              <div className="mb-2 font-mono text-[11px] font-semibold uppercase tracking-[0.1em] text-fg-3">{g.label}</div>
              <div className="overflow-hidden rounded-lg border border-line">
                <table className="w-full text-[13px]">
                  <thead className="bg-surface-1 font-mono text-[11px] uppercase tracking-[0.1em] text-fg-3">
                    <tr>
                      <th className="px-3 py-2.5 text-left font-medium">Model</th>
                      <th className="px-3 py-2.5 text-center font-medium">Enabled</th>
                      <th className="px-3 py-2.5 text-center font-medium">Default</th>
                      <th className="px-3 py-2.5 text-center font-medium">Planner</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line-soft">
                    {g.rows.map(m => {
                      const lock = m.is_default || m.is_planner
                      const busy = savingId === m.id
                      return (
                        <tr key={m.id} className={busy ? 'opacity-50' : undefined}>
                          <td className="px-3 py-2.5">
                            <div className="text-fg-0">{m.label}</div>
                            <div className="font-mono text-[11px] text-fg-3">{m.id}</div>
                          </td>
                          <td className="px-3 py-2.5 text-center">
                            <input
                              type="checkbox"
                              checked={m.enabled}
                              disabled={busy || lock}
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
            </div>
          ))}
        </div>

        <p className="mt-3 text-[11px] text-fg-3">
          Setting a model as default or planner auto-enables it. The active default and planner can't be disabled —
          reassign the role first.
        </p>
      </CardBody>
    </Card>
  )
}
