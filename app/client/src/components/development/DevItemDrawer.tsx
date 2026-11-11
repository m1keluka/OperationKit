import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Copy, ExternalLink, Link2, Loader2, Paperclip, Rocket, Trash2, WrapText,
} from 'lucide-react'
import {
  Alert, Badge, Button, Card, CardBody, CardHeader, Modal, SearchInput, Skeleton,
  SkeletonText, StatusPill, cn, useConfirm, type PipelineStatus,
} from '../ui'
import {
  DEV_SEVERITIES, DEV_STATUSES, DEV_TYPES, STATUS_LABEL, TYPE_LABEL,
  addDevNote, attachPr, deleteDevItem, getDevItem, hexColor, patchDevItem, promoteDevItem,
  publishChangelog, relativeTime, scoreOf, triageDevItem,
  type DevItemDetail, type DevSeverity, type DevStatus, type DevType, type NoteVisibility,
} from '../../lib/devItems'

/* ─────────────────────────────────────────────────────────────────────────
   Detail drawer — PRD §5.7, field by field.

   <Modal variant="sheet"> (right-hand drawer on desktop, bottom sheet on
   mobile). Every write is one contract call: A4 patch, A5 triage, A6 promote,
   A8 attach-pr, A9 notes, A10 delete, A14 publish. No section invents a field
   the API contract does not document, and each Evidence sub-block hides itself
   when its source field is null.
   ───────────────────────────────────────────────────────────────────────── */

const STATUS_TONE: Record<DevStatus, 'neutral' | 'accent' | 'verify' | 'amber' | 'alarm' | 'info'> = {
  new: 'accent', triaged: 'info', planned: 'info', in_progress: 'amber',
  shipped: 'verify', declined: 'neutral', duplicate: 'neutral',
}
const OBJ_STATUS_MAP: Record<string, PipelineStatus> = {
  planning: 'planning', queue: 'queue', working: 'working', ai: 'ai',
  review: 'review', human: 'human', done: 'done', blocked: 'blocked',
}

function Section({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <Card className="mb-3">
      <CardHeader title={title} actions={actions} />
      <CardBody className="pt-0">{children}</CardBody>
    </Card>
  )
}

function Segmented<T extends string>({
  options, value, onChange, allowNull,
}: {
  options: { value: T; label: string }[]
  value: T | null
  onChange: (v: T | null) => void
  allowNull?: boolean
}) {
  return (
    <div className="inline-flex flex-wrap gap-0.5 rounded-lg border border-line bg-surface-1 p-0.5">
      {allowNull && (
        <button
          type="button"
          onClick={() => onChange(null)}
          className={cn(
            'rounded-md px-2 py-1 text-[12px] transition-colors duration-fast',
            value === null ? 'bg-surface-3 text-fg-0' : 'text-fg-2 hover:text-fg-1',
          )}
        >none</button>
      )}
      {options.map(o => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            'rounded-md px-2 py-1 text-[12px] transition-colors duration-fast',
            value === o.value ? 'bg-surface-3 text-fg-0' : 'text-fg-2 hover:text-fg-1',
          )}
        >{o.label}</button>
      ))}
    </div>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mb-3 last:mb-0">
      <div className="mb-1 font-mono text-[10.5px] uppercase tracking-[0.1em] text-fg-3">{label}</div>
      {children}
    </div>
  )
}

const inputCls =
  'w-full rounded-md border border-line bg-surface-2 px-2.5 py-1.5 text-[13px] text-fg-0 placeholder:text-fg-3 ' +
  'transition-colors duration-fast hover:border-line-strong focus:border-[color:var(--accent-line)] focus:outline-none focus:ring-2 focus:ring-accent/40'

/* ── Console log viewer (PRD §5.7 §4) ──────────────────────────────────── */
function ConsoleLog({ text }: { text: string }) {
  const [level, setLevel] = useState<'all' | 'log' | 'warn' | 'error'>('all')
  const [find, setFind] = useState('')
  const [wrap, setWrap] = useState(true)
  const [open, setOpen] = useState(false)
  const lines = useMemo(() => text.split('\n'), [text])
  const levelOf = (l: string) => (/\berror\b/i.test(l) ? 'error' : /\bwarn\b/i.test(l) ? 'warn' : 'log')
  const shown = lines
    .map((line, i) => ({ line, i, lvl: levelOf(line) }))
    .filter(r => (level === 'all' || r.lvl === level) && (!find || r.line.toLowerCase().includes(find.toLowerCase())))
  return (
    <div>
      <button type="button" onClick={() => setOpen(o => !o)} className="text-[12.5px] text-fg-2 underline-offset-2 hover:text-fg-0 hover:underline">
        {open ? 'Hide' : 'Show'} console log ({lines.length} lines)
      </button>
      {open && (
        <div className="mt-2">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Segmented
              options={[{ value: 'all', label: 'all' }, { value: 'log', label: 'log' }, { value: 'warn', label: 'warn' }, { value: 'error', label: 'error' }]}
              value={level}
              onChange={v => setLevel((v ?? 'all') as 'all' | 'log' | 'warn' | 'error')}
            />
            <SearchInput
              value={find}
              onChange={e => setFind(e.target.value)}
              placeholder="Find in log"
              wrapClassName="w-[150px]"
              className="min-h-[32px] sm:min-h-[32px]"
            />
            <Button size="sm" variant="ghost" leftIcon={<WrapText className="h-3.5 w-3.5" />} onClick={() => setWrap(w => !w)}>
              {wrap ? 'No wrap' : 'Wrap'}
            </Button>
            <Button size="sm" variant="ghost" leftIcon={<Copy className="h-3.5 w-3.5" />} onClick={() => navigator.clipboard?.writeText(text)}>
              Copy all
            </Button>
          </div>
          <pre className={cn(
            'max-h-[240px] overflow-auto rounded-md border border-line bg-surface-0 p-2 font-mono text-[11.5px] leading-relaxed',
            wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre',
          )}>
            {shown.map(r => (
              <div key={r.i} className={cn(
                'flex gap-2',
                r.lvl === 'error' && 'text-signal-alarm',
                r.lvl === 'warn' && 'text-signal-amber',
                r.lvl === 'log' && 'text-fg-2',
              )}>
                <span className="shrink-0 select-none text-fg-3">{String(r.i + 1).padStart(3, ' ')}</span>
                <span className="min-w-0">{r.line}</span>
              </div>
            ))}
            {shown.length === 0 && <div className="text-fg-3">No lines match.</div>}
          </pre>
        </div>
      )}
    </div>
  )
}

export function DevItemDrawer({
  itemId, onClose, onChanged, onFilterRoute,
}: {
  itemId: number
  onClose: () => void
  onChanged: () => void
  onFilterRoute: (route: string) => void
}) {
  const [detail, setDetail] = useState<DevItemDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [noteBody, setNoteBody] = useState('')
  const [noteVisibility, setNoteVisibility] = useState<NoteVisibility>('internal')
  const [prInput, setPrInput] = useState('')
  const [copied, setCopied] = useState<string | null>(null)
  const { confirm, confirmDialog } = useConfirm()

  const load = useCallback(() => {
    getDevItem(itemId)
      .then(r => setDetail(r.data))
      .catch(err => setError(err instanceof Error ? err.message : 'Failed to load item'))
  }, [itemId])

  useEffect(() => { setDetail(null); setError(null); load() }, [load])

  const item = detail?.item

  const save = useCallback(async (patch: Parameters<typeof patchDevItem>[1]) => {
    if (!item) return
    setBusy(true)
    try {
      await patchDevItem(item.id, patch)
      load()
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setBusy(false)
    }
  }, [item, load, onChanged])

  const doTriage = useCallback(async (body: Parameters<typeof triageDevItem>[1]) => {
    if (!item) return
    setBusy(true)
    try {
      await triageDevItem(item.id, body)
      load()
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Triage failed')
    } finally {
      setBusy(false)
    }
  }, [item, load, onChanged])

  const copy = (text: string, key: string) => {
    navigator.clipboard?.writeText(text)
    setCopied(key)
    window.setTimeout(() => setCopied(c => (c === key ? null : c)), 1400)
  }

  const postNote = async () => {
    if (!item || !noteBody.trim()) return
    if (noteVisibility === 'submitter') {
      const ok = await confirm({
        title: 'Publish this note to the submitter?',
        message: 'Submitter-visible notes are shown to the end user who reported the item.',
        confirmLabel: 'Publish note',
      })
      if (!ok) return
    }
    setBusy(true)
    try {
      await addDevNote(item.id, { body: noteBody.trim(), visibility: noteVisibility })
      setNoteBody('')
      load()
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not post note')
    } finally {
      setBusy(false)
    }
  }

  const promote = async () => {
    if (!item) return
    setBusy(true)
    try {
      await promoteDevItem(item.id, {})
      load()
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Promote failed')
    } finally {
      setBusy(false)
    }
  }

  const doAttachPr = async () => {
    if (!item || !prInput.trim()) return
    const raw = prInput.trim()
    const m = raw.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/)
    setBusy(true)
    try {
      await attachPr(item.id, m
        ? { repo: m[1], pr_number: Number(m[2]), pr_url: raw, state: 'open' }
        : { repo: raw, state: 'open' })
      setPrInput('')
      load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not attach PR')
    } finally {
      setBusy(false)
    }
  }

  const softDelete = async () => {
    if (!item) return
    const ok = await confirm({
      title: `Delete ${item.ref}?`,
      message: 'This is a soft delete — the item disappears from the board but nothing cascades.',
      confirmLabel: 'Delete',
      danger: true,
    })
    if (!ok) return
    await deleteDevItem(item.id)
    onChanged()
    onClose()
  }

  const score = item ? scoreOf(item) : null

  return (
    <>
      <Modal
        open
        onClose={onClose}
        variant="sheet"
        labelledBy="dev-drawer-title"
        panelClassName="sm:w-[640px]"
      >
        <div className="sticky top-0 z-[2] border-b border-line bg-surface-1/95 px-4 py-3 backdrop-blur">
          {!item ? (
            <Skeleton className="h-5 w-40" />
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[13px] text-fg-0">{item.ref}</span>
                <Badge tone="neutral">{TYPE_LABEL[item.type]}</Badge>
                <Badge tone={STATUS_TONE[item.status]}>{STATUS_LABEL[item.status]}</Badge>
                {item.workspace_label && (
                  <span
                    className="inline-flex items-center rounded-sm border border-line bg-surface-3 px-1.5 py-0.5 font-mono text-[11px] text-fg-2"
                    style={hexColor(item.workspace_badge_color)
                      ? {
                          borderColor: `${hexColor(item.workspace_badge_color)}55`,
                          background: `${hexColor(item.workspace_badge_color)}1a`,
                          color: hexColor(item.workspace_badge_color)!,
                        }
                      : undefined}
                  >{item.workspace_label}</span>
                )}
                {item.project && <span className="font-mono text-[11px] text-fg-3">{item.project}</span>}
                <div className="ml-auto flex items-center gap-1">
                  <Button size="sm" variant="ghost" leftIcon={<Link2 className="h-3.5 w-3.5" />}
                    onClick={() => copy(`${window.location.origin}/development/${item.ref}`, 'link')}>
                    {copied === 'link' ? 'Copied' : 'Copy link'}
                  </Button>
                  <Button size="sm" variant="ghost" leftIcon={<Copy className="h-3.5 w-3.5" />}
                    onClick={() => copy(`Fixes ${item.ref}`, 'fixes')}>
                    {copied === 'fixes' ? 'Copied' : `Fixes ${item.ref}`}
                  </Button>
                  <Button size="sm" variant="ghost" leftIcon={<Trash2 className="h-3.5 w-3.5" />} onClick={softDelete}>
                    Delete
                  </Button>
                </div>
              </div>
              <h2 id="dev-drawer-title" className="mt-2 font-display text-[16px] font-semibold tracking-[-0.01em] text-fg-0">
                {item.title}
              </h2>
            </>
          )}
        </div>

        <div className="p-4">
          {error && <Alert tone="alarm" className="mb-3">{error}</Alert>}
          {busy && (
            <div className="mb-3 flex items-center gap-2 text-[12px] text-fg-3">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> saving…
            </div>
          )}

          {!item ? (
            <>
              <Card className="mb-3"><CardBody><SkeletonText lines={4} /></CardBody></Card>
              <Card className="mb-3"><CardBody><SkeletonText lines={3} /></CardBody></Card>
            </>
          ) : (
            <>
              {/* ── 1. Summary ── */}
              <Section title="Summary">
                <Field label="Title">
                  <input
                    className={inputCls}
                    defaultValue={item.title}
                    onBlur={e => { if (e.target.value !== item.title) save({ title: e.target.value }) }}
                  />
                </Field>
                <Field label="Description">
                  <textarea
                    className={cn(inputCls, 'min-h-[92px] resize-y')}
                    defaultValue={item.description}
                    onBlur={e => { if (e.target.value !== item.description) save({ description: e.target.value }) }}
                  />
                </Field>
                {item.type === 'bug' && (
                  <Field label="Steps to reproduce">
                    <textarea
                      className={cn(inputCls, 'min-h-[80px] resize-y font-mono text-[12px]')}
                      defaultValue={item.steps_to_repro ?? ''}
                      onBlur={e => { if (e.target.value !== (item.steps_to_repro ?? '')) save({ steps_to_repro: e.target.value }) }}
                    />
                  </Field>
                )}
                <p className="text-[11px] text-fg-3">Edits autosave when the field loses focus.</p>
              </Section>

              {/* ── 2. Triage ── */}
              <Section title="Triage">
                <Field label="Type">
                  <Segmented
                    options={DEV_TYPES.map(t => ({ value: t, label: TYPE_LABEL[t] }))}
                    value={item.type}
                    onChange={v => v && save({ type: v as DevType })}
                  />
                </Field>
                <Field label="Severity">
                  <Segmented
                    allowNull
                    options={DEV_SEVERITIES.map(s => ({ value: s, label: s }))}
                    value={item.severity}
                    onChange={v => doTriage({ severity: v as DevSeverity | null })}
                  />
                </Field>
                <div className="mb-3 flex flex-wrap items-end gap-4">
                  <div>
                    <div className="mb-1 font-mono text-[10.5px] uppercase tracking-[0.1em] text-fg-3">Impact</div>
                    <Segmented
                      options={[1, 2, 3].map(n => ({ value: String(n), label: String(n) }))}
                      value={item.impact ? String(item.impact) : null}
                      onChange={v => doTriage({ impact: v ? Number(v) : null })}
                    />
                  </div>
                  <div>
                    <div className="mb-1 font-mono text-[10.5px] uppercase tracking-[0.1em] text-fg-3">Effort</div>
                    <Segmented
                      options={[1, 2, 3].map(n => ({ value: String(n), label: String(n) }))}
                      value={item.effort ? String(item.effort) : null}
                      onChange={v => doTriage({ effort: v ? Number(v) : null })}
                    />
                  </div>
                  <div className="pb-1">
                    <div className="mb-1 font-mono text-[10.5px] uppercase tracking-[0.1em] text-fg-3">Score (i×3/e)</div>
                    <span className="font-mono text-[13px] text-fg-1">{score ?? '—'}</span>
                  </div>
                  {item.priority_rank === null && score !== null && (
                    <Button size="sm" variant="secondary" className="mb-0.5" onClick={() => doTriage({ suggest_rank: true })}>
                      Use as rank
                    </Button>
                  )}
                </div>
                <div className="mb-3 flex flex-wrap gap-4">
                  <div className="min-w-[180px] flex-1">
                    <div className="mb-1 font-mono text-[10.5px] uppercase tracking-[0.1em] text-fg-3">Area</div>
                    <input
                      className={inputCls}
                      defaultValue={item.area ?? ''}
                      placeholder="checkout"
                      onBlur={e => { if (e.target.value !== (item.area ?? '')) save({ area: e.target.value || null }) }}
                    />
                  </div>
                  <div className="min-w-[180px] flex-1">
                    <div className="mb-1 font-mono text-[10.5px] uppercase tracking-[0.1em] text-fg-3">Route</div>
                    <div className="flex items-center gap-2">
                      <code className="min-w-0 flex-1 truncate rounded-md border border-line bg-surface-2 px-2.5 py-1.5 font-mono text-[12px] text-fg-2">
                        {item.route ?? '—'}
                      </code>
                      {item.route && (
                        <Button size="sm" variant="secondary" onClick={() => onFilterRoute(item.route!)}>Filter</Button>
                      )}
                    </div>
                  </div>
                </div>
                <Field label="Status">
                  <div className="flex flex-wrap gap-1">
                    {DEV_STATUSES.map(s => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => save({ status: s })}
                        className={cn(
                          'rounded-md border px-2 py-1 text-[12px] transition-colors duration-fast',
                          item.status === s
                            ? 'border-[color:var(--accent-line)] bg-accent/10 text-fg-0'
                            : 'border-line bg-surface-2 text-fg-2 hover:text-fg-0',
                        )}
                      >{STATUS_LABEL[s]}</button>
                    ))}
                  </div>
                  {item.status === 'duplicate' && (
                    <div className="mt-2">
                      <input
                        className={inputCls}
                        placeholder="Duplicate of item id (required)"
                        defaultValue={item.duplicate_of_id ?? ''}
                        onBlur={e => {
                          const v = e.target.value.replace(/\D/g, '')
                          if (v && Number(v) !== item.duplicate_of_id) save({ duplicate_of_id: Number(v) })
                        }}
                      />
                    </div>
                  )}
                </Field>
                <p className="text-[11.5px] text-fg-3">
                  {item.triaged_at
                    ? `Triaged by ${item.triaged_by ?? 'unknown'} · ${relativeTime(item.triaged_at)}`
                    : 'Not yet triaged'}
                </p>
              </Section>

              {/* ── 3. Submitter ── */}
              <Section title="Submitter">
                <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-fg-1">
                  <span>{item.submitter_label ?? 'Unknown'}</span>
                  {item.submitter_email && (
                    <a className="text-accent-hover hover:underline" href={`mailto:${item.submitter_email}`}>{item.submitter_email}</a>
                  )}
                  <Badge tone="neutral">{item.submitted_via}</Badge>
                  <span className="text-fg-3">{relativeTime(item.created_at)}</span>
                </div>
                {item.submitter_platform_user_id && (
                  <div className="mt-2">
                    <button
                      type="button"
                      onClick={() => copy(item.submitter_platform_user_id!, 'sub')}
                      className="font-mono text-[11.5px] text-fg-2 hover:text-fg-0"
                    >
                      {item.submitter_platform_user_id} {copied === 'sub' ? '· copied' : '· copy'}
                    </button>
                    <p className="mt-0.5 text-[11px] text-fg-3">platform identity — not a Command Center user</p>
                  </div>
                )}
              </Section>

              {/* ── 4. Evidence ── */}
              {(item.posthog_replay_url || item.screenshot_path || item.console_log || item.route_history.length > 0 || item.loom_url) && (
                <Section title="Evidence">
                  {item.posthog_replay_url && (
                    <Field label="Session replay">
                      {/* PostHog only permits framing its /embed/ + /shared/ URLs;
                          framing a plain /replay/ link is refused by its
                          frame-ancestors CSP, so fall back to a link card rather
                          than shipping a guaranteed console error. */}
                      {/\/(embed|shared)\//.test(item.posthog_replay_url) ? (
                        <div className="overflow-hidden rounded-md border border-line bg-surface-0">
                          <iframe
                            title="Session replay"
                            src={item.posthog_replay_url}
                            className="aspect-video w-full"
                            sandbox="allow-scripts allow-same-origin"
                          />
                        </div>
                      ) : (
                        <div className="rounded-md border border-dashed border-line bg-surface-2 px-3 py-4 text-center">
                          <div className="text-[12.5px] text-fg-2">Session replay available</div>
                          <div className="mt-0.5 font-mono text-[11px] text-fg-3">{item.posthog_replay_url}</div>
                        </div>
                      )}
                      <a
                        className="mt-1 inline-flex items-center gap-1 text-[12px] text-accent-hover hover:underline"
                        href={item.posthog_replay_url} target="_blank" rel="noreferrer"
                      >
                        Open in PostHog <ExternalLink className="h-3 w-3" />
                      </a>
                    </Field>
                  )}
                  {item.screenshot_path && (
                    <Field label="Screenshot">
                      {detail?.attachments.find(a => a.storage_path === item.screenshot_path)?.signed_url ? (
                        <a href={detail.attachments.find(a => a.storage_path === item.screenshot_path)!.signed_url!} target="_blank" rel="noreferrer">
                          <img
                            alt="submitted screenshot"
                            src={detail.attachments.find(a => a.storage_path === item.screenshot_path)!.signed_url!}
                            className="max-h-[220px] rounded-md border border-line"
                          />
                        </a>
                      ) : (
                        <div className="rounded-md border border-dashed border-line bg-surface-2 px-3 py-4 text-center">
                          <div className="font-mono text-[11.5px] text-fg-2">{item.screenshot_path}</div>
                          <div className="mt-1 text-[11px] text-fg-3">signed URL is minted per request by A2</div>
                        </div>
                      )}
                    </Field>
                  )}
                  {item.console_log && (
                    <Field label="Console log"><ConsoleLog text={item.console_log} /></Field>
                  )}
                  {item.route_history.length > 0 && (
                    <Field label="Route history">
                      <ol className="border-l border-line pl-3">
                        {item.route_history.map((r, i) => {
                          const prev = i > 0 ? new Date(item.route_history[i - 1].ts).getTime() : null
                          const delta = prev ? Math.max(0, Math.round((new Date(r.ts).getTime() - prev) / 1000)) : null
                          const last = i === item.route_history.length - 1
                          return (
                            <li key={i} className="relative mb-1.5 last:mb-0">
                              <span className={cn(
                                'absolute -left-[17px] top-1.5 h-2 w-2 rounded-full',
                                last ? 'bg-accent' : 'bg-line-strong',
                              )} />
                              <code className={cn('font-mono text-[12px]', last ? 'text-fg-0' : 'text-fg-2')}>{r.path}</code>
                              {delta !== null && <span className="ml-2 font-mono text-[11px] text-fg-3">+{delta}s</span>}
                              {last && <span className="ml-2 text-[11px] text-accent-hover">where they submitted</span>}
                            </li>
                          )
                        })}
                      </ol>
                    </Field>
                  )}
                  {Object.keys(item.client_meta).length > 0 && (
                    <Field label="Client">
                      <dl className="grid grid-cols-[minmax(0,90px)_1fr] gap-x-3 gap-y-1 text-[12px]">
                        {Object.entries(item.client_meta).map(([k, v]) => (
                          <div key={k} className="contents">
                            <dt className="font-mono text-[11px] text-fg-3">{k}</dt>
                            <dd className="min-w-0 truncate text-fg-1">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</dd>
                          </div>
                        ))}
                      </dl>
                    </Field>
                  )}
                  {item.loom_url && (
                    <Field label="Loom">
                      <iframe
                        title="Loom"
                        src={item.loom_url.replace('/share/', '/embed/')}
                        className="aspect-video w-full rounded-md border border-line"
                      />
                    </Field>
                  )}
                </Section>
              )}

              {/* ── 5. Attachments ── */}
              <Section title={`Attachments (${detail?.attachments.length ?? 0})`}>
                {detail && detail.attachments.length > 0 ? (
                  <ul className="flex flex-col gap-1.5">
                    {detail.attachments.map(a => (
                      <li key={a.id} className="flex items-center gap-2 rounded-md border border-line bg-surface-2 px-2.5 py-2">
                        <Paperclip className="h-3.5 w-3.5 shrink-0 text-fg-3" />
                        <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg-1">{a.file_name}</span>
                        <span className="font-mono text-[11px] text-fg-3">{Math.round(a.size_bytes / 1024)} KB</span>
                        <Badge tone="neutral">{a.storage_provider}</Badge>
                        {a.signed_url && (
                          <a className="text-accent-hover" href={a.signed_url} target="_blank" rel="noreferrer" aria-label="open attachment">
                            <ExternalLink className="h-3.5 w-3.5" />
                          </a>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-[12.5px] text-fg-3">No attachments.</p>
                )}
              </Section>

              {/* ── 6. Notes thread ── */}
              <Section title={`Notes (${detail?.notes.length ?? 0})`}>
                <ul className="mb-3 flex flex-col gap-2">
                  {detail?.notes.map(n => (
                    <li key={n.id} className="rounded-md border border-line bg-surface-2 px-3 py-2">
                      <div className="mb-1 flex items-center gap-2">
                        <span className={cn(
                          'text-[12px] font-medium',
                          n.author_label === 'agent' ? 'text-agent-cto' : 'text-fg-0',
                        )}>
                          {n.author_label === 'agent' ? 'AI agent' : n.author_label}
                        </span>
                        {n.author_label === 'agent' && <Badge tone="info">agent</Badge>}
                        <Badge tone={n.visibility === 'submitter' ? 'accent' : 'neutral'}>{n.visibility}</Badge>
                        <span className="ml-auto font-mono text-[11px] text-fg-3">{relativeTime(n.created_at)}</span>
                      </div>
                      <p className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-fg-1">{n.body}</p>
                    </li>
                  ))}
                  {detail?.notes.length === 0 && <li className="text-[12.5px] text-fg-3">No notes yet.</li>}
                </ul>
                <textarea
                  className={cn(inputCls, 'min-h-[70px] resize-y')}
                  placeholder="Add a note…  (⌘/Ctrl+Enter to post)"
                  value={noteBody}
                  onChange={e => setNoteBody(e.target.value)}
                  onKeyDown={e => {
                    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void postNote() }
                  }}
                />
                <div className="mt-2 flex items-center gap-2">
                  <Segmented
                    options={[{ value: 'internal', label: 'internal' }, { value: 'submitter', label: 'submitter' }]}
                    value={noteVisibility}
                    onChange={v => setNoteVisibility((v ?? 'internal') as NoteVisibility)}
                  />
                  <Button size="sm" onClick={postNote} disabled={!noteBody.trim()}>Post note</Button>
                </div>
              </Section>

              {/* ── 7. Work ── */}
              <Section title="Work">
                {item.objective_id ? (
                  <div className="mb-3 rounded-md border border-line bg-surface-2 px-3 py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-[12.5px] text-fg-0">#{item.objective_id}</span>
                      {detail?.objective?.status && OBJ_STATUS_MAP[detail.objective.status] && (
                        <StatusPill status={OBJ_STATUS_MAP[detail.objective.status]} />
                      )}
                      {item.branch_name && <code className="font-mono text-[11.5px] text-fg-2">{item.branch_name}</code>}
                      <a className="ml-auto text-[12px] text-accent-hover hover:underline" href="/">Open on the Board</a>
                    </div>
                    {detail?.objective?.completion_goal && (
                      <p className="mt-1.5 text-[12px] text-fg-2">{detail.objective.completion_goal}</p>
                    )}
                  </div>
                ) : (
                  <div className="mb-3">
                    <Button
                      leftIcon={<Rocket className="h-4 w-4" />}
                      onClick={promote}
                      disabled={item.status !== 'triaged'}
                      title={item.status !== 'triaged' ? 'Triage the item first — promoting untriaged work is how you get an unranked backlog.' : undefined}
                    >
                      Promote to objective
                    </Button>
                    {item.status !== 'triaged' && (
                      <p className="mt-1 text-[11.5px] text-fg-3">Available once the item is triaged.</p>
                    )}
                  </div>
                )}

                <div className="mb-2 font-mono text-[10.5px] uppercase tracking-[0.1em] text-fg-3">Pull requests</div>
                <ul className="mb-2 flex flex-col gap-1.5">
                  {detail?.prs.map(p => (
                    <li key={`${p.repo}#${p.pr_number}`} className="flex items-center gap-2 rounded-md border border-line bg-surface-2 px-2.5 py-1.5">
                      <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg-2">{p.repo} #{p.pr_number}</code>
                      <Badge tone={p.state === 'merged' ? 'verify' : p.state === 'open' ? 'amber' : 'neutral'}>{p.state}</Badge>
                      <Badge tone="neutral">{p.via}</Badge>
                      <a className="text-accent-hover" href={p.pr_url} target="_blank" rel="noreferrer" aria-label="open PR">
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    </li>
                  ))}
                  {detail?.prs.length === 0 && <li className="text-[12.5px] text-fg-3">No linked pull requests.</li>}
                </ul>
                <div className="flex gap-2">
                  <input
                    className={inputCls}
                    placeholder="Paste a PR URL to attach"
                    value={prInput}
                    onChange={e => setPrInput(e.target.value)}
                  />
                  <Button variant="secondary" size="sm" onClick={doAttachPr} disabled={!prInput.trim()}>Attach PR</Button>
                </div>
              </Section>

              {/* ── 8. Changelog ── */}
              {(detail?.changelog || item.status === 'shipped') && (
                <Section title="Changelog">
                  {detail?.changelog ? (
                    <div>
                      <div className="mb-1 flex flex-wrap items-center gap-2">
                        <Badge tone={detail.changelog.status === 'published' ? 'verify' : detail.changelog.status === 'draft' ? 'amber' : 'neutral'}>
                          {detail.changelog.status}
                        </Badge>
                        {detail.changelog.category && <Badge tone="neutral">{detail.changelog.category}</Badge>}
                        <span className="text-[11.5px] text-fg-3">
                          {detail.changelog.published_at ? `published ${relativeTime(detail.changelog.published_at)}` : 'not published'}
                        </span>
                      </div>
                      <p className="text-[13px] text-fg-0">{detail.changelog.headline}</p>
                      <div className="mt-2 flex gap-2">
                        {detail.changelog.status !== 'published' && (
                          <Button size="sm" onClick={async () => {
                            await publishChangelog(detail.changelog!.id, 'publish'); load(); onChanged()
                          }}>Publish</Button>
                        )}
                        {detail.changelog.status !== 'skipped' && (
                          <Button size="sm" variant="secondary" onClick={async () => {
                            await publishChangelog(detail.changelog!.id, 'skip'); load(); onChanged()
                          }}>Skip</Button>
                        )}
                      </div>
                    </div>
                  ) : (
                    <p className="text-[12.5px] text-fg-3">No changelog entry — one is created when a PR closing this item merges.</p>
                  )}
                </Section>
              )}

              {/* ── Footer provenance ── */}
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10.5px] text-fg-3">
                <span>created {relativeTime(item.created_at)}</span>
                <span>updated {relativeTime(item.updated_at)}</span>
                <span>closed {item.closed_at ? relativeTime(item.closed_at) : '—'}</span>
                <span>source {item.source_system ?? 'native'}{item.source_id ? `:${item.source_id}` : ''}</span>
              </div>
            </>
          )}
        </div>
      </Modal>
      {confirmDialog}
    </>
  )
}
