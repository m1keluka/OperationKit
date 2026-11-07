/**
 * Agent webhooks — Settings → You (obj 719278).
 * Per agent key: where to POST when a card that key created or started moves,
 * the sender key the bot expects (stored in Secrets, never shown again), which
 * events to send, a test button and the recent delivery log.
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
import { fmtDate } from './helpers'
import {
  AGENT_WEBHOOK_EVENTS,
  AGENT_WEBHOOK_EVENT_DESCRIPTIONS,
  DEFAULT_AGENT_WEBHOOK_EVENTS,
  type AgentApiKeySummary,
  type AgentWebhookConfig,
  type AgentWebhookDelivery,
  type AgentWebhookEvent,
} from '@operationkit/shared'

const INPUT =
  'mt-1 min-h-[44px] w-full rounded border border-line bg-surface px-2.5 py-2 text-sm text-fg-0 placeholder:text-fg-3 transition-colors duration-base hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 sm:min-h-[36px]'

function errorText(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return (err.body as { error?: string })?.error || err.message
  return err instanceof Error ? err.message : fallback
}

type TestResult = { delivered: boolean; status_code: number | null; error: string | null }

const DELIVERY_TONE: Record<AgentWebhookDelivery['status'], 'verify' | 'amber' | 'alarm'> = {
  delivered: 'verify',
  pending: 'amber',
  failed: 'alarm',
}

export function AgentWebhooksSection() {
  const [keys, setKeys] = useState<AgentApiKeySummary[] | null>(null)
  const [hooks, setHooks] = useState<Record<number, AgentWebhookConfig | null>>({})
  const [openId, setOpenId] = useState<number | null>(null)
  const [error, setError] = useState('')

  async function loadHook(id: number) {
    try {
      const res = await api.get<{ webhook: AgentWebhookConfig | null }>(`/auth/agent-keys/${id}/webhook`)
      setHooks(prev => ({ ...prev, [id]: res?.webhook ?? null }))
    } catch {
      setHooks(prev => ({ ...prev, [id]: null }))
    }
  }

  useEffect(() => {
    void (async () => {
      try {
        const res = await api.get<{ keys: AgentApiKeySummary[] }>('/auth/agent-keys')
        const active = (res?.keys ?? []).filter(k => !k.revoked_at)
        setKeys(active)
        await Promise.all(active.map(k => loadHook(k.id)))
      } catch (err) {
        setError(errorText(err, 'Failed to load agent keys'))
        setKeys([])
      }
    })()
  }, [])

  return (
    <section className="mt-6 rounded-lg border border-border bg-surface-raised p-5" aria-labelledby="agent-webhooks-heading">
      <div className="mb-4">
        <h2 id="agent-webhooks-heading" className="text-base font-semibold text-fg-0">Agent webhooks</h2>
        <p className="mt-1 max-w-prose text-xs text-fg-2">
          Wake a bot when a card it created or started changes status, instead of it polling. Each POST carries the
          card id, title, status, PR and link — never a secret or transcript — and is signed with the sender key.
        </p>
      </div>

      {error && (
        <div role="alert" className="mb-3 rounded bg-signal-alarm/10 px-3 py-2 text-sm text-signal-alarm">{error}</div>
      )}

      {keys === null ? (
        <div className="space-y-2" aria-busy="true">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : keys.length === 0 ? (
        <div className="rounded-md border border-dashed border-line px-4 py-6 text-center">
          <p className="text-sm text-fg-1">No active agent keys.</p>
          <p className="mt-1 text-xs text-fg-2">Create an agent key above, then give it a webhook here.</p>
        </div>
      ) : (
        <ul className="divide-y divide-line-soft rounded-md border border-line">
          {keys.map(k => {
            const hook = hooks[k.id]
            const open = openId === k.id
            return (
              <li key={k.id} className="p-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-fg-0">{k.label}</span>
                      {hook === undefined ? (
                        <Skeleton className="h-4 w-14" />
                      ) : hook === null ? (
                        <Badge>no webhook</Badge>
                      ) : hook.enabled ? (
                        <Badge tone="verify">on</Badge>
                      ) : (
                        <Badge tone="amber">paused</Badge>
                      )}
                    </div>
                    {hook && <p className="truncate font-mono text-[11px] text-fg-2">{hook.url}</p>}
                  </div>
                  <Button
                    className="min-h-[44px] shrink-0 self-start sm:min-h-0 sm:self-center"
                    aria-expanded={open}
                    onClick={() => setOpenId(open ? null : k.id)}
                  >
                    {open ? 'Close' : hook ? 'Edit webhook' : 'Add webhook'}
                  </Button>
                </div>
                {open && (
                  <WebhookEditor
                    keyId={k.id}
                    label={k.label}
                    hook={hook ?? null}
                    onSaved={w => setHooks(prev => ({ ...prev, [k.id]: w }))}
                  />
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

function WebhookEditor({
  keyId,
  label,
  hook,
  onSaved,
}: {
  keyId: number
  label: string
  hook: AgentWebhookConfig | null
  onSaved: (w: AgentWebhookConfig | null) => void
}) {
  const [url, setUrl] = useState(hook?.url ?? '')
  const [secret, setSecret] = useState('')
  const [headerName, setHeaderName] = useState(hook?.header_name ?? 'Authorization')
  const [headerPrefix, setHeaderPrefix] = useState(hook?.header_prefix ?? 'Bearer ')
  // obj 900270: needs_agent is offered on every key (the label pilot is gone) — the
  // one shared connection opts in here. A saved webhook keeps exactly its events.
  const offeredEvents = AGENT_WEBHOOK_EVENTS
  const [events, setEvents] = useState<AgentWebhookEvent[]>(hook?.events ?? [...DEFAULT_AGENT_WEBHOOK_EVENTS])
  const [enabled, setEnabled] = useState(hook?.enabled ?? true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [test, setTest] = useState<TestResult | null>(null)
  const [deliveries, setDeliveries] = useState<AgentWebhookDelivery[] | null>(hook ? null : [])
  const { confirm, confirmDialog } = useConfirm()

  async function loadDeliveries() {
    try {
      const res = await api.get<{ deliveries: AgentWebhookDelivery[] }>(`/auth/agent-keys/${keyId}/webhook/deliveries?limit=20`)
      setDeliveries(res?.deliveries ?? [])
    } catch {
      setDeliveries([])
    }
  }

  useEffect(() => {
    if (hook) void loadDeliveries()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyId])

  function toggleEvent(e: AgentWebhookEvent) {
    setEvents(prev => (prev.includes(e) ? prev.filter(x => x !== e) : AGENT_WEBHOOK_EVENTS.filter(x => x === e || prev.includes(x))))
  }

  const needsSecret = !hook?.has_secret
  const canSave = url.trim().length > 0 && events.length > 0 && headerName.trim().length > 0 && (!needsSecret || secret.length >= 8)

  async function save() {
    if (!canSave) return
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const res = await api.put<{ webhook: AgentWebhookConfig }>(`/auth/agent-keys/${keyId}/webhook`, {
        url: url.trim(),
        header_name: headerName.trim(),
        header_prefix: headerPrefix,
        events,
        enabled,
        ...(secret ? { secret } : {}),
      })
      setSecret('')
      onSaved(res?.webhook ?? null)
      setNotice('Saved. The sender key is stored in Secrets and will not be shown again.')
      void loadDeliveries()
    } catch (err) {
      setError(errorText(err, 'Save failed'))
    } finally {
      setSaving(false)
    }
  }

  async function sendTest() {
    setTesting(true)
    setError('')
    setTest(null)
    try {
      const res = await api.post<TestResult>(`/auth/agent-keys/${keyId}/webhook/test`)
      setTest(res ?? null)
      void loadDeliveries()
    } catch (err) {
      setError(errorText(err, 'Test failed'))
    } finally {
      setTesting(false)
    }
  }

  async function remove() {
    const ok = await confirm({
      title: `Remove the webhook for “${label}”?`,
      message: 'Its sender key is deleted from Secrets and queued deliveries are dropped. The agent key keeps working.',
      confirmLabel: 'Remove',
      danger: true,
    })
    if (!ok) return
    setRemoving(true)
    setError('')
    try {
      await api.del(`/auth/agent-keys/${keyId}/webhook`)
      onSaved(null)
    } catch (err) {
      setError(errorText(err, 'Remove failed'))
      setRemoving(false)
    }
  }

  const id = (s: string) => `wh-${keyId}-${s}`

  return (
    <form
      className="mt-3 space-y-4 rounded-md border border-line bg-surface-1 p-4"
      onSubmit={e => { e.preventDefault(); void save() }}
    >
      {error && <div role="alert" className="rounded bg-signal-alarm/10 px-3 py-2 text-sm text-signal-alarm">{error}</div>}
      {notice && <div role="status" className="rounded bg-accent/10 px-3 py-2 text-sm text-fg-0">{notice}</div>}

      <div>
        <label htmlFor={id('url')} className="block text-xs font-medium text-fg-1">Webhook URL</label>
        <input
          id={id('url')}
          type="url"
          inputMode="url"
          value={url}
          onChange={e => setUrl(e.target.value)}
          placeholder="https://bot.example.com/cc-events"
          className={cn(INPUT, 'font-mono')}
        />
      </div>

      <div>
        <label htmlFor={id('secret')} className="block text-xs font-medium text-fg-1">Sender key</label>
        <input
          id={id('secret')}
          type="password"
          autoComplete="new-password"
          value={secret}
          onChange={e => setSecret(e.target.value)}
          placeholder={hook?.has_secret ? 'Stored — leave blank to keep it' : 'The key your bot expects (min 8 characters)'}
          className={cn(INPUT, 'font-mono')}
        />
        <p className="mt-1 text-[11px] text-fg-2">
          Sent as the auth header below and used to sign each body (<span className="font-mono">X-CC-Signature: sha256=…</span>).
          {hook?.has_secret && <> Stored in Secrets as <span className="font-mono">{hook.secret_name}</span>.</>}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={id('hname')} className="block text-xs font-medium text-fg-1">Header name</label>
          <input id={id('hname')} value={headerName} maxLength={64} onChange={e => setHeaderName(e.target.value)} className={cn(INPUT, 'font-mono')} />
        </div>
        <div>
          <label htmlFor={id('hprefix')} className="block text-xs font-medium text-fg-1">Value prefix</label>
          <input id={id('hprefix')} value={headerPrefix} maxLength={32} onChange={e => setHeaderPrefix(e.target.value)} placeholder="(none)" className={cn(INPUT, 'font-mono')} />
        </div>
      </div>
      <p className="-mt-2 text-[11px] text-fg-2">
        Sends <span className="font-mono text-fg-1">{headerName || '…'}: {headerPrefix}&lt;sender key&gt;</span>
      </p>

      <fieldset>
        <legend className="text-xs font-medium text-fg-1">Send these events</legend>
        <div className="mt-1 grid gap-1 sm:grid-cols-2">
          {offeredEvents.map(e => {
            const on = events.includes(e)
            return (
              <label
                key={e}
                className={cn(
                  'flex min-h-[44px] cursor-pointer items-start gap-2.5 rounded-md border px-2.5 py-2 transition-colors duration-base',
                  on ? 'border-line-strong bg-surface-2' : 'border-transparent hover:bg-surface-2',
                )}
              >
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => toggleEvent(e)}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
                />
                <span className="min-w-0">
                  <span className="block font-mono text-xs text-fg-0">{e}</span>
                  <span className="block text-[11px] text-fg-2">{AGENT_WEBHOOK_EVENT_DESCRIPTIONS[e]}</span>
                </span>
              </label>
            )
          })}
        </div>
      </fieldset>

      <label className="flex min-h-[44px] cursor-pointer items-center gap-2.5">
        <input
          type="checkbox"
          checked={enabled}
          onChange={e => setEnabled(e.target.checked)}
          className="h-4 w-4 accent-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
        />
        <span className="text-sm text-fg-1">Enabled</span>
      </label>

      <div className="flex flex-wrap gap-2 pt-1">
        <Button type="submit" variant="primary" loading={saving} disabled={!canSave}>
          Save webhook
        </Button>
        {hook && (
          <Button type="button" loading={testing} onClick={() => void sendTest()}>
            Send test event
          </Button>
        )}
        {hook && (
          <Button type="button" variant="danger" loading={removing} onClick={() => void remove()}>
            Remove
          </Button>
        )}
      </div>

      {test && (
        <p role="status" className={cn('text-sm', test.delivered ? 'text-signal-verify' : 'text-signal-alarm')}>
          {test.delivered ? `Delivered — receiver answered ${test.status_code}.` : `Not delivered — ${test.error ?? 'no response'}.`}
        </p>
      )}

      {hook && (
        <div>
          <h3 className="text-xs font-medium text-fg-1">Recent deliveries</h3>
          {deliveries === null ? (
            <div className="mt-2 space-y-1.5" aria-busy="true">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : deliveries.length === 0 ? (
            <p className="mt-2 rounded-md border border-dashed border-line px-3 py-3 text-center text-xs text-fg-2">
              Nothing sent yet. Use “Send test event” to check the receiver.
            </p>
          ) : (
            <ul className="mt-2 divide-y divide-line-soft rounded-md border border-line" aria-label="Recent deliveries">
              {deliveries.map(d => (
                <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-xs">
                  <Badge tone={DELIVERY_TONE[d.status]}>{d.status}</Badge>
                  <span className="font-mono text-fg-0">{d.event}</span>
                  <span className="text-fg-2">{d.objective_id ? `#${d.objective_id}` : 'test'}</span>
                  <span className="text-fg-2">
                    {d.attempts} {d.attempts === 1 ? 'try' : 'tries'}
                    {d.last_status_code != null && <> · HTTP {d.last_status_code}</>}
                  </span>
                  {d.last_error && d.status !== 'delivered' && <span className="min-w-0 truncate text-signal-alarm">{d.last_error}</span>}
                  <span className="ml-auto text-fg-3">{fmtDate(d.delivered_at ?? d.created_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {confirmDialog}
    </form>
  )
}
