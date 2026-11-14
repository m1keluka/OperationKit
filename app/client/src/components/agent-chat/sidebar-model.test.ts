import { describe, it, expect } from 'vitest'
import { buildSidebarView, isSidebarState, shortTime } from './sidebar-model'
import type { ChatAgentInfo, SidebarBot, SidebarState } from './types'

/* obj 900798 — the arrangement rules of the Bots sidebar, without rendering. */

const agent = (slug: string, name: string, description = ''): ChatAgentInfo =>
  ({
    slug, name, description, avatar: name.slice(0, 2).toUpperCase(), colour: 'blue', knowledge_folders: [], tools: [],
    model: null, provider: null, version: null, author: null, source: 'file', answered_by: { id: 'demo', model: null },
  }) as ChatAgentInfo

const bot = (p: Partial<SidebarBot> = {}): SidebarBot => ({
  pinned: false, pin_position: 0, section_id: null, hidden: false, marked_unread: false, unread_count: 0, unread: false, last_message: null, ...p,
})
const last = (id: number, preview: string) => ({ id, role: 'assistant' as const, preview, created_at: '2026-11-13 10:00:00', thread_id: null, thread_title: null })

const AGENTS = [agent('dev', 'Dev Bot', 'Writes code'), agent('mkt', 'Marketing Bot'), agent('ops', 'Ops Bot'), agent('cfo', 'Finance Bot')]
const STATE: SidebarState = {
  sections: [
    { id: 2, name: 'Marketing', position: 1, collapsed: false },
    { id: 1, name: 'Development', position: 0, collapsed: false },
    { id: 3, name: 'Empty one', position: 2, collapsed: false },
  ],
  bots: {
    dev: bot({ section_id: 1, last_message: last(5, 'merged the PR') }),
    mkt: bot({ section_id: 2, unread: true, unread_count: 2, last_message: last(9, 'new campaign draft') }),
    ops: bot({ pinned: true, pin_position: 0, section_id: 1 }),
    cfo: bot({ hidden: true }),
  },
  max_pins: 12,
  max_sections: 20,
}

describe('buildSidebarView', () => {
  it('puts pinned bots in the rail, sections in the person\'s order, empty sections kept, hidden left out', () => {
    const v = buildSidebarView(AGENTS, STATE, 'all', '')
    expect(v.rail.map(a => a.slug)).toEqual(['ops'])
    expect(v.groups.map(g => g.title)).toEqual(['Development', 'Marketing', 'Empty one'])
    expect(v.groups[0].agents.map(a => a.slug)).toEqual(['dev']) // ops is in the rail, not twice
    expect(v.groups[1].agents.map(a => a.slug)).toEqual(['mkt'])
    expect(v.groups[2].agents).toEqual([])
    expect(v.counts).toEqual({ all: 3, unread: 1, pinned: 1, hidden: 1 })
  })

  it('shows a plain untitled list when the person has no sections and no prefs (the default)', () => {
    const v = buildSidebarView(AGENTS, null, 'all', '')
    expect(v.rail).toEqual([])
    expect(v.groups).toHaveLength(1)
    expect(v.groups[0].title).toBeNull()
    expect(v.groups[0].agents).toHaveLength(4)
  })

  it('Unread keeps only unread bots, pinned ones included as rows', () => {
    const s = { ...STATE, bots: { ...STATE.bots, ops: bot({ pinned: true, unread: true, marked_unread: true }) } }
    const v = buildSidebarView(AGENTS, s, 'unread', '')
    expect(v.rail).toEqual([])
    expect(v.groups.flatMap(g => g.agents.map(a => a.slug)).sort()).toEqual(['mkt', 'ops'])
  })

  it('search matches name, id, description and the last message, across sections', () => {
    expect(buildSidebarView(AGENTS, STATE, 'all', 'campaign').groups.flatMap(g => g.agents.map(a => a.slug))).toEqual(['mkt'])
    expect(buildSidebarView(AGENTS, STATE, 'all', 'writes code').groups.flatMap(g => g.agents.map(a => a.slug))).toEqual(['dev'])
    const none = buildSidebarView(AGENTS, STATE, 'all', 'zzz')
    expect(none.empty).toBe(true)
  })

  it('Hidden lists only hidden bots; a section filter lists that section, pinned bots included', () => {
    expect(buildSidebarView(AGENTS, STATE, 'hidden', '').groups[0].agents.map(a => a.slug)).toEqual(['cfo'])
    const dev = buildSidebarView(AGENTS, STATE, 'section:1', '')
    expect(dev.groups[0].title).toBe('Development')
    expect(dev.groups[0].agents.map(a => a.slug).sort()).toEqual(['dev', 'ops'])
  })

  it('orders rows by most recent conversation, then by name', () => {
    const s: SidebarState = { ...STATE, sections: [], bots: { dev: bot({ last_message: last(3, 'a') }), mkt: bot({ last_message: last(7, 'b') }), ops: bot(), cfo: bot() } }
    expect(buildSidebarView(AGENTS, s, 'all', '').groups[0].agents.map(a => a.slug)).toEqual(['mkt', 'dev', 'cfo', 'ops'])
  })
})

describe('isSidebarState', () => {
  it('rejects an empty or odd answer so the defaults stay', () => {
    expect(isSidebarState({})).toBe(false)
    expect(isSidebarState(null)).toBe(false)
    expect(isSidebarState(STATE)).toBe(true)
  })
})

describe('shortTime', () => {
  const now = new Date('2026-11-13T18:00:00Z')
  it('says Yesterday, a weekday, then a date', () => {
    expect(shortTime('2026-11-12 12:00:00', now)).toBe('Yesterday')
    expect(shortTime('2026-11-10T12:00:00Z', now)).toMatch(/^[A-Z][a-z]{2}/)
    expect(shortTime('2026-10-01 12:00:00', now)).toMatch(/Oct/)
    expect(shortTime('not a date', now)).toBe('')
  })
})
