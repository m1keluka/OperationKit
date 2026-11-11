/**
 * Secrets audit log (obj 900498).
 *
 * Reads `GET /api/secrets/audit` — the append-only `secret_access_log`. Two
 * modes, same component:
 *   - Page panel (global admin): the whole log, filterable by action and key,
 *     paged newest-first with "Load more" (keyset `beforeId`).
 *   - Per-secret (`scopeQuery` + `secretKey` set, used in the History modal):
 *     only that secret's own history. Any user who may see the secret may read it.
 *
 * Rows are metadata only: who, when, what, which key, how. The log never holds
 * a value, so there is nothing here to mask.
 */
import { useCallback, useEffect, useState } from 'react'
import { api } from '../../lib/api'
import type { SecretAuditEntry, SecretAuditPage } from '@operationkit/shared'
import { fmtTime } from './SecretRow'

/** Plain-language label per action. Unknown actions fall back to the raw string. */
export const AUDIT_ACTION_LABELS: Record<string, string> = {
  create: 'Created',
  update: 'Updated',
  rotate: 'Rotated',
  describe: 'Description changed',
  delete: 'Deleted',
  rollback: 'Rolled back',
  read: 'Read by server',
  inject: 'Injected into session',
  use: 'Used via broker',
  reveal_attempt: 'Reveal attempt (refused)',
}

const ACTION_TONES: Record<string, string> = {
  delete: 'text-signal-alarm',
  reveal_attempt: 'text-signal-amber',
  rotate: 'text-accent',
  create: 'text-signal-verify',
}

const FILTERABLE = ['', 'create', 'rotate', 'update', 'describe', 'delete', 'rollback', 'reveal_attempt', 'use', 'inject', 'read']

function actorLabel(e: SecretAuditEntry): string {
  if (e.actorUsername) return e.actorUsername
  if (e.actorUserId == null || e.actorUserId === 0) return e.source === 'spawn' ? 'session spawn' : 'system'
  return `user #${e.actorUserId}`
}

interface Props {
  /** Per-secret mode: the row's scope query string (scopeType=…&workspace=…). */
  scopeQuery?: string
  secretKey?: string
  /** Any value change triggers a reload (e.g. the secrets list after a save). */
  refreshToken?: unknown
  pageSize?: number
}

export function AuditLogPanel({ scopeQuery, secretKey, refreshToken, pageSize = 50 }: Props) {
  const perSecret = !!(scopeQuery && secretKey)
  const [open, setOpen] = useState(perSecret)
  const [entries, setEntries] = useState<SecretAuditEntry[]>([])
  const [next, setNext] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [action, setAction] = useState('')
  const [keyFilter, setKeyFilter] = useState('')
  const [appliedKey, setAppliedKey] = useState('')

  const buildPath = useCallback((beforeId?: number) => {
    const p = new URLSearchParams()
    p.set('limit', String(pageSize))
    if (action) p.set('action', action)
    if (beforeId != null) p.set('beforeId', String(beforeId))
    if (perSecret) return `/secrets/audit?${scopeQuery}&key=${encodeURIComponent(secretKey!)}&${p}`
    if (appliedKey) p.set('key', appliedKey)
    return `/secrets/audit?${p}`
  }, [action, appliedKey, pageSize, perSecret, scopeQuery, secretKey])

  const load = useCallback(async (beforeId?: number) => {
    setLoading(true)
    setError('')
    try {
      const page = await api.get<SecretAuditPage>(buildPath(beforeId))
      const rows = Array.isArray(page?.entries) ? page.entries : []
      setEntries(prev => (beforeId != null ? [...prev, ...rows] : rows))
      setNext(typeof page?.nextBeforeId === 'number' ? page.nextBeforeId : null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the audit log')
    } finally {
      setLoading(false)
    }
  }, [buildPath])

  useEffect(() => {
    if (open) void load()
  }, [open, load, refreshToken])

  const body = (
    <div data-testid="secret-audit-log">
      {!perSecret && (
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="audit-action" className="mb-1 block text-[12px] uppercase tracking-wider text-fg-3">Action</label>
            <select
              id="audit-action"
              value={action}
              onChange={e => setAction(e.target.value)}
              data-testid="audit-action-filter"
              className="rounded border border-border bg-surface px-2 py-1.5 text-sm text-fg-0 outline-none focus:border-accent"
            >
              {FILTERABLE.map(a => (
                <option key={a || 'all'} value={a}>{a ? AUDIT_ACTION_LABELS[a] ?? a : 'All actions'}</option>
              ))}
            </select>
          </div>
          <form
            onSubmit={e => { e.preventDefault(); setAppliedKey(keyFilter.trim()) }}
            className="flex items-end gap-2"
          >
            <div>
              <label htmlFor="audit-key" className="mb-1 block text-[12px] uppercase tracking-wider text-fg-3">Key</label>
              <input
                id="audit-key"
                value={keyFilter}
                onChange={e => setKeyFilter(e.target.value)}
                placeholder="exact key, e.g. OPENAI_API_KEY"
                className="w-56 rounded border border-border bg-surface px-2 py-1.5 font-mono text-xs text-fg-0 outline-none focus:border-accent"
              />
            </div>
            <button type="submit" className="rounded px-2 py-1.5 text-xs text-accent hover:bg-surface-overlay">Filter</button>
          </form>
          <p className="ml-auto max-w-sm text-[12px] text-fg-3">
            Append-only: rows cannot be edited or deleted. Values are never logged.
          </p>
        </div>
      )}

      {error && <div className="mb-2 rounded bg-signal-alarm/10 px-3 py-2 text-sm text-signal-alarm">{error}</div>}

      <div className="overflow-x-auto rounded border border-border">
        <table className="w-full text-xs">
          <thead className="bg-surface border-b border-border">
            <tr className="text-left text-fg-2">
              <th className="px-2 py-1.5 font-medium">When (UTC)</th>
              <th className="px-2 py-1.5 font-medium">Action</th>
              {!perSecret && <th className="px-2 py-1.5 font-medium">Key</th>}
              {!perSecret && <th className="px-2 py-1.5 font-medium">Scope</th>}
              <th className="px-2 py-1.5 font-medium">Who</th>
              <th className="px-2 py-1.5 font-medium">How</th>
            </tr>
          </thead>
          <tbody>
            {entries.length === 0 && !loading ? (
              <tr><td colSpan={perSecret ? 4 : 6} className="px-2 py-4 text-center text-fg-3">No audit events.</td></tr>
            ) : entries.map(e => (
              <tr key={e.id} data-testid="audit-row" className="border-b border-border last:border-b-0">
                <td className="whitespace-nowrap px-2 py-1.5 text-fg-3">{fmtTime(e.at)}</td>
                <td className={`whitespace-nowrap px-2 py-1.5 ${ACTION_TONES[e.action] ?? 'text-fg-1'}`}>
                  {AUDIT_ACTION_LABELS[e.action] ?? e.action}
                </td>
                {!perSecret && <td className="px-2 py-1.5 font-mono text-fg-1">{e.key}</td>}
                {!perSecret && <td className="px-2 py-1.5 text-fg-2">{e.scope}</td>}
                <td className="px-2 py-1.5 text-fg-2">{actorLabel(e)}</td>
                <td className="px-2 py-1.5 text-fg-3">
                  {e.source ?? '—'}
                  {e.detail && <span className="ml-1 text-fg-3">· {e.detail}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-2 flex items-center gap-3">
        {loading && <span className="text-[12px] text-fg-3">Loading…</span>}
        {next != null && !loading && (
          <button type="button" onClick={() => void load(next)} className="text-xs text-accent hover:underline" data-testid="audit-load-more">
            Load more
          </button>
        )}
      </div>
    </div>
  )

  if (perSecret) return body

  return (
    <section className="mt-6 rounded-lg border border-border bg-surface-raised">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        data-testid="audit-log-toggle"
        className="flex w-full items-center justify-between px-4 py-3 text-left"
      >
        <span>
          <span className="text-sm font-medium text-fg-0">Audit log</span>
          <span className="ml-2 text-xs text-fg-3">who created, rotated, deleted, used or tried to reveal a secret</span>
        </span>
        <span className="text-xs text-fg-3">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && <div className="border-t border-border p-4">{body}</div>}
    </section>
  )
}
