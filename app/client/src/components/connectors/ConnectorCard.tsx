/**
 * One connector in Settings → Connectors. Renders entirely from the server's
 * ConnectorSummary, so a new connector needs no client code.
 *
 * Credentials: a pasted token lives in this component's state only until the
 * server accepts it, then it is cleared. Nothing the server returns contains
 * one, and nothing here renders one.
 */
import { useState } from 'react'
import type { ConnectorAccess, ConnectorStatus, ConnectorSummary } from '@operationkit/shared'
import { Badge, Button, Card } from '../ui'
import { AccessEditor } from './AccessEditor'
import { fmtDate } from '../account-settings/helpers'

function StateBadge({ status, available }: { status: ConnectorStatus; available: boolean }) {
  if (status.state === 'connected') return <Badge tone="verify">Connected</Badge>
  if (status.state === 'error') return <Badge tone="alarm">Needs attention</Badge>
  if (!available) return <Badge tone="neutral">Not set up</Badge>
  return <Badge tone="neutral">Not connected</Badge>
}

function accessSummary(a: ConnectorAccess): string {
  const agents = a.agents === null ? 'all agents' : a.agents.length === 0 ? 'no agents' : `${a.agents.length} agent${a.agents.length === 1 ? '' : 's'}`
  const ws = a.workspaces === null ? 'every workspace' : a.workspaces.length === 0 ? 'no workspaces' : `${a.workspaces.length} workspace${a.workspaces.length === 1 ? '' : 's'}`
  return `Used by ${agents} in ${ws}`
}

export interface ConnectorActions {
  /** Resolves true when the server accepted it (or sent the browser off to sign in). */
  connect: (id: string, fields?: Record<string, string>) => Promise<boolean>
  check: (id: string) => Promise<void>
  disconnect: (c: ConnectorSummary) => Promise<void>
  saveAccess: (id: string, access: ConnectorAccess) => Promise<void>
}

export function ConnectorCard({
  connector: c,
  actions,
  agents,
  workspaces,
}: {
  connector: ConnectorSummary
  actions: ConnectorActions
  agents: { value: string; label: string }[]
  workspaces: { value: string; label: string }[]
}) {
  const [fields, setFields] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<'connect' | 'check' | 'disconnect' | null>(null)
  const [showAccess, setShowAccess] = useState(false)
  const connected = c.status.state !== 'not_connected'

  async function run(kind: 'connect' | 'check' | 'disconnect', fn: () => Promise<unknown>) {
    setBusy(kind)
    try {
      const ok = await fn()
      if (kind === 'connect' && ok) setFields({}) // never keep an accepted credential around
    } finally {
      setBusy(null)
    }
  }

  const tokenFields = c.connect.kind === 'token' ? c.connect.fields : []
  const canSubmitToken = tokenFields.every(f => (fields[f.key] ?? '').trim().length > 0)

  return (
    <Card inset className="overflow-hidden">
      <section aria-labelledby={`connector-${c.id}`}>
        <div className="flex flex-wrap items-start justify-between gap-3 p-4 sm:p-5">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 id={`connector-${c.id}`} className="font-display text-[16px] font-semibold tracking-[-0.01em] text-fg-0">
                {c.name}
              </h2>
              <StateBadge status={c.status} available={c.available} />
            </div>
            <p className="mt-1 max-w-prose text-[13px] leading-relaxed text-fg-2">{c.description}</p>
            {c.products.length > 0 && (
              <ul className="mt-3 flex flex-wrap gap-1.5" aria-label={`What ${c.name} covers`}>
                {c.products.map(p => (
                  <li key={p.id} title={p.description}>
                    <Badge>{p.name}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="border-t border-line-soft p-4 sm:p-5">
          {connected ? (
            <div className="space-y-4">
              {c.status.error && <p className="text-[13px] text-signal-alarm">{c.status.error}</p>}
              <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
                <div>
                  <dt className="text-[11px] uppercase tracking-wider text-fg-3">Connected as</dt>
                  <dd className="break-all text-[13px] text-fg-0">{c.status.account ?? '—'}</dd>
                </div>
                {c.status.details.map(d => (
                  <div key={d.label}>
                    <dt className="text-[11px] uppercase tracking-wider text-fg-3">{d.label}</dt>
                    <dd className="break-all text-[13px] text-fg-1">{d.value}</dd>
                  </div>
                ))}
                <div>
                  <dt className="text-[11px] uppercase tracking-wider text-fg-3">Connected</dt>
                  <dd className="text-[13px] text-fg-1">{fmtDate(c.status.connected_at)}</dd>
                </div>
                <div>
                  <dt className="text-[11px] uppercase tracking-wider text-fg-3">Last checked</dt>
                  <dd className="text-[13px] text-fg-1">{fmtDate(c.status.checked_at)}</dd>
                </div>
              </dl>
              <div className="flex flex-wrap gap-2">
                {c.can_check && (
                  <Button
                    loading={busy === 'check'}
                    disabled={busy !== null}
                    onClick={() => run('check', () => actions.check(c.id))}
                  >
                    Check connection
                  </Button>
                )}
                <Button
                  variant="danger"
                  loading={busy === 'disconnect'}
                  disabled={busy !== null}
                  onClick={() => run('disconnect', () => actions.disconnect(c))}
                >
                  Disconnect
                </Button>
              </div>
            </div>
          ) : !c.available ? (
            <p className="text-[13px] text-fg-2">{c.unavailable_reason}</p>
          ) : c.connect.kind === 'oauth' ? (
            <Button
              variant="primary"
              loading={busy === 'connect'}
              onClick={() => run('connect', () => actions.connect(c.id))}
            >
              {c.connect.button_label}
            </Button>
          ) : (
            <form
              className="space-y-3"
              onSubmit={e => {
                e.preventDefault()
                if (canSubmitToken) void run('connect', () => actions.connect(c.id, fields))
              }}
            >
              {tokenFields.map(f => (
                <div key={f.key}>
                  <label htmlFor={`${c.id}-${f.key}`} className="mb-1 block text-[12px] font-medium text-fg-1">
                    {f.label}
                  </label>
                  <input
                    id={`${c.id}-${f.key}`}
                    type={f.secret ? 'password' : 'text'}
                    autoComplete="off"
                    spellCheck={false}
                    value={fields[f.key] ?? ''}
                    onChange={e => setFields(prev => ({ ...prev, [f.key]: e.target.value }))}
                    placeholder={f.placeholder}
                    className="min-h-[44px] w-full rounded-md border border-line bg-surface-1 px-3 font-mono text-[13px] text-fg-0 outline-none transition-colors duration-fast ease-out placeholder:text-fg-3 hover:border-line-strong focus:border-accent focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-[36px]"
                  />
                  {f.help && <p className="mt-1 text-[12px] leading-relaxed text-fg-3">{f.help}</p>}
                </div>
              ))}
              <Button type="submit" variant="primary" loading={busy === 'connect'} disabled={!canSubmitToken}>
                Connect {c.name}
              </Button>
            </form>
          )}
        </div>

        <div className="border-t border-line-soft">
          <button
            type="button"
            aria-expanded={showAccess}
            aria-controls={`connector-access-${c.id}`}
            onClick={() => setShowAccess(s => !s)}
            className="flex min-h-[44px] w-full items-center justify-between gap-3 px-4 py-2 text-left transition-colors duration-fast ease-out hover:bg-surface-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/50 sm:px-5"
          >
            <span>
              <span className="block text-[13px] font-medium text-fg-0">Who can use it</span>
              <span className="block text-[12px] text-fg-3">{accessSummary(c.access)}</span>
            </span>
            <svg
              aria-hidden="true"
              viewBox="0 0 20 20"
              className={`h-4 w-4 shrink-0 text-fg-3 transition-transform duration-fast ease-out ${showAccess ? 'rotate-180' : ''}`}
              fill="currentColor"
            >
              <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 0 1 1.06.02L10 11.06l3.71-3.83a.75.75 0 1 1 1.08 1.04l-4.25 4.39a.75.75 0 0 1-1.08 0L5.21 8.27a.75.75 0 0 1 .02-1.06Z" clipRule="evenodd" />
            </svg>
          </button>
          {showAccess && (
            <div id={`connector-access-${c.id}`} className="px-4 pb-5 pt-1 sm:px-5">
              <p className="mb-3 text-[12px] leading-relaxed text-fg-3">
                Agents never see the credential itself. A session only gets it when it starts, and only for the agents and workspaces picked here.
              </p>
              <AccessEditor
                access={c.access}
                agents={agents}
                workspaces={workspaces}
                onSave={next => actions.saveAccess(c.id, next)}
              />
            </div>
          )}
        </div>
      </section>
    </Card>
  )
}
