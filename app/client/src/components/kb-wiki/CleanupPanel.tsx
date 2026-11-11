import { useCallback, useEffect, useMemo, useState } from 'react'
import { CheckCircle2, Eye, RefreshCw, Wand2 } from 'lucide-react'
import {
  LINT_KIND_LABEL, hourLabel, labelFromRel,
  type LintItem, type LintReport, type LintSchedule, type WikiPageSummary, type WikiSettings,
} from '../../lib/kbWiki'
import { Alert, Badge, Button, EmptyState, SkeletonText, useConfirm } from '../ui'
import { wikiApi, wsQuery } from './wikiApi'

const SCHEDULE_LABEL: Record<LintSchedule, string> = {
  nightly: 'Every night',
  weekly: 'Once a week',
  off: 'Only when I click “Run cleanup now”',
}

const FIELD = 'min-h-[44px] rounded-md border border-line bg-surface-1 px-2 text-[13px] text-fg-0 transition-colors duration-fast hover:border-line-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-60 sm:min-h-[36px]'

function when(iso?: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/* CleanupPanel (obj 720117) — the wiki's tidy-up pass: what it fixed by itself,
   what needs a person to look at, "Run cleanup now", and the schedule (admins
   change it; everyone else sees it read-only). */
export function CleanupPanel({
  workspace,
  pages,
  isAdmin,
  onOpenNote,
  onChanged,
}: {
  workspace: string
  pages: WikiPageSummary[] | null
  isAdmin: boolean
  onOpenNote: (rel: string) => void
  onChanged: () => void
}) {
  const [report, setReport] = useState<LintReport | null>(null)
  const [settings, setSettings] = useState<WikiSettings | null>(null)
  const [nextRun, setNextRun] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedNote, setSavedNote] = useState<string | null>(null)
  const [rebuilding, setRebuilding] = useState(false)
  const { confirm, confirmDialog } = useConfirm()

  const titles = useMemo(() => new Map((pages ?? []).map(p => [p.rel, p.title])), [pages])

  const load = useCallback(async () => {
    if (!workspace) return
    try {
      const b = await wikiApi<{ report: LintReport | null; settings: WikiSettings; next_run?: string | null }>(`/lint?${wsQuery(workspace)}`)
      setReport(b.report)
      setSettings(b.settings)
      setNextRun(b.next_run ?? null)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoaded(true)
    }
  }, [workspace])

  useEffect(() => { setLoaded(false); void load() }, [load])

  const runNow = async () => {
    setRunning(true)
    setError(null)
    try {
      const b = await wikiApi<{ report: LintReport }>(`/lint/run?${wsQuery(workspace)}`, { method: 'POST', json: { workspace } })
      setReport(b.report)
      onChanged()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setRunning(false)
    }
  }

  const saveSettings = async (patch: Partial<WikiSettings>) => {
    if (!settings) return
    const next = { ...settings, ...patch }
    setSettings(next)
    setSaving(true)
    setSavedNote(null)
    try {
      const b = await wikiApi<{ settings?: WikiSettings } & Partial<WikiSettings>>(`/lint/settings?${wsQuery(workspace)}`, { method: 'PUT', json: { workspace, ...patch } })
      if (b.settings) setSettings(b.settings)
      setSavedNote('Schedule saved.')
      void load()
    } catch (e) {
      setError((e as Error).message)
      void load()
    } finally {
      setSaving(false)
    }
  }

  const rebuild = async () => {
    if (!(await confirm({
      title: 'Rebuild the whole wiki?',
      message: 'Moves the current pages to a trash folder and re-reads every original. Originals are never touched. Saved answers are kept. This can take a while.',
      confirmLabel: 'Rebuild',
      danger: true,
    }))) return
    setRebuilding(true)
    setError(null)
    try {
      await wikiApi(`/rebuild?${wsQuery(workspace)}`, { method: 'POST', json: { workspace, confirm: true } })
      setSavedNote('Rebuild started. Pages will reappear as the files are read again.')
      onChanged()
      void load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setRebuilding(false)
    }
  }

  const pageButton = (rel: string) => (
    <button
      key={rel}
      type="button"
      onClick={() => onOpenNote(rel)}
      className="inline-flex min-h-[44px] items-center rounded-md border border-line-soft bg-surface-2 px-2.5 text-[12px] text-fg-1 transition-all duration-fast hover:border-line-strong hover:bg-surface-3 hover:text-fg-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:min-h-[28px]"
    >
      {titles.get(rel) ?? labelFromRel(rel)}
    </button>
  )

  const itemList = (list: LintItem[], tone: 'verify' | 'amber') => (
    <ul className="flex flex-col divide-y divide-line-soft">
      {list.map((it, i) => {
        const rels = [...new Set([...(it.page ? [it.page] : []), ...(it.pages ?? [])])]
        return (
          <li key={`${it.kind}-${it.page ?? ''}-${i}`} className="flex flex-col gap-1.5 py-2.5">
            <div className="flex flex-wrap items-start gap-2">
              <Badge tone={tone}>{LINT_KIND_LABEL[it.kind] ?? it.kind}</Badge>
              <p className="min-w-0 flex-1 text-[13px] leading-snug text-fg-1">{it.detail}</p>
            </div>
            {rels.length > 0 && <div className="flex flex-wrap gap-1.5">{rels.map(pageButton)}</div>}
          </li>
        )
      })}
    </ul>
  )

  if (!loaded) {
    return <div aria-busy="true"><span className="sr-only">Loading cleanup…</span><SkeletonText lines={5} /></div>
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <p className="max-w-[64ch] text-[13px] leading-relaxed text-fg-2">
          Cleanup checks the wiki for broken links, missing topic pages, pages nothing links to, likely duplicates,
          pages that haven’t been updated in a while, and facts that disagree between files. Safe fixes happen
          automatically; anything that needs judgement is listed for you. Your original files are never changed.
        </p>
        <Button variant="primary" loading={running} disabled={!workspace} onClick={() => { void runNow() }}
          leftIcon={<Wand2 className="h-4 w-4" aria-hidden="true" />} className="shrink-0">
          Run cleanup now
        </Button>
      </div>

      {error && <Alert tone="alarm" title="Something went wrong">{error}</Alert>}
      {savedNote && !error && <Alert tone="verify" title={savedNote} />}

      {running && (
        <div aria-live="polite" aria-busy="true">
          <span className="sr-only">Cleaning up…</span>
          <SkeletonText lines={4} />
        </div>
      )}

      {!running && !report && (
        <EmptyState
          compact
          icon={<Wand2 className="h-5 w-5" aria-hidden="true" />}
          title="Cleanup hasn't run yet"
          description="It runs on the schedule below, or click “Run cleanup now” to check the wiki right away."
        />
      )}

      {!running && report && (
        <div className="flex flex-col gap-5">
          <p className="text-[12.5px] text-fg-3">Last run {when(report.ran_at)}.</p>
          {(report.notes ?? []).map(n => <Alert key={n} tone="info">{n}</Alert>)}

          <section aria-labelledby="cleanup-needs" className="flex flex-col gap-1.5">
            <h4 id="cleanup-needs" className="flex items-center gap-2 font-display text-[13.5px] font-semibold tracking-[-0.01em] text-fg-0">
              <Eye className="h-4 w-4 text-signal-amber" aria-hidden="true" />
              Needs a look
              <span className="font-mono text-[11px] font-normal text-fg-3">{report.needs_human.length}</span>
            </h4>
            {report.needs_human.length === 0
              ? <p className="text-[13px] text-fg-2">Nothing needs your attention.</p>
              : itemList(report.needs_human, 'amber')}
          </section>

          <section aria-labelledby="cleanup-fixed" className="flex flex-col gap-1.5">
            <h4 id="cleanup-fixed" className="flex items-center gap-2 font-display text-[13.5px] font-semibold tracking-[-0.01em] text-fg-0">
              <CheckCircle2 className="h-4 w-4 text-signal-verify" aria-hidden="true" />
              Fixed automatically
              <span className="font-mono text-[11px] font-normal text-fg-3">{report.fixed.length}</span>
            </h4>
            {report.fixed.length === 0
              ? <p className="text-[13px] text-fg-2">Nothing needed fixing.</p>
              : itemList(report.fixed, 'verify')}
          </section>
        </div>
      )}

      {settings && (
        <section aria-labelledby="cleanup-schedule" className="flex flex-col gap-2 border-t border-line-soft pt-4">
          <h4 id="cleanup-schedule" className="font-display text-[13.5px] font-semibold tracking-[-0.01em] text-fg-0">Schedule</h4>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-[11.5px] text-fg-3">
              How often
              <select value={settings.lint_schedule} disabled={!isAdmin || saving}
                onChange={e => { void saveSettings({ lint_schedule: e.target.value as LintSchedule }) }} className={FIELD}>
                {(Object.keys(SCHEDULE_LABEL) as LintSchedule[]).map(s => <option key={s} value={s}>{SCHEDULE_LABEL[s]}</option>)}
              </select>
            </label>
            {settings.lint_schedule === 'nightly' && (
              <label className="flex flex-col gap-1 text-[11.5px] text-fg-3">
                At
                <select value={settings.lint_hour_utc} disabled={!isAdmin || saving}
                  onChange={e => { void saveSettings({ lint_hour_utc: Number(e.target.value) }) }} className={FIELD}>
                  {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
                </select>
              </label>
            )}
          </div>
          <p className="text-[12px] text-fg-3">
            {nextRun && settings.lint_schedule !== 'off' ? `Next run around ${when(nextRun)}. ` : ''}
            {isAdmin ? 'This schedule applies to every workspace.' : 'Only an admin can change the schedule.'}
          </p>
        </section>
      )}

      {isAdmin && (
        <section aria-labelledby="cleanup-rebuild" className="flex flex-col gap-2 border-t border-line-soft pt-4">
          <h4 id="cleanup-rebuild" className="font-display text-[13.5px] font-semibold tracking-[-0.01em] text-fg-0">Start over</h4>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="max-w-[60ch] text-[12.5px] text-fg-2">
              Rebuild every page from your original files and imported chats — useful after big changes to how pages are written.
            </p>
            <Button variant="danger" loading={rebuilding} onClick={() => { void rebuild() }} leftIcon={<RefreshCw className="h-4 w-4" aria-hidden="true" />} className="shrink-0">
              Rebuild wiki
            </Button>
          </div>
        </section>
      )}
      {confirmDialog}
    </div>
  )
}
