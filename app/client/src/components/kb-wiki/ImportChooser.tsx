import { useCallback, useEffect, useState } from 'react'
import { Play } from 'lucide-react'
import {
  compactFilter, itemQuery, shortDate,
  type ImportItem, type ImportItemStatus, type ImportJobSummary, type ItemFilter,
} from '../../lib/kbWiki'
import { Alert, Badge, Button, SearchInput, Skeleton, cn } from '../ui'
import { wikiApi, wsQuery } from './wikiApi'

const PAGE_SIZE = 50

export const ITEM_STATUS: Record<ImportItemStatus, { label: string; tone: 'neutral' | 'info' | 'verify' | 'alarm' | 'amber' }> = {
  pending: { label: 'Not imported', tone: 'neutral' },
  queued: { label: 'Waiting', tone: 'neutral' },
  working: { label: 'Reading', tone: 'info' },
  done: { label: 'Imported', tone: 'verify' },
  skipped: { label: 'Skipped', tone: 'amber' },
  failed: { label: 'Failed', tone: 'alarm' },
}

const FIELD = 'min-h-[44px] rounded-md border border-line bg-surface-1 px-2 text-[13px] text-fg-0 transition-colors duration-fast hover:border-line-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:min-h-[36px]'

/* ImportChooser (obj 720117) — pick which chats/calls of an import get read.
   Search + date range + status + "at least N messages", tick per row or every
   match at once, 50 per page, then "Process N selected". */
export function ImportChooser({
  workspace,
  job,
  onJobChanged,
  onOpenNote,
}: {
  workspace: string
  job: ImportJobSummary
  onJobChanged: () => void
  onOpenNote: (rel: string) => void
}) {
  const [filter, setFilter] = useState<ItemFilter>({})
  const [q, setQ] = useState('')
  const [offset, setOffset] = useState(0)
  const [items, setItems] = useState<ImportItem[] | null>(null)
  const [total, setTotal] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const base = `/imports/${encodeURIComponent(job.id)}`
  const running = job.status === 'running'
  const progressKey = `${job.status}:${job.counts.done}:${job.counts.skipped}:${job.counts.failed}:${job.counts.working}`

  // Debounce the search box.
  useEffect(() => {
    const t = setTimeout(() => { setFilter(f => ({ ...f, q })); setOffset(0) }, 300)
    return () => clearTimeout(t)
  }, [q])

  const load = useCallback(async () => {
    try {
      const b = await wikiApi<{ items: ImportItem[]; total: number }>(`${base}/items?${wsQuery(workspace)}&${itemQuery(filter, offset, PAGE_SIZE)}`)
      setItems(b.items)
      setTotal(b.total)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [base, workspace, filter, offset])

  // Reload when the filter/page changes and as the background import progresses.
  useEffect(() => { void load() }, [load, progressKey])

  const select = async (sel: { keys?: string[]; all_matching?: ItemFilter; selected: boolean }, tag: string) => {
    setBusy(tag)
    try {
      await wikiApi(`${base}/select?${wsQuery(workspace)}`, { method: 'POST', json: { workspace, ...sel } })
      if (sel.keys) setItems(list => list?.map(i => (sel.keys!.includes(i.key) ? { ...i, selected: sel.selected } : i)) ?? null)
      else await load()
      onJobChanged()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const start = async () => {
    setBusy('start')
    try {
      await wikiApi(`${base}/start?${wsQuery(workspace)}`, { method: 'POST', json: { workspace } })
      onJobChanged()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const setField = (patch: Partial<ItemFilter>) => { setFilter(f => ({ ...f, ...patch })); setOffset(0) }
  const filtered = Object.keys(compactFilter(filter)).length > 0
  const toProcess = job.counts.selected - job.counts.done - job.counts.skipped

  return (
    <div className="flex flex-col gap-3 rounded-md border border-line-soft bg-surface-1 p-3">
      <div className="flex flex-col gap-2 lg:flex-row lg:flex-wrap lg:items-end">
        <SearchInput
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Search titles, people and text"
          aria-label="Search chats"
          wrapClassName="w-full lg:w-64"
        />
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-[11.5px] text-fg-3">
            From
            <input type="date" value={filter.from ?? ''} onChange={e => setField({ from: e.target.value || undefined })} className={FIELD} />
          </label>
          <label className="flex flex-col gap-1 text-[11.5px] text-fg-3">
            To
            <input type="date" value={filter.to ?? ''} onChange={e => setField({ to: e.target.value || undefined })} className={FIELD} />
          </label>
          <label className="flex flex-col gap-1 text-[11.5px] text-fg-3">
            Status
            <select value={filter.status ?? ''} onChange={e => setField({ status: (e.target.value || undefined) as ImportItemStatus | undefined })} className={FIELD}>
              <option value="">Any</option>
              {(Object.keys(ITEM_STATUS) as ImportItemStatus[]).map(s => <option key={s} value={s}>{ITEM_STATUS[s].label}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[11.5px] text-fg-3">
            Length
            <select value={filter.min_messages ?? 0} onChange={e => setField({ min_messages: Number(e.target.value) || undefined })} className={FIELD}>
              <option value={0}>Any length</option>
              <option value={2}>2+ messages</option>
              <option value={5}>5+ messages</option>
              <option value={10}>10+ messages</option>
              <option value={25}>25+ messages</option>
            </select>
          </label>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[12.5px] text-fg-2">
          {filtered ? `${total} match${total === 1 ? '' : 'es'}` : `${total} in this import`} · <span className="text-fg-0">{job.counts.selected} ticked</span>
        </span>
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" variant="secondary" className="min-h-[44px] sm:min-h-[32px]" loading={busy === 'all'} disabled={!total || !!busy}
            onClick={() => { void select({ all_matching: compactFilter(filter), selected: true }, 'all') }}>
            {filtered ? `Tick all ${total} matching` : 'Tick all'}
          </Button>
          <Button size="sm" variant="ghost" className="min-h-[44px] sm:min-h-[32px]" loading={busy === 'none'} disabled={!job.counts.selected || !!busy}
            onClick={() => { void select({ all_matching: {}, selected: false }, 'none') }}>
            Clear ticks
          </Button>
        </div>
      </div>

      {error && <Alert tone="alarm" title="Something went wrong">{error}</Alert>}

      {!items && !error && (
        <div className="flex flex-col gap-2" aria-busy="true">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      )}

      {items && items.length === 0 && (
        <p className="py-6 text-center text-[13px] text-fg-2">Nothing matches. Try a wider date range or clear the search.</p>
      )}

      {items && items.length > 0 && (
        <ul className="flex flex-col divide-y divide-line-soft">
          {items.map(it => {
            const st = ITEM_STATUS[it.status]
            const locked = it.status === 'working' || it.status === 'done'
            return (
              <li key={it.key} className="flex items-start gap-2 py-2">
                <label className={cn('grid min-h-[44px] min-w-[44px] shrink-0 place-items-center rounded-md sm:min-h-[32px] sm:min-w-[32px]', locked ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-surface-2')}>
                  <input
                    type="checkbox"
                    checked={it.selected}
                    disabled={locked || busy === it.key}
                    onChange={e => { void select({ keys: [it.key], selected: e.target.checked }, it.key) }}
                    aria-label={`Include “${it.title}”`}
                    className="h-4 w-4 accent-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  />
                </label>
                <div className="min-w-0 flex-1 py-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="min-w-0 truncate text-[13.5px] font-medium text-fg-0" title={it.title}>{it.title}</span>
                    {it.status !== 'pending' && <Badge tone={st.tone}>{st.label}</Badge>}
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11.5px] text-fg-3">
                    {it.started_at && <span>{shortDate(it.started_at)}</span>}
                    <span>{it.message_count} message{it.message_count === 1 ? '' : 's'}</span>
                    {it.participants.length > 0 && (
                      <span className="min-w-0 truncate">
                        {it.participants.slice(0, 3).join(', ')}{it.participants.length > 3 ? ` +${it.participants.length - 3}` : ''}
                      </span>
                    )}
                  </div>
                  {it.preview && <p className="mt-1 line-clamp-2 text-[12.5px] leading-snug text-fg-2">{it.preview}</p>}
                  {it.status === 'skipped' && it.skip_reason && <p className="mt-1 text-[12px] text-signal-amber">Skipped: {it.skip_reason}</p>}
                  {it.status === 'failed' && it.error && <p className="mt-1 text-[12px] text-signal-alarm">{it.error}</p>}
                  {it.source_note && (
                    <Button size="sm" variant="ghost" className="mt-1 min-h-[44px] px-2 sm:min-h-[28px]" onClick={() => onOpenNote(it.source_note!)}>
                      Open readable copy
                    </Button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between gap-2 border-t border-line-soft pt-2">
          <Button size="sm" variant="ghost" className="min-h-[44px] sm:min-h-[32px]" disabled={offset === 0} onClick={() => setOffset(o => Math.max(0, o - PAGE_SIZE))}>
            Previous
          </Button>
          <span className="font-mono text-[11.5px] text-fg-3">
            {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
          </span>
          <Button size="sm" variant="ghost" className="min-h-[44px] sm:min-h-[32px]" disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(o => o + PAGE_SIZE)}>
            Next
          </Button>
        </div>
      )}

      {!running && job.status !== 'cancelled' && (
        <div className="flex flex-col gap-2 border-t border-line-soft pt-3 sm:flex-row sm:items-center sm:justify-between">
          <span className="text-[12px] text-fg-3">Small talk and chats with no business facts are skipped automatically.</span>
          <Button variant="primary" loading={busy === 'start'} disabled={toProcess <= 0 || !!busy} onClick={() => { void start() }}
            leftIcon={<Play className="h-4 w-4" aria-hidden="true" />}>
            {toProcess > 0 ? `Process ${toProcess} selected` : 'Tick chats to process'}
          </Button>
        </div>
      )}
    </div>
  )
}
