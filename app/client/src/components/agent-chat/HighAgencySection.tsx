import { useEffect, useMemo, useState } from 'react'
import { api } from '../../lib/api'
import { Alert, Button, cn } from '../ui'
import {
  DEFAULT_INSTALL_TIMEZONE,
  DEFAULT_LEVEL,
  HIGH_AGENCY_LEVELS,
  isHighAgencyLevel,
  levelSummary,
  MAX_LEVEL,
  MIN_LEVEL,
  runsPerDay,
  wakeTimes,
} from '../../../../shared/high-agency'
import type { ChatAgentInfo, HighAgencyInfo, HighAgencyPatch, HighAgencyResponse } from './types'

/* High Agency (obj 900748; levels 1-10 + the close-out operating loop, obj 900794),
   on the bot's settings panel.

   An optional mode per bot, off by default. When it is on, the bot wakes on a
   schedule set by its LEVEL and runs the High Agency operating loop: orient,
   close out the cards it owns, then choose at most one next project and run it
   — or say nothing is worth doing and stop. Each wake is a board card worked
   by this bot, on the bot's own model when the board can run it.

   Level 1 = one wake at night, level 10 = every hour, in between 4…21 wakes a
   day spread across the whole day — all in the install timezone. The schedule
   is a managed routine the server derives from these settings, so every wake
   also shows on Jobs → Executions. Saving here is the only way to change it.
   Non-admins see the same section read-only. */

/** "EST" / "EDT" for an IANA zone, falling back to the zone name. */
function tzShort(tz: string): string {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(new Date()).find(p => p.type === 'timeZoneName')
    return part?.value ?? tz
  } catch {
    return tz
  }
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
  const [maxProjects, setMaxProjects] = useState(1)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [enabled, setEnabled] = useState(false)
  const [level, setLevel] = useState<number>(DEFAULT_LEVEL)
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
    setLevel(isHighAgencyLevel(h.level) ? h.level : DEFAULT_LEVEL)
    const ws = h.workspace ?? r.workspace_options?.[0] ?? ''
    setWorkspace(ws)
    setLoadedWorkspace(ws)
    setAllowCards(h.allow_cards)
    setAllowWorkflows(h.allow_workflows)
    if (r.workspace_options) setWorkspaces(r.workspace_options)
    if (typeof r.max_new_projects_per_wake === 'number') setMaxProjects(r.max_new_projects_per_wake)
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
    () => (isHighAgencyLevel(level) ? wakeTimes(agent.slug, level) : []),
    [agent.slug, level],
  )
  const timezone = info?.timezone || DEFAULT_INSTALL_TIMEZONE
  const tz = tzShort(timezone)
  const summary = isHighAgencyLevel(level) ? levelSummary(level) : ''

  const dirty = !!info && (
    info.enabled !== enabled ||
    info.level !== level ||
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
      level,
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
          {!info ? '…' : info.enabled ? (paused ? 'On · paused' : `On · level ${info.level}`) : 'Off'}
        </span>
      </div>
      <p className="text-[12px] text-fg-2">
        On each wake this bot runs its area like an owner: it orients on its objectives and data, closes out the cards it owns first, then picks at most one next project and runs it to done — or says nothing is worth doing and stops. No busywork. Each wake is a board card this bot works, on its own model. Off by default.
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
                ? `Level ${level}: wakes ${summary.charAt(0).toLowerCase()}${summary.slice(1)}.`
                : 'This bot never wakes on its own.'}
            </span>
          </span>
        </label>

        <div>
          <div className="mb-1 flex items-baseline justify-between gap-2">
            <label htmlFor={id('level')} className="block text-[12px] font-medium text-fg-1">High Agency level</label>
            <span className="text-[12px] font-medium text-fg-0" aria-live="polite">Level {level} · {summary}</span>
          </div>
          <input
            id={id('level')}
            type="range"
            min={MIN_LEVEL}
            max={MAX_LEVEL}
            step={1}
            value={level}
            onChange={e => { setLevel(Number(e.target.value)); setNotice(null) }}
            aria-valuetext={`Level ${level}: ${summary}`}
            className="w-full accent-[var(--accent)]"
          />
          <div className="flex justify-between text-[12px] text-fg-2" aria-hidden="true">
            <span>1 · once, at night</span>
            <span>10 · every hour</span>
          </div>
        </div>
        <p className="-mt-1 text-[12px] text-fg-2" data-testid="high-agency-preview">
          Wakes at {preview.join(', ')} {tz} ({timezone}).
        </p>
        <details className="-mt-1 text-[12px] text-fg-2">
          <summary className="cursor-pointer">How levels map to wakes a day</summary>
          <table className="mt-1 w-full text-left">
            <thead>
              <tr><th className="pr-2 font-medium">Level</th>{HIGH_AGENCY_LEVELS.map(l => <th key={l} className="px-1 font-medium">{l}</th>)}</tr>
            </thead>
            <tbody>
              <tr><td className="pr-2">Wakes / day</td>{HIGH_AGENCY_LEVELS.map(l => <td key={l} className="px-1">{runsPerDay(l)}</td>)}</tr>
            </tbody>
          </table>
          <p className="mt-1">Level 1 wakes once at night; level 10 every hour. Wakes are spread across the whole day on the hour (minute fixed per bot), in the install timezone.</p>
        </details>
        {info?.wake_model !== undefined && (
          <p className="-mt-1 text-[12px] text-fg-2">
            {info.wake_model ? <>Wakes run on this bot&apos;s model, <code>{info.wake_model}</code>.</> : 'Wakes run on the board’s default model (this bot has no model set that the board can run).'}
          </p>
        )}

        <div>
          <label htmlFor={id('workspace')} className="mb-1 block text-[12px] font-medium text-fg-1">Wake cards go to</label>
          <select id={id('workspace')} value={workspace} onChange={e => { setWorkspace(e.target.value); setNotice(null) }} className={inputCls}>
            {!workspace && <option value="">First workspace this bot may use</option>}
            {[...new Set([...(workspace ? [workspace] : []), ...workspaces])].map(w => <option key={w} value={w}>{w}</option>)}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <p className="text-[12px] font-medium text-fg-1">On each wake, this bot may</p>
          <label className="flex items-start gap-2 px-1 py-1">
            <input type="checkbox" checked={allowCards} onChange={e => { setAllowCards(e.target.checked); setNotice(null) }} className="mt-0.5" />
            <span>
              <span className="block text-[13px] text-fg-0">File and run its next project</span>
              <span className="block text-[12px] text-fg-2">At most {maxProjects} new project card per wake, owned and started by this bot, after it has closed out its own cards.</span>
            </span>
          </label>
          <label className="flex items-start gap-2 px-1 py-1">
            <input type="checkbox" checked={allowWorkflows} onChange={e => { setAllowWorkflows(e.target.checked); setNotice(null) }} className="mt-0.5" />
            <span>
              <span className="block text-[13px] text-fg-0">Propose repeatable workflows</span>
              <span className="block text-[12px] text-fg-2">When its next project is recurring work. A proposal is a draft: nothing runs until you publish it.</span>
            </span>
          </label>
          <p className="px-1 text-[12px] text-fg-2">It never sends email, merges, deploys, spends money or publishes a workflow — those go to your decision queue.</p>
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
