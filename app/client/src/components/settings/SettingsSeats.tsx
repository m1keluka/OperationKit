/**
 * Settings → Seats (admin only). The subscription seat pool: every Claude /
 * Codex / Grok subscription the server can run sessions on, grouped by engine,
 * with health, usage, credential summary and per-seat actions, plus the
 * per-workspace engine-failover policy.
 *
 * Credentials are write-only here: a pasted token is cleared from state the
 * moment it is submitted and the server only ever sends back the last 4 chars.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { api, ApiError } from '../../lib/api'
import { useWorkspaces } from '../../hooks/useWorkspaces'
import { Alert, Badge, Button, Card, EmptyState, IconButton, Skeleton, cn, useConfirm } from '../../components/ui'
import { SeatDeviceLogin } from './SeatDeviceLogin'

// ── Types (mirror server/src/services/seat-credentials.ts SeatSummary) ──────
export type SeatKind = 'claude' | 'codex' | 'grok'
export type SeatHealth = 'healthy' | 'cooling_down' | 'needs_reconnect' | 'needs_admin' | 'credits_exhausted' | 'disabled'

export interface SeatSummary {
  id: string
  label: string
  kind: SeatKind
  priority: number
  enabled: boolean
  health: SeatHealth
  available: boolean
  cooldownUntil: string | null
  consecutiveFailures: number
  credential: {
    kind: 'setup_token' | 'cli_login'
    last4: string | null
    addedAt: string | null
    expiresAt: string | null
    expiry: 'expired' | 'expiring' | null
  }
  sessions: { active: number; today: number }
  usageToday: { tokens: number; cost: number }
}

interface FailoverPolicy { workspace: string; enabled: boolean; order: SeatKind[] }
type TestOutcome = 'healthy' | 'unparked' | 'parked' | 'rate_limited' | 'inconclusive' | 'skipped'

const ENGINES: { kind: SeatKind; name: string; empty: string }[] = [
  { kind: 'claude', name: 'Claude', empty: 'No Claude seats yet — sessions use the server token if one is set' },
  { kind: 'codex', name: 'Codex', empty: 'No Codex seats' },
  { kind: 'grok', name: 'Grok', empty: 'No Grok seats' },
]
const ENGINE_NAME: Record<SeatKind, string> = { claude: 'Claude', codex: 'Codex', grok: 'Grok' }

const INPUT =
  'min-h-[44px] w-full rounded-md border border-line bg-surface-1 px-3 text-[13px] text-fg-0 outline-none ' +
  'transition-colors duration-fast ease-out placeholder:text-fg-3 hover:border-line-strong focus:border-accent ' +
  'focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-45 sm:min-h-[36px]'

const TEST_COPY: Record<TestOutcome, { ok: boolean; text: string }> = {
  healthy: { ok: true, text: 'works.' },
  unparked: { ok: true, text: 'works again and is back in rotation.' },
  parked: { ok: false, text: 'failed the test and was taken out of rotation.' },
  rate_limited: { ok: false, text: 'is rate limited right now and will cool down.' },
  inconclusive: { ok: false, text: 'test was inconclusive. Try again in a minute.' },
  skipped: { ok: true, text: 'was not tested (nothing to test yet).' },
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function errText(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return (err.body as { error?: string } | null)?.error || err.message || fallback
  return err instanceof Error ? err.message : fallback
}

function fmtTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
function fmtDate(iso: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })
}
const fmtTokens = (n: number) => new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n)

export function healthBadge(seat: Pick<SeatSummary, 'health' | 'cooldownUntil'>): { tone: 'verify' | 'amber' | 'alarm' | 'neutral'; text: string } {
  switch (seat.health) {
    case 'healthy': return { tone: 'verify', text: 'Healthy' }
    case 'cooling_down':
      return { tone: 'amber', text: seat.cooldownUntil ? `Cooling down until ${fmtTime(seat.cooldownUntil)}` : 'Cooling down' }
    case 'needs_reconnect': return { tone: 'alarm', text: 'Needs reconnect' }
    case 'needs_admin': return { tone: 'alarm', text: 'Needs admin' }
    case 'credits_exhausted': return { tone: 'amber', text: 'Credits used up' }
    case 'disabled': return { tone: 'neutral', text: 'Disabled' }
  }
}

function Chevron({ up }: { up?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" className={cn('h-4 w-4', up && 'rotate-180')} fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** Accessible on/off switch with a 44px tap target. */
function Switch({ checked, onChange, label, disabled, busy }: {
  checked: boolean; onChange: (v: boolean) => void; label: ReactNode; disabled?: boolean; busy?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-busy={busy || undefined}
      disabled={disabled || busy}
      onClick={() => onChange(!checked)}
      className="group inline-flex min-h-[44px] items-center gap-2.5 rounded-md px-1 text-left text-[13px] text-fg-1 transition-colors duration-fast ease-out hover:text-fg-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:cursor-not-allowed disabled:opacity-45"
    >
      <span
        className={cn(
          'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors duration-base ease-out',
          checked ? 'border-transparent bg-accent' : 'border-line-strong bg-surface-3 group-hover:bg-surface-4',
        )}
        aria-hidden="true"
      >
        <span
          className={cn(
            'inline-block h-3.5 w-3.5 rounded-full bg-fg-0 transition-transform duration-base ease-out',
            checked ? 'translate-x-[18px]' : 'translate-x-[2px]',
          )}
        />
      </span>
      <span>{label}</span>
    </button>
  )
}

function Field({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-[12.5px] font-medium text-fg-1">{label}</label>
      {children}
      {hint && <p className="text-[12px] leading-relaxed text-fg-3">{hint}</p>}
    </div>
  )
}

function SeatSkeleton() {
  return (
    <div className="rounded-lg border border-line bg-surface-2 p-4" aria-hidden="true">
      <div className="flex items-center gap-2">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-4 w-16" />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-8" />)}
      </div>
      <Skeleton className="mt-4 h-9 w-full sm:w-2/3" />
    </div>
  )
}

type Notice = { ok: boolean; text: string } | null

// ── Add Claude seat form ────────────────────────────────────────────────────
function AddClaudeForm({ onAdded, onCancel, onNotice }: {
  onAdded: (seat: SeatSummary) => void; onCancel: () => void; onNotice: (n: Notice) => void
}) {
  const [label, setLabel] = useState('')
  const [token, setToken] = useState('')
  const [expiresAt, setExpiresAt] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const credential = token.trim()
    // Drop the value from state before the request is even sent.
    setToken('')
    if (!credential) {
      setError('Paste the setup token first.')
      return
    }
    setSaving(true)
    setError('')
    try {
      const body: Record<string, unknown> = { kind: 'claude', credential }
      if (label.trim()) body.label = label.trim()
      if (expiresAt) body.expiresAt = expiresAt
      const res = await api.post<{ ok: boolean; seat: SeatSummary }>('/admin/seats', body)
      onNotice({ ok: true, text: `${res.seat?.label || 'Claude seat'} added.` })
      onAdded(res.seat)
    } catch (err) {
      setError(errText(err, 'Adding the seat failed.'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3 rounded-md border border-line bg-surface-1 p-4" aria-label="Add Claude seat">
      <Field label="Label" htmlFor="seat-claude-label">
        <input id="seat-claude-label" className={INPUT} value={label} onChange={e => setLabel(e.target.value)} placeholder="Seat 1" autoComplete="off" disabled={saving} />
      </Field>
      <Field
        label="Setup token"
        htmlFor="seat-claude-token"
        hint={<>Run <code className="font-mono text-fg-2">claude setup-token</code> on a machine signed in to the subscription and paste the token. It is stored encrypted and never shown again.</>}
      >
        <input
          id="seat-claude-token"
          type="password"
          autoComplete="off"
          spellCheck={false}
          className={cn(INPUT, 'font-mono')}
          value={token}
          onChange={e => setToken(e.target.value)}
          disabled={saving}
        />
      </Field>
      <Field label="Expires (optional)" htmlFor="seat-claude-expiry">
        <input id="seat-claude-expiry" type="date" className={cn(INPUT, 'sm:max-w-[220px]')} value={expiresAt} onChange={e => setExpiresAt(e.target.value)} disabled={saving} />
      </Field>
      {error && <Alert tone="alarm">{error}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" loading={saving}>Add seat</Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={saving}>Cancel</Button>
      </div>
    </form>
  )
}

// ── One seat ────────────────────────────────────────────────────────────────
function SeatCard({ seat, onChange, onRemoved, onNotice, confirm }: {
  seat: SeatSummary
  onChange: (seat: SeatSummary) => void
  onRemoved: (id: string) => void
  onNotice: (n: Notice) => void
  confirm: ReturnType<typeof useConfirm>['confirm']
}) {
  const [busy, setBusy] = useState<null | 'rename' | 'priority' | 'enabled' | 'test' | 'rotate' | 'remove'>(null)
  const [renaming, setRenaming] = useState(false)
  const [labelDraft, setLabelDraft] = useState(seat.label)
  const [priorityDraft, setPriorityDraft] = useState(String(seat.priority))
  const [rotating, setRotating] = useState(false)
  const [rotateToken, setRotateToken] = useState('')
  const [rotateExpiry, setRotateExpiry] = useState('')
  const [rowError, setRowError] = useState('')
  const id = encodeURIComponent(seat.id)
  const name = seat.label || `${ENGINE_NAME[seat.kind]} seat`
  const badge = healthBadge(seat)
  const isClaude = seat.kind === 'claude'

  useEffect(() => { setPriorityDraft(String(seat.priority)) }, [seat.priority])

  const patch = async (what: 'rename' | 'priority' | 'enabled', body: Record<string, unknown>) => {
    setBusy(what)
    setRowError('')
    try {
      const res = await api.patch<{ ok: boolean; seat: SeatSummary }>(`/admin/seats/${id}`, body)
      onChange(res.seat)
      return true
    } catch (err) {
      setRowError(errText(err, 'Saving failed.'))
      return false
    } finally {
      setBusy(null)
    }
  }

  const saveLabel = async () => {
    const next = labelDraft.trim()
    if (next === seat.label) { setRenaming(false); return }
    if (await patch('rename', { label: next })) setRenaming(false)
  }

  const savePriority = async (value: number) => {
    if (!Number.isFinite(value) || value === seat.priority) { setPriorityDraft(String(seat.priority)); return }
    await patch('priority', { priority: Math.round(value) })
  }

  const test = async () => {
    setBusy('test')
    setRowError('')
    onNotice(null)
    try {
      const res = await api.post<{ ok: boolean; outcome: TestOutcome; seat: SeatSummary }>(`/admin/seats/${id}/test`, undefined, { timeoutMs: 90_000 })
      if (res.seat) onChange(res.seat)
      const copy = TEST_COPY[res.outcome] ?? { ok: false, text: `test finished: ${res.outcome}.` }
      onNotice({ ok: copy.ok, text: `${name} ${copy.text}` })
    } catch (err) {
      setRowError(errText(err, 'The test did not finish.'))
    } finally {
      setBusy(null)
    }
  }

  const rotate = async (e: FormEvent) => {
    e.preventDefault()
    const credential = rotateToken.trim()
    setRotateToken('')
    if (!credential) { setRowError('Paste the new setup token first.'); return }
    setBusy('rotate')
    setRowError('')
    try {
      const body: Record<string, unknown> = { credential }
      if (rotateExpiry) body.expiresAt = rotateExpiry
      const res = await api.post<{ ok: boolean; seat: SeatSummary }>(`/admin/seats/${id}/rotate`, body)
      onChange(res.seat)
      setRotating(false)
      setRotateExpiry('')
      onNotice({ ok: true, text: `New token saved for ${name}.` })
    } catch (err) {
      setRowError(errText(err, 'Saving the new token failed.'))
    } finally {
      setBusy(null)
    }
  }

  const remove = async () => {
    const ok = await confirm({
      title: `Remove ${name}?`,
      message: 'Sessions stop using this seat and its stored sign-in is deleted. This cannot be undone.',
      confirmLabel: 'Remove seat',
      danger: true,
    })
    if (!ok) return
    setBusy('remove')
    setRowError('')
    try {
      await api.del(`/admin/seats/${id}`)
      onNotice({ ok: true, text: `${name} removed.` })
      onRemoved(seat.id)
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setRowError('This seat is running sessions right now. Disable it, wait for them to finish, then remove it.')
      } else {
        setRowError(errText(err, 'Removing the seat failed.'))
      }
    } finally {
      setBusy(null)
    }
  }

  const cred = seat.credential
  const added = fmtDate(cred.addedAt)
  const expires = fmtDate(cred.expiresAt)

  return (
    <Card className="space-y-3" data-testid={`seat-${seat.id}`}>
      {/* Title row */}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          {renaming ? (
            <form className="flex flex-wrap items-center gap-2" onSubmit={e => { e.preventDefault(); void saveLabel() }}>
              <label htmlFor={`seat-label-${seat.id}`} className="sr-only">Seat name</label>
              <input
                id={`seat-label-${seat.id}`}
                className={cn(INPUT, 'max-w-[260px] flex-1')}
                value={labelDraft}
                autoFocus
                autoComplete="off"
                onChange={e => setLabelDraft(e.target.value)}
                onKeyDown={e => { if (e.key === 'Escape') { setRenaming(false); setLabelDraft(seat.label) } }}
                disabled={busy === 'rename'}
              />
              <Button type="submit" variant="primary" loading={busy === 'rename'}>Save</Button>
              <Button type="button" variant="ghost" onClick={() => { setRenaming(false); setLabelDraft(seat.label) }} disabled={busy === 'rename'}>Cancel</Button>
            </form>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="truncate font-display text-[15px] font-semibold tracking-[-0.01em] text-fg-0">{name}</h4>
              <Badge tone={badge.tone}>{badge.text}</Badge>
              {seat.consecutiveFailures > 0 && (
                <span className="text-[12px] text-fg-3">{seat.consecutiveFailures} failure{seat.consecutiveFailures === 1 ? '' : 's'} in a row</span>
              )}
            </div>
          )}
        </div>
        <Switch
          checked={seat.enabled}
          onChange={v => void patch('enabled', { enabled: v })}
          busy={busy === 'enabled'}
          disabled={!!busy && busy !== 'enabled'}
          label={seat.enabled ? 'Enabled' : 'Disabled'}
        />
      </div>

      {/* Stats */}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[12.5px] sm:grid-cols-4">
        <div>
          <dt className="text-fg-3">Sessions</dt>
          <dd className="font-mono text-fg-1">{seat.sessions.active} active · {seat.sessions.today} today</dd>
        </div>
        <div>
          <dt className="text-fg-3">Usage today</dt>
          <dd className="font-mono text-fg-1">
            {fmtTokens(seat.usageToday.tokens)} tokens{isClaude && ` · $${seat.usageToday.cost.toFixed(2)}`}
          </dd>
        </div>
        <div className="col-span-2">
          <dt className="text-fg-3">Credential</dt>
          <dd className="flex flex-wrap items-center gap-x-2 gap-y-1 text-fg-1">
            <span className="font-mono">
              {cred.kind === 'setup_token' ? `Setup token ••••${cred.last4 ?? '????'}` : 'CLI login'}
            </span>
            {added && <span className="text-fg-3">added {added}</span>}
            {expires && (
              <span
                className={cn(
                  cred.expiry === 'expired' ? 'text-signal-alarm' : cred.expiry === 'expiring' ? 'text-signal-amber' : 'text-fg-3',
                )}
              >
                {cred.expiry === 'expired' ? `expired ${expires}` : `expires ${expires}`}
              </span>
            )}
          </dd>
        </div>
      </dl>

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-2 border-t border-line-soft pt-3">
        <div className="flex items-center gap-1.5">
          <label htmlFor={`seat-priority-${seat.id}`} className="text-[12.5px] text-fg-2">Priority</label>
          <input
            id={`seat-priority-${seat.id}`}
            type="number"
            inputMode="numeric"
            className={cn(INPUT, 'w-20 font-mono')}
            value={priorityDraft}
            onChange={e => setPriorityDraft(e.target.value)}
            onBlur={() => void savePriority(Number(priorityDraft))}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void savePriority(Number(priorityDraft)) } }}
            disabled={busy === 'priority'}
            aria-describedby={`seat-priority-hint-${seat.id}`}
          />
          <span id={`seat-priority-hint-${seat.id}`} className="sr-only">Lower numbers are used first.</span>
        </div>
        {!renaming && <Button variant="ghost" onClick={() => { setLabelDraft(seat.label); setRenaming(true) }} disabled={!!busy}>Rename</Button>}
        <Button variant="secondary" onClick={() => void test()} loading={busy === 'test'} disabled={!!busy && busy !== 'test'}>
          {busy === 'test' ? 'Testing…' : 'Test now'}
        </Button>
        <Button variant="secondary" onClick={() => { setRotating(r => !r); setRotateToken(''); setRowError('') }} disabled={!!busy} aria-expanded={rotating}>
          {isClaude ? 'Rotate token' : 'Sign in again'}
        </Button>
        <Button variant="danger" onClick={() => void remove()} loading={busy === 'remove'} disabled={!!busy && busy !== 'remove'} className="sm:ml-auto">
          Remove
        </Button>
      </div>
      {busy === 'test' && (
        <p className="text-[12px] text-fg-3" aria-live="polite">Running a small test turn. This can take up to a minute.</p>
      )}

      {rotating && isClaude && (
        <form onSubmit={rotate} className="space-y-3 rounded-md border border-line bg-surface-1 p-4" aria-label={`Rotate token for ${name}`}>
          <Field label="New setup token" htmlFor={`seat-rotate-${seat.id}`} hint="The old token is replaced. The new one is stored encrypted and never shown again.">
            <input
              id={`seat-rotate-${seat.id}`}
              type="password"
              autoComplete="off"
              spellCheck={false}
              className={cn(INPUT, 'font-mono')}
              value={rotateToken}
              onChange={e => setRotateToken(e.target.value)}
              disabled={busy === 'rotate'}
            />
          </Field>
          <Field label="Expires (optional)" htmlFor={`seat-rotate-expiry-${seat.id}`}>
            <input id={`seat-rotate-expiry-${seat.id}`} type="date" className={cn(INPUT, 'sm:max-w-[220px]')} value={rotateExpiry} onChange={e => setRotateExpiry(e.target.value)} disabled={busy === 'rotate'} />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary" loading={busy === 'rotate'}>Save new token</Button>
            <Button type="button" variant="ghost" onClick={() => { setRotating(false); setRotateToken('') }} disabled={busy === 'rotate'}>Cancel</Button>
          </div>
        </form>
      )}
      {rotating && !isClaude && (
        <SeatDeviceLogin<SeatSummary>
          seatId={seat.id}
          engine={ENGINE_NAME[seat.kind]}
          onSuccess={s => {
            if (s) onChange(s)
            setRotating(false)
            onNotice({ ok: true, text: `${name} is signed in.` })
          }}
          onCancel={() => setRotating(false)}
        />
      )}

      {rowError && <Alert tone="alarm">{rowError}</Alert>}
    </Card>
  )
}

// ── Engine section ──────────────────────────────────────────────────────────
function EngineSection({ kind, name, empty, seats, onSeat, onRemoved, onNotice, confirm }: {
  kind: SeatKind
  name: string
  empty: string
  seats: SeatSummary[]
  onSeat: (seat: SeatSummary) => void
  onRemoved: (id: string) => void
  onNotice: (n: Notice) => void
  confirm: ReturnType<typeof useConfirm>['confirm']
}) {
  const [adding, setAdding] = useState(false)
  const [creating, setCreating] = useState(false)
  const [loginSeat, setLoginSeat] = useState<string | null>(null)
  const [error, setError] = useState('')

  const startAdd = async () => {
    setError('')
    if (kind === 'claude') { setAdding(true); return }
    setCreating(true)
    try {
      const res = await api.post<{ ok: boolean; seat: SeatSummary }>('/admin/seats', { kind })
      onSeat(res.seat)
      setLoginSeat(res.seat.id)
    } catch (err) {
      setError(errText(err, `Adding the ${name} seat failed.`))
    } finally {
      setCreating(false)
    }
  }

  const addButton = (
    <Button variant="secondary" onClick={() => void startAdd()} loading={creating} disabled={adding || !!loginSeat}>
      Add {name} seat
    </Button>
  )

  return (
    <section aria-labelledby={`seats-${kind}`} className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`seats-${kind}`} className="font-display text-[15px] font-semibold tracking-[-0.01em] text-fg-0">
          {name} <span className="font-mono text-[12px] font-normal text-fg-3">{seats.length}</span>
        </h3>
        {seats.length > 0 && addButton}
      </div>

      {adding && kind === 'claude' && (
        <AddClaudeForm onAdded={s => { onSeat(s); setAdding(false) }} onCancel={() => setAdding(false)} onNotice={onNotice} />
      )}
      {loginSeat && (
        <SeatDeviceLogin<SeatSummary>
          seatId={loginSeat}
          engine={name}
          onSuccess={s => {
            if (s) onSeat(s)
            setLoginSeat(null)
            onNotice({ ok: true, text: `${s?.label || `${name} seat`} is signed in.` })
          }}
          onCancel={() => setLoginSeat(null)}
        />
      )}
      {error && <Alert tone="alarm">{error}</Alert>}

      {seats.length === 0 ? (
        !adding && !loginSeat && (
          <div className="rounded-lg border border-dashed border-line bg-surface-1">
            <EmptyState compact title={empty} description={`Add a ${name} subscription so sessions can run on it.`} action={addButton} />
          </div>
        )
      ) : (
        <div className="space-y-3">
          {seats.map(s => (
            <SeatCard key={s.id} seat={s} onChange={onSeat} onRemoved={onRemoved} onNotice={onNotice} confirm={confirm} />
          ))}
        </div>
      )}
    </section>
  )
}

// ── Failover panel ──────────────────────────────────────────────────────────
function pickInitialWorkspace(slugs: string[]): string {
  let stored: string | null = null
  try { stored = localStorage.getItem('cc-workspace') } catch { /* storage blocked */ }
  return stored && slugs.includes(stored) ? stored : slugs[0] ?? ''
}

function FailoverPanel({ onNotice }: { onNotice: (n: Notice) => void }) {
  const { slugs, labelOf } = useWorkspaces()
  const choices = useMemo(() => slugs.filter(s => s !== 'all'), [slugs])
  const [workspace, setWorkspace] = useState('')
  const [saved, setSaved] = useState<FailoverPolicy | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [order, setOrder] = useState<SeatKind[]>(['claude', 'codex', 'grok'])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!workspace && choices.length) setWorkspace(pickInitialWorkspace(choices))
  }, [choices, workspace])

  useEffect(() => {
    if (!workspace) return
    let live = true
    setLoading(true)
    setError('')
    api.get<FailoverPolicy>(`/admin/seats/failover/${encodeURIComponent(workspace)}`)
      .then(p => {
        if (!live) return
        setSaved(p)
        setEnabled(p.enabled)
        setOrder(p.order)
      })
      .catch(err => { if (live) setError(errText(err, 'Could not load the failover setting.')) })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [workspace])

  const dirty = !!saved && (saved.enabled !== enabled || saved.order.join() !== order.join())

  const move = (i: number, delta: -1 | 1) => {
    setOrder(o => {
      const j = i + delta
      if (j < 0 || j >= o.length) return o
      const next = [...o]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
  }

  const save = async () => {
    setSaving(true)
    setError('')
    try {
      const p = await api.put<FailoverPolicy>(`/admin/seats/failover/${encodeURIComponent(workspace)}`, { enabled, order })
      setSaved(p)
      setEnabled(p.enabled)
      setOrder(p.order)
      onNotice({ ok: true, text: 'Failover setting saved.' })
    } catch (err) {
      setError(errText(err, 'Saving the failover setting failed.'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card className="space-y-3" aria-labelledby="seats-failover">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="seats-failover" className="font-display text-[15px] font-semibold tracking-[-0.01em] text-fg-0">Engine failover</h3>
        {choices.length > 1 && (
          <div className="flex items-center gap-2">
            <label htmlFor="seats-failover-ws" className="text-[12.5px] text-fg-2">Workspace</label>
            <select id="seats-failover-ws" className={cn(INPUT, 'w-auto pr-8')} value={workspace} onChange={e => setWorkspace(e.target.value)} disabled={saving}>
              {choices.map(s => <option key={s} value={s}>{labelOf(s)}</option>)}
            </select>
          </div>
        )}
      </div>

      {!workspace ? (
        <p className="text-[13px] text-fg-3">No workspaces yet.</p>
      ) : loading && !saved ? (
        <div className="space-y-2" aria-hidden="true">
          <Skeleton className="h-6 w-3/4" />
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-full" />
        </div>
      ) : (
        <>
          <Switch
            checked={enabled}
            onChange={setEnabled}
            disabled={saving || loading}
            label="If every seat of a card's engine is down, run it on another engine"
          />
          <ol className={cn('space-y-1.5 transition-opacity duration-base', !enabled && 'opacity-60')} aria-label="Failover order">
            {order.map((k, i) => (
              <li key={k} className="flex min-h-[44px] items-center gap-2 rounded-md border border-line bg-surface-1 pl-3 pr-1">
                <span className="w-5 font-mono text-[12px] text-fg-3">{i + 1}</span>
                <span className="flex-1 text-[13px] text-fg-1">{ENGINE_NAME[k]}</span>
                <IconButton label={`Move ${ENGINE_NAME[k]} up`} onClick={() => move(i, -1)} disabled={i === 0 || saving} className="disabled:cursor-not-allowed disabled:opacity-35">
                  <Chevron up />
                </IconButton>
                <IconButton label={`Move ${ENGINE_NAME[k]} down`} onClick={() => move(i, 1)} disabled={i === order.length - 1 || saving} className="disabled:cursor-not-allowed disabled:opacity-35">
                  <Chevron />
                </IconButton>
              </li>
            ))}
          </ol>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[12px] text-fg-3">Cards pinned to one engine never move.</p>
            <Button variant="primary" onClick={() => void save()} loading={saving} disabled={!dirty || loading}>Save</Button>
          </div>
        </>
      )}
      {error && <Alert tone="alarm">{error}</Alert>}
    </Card>
  )
}

// ── Page ────────────────────────────────────────────────────────────────────
export function SettingsSeats() {
  const [seats, setSeats] = useState<SeatSummary[] | null>(null)
  const [loadError, setLoadError] = useState('')
  const [notice, setNotice] = useState<Notice>(null)
  const { confirm, confirmDialog } = useConfirm()

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ seats: SeatSummary[] }>('/admin/seats')
      setSeats(res.seats ?? [])
      setLoadError('')
    } catch (err) {
      setLoadError(errText(err, 'Could not load seats.'))
      setSeats(prev => prev ?? [])
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const upsert = useCallback((seat: SeatSummary) => {
    if (!seat) return
    setSeats(list => {
      const cur = list ?? []
      return cur.some(s => s.id === seat.id) ? cur.map(s => (s.id === seat.id ? seat : s)) : [...cur, seat]
    })
  }, [])
  const removeLocal = useCallback((id: string) => setSeats(list => (list ?? []).filter(s => s.id !== id)), [])

  const byKind = useMemo(() => {
    const groups: Record<SeatKind, SeatSummary[]> = { claude: [], codex: [], grok: [] }
    for (const s of seats ?? []) (groups[s.kind] ?? groups.claude).push(s)
    for (const k of Object.keys(groups) as SeatKind[]) groups[k].sort((a, b) => a.priority - b.priority)
    return groups
  }, [seats])

  return (
    <div className="max-w-4xl space-y-6">
      <p className="text-[13px] leading-relaxed text-fg-2">
        Subscriptions sessions run on. Each card uses the healthy seat with the lowest priority number for its engine;
        a seat that hits a limit cools down and the next one takes over.
      </p>

      {notice && (
        <div aria-live="polite">
          <Alert tone={notice.ok ? 'verify' : 'alarm'}>{notice.text}</Alert>
        </div>
      )}
      {loadError && <Alert tone="alarm" title="Could not load seats">{loadError}</Alert>}

      {seats === null ? (
        <div className="space-y-3" data-testid="seats-loading">
          <Skeleton className="h-5 w-24" />
          <SeatSkeleton />
          <SeatSkeleton />
        </div>
      ) : (
        ENGINES.map(e => (
          <EngineSection
            key={e.kind}
            kind={e.kind}
            name={e.name}
            empty={e.empty}
            seats={byKind[e.kind]}
            onSeat={upsert}
            onRemoved={removeLocal}
            onNotice={setNotice}
            confirm={confirm}
          />
        ))
      )}

      <FailoverPanel onNotice={setNotice} />

      <p className="border-t border-line-soft pt-4 text-[12px] text-fg-3">
        Connect only subscriptions you own and follow each provider's terms.
      </p>
      {confirmDialog}
    </div>
  )
}
