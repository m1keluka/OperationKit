import { useCallback, useEffect, useRef, useState } from 'react'
import type { Objective, ObjectiveStatus, Workspace } from '@operationkit/shared'
import { api } from '../lib/api'

/** Server caps ?limit at 200; walk pages until a short page. */
const PAGE_SIZE = 200

function workspaceQuery(workspaces: Workspace[]): string {
  const list = workspaces.filter(w => w && w !== 'all')
  if (list.length === 0) return ''
  if (list.length === 1) return `workspace=${encodeURIComponent(list[0])}`
  return `workspaces=${list.map(encodeURIComponent).join(',')}`
}

function scopeFromKey(wsKey: string): Workspace[] {
  return wsKey ? (wsKey.split(',') as Workspace[]) : []
}

async function fetchAllForStatus(
  status: Extract<ObjectiveStatus, 'done' | 'cancelled'>,
  workspaces: Workspace[],
  onPage: (acc: Objective[]) => void,
  cancelled: () => boolean,
): Promise<Objective[]> {
  const acc: Objective[] = []
  let offset = 0
  const q = workspaceQuery(workspaces)
  const wsParam = q ? `&${q}` : ''
  while (!cancelled()) {
    const page = await api.get<Objective[]>(
      `/objectives?status=${status}&limit=${PAGE_SIZE}&offset=${offset}${wsParam}`,
    )
    if (cancelled()) return acc
    acc.push(...page)
    onPage([...acc])
    if (page.length < PAGE_SIZE) break
    offset += page.length
  }
  return acc
}

/**
 * Full terminal-state library (done + cancelled). Walks the paginated list
 * endpoints so the archive can show the entire backlog without mounting it
 * on the live board. Pages stream in so the first 200 are usable immediately.
 */
export function useArchiveLibrary(workspaces: Workspace[]) {
  const wsKey = workspaces.slice().sort().join(',')
  const [done, setDone] = useState<Objective[]>([])
  const [cancelled, setCancelled] = useState<Objective[]>([])
  const [doneLoading, setDoneLoading] = useState(true)
  const [cancelledLoading, setCancelledLoading] = useState(false)
  const [cancelledLoaded, setCancelledLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const genRef = useRef(0)
  const cancelledLoadedRef = useRef(false)
  const cancelledLoadingRef = useRef(false)

  useEffect(() => {
    const gen = ++genRef.current
    cancelledLoadedRef.current = false
    cancelledLoadingRef.current = false
    setDone([])
    setCancelled([])
    setCancelledLoaded(false)
    setError(null)
    setDoneLoading(true)
    const stale = () => gen !== genRef.current
    fetchAllForStatus('done', scopeFromKey(wsKey), next => { if (!stale()) setDone(next) }, stale)
      .catch(err => {
        if (!stale()) setError(err instanceof Error ? err.message : 'Failed to load archive')
      })
      .finally(() => { if (!stale()) setDoneLoading(false) })
  }, [wsKey])

  const loadCancelled = useCallback(async () => {
    if (cancelledLoadedRef.current || cancelledLoadingRef.current) return
    const gen = genRef.current
    const stale = () => gen !== genRef.current
    cancelledLoadingRef.current = true
    setCancelledLoading(true)
    setError(null)
    try {
      await fetchAllForStatus(
        'cancelled',
        scopeFromKey(wsKey),
        next => { if (!stale()) setCancelled(next) },
        stale,
      )
      if (!stale()) {
        cancelledLoadedRef.current = true
        setCancelledLoaded(true)
      }
    } catch (err) {
      if (!stale()) setError(err instanceof Error ? err.message : 'Failed to load retired')
    } finally {
      cancelledLoadingRef.current = false
      if (!stale()) setCancelledLoading(false)
    }
  }, [wsKey])

  const applyUpdate = useCallback((item: Objective) => {
    const mergeInto = (list: Objective[]) => {
      const idx = list.findIndex(x => x.id === item.id)
      if (idx < 0) return [item, ...list]
      const next = [...list]
      next[idx] = { ...next[idx], ...item }
      return next
    }
    if (item.status === 'done') {
      setDone(mergeInto)
      setCancelled(prev => prev.filter(x => x.id !== item.id))
      return
    }
    if (item.status === 'cancelled') {
      setCancelled(mergeInto)
      setDone(prev => prev.filter(x => x.id !== item.id))
      return
    }
    setDone(prev => prev.filter(x => x.id !== item.id))
    setCancelled(prev => prev.filter(x => x.id !== item.id))
  }, [])

  return {
    done,
    cancelled,
    doneLoading,
    cancelledLoading,
    cancelledLoaded,
    error,
    loadCancelled,
    applyUpdate,
  }
}
