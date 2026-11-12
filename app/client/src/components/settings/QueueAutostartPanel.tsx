/**
 * Queue auto-start (obj 900625), shown on the Jobs page (moved there from
 * Settings → Platform in obj 900686). Admin only: JobsBoard renders it for
 * global admins and the API is under /api/admin.
 *
 * One switch per workspace. ON means: queued task/bug cards in that workspace start
 * on their own when a session slot and a seat are free — but only cards that enter
 * the queue after the switch was turned on, or whose start hit the session cap.
 * The backlog that was already queued is never swept up.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, ApiError } from '../../lib/api'
import { useWorkspaces } from '../../hooks/useWorkspaces'
import { Alert, Badge, Card, Skeleton, cn } from '../ui'

export interface QueueAutostartWorkspace {
  workspace: string
  enabled: boolean
  source: 'setting' | 'env' | 'setting+env'
  enabled_at: string
  ceiling_policy: 'enforce' | 'observe' | 'off'
  ceiling_policy_source: string
  ceiling_configured: boolean
  ceiling_source: string
}

export interface QueueAutostartState {
  workspaces: QueueAutostartWorkspace[]
  max_concurrent: number
  max_concurrent_source: string
  in_flight: number
  grace_minutes: number
}

function errText(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message || fallback
  if (err instanceof Error) return err.message || fallback
  return fallback
}

function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="group inline-flex min-h-[44px] items-center rounded-md px-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:cursor-not-allowed disabled:opacity-45"
    >
      <span
        aria-hidden="true"
        className={cn(
          'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors duration-base ease-out',
          checked ? 'border-transparent bg-accent' : 'border-line-strong bg-surface-3 group-hover:bg-surface-4',
        )}
      >
        <span className={cn('inline-block h-3.5 w-3.5 rounded-full bg-fg-0 transition-transform duration-base ease-out', checked ? 'translate-x-[18px]' : 'translate-x-[2px]')} />
      </span>
    </button>
  )
}

export function QueueAutostartPanel() {
  const { slugs, labelOf } = useWorkspaces()
  const [state, setState] = useState<QueueAutostartState | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(() => {
    api.get<QueueAutostartState>('/admin/queue-autostart')
      .then(setState)
      .catch(err => setError(errText(err, 'Could not load the queue auto-start setting.')))
  }, [])
  useEffect(load, [load])

  const byWorkspace = useMemo(() => new Map((state?.workspaces ?? []).map(w => [w.workspace, w])), [state])
  const rows = useMemo(() => {
    const all = slugs.filter(s => s !== 'all')
    for (const w of state?.workspaces ?? []) if (!all.includes(w.workspace)) all.push(w.workspace)
    return all
  }, [slugs, state])

  const toggle = async (workspace: string, enabled: boolean) => {
    setBusy(workspace)
    setError('')
    try {
      setState(await api.put<QueueAutostartState>(`/admin/queue-autostart/${encodeURIComponent(workspace)}`, { enabled }))
    } catch (err) {
      setError(errText(err, 'Saving the queue auto-start setting failed.'))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card className="space-y-3" aria-labelledby="queue-autostart-title">
      <div className="space-y-1">
        <h3 id="queue-autostart-title" className="font-display text-[15px] font-semibold tracking-[-0.01em] text-fg-0">Queue auto-start</h3>
        <p className="text-[12.5px] text-fg-2">
          Queued task and bug cards start on their own when a session slot and a seat are free. Only cards that enter the
          queue after you switch a workspace on — or whose start hit the session limit — are started; the existing backlog is
          left alone. Held cards and cards waiting on another card are skipped.
        </p>
      </div>

      {error && <Alert tone="alarm">{error}</Alert>}

      {!state ? (
        <div className="space-y-2" aria-hidden="true">
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-full" />
        </div>
      ) : (
        <>
          <ul className="divide-y divide-line rounded-md border border-line" aria-label="Queue auto-start by workspace">
            {rows.map(ws => {
              const on = byWorkspace.get(ws)
              const envLocked = !!on && on.source !== 'setting'
              return (
                <li key={ws} className="flex min-h-[44px] flex-wrap items-center gap-2 px-3 py-1.5">
                  <span className="flex-1 text-[13px] text-fg-1">{labelOf(ws)}</span>
                  {on && !on.ceiling_configured && on.ceiling_policy === 'enforce' && (
                    <Badge tone="amber">No job ceiling — cards will not start</Badge>
                  )}
                  {on && on.ceiling_policy === 'observe' && <Badge tone="info">Unbudgeted starts allowed</Badge>}
                  {envLocked && <Badge tone="neutral">Set by server env</Badge>}
                  {on && <span className="font-mono text-[12px] text-fg-3">since {on.enabled_at} UTC</span>}
                  <Toggle
                    checked={!!on}
                    onChange={v => void toggle(ws, v)}
                    disabled={busy !== null || (envLocked && !!on)}
                    label={`Queue auto-start for ${labelOf(ws)}`}
                  />
                </li>
              )
            })}
          </ul>
          <p className="text-[12px] text-fg-3">
            At most {state.max_concurrent} auto-started cards run at once ({state.in_flight} running now). A new card waits{' '}
            {state.grace_minutes} min before it is eligible. A workspace needs a finite job ceiling unless its policy is set to observe.
          </p>
        </>
      )}
    </Card>
  )
}
