import { useEffect, useMemo, useState } from 'react'
import { api } from '../../lib/api'
import { Alert, Button, cn } from '../ui'
import {
  DEFAULT_FIRST_HOUR,
  HIGH_AGENCY_CADENCES,
  isHighAgencyCadence,
  wakeTimes,
} from '../../../../shared/high-agency'
import type { ChatAgentInfo, HighAgencyInfo, HighAgencyPatch, HighAgencyResponse } from './types'

/* High Agency (obj 900748), on the bot's settings panel.

   An optional mode per bot, off by default. When it is on, the bot wakes a few
   times a day and asks itself "What's the next thing I need to do? If nothing
   is urgent, what can I do to move my area of the business forward?". Each
   wake is a board card worked by this bot; it may file cards and propose
   repeatable workflows (drafts only — publishing is always the owner's click).

   The schedule is a managed routine the server derives from these settings, so
   every wake also shows on Jobs → Executions. Saving here is the only way to
   change it. Non-admins see the same section read-only. */

const HOURS = Array.from({ length: 24 }, (_, h) => h)
const hh = (h: number) => `${String(h).padStart(2, '0')}:00`

function cadenceLabel(n: number): string {
  if (n === 1) return 'Once a day'
  if (n === 2) return 'Twice a day'
  return `${n} times a day`
}

function when(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })
}

export function HighAgencySection({
  agent,
  isAdmin,
}: {
  agent: Pick<ChatAgentInfo, 'slug' | 'name'>
  isAdmin: boolean
}) {
  const [info, setInfo] = useState<HighAgencyInfo | null>(null)
  const [workspaces, setWorkspaces] = useState<string[]>([])
  const [maxCards, setMaxCards] = useState(3)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [enabled, setEnabled] = useState(false)
  const [times, setTimes] = useState<number>(1)
  const [firstHour, setFirstHour] = useState<number>(DEFAULT_FIRST_HOUR)
  const [workspace, setWorkspace] = useState<string>('')
  // What the picker showed when the setting loaded (a fresh bot has no saved
  // workspace, so the picker starts on the first option) — the dirty baseline.
  const [loadedWorkspace, setLoadedWorkspace] = useState<string>('')
  const [allowCards, setAllowCards] = useState(true)
  const [allowWorkflows, setAllowWorkflows] = useState(true)

  const [busy, setBusy] = useState<'save' | 'wake' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const url = `/agent-chat/agents/${encodeURIComponent(agent.slug)}/high-agency`

  const adopt = (r: HighAgencyResponse) => {
    const h = r?.high_agency
    if (!h) throw new Error('This server does not support High Agency yet')
    setInfo(h)
    setEnabled(h.enabled)
    setTimes(h.times_per_day)
    setFirstHour(h.first_hour)
    const ws = h.workspace ?? r.workspace_options?.[0] ?? ''
    setWorkspace(ws)
    setLoadedWorkspace(ws)
    setAllowCards(h.allow_cards)
    setAllowWorkflows(h.allow_workflows)
    if (r.workspace_options) setWorkspaces(r.workspace_options)
    if (typeof r.max_cards_per_wake === 'number') setMaxCards(r.max_cards_per_wake)
  }

  useEffect(() => {
    let live = true
    setLoadError(null)
    api.get<HighAgencyResponse>(url)
      .then(r => { if (live) adopt(r) })
      .catch(e => { if (live) setLoadError(e instanceof Error ? e.message : 'Could not load High Agency') })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url])

  // The preview follows the form, not the saved row, so the admin sees the
  // exact wake times before pressing Save.
  const preview = useMemo(
    () => (isHighAgencyCadence(times) ? wakeTimes(agent.slug, times, firstHour) : []),
    [agent.slug, times, firstHour],
  )

  const dirty = !!info && (
    info.enabled !== enabled ||
    info.times_per_day !== times ||
    info.first_hour !== firstHour ||
    loadedWorkspace !== workspace ||
    info.allow_cards !== allowCards ||
    info.allow_workflows !== allowWorkflows
  )

  const save = async () => {
    setBusy('save')
    setError(null)
    setNotice(null)
    const body: HighAgencyPatch = {
      enabled,
      times_per_day: times,
      first_hour: firstHour,
      workspace: workspace || null,
      allow_cards: allowCards,
      allow_workflows: allowWorkflows,
    }
    try {
      adopt(await api.put<HighAgencyResponse>(url, body))
      setNotice(enabled ? 'Saved. High Agency is on.' : 'Saved. High Agency is off.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save High Agency')
    } finally {
      setBusy(null)
    }
  }

  const wake = async () => {
    setBusy('wake')
    setError(null)
    setNotice(null)
    try {
      const r = await api.post<HighAgencyResponse>(`${url}/wake`, {})
      adopt(r)
      setNotice(r.result?.objective_id ? `Woke ${agent.name}: card #${r.result.objective_id}.` : 'Wake started.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The wake did not start')
    } finally {
      setBusy(null)
    }
  }

  const inputCls =
    'min-h-[40px] w-full rounded-md border border-line bg-surface-0 px-2 text-[13px] text-fg-0 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-60'
  const id = (k: string) => `high-agency-${k}-${agent.slug}`
  const paused = info?.enabled && info.routine && !info.routine.enabled
  const disabled = !isAdmin || busy !== null || !info

  return (
    <section aria-labelledby={id('title')} className="flex flex-col gap-3 border-t border-line pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 id={id('title')} className="font-display text-[13px] font-semibold text-fg-0">High Agency</h4>
        <span
          className={cn(
            'rounded-full px-2 py-0.5 text-[12px]',
            info?.enabled ? 'bg-[var(--accent-tint)] text-accent-hover' : 'bg-surface-2 text-fg-2',
          )}
        >
          {!info ? '…' : info.enabled ? (paused ? 'On · paused' : `On · ${cadenceLabel(info.times_per_day).toLowerCase()}`) : 'Off'}
        </span>
      </div>
      <p className="text-[12px] text-fg-2">
        Wake this bot on a schedule to ask itself: <em>&ldquo;What&apos;s the next thing I need to do? If nothing is urgent, what can I do to move my area of the business forward?&rdquo;</em> Each wake is a board card this bot works. Off by default.
      </p>

      {loadError && <Alert tone="alarm">{loadError}</Alert>}

      <fieldset className="flex flex-col gap-3" disabled={disabled}>
        <legend className="sr-only">High Agency settings</legend>
        <label className="flex items-start gap-2 rounded-md border border-line bg-surface-0 px-3 py-2">
          <input
            type="checkbox"
            role="switch"
            aria-checked={enabled}
            checked={enabled}
            onChange={e => { setEnabled(e.target.checked); setNotice(null) }}
            className="mt-0.5"
            aria-describedby={id('help')}
          />
          <span>
            <span className="block text-[13px] font-medium text-fg-0">High Agency on</span>
            <span id={id('help')} className="block text-[12px] text-fg-2">
              {enabled && preview.length
                ? `Wakes ${cadenceLabel(times).toLowerCase()} at ${preview.join(', ')} UTC.`
                : 'This bot never wakes on its own.'}
            </span>
          </span>
        </label>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor={id('times')} className="mb-1 block text-[12px] font-medium text-fg-1">How often</label>
            <select id={id('times')} value={times} onChange={e => { setTimes(Number(e.target.value)); setNotice(null) }} className={inputCls}>
              {HIGH_AGENCY_CADENCES.map(n => <option key={n} value={n}>{cadenceLabel(n)}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor={id('first')} className="mb-1 block text-[12px] font-medium text-fg-1">First wake (UTC)</label>
            <select id={id('first')} value={firstHour} onChange={e => { setFirstHour(Number(e.target.value)); setNotice(null) }} className={inputCls}>
              {HOURS.map(h => <option key={h} value={h}>{hh(h)}</option>)}
            </select>
          </div>
        </div>
        <p className="-mt-1 text-[12px] text-fg-2">
          Wakes are spread over the 12 hours from the first wake: {preview.join(', ')} UTC.
        </p>

        <div>
          <label htmlFor={id('workspace')} className="mb-1 block text-[12px] font-medium text-fg-1">Wake cards go to</label>
          <select id={id('workspace')} value={workspace} onChange={e => { setWorkspace(e.target.value); setNotice(null) }} className={inputCls}>
            {!workspace && <option value="">Your first workspace</option>}
            {[...new Set([...(workspace ? [workspace] : []), ...workspaces])].map(w => <option key={w} value={w}>{w}</option>)}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <p className="text-[12px] font-medium text-fg-1">On each wake, this bot may</p>
          <label className="flex items-start gap-2 px-1 py-1">
            <input type="checkbox" checked={allowCards} onChange={e => { setAllowCards(e.target.checked); setNotice(null) }} className="mt-0.5" />
            <span>
              <span className="block text-[13px] text-fg-0">Write cards to the board</span>
              <span className="block text-[12px] text-fg-2">Up to {maxCards} new cards per wake, each linked back to the wake.</span>
            </span>
          </label>
          <label className="flex items-start gap-2 px-1 py-1">
            <input type="checkbox" checked={allowWorkflows} onChange={e => { setAllowWorkflows(e.target.checked); setNotice(null) }} className="mt-0.5" />
            <span>
              <span className="block text-[13px] text-fg-0">Propose repeatable workflows</span>
              <span className="block text-[12px] text-fg-2">For work that recurs. A proposal is a draft: nothing runs until you publish it.</span>
            </span>
          </label>
          <p className="px-1 text-[12px] text-fg-2">It never sends email, merges, deploys, spends money or publishes a workflow.</p>
        </div>
      </fieldset>

      {info && (info.next_wake_at || info.last_wake) && (
        <p className="text-[12px] text-fg-2">
          {info.next_wake_at && <>Next wake {when(info.next_wake_at)}. </>}
          {info.last_wake && (
            <>Last wake: <a className="text-accent-hover underline" href={`/o/${info.last_wake.objective_id}`}>card #{info.last_wake.objective_id}</a> ({info.last_wake.status}).</>
          )}
        </p>
      )}
      {paused && (
        <Alert tone="amber">
          The wake schedule is paused on the Jobs page{info?.routine?.auto_pause_reason ? ` (${info.routine.auto_pause_reason})` : ''}. Save here to resume it.
        </Alert>
      )}
      {error && <Alert tone="alarm">{error}</Alert>}

      {isAdmin && (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" size="sm" loading={busy === 'save'} disabled={!info || busy !== null || (!dirty && !paused)} onClick={() => void save()}>
            Save High Agency
          </Button>
          <Button variant="ghost" size="sm" loading={busy === 'wake'} disabled={!info || busy !== null} onClick={() => void wake()}>
            Wake now
          </Button>
          {notice && <span role="status" className="text-[12px] text-fg-2">{notice}</span>}
          {!notice && info?.updated_by && <span className="text-[12px] text-fg-2">Changed by {info.updated_by}</span>}
        </div>
      )}
      {!isAdmin && <p className="text-[12px] text-fg-2">Only an admin can change High Agency.</p>}
    </section>
  )
}
