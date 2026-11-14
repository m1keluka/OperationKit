// The Bots sidebar's view model (obj 900798): which bots go in the pinned rail,
// which section each row sits in, and what the filter leaves. Pure functions
// only, so the arrangement rules are tested without rendering anything.
import type { ChatAgentInfo, SidebarBot, SidebarSection, SidebarState } from './types'

/** The left filter. `section:<id>` narrows to one of the person's sections. */
export type SidebarFilter = 'all' | 'unread' | 'pinned' | 'hidden' | `section:${number}`

export const DEFAULT_BOT: SidebarBot = {
  pinned: false,
  pin_position: 0,
  section_id: null,
  hidden: false,
  marked_unread: false,
  unread_count: 0,
  unread: false,
  last_message: null,
}

export function botState(state: SidebarState | null, slug: string): SidebarBot {
  return state?.bots?.[slug] ?? DEFAULT_BOT
}

export interface SidebarGroup {
  /** Stable React key. */
  key: string
  /** Heading; null = no heading (the plain list before any section exists). */
  title: string | null
  section: SidebarSection | null
  agents: ChatAgentInfo[]
}

export interface SidebarView {
  /** The large-avatar rail. Only shown on the unfiltered view. */
  rail: ChatAgentInfo[]
  groups: SidebarGroup[]
  counts: { all: number; unread: number; pinned: number; hidden: number }
  /** True when the filter or search leaves nothing to show. */
  empty: boolean
}

/** A runtime check, so a server that does not answer /sidebar (or answers oddly) leaves the defaults in place. */
export function isSidebarState(v: unknown): v is SidebarState {
  const s = v as SidebarState | null
  return !!s && typeof s === 'object' && Array.isArray(s.sections) && !!s.bots && typeof s.bots === 'object'
}

function matches(a: ChatAgentInfo, b: SidebarBot, q: string): boolean {
  if (!q) return true
  const hay = [a.name, a.slug, a.description, b.last_message?.preview ?? '', b.last_message?.thread_title ?? ''].join('\n').toLowerCase()
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every(word => hay.includes(word))
}

/** Most recent conversation first; bots never talked to after them, by name. */
export function byRecency(state: SidebarState | null) {
  return (x: ChatAgentInfo, y: ChatAgentInfo): number => {
    const lx = botState(state, x.slug).last_message?.id ?? 0
    const ly = botState(state, y.slug).last_message?.id ?? 0
    if (lx !== ly) return ly - lx
    return x.name.localeCompare(y.name)
  }
}

const byPin = (state: SidebarState | null) => (x: ChatAgentInfo, y: ChatAgentInfo) =>
  botState(state, x.slug).pin_position - botState(state, y.slug).pin_position || x.name.localeCompare(y.name)

export function buildSidebarView(
  agents: ChatAgentInfo[],
  state: SidebarState | null,
  filter: SidebarFilter,
  query: string,
): SidebarView {
  const q = query.trim()
  const sections = [...(state?.sections ?? [])].sort((a, b) => a.position - b.position || a.id - b.id)
  const known = new Set(sections.map(s => s.id))
  const sectionOf = (a: ChatAgentInfo) => {
    const id = botState(state, a.slug).section_id
    return id != null && known.has(id) ? id : null
  }
  const visible = agents.filter(a => !botState(state, a.slug).hidden)
  const counts = {
    all: visible.length,
    unread: visible.filter(a => botState(state, a.slug).unread).length,
    pinned: visible.filter(a => botState(state, a.slug).pinned).length,
    hidden: agents.length - visible.length,
  }
  const recency = byRecency(state)
  const found = (list: ChatAgentInfo[]) => list.filter(a => matches(a, botState(state, a.slug), q))

  // The flat filters: one list, no rail.
  if (filter === 'pinned' || filter === 'hidden') {
    const list =
      filter === 'pinned'
        ? found(visible.filter(a => botState(state, a.slug).pinned)).sort(byPin(state))
        : found(agents.filter(a => botState(state, a.slug).hidden)).sort((x, y) => x.name.localeCompare(y.name))
    return {
      rail: [],
      groups: list.length ? [{ key: filter, title: filter === 'pinned' ? 'Pinned' : 'Hidden from sidebar', section: null, agents: list }] : [],
      counts,
      empty: list.length === 0,
    }
  }

  if (filter.startsWith('section:')) {
    const id = Number(filter.slice('section:'.length))
    const section = sections.find(s => s.id === id) ?? null
    const list = section ? found(visible.filter(a => sectionOf(a) === id)).sort(recency) : []
    return {
      rail: [],
      groups: section ? [{ key: `s${id}`, title: section.name, section: { ...section, collapsed: false }, agents: list }] : [],
      counts,
      empty: list.length === 0,
    }
  }

  // 'all' and 'unread': the person's sections in their order, then "Other bots".
  const narrowing = filter === 'unread' || q !== ''
  const pool = found(filter === 'unread' ? visible.filter(a => botState(state, a.slug).unread) : visible)
  // The rail holds the pinned bots on the plain view; while narrowing, a
  // pinned match is a normal row so nothing that matches is tucked away.
  const rail = narrowing ? [] : pool.filter(a => botState(state, a.slug).pinned).sort(byPin(state))
  const rows = narrowing ? pool : pool.filter(a => !botState(state, a.slug).pinned)
  const groups: SidebarGroup[] = sections.map(s => ({
    key: `s${s.id}`,
    title: s.name,
    section: s,
    agents: rows.filter(a => sectionOf(a) === s.id).sort(recency),
  }))
  const other = rows.filter(a => sectionOf(a) === null).sort(recency)
  groups.push({ key: 'other', title: sections.length ? 'Other bots' : null, section: null, agents: other })
  // An empty section stays on the plain view (so a new one is visible and can
  // be filled); while narrowing, only groups with a match are shown.
  const shown = groups.filter(g => (narrowing ? g.agents.length > 0 : g.section !== null || g.agents.length > 0))
  return { rail, groups: shown, counts, empty: rail.length === 0 && shown.every(g => g.agents.length === 0) }
}

/** "3:42 PM" today, "Yesterday", "Tue" this week, "Nov 3" this year, else "Nov 3, 2025". */
export function shortTime(iso: string, now: Date = new Date()): string {
  const d = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`)
  if (Number.isNaN(d.getTime())) return ''
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((day(now) - day(d)) / 86_400_000)
  if (days <= 0) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (days === 1) return 'Yesterday'
  if (days < 7) return d.toLocaleDateString([], { weekday: 'short' })
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
}
