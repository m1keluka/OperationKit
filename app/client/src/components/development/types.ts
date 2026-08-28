/**
 * Development board types, URL helpers, and constants — extracted from
 * DevelopmentPage.tsx (behavior frozen).
 */
import type { DevItemQuery, DevSeverity, DevStatus, DevType } from '../../lib/devItems'

export type Tab = 'inbox' | 'triaged' | 'active' | 'shipped' | 'closed' | 'changelog'
export const TABS: Tab[] = ['inbox', 'triaged', 'active', 'shipped', 'closed', 'changelog']
export const TAB_LABEL: Record<Tab, string> = {
  inbox: 'Inbox', triaged: 'Triaged', active: 'Active',
  shipped: 'Shipped', closed: 'Closed', changelog: 'Changelog',
}
export const TAB_STATUS: Record<Tab, DevStatus[]> = {
  inbox: ['new'],
  triaged: ['triaged'],
  active: ['planned', 'in_progress'],
  shipped: ['shipped'],
  closed: ['declined', 'duplicate'],
  changelog: [],
}
export const TAB_SORT: Record<Tab, NonNullable<DevItemQuery['sort']>> = {
  inbox: 'newest', triaged: 'rank', active: 'rank',
  shipped: 'newest', closed: 'newest', changelog: 'newest',
}
export const SORTS: { value: NonNullable<DevItemQuery['sort']>; label: string }[] = [
  { value: 'rank', label: 'Rank' },
  { value: 'newest', label: 'Newest' },
  { value: 'oldest', label: 'Oldest' },
  { value: 'severity', label: 'Severity' },
  { value: 'score', label: 'Impact/Effort' },
  { value: 'updated', label: 'Last updated' },
]
export const DATE_PRESETS: { value: string; label: string; days: number | null }[] = [
  { value: 'today', label: 'Today', days: 1 },
  { value: '7d', label: 'Last 7 days', days: 7 },
  { value: '30d', label: 'Last 30 days', days: 30 },
  { value: '90d', label: 'Last 90 days', days: 90 },
]

export const SEV_TONE: Record<DevSeverity, 'alarm' | 'amber' | 'info' | 'neutral'> = {
  blocker: 'alarm', high: 'amber', medium: 'info', low: 'neutral',
}
export const STATUS_TONE: Record<DevStatus, 'neutral' | 'accent' | 'verify' | 'amber' | 'alarm' | 'info'> = {
  new: 'accent', triaged: 'info', planned: 'info', in_progress: 'amber',
  shipped: 'verify', declined: 'neutral', duplicate: 'neutral',
}

export interface UiFilters {
  workspace: string[]
  project: string[]
  type: DevType[]
  status: DevStatus[]        // explicit widening; empty = "use the tab's lane"
  severity: string[]
  area: string | null
  route: string | null
  has_replay?: 'yes' | 'no'
  has_screenshot?: 'yes' | 'no'
  unassigned: boolean
  untriaged: boolean
  date: string | null        // null = the tab default
  q: string
  /** true once the user has touched the platform filter — so "All platforms"
      survives a reload instead of being re-seeded from the workspace switcher. */
  wsExplicit: boolean
}

/** URL sentinel for an explicitly-chosen "All platforms". */
export const ALL_PLATFORMS = '__all__'

export const EMPTY_FILTERS: UiFilters = {
  workspace: [], project: [], type: [], status: [], severity: [],
  area: null, route: null, unassigned: false, untriaged: false, date: null, q: '', wsExplicit: true,
}

/* ── URL <-> filter state (§5.4: "every filter writes to the URL") ─────── */
export function filtersFromUrl(): { tab: Tab; filters: UiFilters; sort: NonNullable<DevItemQuery['sort']> | null } {
  const p = new URLSearchParams(window.location.search)
  const tabParam = p.get('tab') as Tab | null
  return {
    tab: tabParam && TABS.includes(tabParam) ? tabParam : 'inbox',
    sort: (p.get('sort') as NonNullable<DevItemQuery['sort']> | null) ?? null,
    filters: {
      workspace: p.getAll('workspace').filter(w => w !== ALL_PLATFORMS),
      wsExplicit: p.getAll('workspace').length > 0,
      project: p.getAll('project'),
      type: p.getAll('type') as DevType[],
      status: p.getAll('status') as DevStatus[],
      severity: p.getAll('severity'),
      area: p.get('area'),
      route: p.get('route'),
      has_replay: (p.get('has_replay') as 'yes' | 'no' | null) ?? undefined,
      has_screenshot: (p.get('has_screenshot') as 'yes' | 'no' | null) ?? undefined,
      unassigned: p.get('unassigned') === '1',
      untriaged: p.get('untriaged') === '1',
      date: p.get('date'),
      q: p.get('q') ?? '',
    },
  }
}

export function urlFor(tab: Tab, f: UiFilters, sort: NonNullable<DevItemQuery['sort']> | null): string {
  const p = new URLSearchParams()
  if (tab !== 'inbox') p.set('tab', tab)
  if (f.workspace.length) f.workspace.forEach(v => p.append('workspace', v))
  else if (f.wsExplicit) p.set('workspace', ALL_PLATFORMS)
  f.project.forEach(v => p.append('project', v))
  f.type.forEach(v => p.append('type', v))
  f.status.forEach(v => p.append('status', v))
  f.severity.forEach(v => p.append('severity', v))
  if (f.area) p.set('area', f.area)
  if (f.route) p.set('route', f.route)
  if (f.has_replay) p.set('has_replay', f.has_replay)
  if (f.has_screenshot) p.set('has_screenshot', f.has_screenshot)
  if (f.unassigned) p.set('unassigned', '1')
  if (f.untriaged) p.set('untriaged', '1')
  if (f.date) p.set('date', f.date)
  if (f.q) p.set('q', f.q)
  if (sort) p.set('sort', sort)
  const s = p.toString()
  return s ? `?${s}` : ''
}

export function activeFilterCount(f: UiFilters): number {
  return [
    f.workspace.length, f.project.length, f.type.length, f.status.length, f.severity.length,
    f.area, f.route, f.has_replay, f.has_screenshot, f.unassigned, f.untriaged, f.date, f.q,
  ].filter(v => (typeof v === 'number' ? v > 0 : Boolean(v))).length
}

export function idFromPath(pathname: string): number | null {
  const m = pathname.match(/^\/development\/DEV-(\d+)$/i)
  return m ? Number(m[1]) : null
}
