/**
 * Agent keys — Settings → You (obj 714090).
 * One named, scoped key per Grok Bot / agent, instead of every bot sharing the
 * full-access API key above. Done + delete stay a human signature by default.
 */
import { useEffect, useState } from 'react'
import { api, ApiError } from '../../lib/api'
import { useConfirm } from '../ui'
// Direct module paths (not the '../ui' barrel) so suites that mock the barrel
// with only useConfirm still render this card.
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { Skeleton } from '../../components/ui/Skeleton'
import { cn } from '../../components/ui/cn'
import { useWorkspaces } from '../../hooks/useWorkspaces'
import { fmtDate } from './helpers'
import {
  AGENT_SCOPES,
  AGENT_SCOPE_DESCRIPTIONS,
  DEFAULT_AGENT_SCOPES,
  type AgentApiKeyIssued,
  type AgentApiKeySummary,
  type AgentScope,
} from '@operationkit/shared'

const HUMAN_SIGNATURE: AgentScope[] = ['board:done', 'board:delete']

function errorText(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return (err.body as { error?: string })?.error || err.message
  return err instanceof Error ? err.message : fallback
}

export function AgentKeysSection() {
  const [keys, setKeys] = useState<AgentApiKeySummary[] | null>(null)
  const [error, setError] = useState('')
  const [formOpen, setFormOpen] = useState(false)
  const [label, setLabel] = useState('')
  const [scopes, setScopes] = useState<AgentScope[]>([...DEFAULT_AGENT_SCOPES])
  const [restrict, setRestrict] = useState(false)
  const [allowed, setAllowed] = useState<string[]>([])
  const [creating, setCreating] = useState(false)
  const [revoking, setRevoking] = useState<number | null>(null)
  const [issued, setIssued] = useState<AgentApiKeyIssued | null>(null)
  const [copied, setCopied] = useState(false)
  const { confirm, confirmDialog } = useConfirm()
  const { workspaces, labelOf } = useWorkspaces()

  async function reload() {
    try {
      const res = await api.get<{ keys: AgentApiKeySummary[] }>('/auth/agent-keys')
      setKeys(res?.keys ?? [])
    } catch (err) {
      setError(errorText(err, 'Failed to load agent keys'))
      setKeys([])
    }
  }

  useEffect(() => { void reload() }, [])

  function resetForm() {
    setLabel('')
    setScopes([...DEFAULT_AGENT_SCOPES])
    setRestrict(false)
    setAllowed([])
  }

  function toggleScope(s: AgentScope) {
    setScopes(prev => (prev.includes(s) ? prev.filter(x => x !== s) : AGENT_SCOPES.filter(x => x === s || prev.includes(x))))
  }

  function toggleWorkspace(slug: string) {
    setAllowed(prev => (prev.includes(slug) ? prev.filter(x => x !== slug) : [...prev, slug]))
  }

  const canCreate = label.trim().length > 0 && scopes.length > 0 && (!restrict || allowed.length > 0)

  async function create() {
    if (!canCreate) return
    setCreating(true)
    setError('')
    setCopied(false)
    try {
      const key = await api.post<AgentApiKeyIssued>('/auth/agent-keys', {
        label: label.trim(),
        scopes,
        workspaces: restrict ? allowed : null,
      })
      setIssued(key)
      setFormOpen(false)
      resetForm()
      await reload()
    } catch (err) {
      setError(errorText(err, 'Create failed'))
    } finally {
      setCreating(false)
    }
  }

  async function revoke(key: AgentApiKeySummary) {
    const ok = await confirm({
      title: `Revoke “${key.label}”?`,
      message: 'Anything using this key gets 401 immediately. Other keys keep working.',
      confirmLabel: 'Revoke',
      danger: true,
    })
    if (!ok) return
    setRevoking(key.id)
    setError('')
    try {
      await api.del(`/auth/agent-keys/${key.id}`)
      if (issued?.id === key.id) setIssued(null)
      await reload()
    } catch (err) {
      setError(errorText(err, 'Revoke failed'))
    } finally {
      setRevoking(null)
    }
  }

  async function copy() {
    if (!issued) return
    try {
      await navigator.clipboard.writeText(issued.token)
      setCopied(true)
    } catch {
      setError('Could not copy — select the key and copy it yourself.')
    }
  }

  const active = (keys ?? []).filter(k => !k.revoked_at)
  const revoked = (keys ?? []).filter(k => k.revoked_at)

  return (
    <section className="mt-6 rounded-lg border border-border bg-surface-raised p-5" aria-labelledby="agent-keys-heading">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 id="agent-keys-heading" className="text-base font-semibold text-fg-0">Agent keys</h2>
          <p className="mt-1 max-w-prose text-xs text-fg-2">
            One key per bot. Each is its own identity — cards it creates say who made them — and it can
            only do what you tick. Done and delete stay with you unless you grant them.
          </p>
        </div>
        {!formOpen && (
          <Button variant="primary" className="shrink-0" onClick={() => { setFormOpen(true); setIssued(null) }}>
            New agent key
          </Button>
        )}
      </div>

      {error && (
        <div role="alert" className="mb-3 rounded bg-signal-alarm/10 px-3 py-2 text-sm text-signal-alarm">{error}</div>
      )}

      {issued && (
        <div className="mb-4 space-y-2 rounded-md border border-accent/40 bg-surface p-3">
          <p className="text-xs text-fg-1">
            <span className="font-semibold text-fg-0">{issued.label}</span> — copy this now. It will not be shown again.
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              readOnly
              aria-label={`API key for ${issued.label}`}
              value={issued.token}
              onFocus={e => e.currentTarget.select()}
              className="min-h-[44px] w-full rounded border border-line bg-surface-1 px-2.5 py-2 font-mono text-sm text-fg-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 sm:min-h-[36px]"
            />
            <Button variant="primary" className="shrink-0" onClick={() => void copy()}>
              {copied ? 'Copied' : 'Copy'}
            </Button>
            <Button variant="ghost" className="shrink-0" onClick={() => setIssued(null)}>
              Done
            </Button>
          </div>
        </div>
      )}

      {formOpen && (
        <form
          className="mb-5 space-y-4 rounded-md border border-line bg-surface-1 p-4"
          onSubmit={e => { e.preventDefault(); void create() }}
        >
          <div>
            <label htmlFor="agent-key-label" className="block text-xs font-medium text-fg-1">Label</label>
            <input
              id="agent-key-label"
              autoFocus
              maxLength={80}
              value={label}
              onChange={e => setLabel(e.target.value)}
              placeholder="Grok: General"
              className="mt-1 min-h-[44px] w-full rounded border border-line bg-surface px-2.5 py-2 text-sm text-fg-0 placeholder:text-fg-3 transition-colors duration-base hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 sm:min-h-[36px]"
            />
          </div>

          <fieldset>
            <legend className="text-xs font-medium text-fg-1">What it can do</legend>
            <div className="mt-1 grid gap-1 sm:grid-cols-2">
              {AGENT_SCOPES.map(s => {
                const on = scopes.includes(s)
                return (
                  <label
                    key={s}
                    className={cn(
                      'flex min-h-[44px] cursor-pointer items-start gap-2.5 rounded-md border px-2.5 py-2 transition-colors duration-base',
                      on ? 'border-line-strong bg-surface-2' : 'border-transparent hover:bg-surface-2',
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => toggleScope(s)}
                      className="mt-0.5 h-4 w-4 shrink-0 accent-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
                    />
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5 font-mono text-xs text-fg-0">
                        {s}
                        {HUMAN_SIGNATURE.includes(s) && <Badge tone="amber">human</Badge>}
                      </span>
                      <span className="block text-[11px] text-fg-2">{AGENT_SCOPE_DESCRIPTIONS[s]}</span>
                    </span>
                  </label>
                )
              })}
            </div>
          </fieldset>

          <fieldset>
            <legend className="text-xs font-medium text-fg-1">Workspaces</legend>
            <div className="mt-1 flex flex-wrap gap-2">
              <Button type="button" size="sm" variant={!restrict ? 'primary' : 'secondary'} className="min-h-[44px] sm:min-h-0" aria-pressed={!restrict} onClick={() => setRestrict(false)}>
                All my workspaces
              </Button>
              <Button type="button" size="sm" variant={restrict ? 'primary' : 'secondary'} className="min-h-[44px] sm:min-h-0" aria-pressed={restrict} onClick={() => setRestrict(true)}>
                Only some
              </Button>
            </div>
            {restrict && (
              <div className="mt-2 flex flex-wrap gap-2">
                {workspaces.length === 0 && <span className="text-xs text-fg-2">No workspaces visible.</span>}
                {workspaces.map(w => {
                  const on = allowed.includes(w.slug)
                  return (
                    <button
                      key={w.slug}
                      type="button"
                      aria-pressed={on}
                      onClick={() => toggleWorkspace(w.slug)}
                      className={cn(
                        'min-h-[44px] rounded-full border px-3 text-xs transition-colors duration-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 sm:min-h-[32px]',
                        on ? 'border-accent/60 bg-accent/15 text-fg-0' : 'border-line text-fg-1 hover:border-line-strong hover:bg-surface-2',
                      )}
                    >
                      {labelOf(w.slug)}
                    </button>
                  )
                })}
              </div>
            )}
          </fieldset>

          <div className="flex flex-wrap gap-2 pt-1">
            <Button type="submit" variant="primary" loading={creating} disabled={!canCreate}>
              Create key
            </Button>
            <Button type="button" variant="ghost" onClick={() => { setFormOpen(false); resetForm() }}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {keys === null ? (
        <div className="space-y-2" aria-busy="true">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : active.length === 0 && revoked.length === 0 ? (
        <div className="rounded-md border border-dashed border-line px-4 py-6 text-center">
          <p className="text-sm text-fg-1">No agent keys yet.</p>
          <p className="mt-1 text-xs text-fg-2">Make one per outside agent — e.g. “Reporting bot” scoped to one workspace.</p>
        </div>
      ) : (
        <ul className="divide-y divide-line-soft rounded-md border border-line">
          {[...active, ...revoked].map(k => (
            <li key={k.id} className={cn('flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between', k.revoked_at && 'opacity-60')}>
              <div className="min-w-0 space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-fg-0">{k.label}</span>
                  <span className="font-mono text-xs text-fg-2">cc_live_••••{k.last4}</span>
                  {k.revoked_at && <Badge tone="alarm">revoked</Badge>}
                </div>
                <div className="flex flex-wrap gap-1">
                  {k.scopes.map(s => (
                    <Badge key={s} mono tone={HUMAN_SIGNATURE.includes(s) ? 'amber' : 'neutral'}>{s}</Badge>
                  ))}
                  <Badge tone="info">{k.workspaces ? k.workspaces.map(labelOf).join(', ') : 'all workspaces'}</Badge>
                </div>
                <p className="text-[11px] text-fg-2">
                  Created {fmtDate(k.created_at)} · Last used {k.last_used_at ? fmtDate(k.last_used_at) : 'never'}
                  {k.revoked_at && <> · Revoked {fmtDate(k.revoked_at)}</>}
                </p>
              </div>
              {!k.revoked_at && (
                <Button variant="danger" className="shrink-0 self-start sm:self-center" loading={revoking === k.id} onClick={() => void revoke(k)}>
                  Revoke
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {confirmDialog}
    </section>
  )
}
