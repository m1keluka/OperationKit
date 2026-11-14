import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../lib/api'
import { isSidebarState } from './sidebar-model'
import type { SidebarSection, SidebarState } from './types'

/** How often the sidebar re-reads unread + previews while the page is visible. */
export const SIDEBAR_POLL_MS = 30_000

const BASE = '/agent-chat/sidebar'
const bot = (slug: string) => `${BASE}/bots/${encodeURIComponent(slug)}`

/**
 * The person's Bots sidebar (obj 900798): pins, sections, hidden, unread and
 * previews, kept in step with /api/agent-chat/sidebar. Every write answers with
 * the whole new state, so the screen always shows what the server stored.
 *
 * The sidebar is ADDITIVE: a server without the route (or with an odd answer)
 * leaves `state` null and the list falls back to the defaults — talking to a
 * bot must never depend on it.
 */
export function useBotSidebar() {
  const [state, setState] = useState<SidebarState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const reading = useRef(new Set<string>())

  const take = useCallback((r: unknown) => {
    if (isSidebarState(r)) setState(r)
  }, [])

  const refresh = useCallback(async () => {
    try {
      take(await api.get<unknown>(BASE))
    } catch {
      /* leave the sidebar as it is */
    }
  }, [take])

  useEffect(() => {
    void refresh()
    const t = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden') void refresh()
    }, SIDEBAR_POLL_MS)
    return () => clearInterval(t)
  }, [refresh])

  /** Run one write; on failure keep the message for the toast and re-read the truth. */
  const run = useCallback(
    async (work: () => Promise<unknown>, failure: string): Promise<boolean> => {
      setError(null)
      try {
        take(await work())
        return true
      } catch (e) {
        setError(e instanceof Error && e.message ? e.message : failure)
        void refresh()
        return false
      }
    },
    [take, refresh],
  )

  const patchLocal = useCallback((slug: string, patch: Partial<SidebarState['bots'][string]>) => {
    setState(s => (s && s.bots[slug] ? { ...s, bots: { ...s.bots, [slug]: { ...s.bots[slug], ...patch } } } : s))
  }, [])

  const markRead = useCallback(
    async (slug: string) => {
      // Opening a bot clears its dot at once; the server answer confirms it.
      patchLocal(slug, { unread: false, unread_count: 0, marked_unread: false })
      if (reading.current.has(slug)) return
      reading.current.add(slug)
      try {
        take(await api.post<unknown>(`${bot(slug)}/read`))
      } catch {
        /* the next poll shows the truth */
      } finally {
        reading.current.delete(slug)
      }
    },
    [patchLocal, take],
  )

  const markUnread = (slug: string) => run(() => api.post(`${bot(slug)}/unread`), 'Could not mark it unread')
  const setPinned = (slug: string, pinned: boolean) =>
    run(() => api.patch(bot(slug), { pinned }), pinned ? 'Could not pin this bot' : 'Could not unpin this bot')
  const setHidden = (slug: string, hidden: boolean) =>
    run(() => api.patch(bot(slug), { hidden }), hidden ? 'Could not hide this bot' : 'Could not show this bot')
  const moveTo = (slug: string, sectionId: number | null) =>
    run(() => api.patch(bot(slug), { section_id: sectionId }), 'Could not move this bot')

  const createSection = async (name: string): Promise<SidebarSection | null> => {
    setError(null)
    try {
      const r = await api.post<{ section: SidebarSection } & SidebarState>(`${BASE}/sections`, { name })
      take(r)
      return r.section ?? null
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'Could not add the section')
      return null
    }
  }
  const renameSection = (id: number, name: string) => run(() => api.patch(`${BASE}/sections/${id}`, { name }), 'Could not rename the section')
  const setCollapsed = (id: number, collapsed: boolean) => {
    setState(s => (s ? { ...s, sections: s.sections.map(x => (x.id === id ? { ...x, collapsed } : x)) } : s))
    return run(() => api.patch(`${BASE}/sections/${id}`, { collapsed }), 'Could not save that')
  }
  const moveSection = (id: number, by: -1 | 1) => {
    const ids = [...(state?.sections ?? [])].sort((a, b) => a.position - b.position || a.id - b.id).map(s => s.id)
    const i = ids.indexOf(id)
    const j = i + by
    if (i < 0 || j < 0 || j >= ids.length) return Promise.resolve(false)
    ;[ids[i], ids[j]] = [ids[j], ids[i]]
    return run(() => api.put(`${BASE}/sections/order`, { ids }), 'Could not move the section')
  }
  const deleteSection = (id: number) => run(() => api.del(`${BASE}/sections/${id}`), 'Could not delete the section')
  const movePin = (slug: string, by: -1 | 1) => {
    const pinned = Object.entries(state?.bots ?? {})
      .filter(([, b]) => b.pinned && !b.hidden)
      .sort(([sa, a], [sb, b]) => a.pin_position - b.pin_position || sa.localeCompare(sb))
      .map(([s]) => s)
    // The server's order covers every pin, hidden ones included (there are none: hiding unpins).
    const i = pinned.indexOf(slug)
    const j = i + by
    if (i < 0 || j < 0 || j >= pinned.length) return Promise.resolve(false)
    ;[pinned[i], pinned[j]] = [pinned[j], pinned[i]]
    return run(() => api.put(`${BASE}/pins/order`, { slugs: pinned }), 'Could not move the pin')
  }

  return {
    state,
    error,
    setError,
    refresh,
    markRead,
    markUnread,
    setPinned,
    setHidden,
    moveTo,
    movePin,
    createSection,
    renameSection,
    setCollapsed,
    moveSection,
    deleteSection,
  }
}

export type BotSidebarApi = ReturnType<typeof useBotSidebar>
