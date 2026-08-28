import { useState, useEffect, useCallback, useRef } from 'react'
import type {
  Objective,
  CreateObjectiveRequest,
  UpdateObjectiveRequest,
  ObjectiveStatus,
  ServerMessage,
  Workspace,
} from '@command-center/shared'
import { useWebSocket } from './useWebSocket'
import { api } from '../lib/api'
import { mergeObjectiveUpdate } from '../lib/mergeObjective'

// Page size for the lazy Done column (obj 700512). The board never mounts the
// full ~2k-row done backlog at once — done loads on demand, this many at a time.
const DONE_PAGE_SIZE = 50
// Retired (status=cancelled) column (obj 700872) uses the same on-demand,
// paginated mechanism as Done — hidden by default, fetched only when toggled on.
const CANCELLED_PAGE_SIZE = 50

function normalizeWorkspaces(scope: Workspace | Workspace[]): Workspace[] {
  if (Array.isArray(scope)) return scope.filter(w => w && w !== 'all')
  return scope && scope !== 'all' ? [scope] : []
}

function workspaceQuery(workspaces: Workspace[]): string {
  if (workspaces.length === 0) return ''
  if (workspaces.length === 1) return `workspace=${encodeURIComponent(workspaces[0])}`
  return `workspaces=${workspaces.map(encodeURIComponent).join(',')}`
}

function upsertFront(list: Objective[], item: Objective): Objective[] {
  const idx = list.findIndex(x => x.id === item.id)
  if (idx < 0) return [item, ...list]
  const next = [...list]
  next[idx] = mergeObjectiveUpdate(list[idx], item)
  return next
}

export function useObjectives(scope: Workspace | Workspace[] = 'all') {
  const workspaces = normalizeWorkspaces(scope)
  const wsKey = workspaces.slice().sort().join(',')
  const workspace = workspaces.length === 1 ? workspaces[0] : 'all'
  const [objectives, setObjectives] = useState<Objective[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Cards this tab marked done/cancelled. Ignore later WS working/review so a
  // dying session cannot put them back on the live board.
  const locallyDoneIds = useRef(new Set<number>())

  // Lazy Done column state (obj 700512). The active list above EXCLUDES done;
  // these back a fetch-on-demand, paginated Done column so it never renders the
  // ~1987-card backlog on load.
  const [doneObjectives, setDoneObjectives] = useState<Objective[]>([])
  const [doneLoading, setDoneLoading] = useState(false)
  const [doneLoaded, setDoneLoaded] = useState(false)
  const [doneHasMore, setDoneHasMore] = useState(true)

  // Lazy Retired column state (obj 700872). Mirrors the Done column exactly:
  // the active list EXCLUDES cancelled, so these back a fetch-on-demand,
  // paginated Retired column that only loads when its toggle is switched on.
  const [cancelledObjectives, setCancelledObjectives] = useState<Objective[]>([])
  const [cancelledLoading, setCancelledLoading] = useState(false)
  const [cancelledLoaded, setCancelledLoaded] = useState(false)
  const [cancelledHasMore, setCancelledHasMore] = useState(true)

  const handleWsMessage = useCallback((msg: ServerMessage) => {
    switch (msg.type) {
      case 'objective_updated':
        setObjectives(prev => {
          const o = msg.payload
          const idx = prev.findIndex(x => x.id === o.id)
          // Scope to the active workspace set. In a filtered view, ignore (and
          // evict) objectives that don't belong to it — this is the client
          // guard for the live view-leak bug (obj 1001). Empty/all sees everything.
          const selected = wsKey ? wsKey.split(',') : []
          const matches = selected.length === 0 || selected.includes(o.workspace)
          if (!matches) {
            return idx >= 0 ? prev.filter(x => x.id !== o.id) : prev
          }
          const lockedHere = locallyDoneIds.current.has(o.id)
          if (o.status === 'done') {
            setDoneObjectives(d => upsertFront(d, o))
            setCancelledObjectives(d => d.filter(x => x.id !== o.id))
            return idx >= 0 ? prev.filter(x => x.id !== o.id) : prev
          }
          if (o.status === 'cancelled') {
            setCancelledObjectives(d => upsertFront(d, o))
            setDoneObjectives(d => d.filter(x => x.id !== o.id))
            return idx >= 0 ? prev.filter(x => x.id !== o.id) : prev
          }
          // This tab already marked it done/cancelled. A dying session's
          // working/review broadcast must not put it back on the live board.
          if (lockedHere) {
            return idx >= 0 ? prev.filter(x => x.id !== o.id) : prev
          }
          setDoneObjectives(d => d.filter(x => x.id !== o.id))
          setCancelledObjectives(d => d.filter(x => x.id !== o.id))
          if (idx >= 0) {
            const next = [...prev]
            next[idx] = mergeObjectiveUpdate(prev[idx], o)
            return next
          }
          return [o, ...prev]
        })
        break
      case 'objective_deleted':
        setObjectives(prev => prev.filter(o => o.id !== msg.payload.id))
        setDoneObjectives(prev => prev.filter(o => o.id !== msg.payload.id))
        setCancelledObjectives(prev => prev.filter(o => o.id !== msg.payload.id))
        break
      case 'session_intel_ready':
        // Objective already updated via objective_updated broadcast
        break
      case 'session_stuck':
        console.warn(`[stuck] Objective ${msg.payload.objective_id}: ${msg.payload.reason}`)
        break
    }
  }, [wsKey])

  // Pass the active workspace so the socket is scoped at connect time via the
  // `?workspace=` URL param — closes the connect/reconnect view-leak race
  // (obj 700082). `set_view_scope` below still covers in-place workspace switches
  // (no reconnect). The client-side guard in handleWsMessage stays as a backstop.
  const { send, connected, state: connectionState } = useWebSocket(handleWsMessage, workspace)

  // Tell the server which workspace this socket is viewing so it can scope admin
  // broadcasts server-side (view-leak fix, obj 1001). Re-emit on workspace change
  // and on every (re)connect so a dropped/restarted socket re-establishes scope.
  useEffect(() => {
    if (connected) send({ type: 'set_view_scope', workspace })
  }, [workspace, connected, send])

  useEffect(() => {
    setLoading(true)
    // Reset the lazy Done column whenever the workspace changes — the previously
    // loaded done rows belong to the old scope.
    setDoneObjectives([])
    setDoneLoaded(false)
    setDoneHasMore(true)
    // Same reset for the lazy Retired column — its rows belong to the old scope.
    setCancelledObjectives([])
    setCancelledLoaded(false)
    setCancelledHasMore(true)
    const q = workspaceQuery(wsKey ? (wsKey.split(',') as Workspace[]) : [])
    const params = q ? `?${q}` : ''
    // Default list — active pipeline only (server excludes status=done).
    api.get<Objective[]>(`/objectives${params}`)
      .then(data => setObjectives(data))
      .catch(err => setError(err.message))
      .finally(() => setLoading(false))
  }, [wsKey])

  // Fetch the next page of done objectives on demand (obj 700512). Newest-first,
  // workspace-scoped, DONE_PAGE_SIZE at a time. Offset is the count already held.
  const loadMoreDone = useCallback(async () => {
    setDoneLoading(true)
    try {
      const q = workspaceQuery(wsKey ? (wsKey.split(',') as Workspace[]) : [])
      const wsParam = q ? `&${q}` : ''
      const offset = doneObjectives.length
      const page = await api.get<Objective[]>(
        `/objectives?status=done&limit=${DONE_PAGE_SIZE}&offset=${offset}${wsParam}`
      )
      setDoneObjectives(prev => {
        // Dedupe by id in case a live-completed card already arrived via WS.
        const seen = new Set(prev.map(o => o.id))
        return [...prev, ...page.filter(o => !seen.has(o.id))]
      })
      setDoneHasMore(page.length === DONE_PAGE_SIZE)
      setDoneLoaded(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load done objectives')
    } finally {
      setDoneLoading(false)
    }
  }, [wsKey, doneObjectives.length])

  // Fetch the next page of cancelled/retired objectives on demand (obj 700872).
  // Byte-for-byte parallel to loadMoreDone but on the ?status=cancelled path.
  const loadMoreCancelled = useCallback(async () => {
    setCancelledLoading(true)
    try {
      const q = workspaceQuery(wsKey ? (wsKey.split(',') as Workspace[]) : [])
      const wsParam = q ? `&${q}` : ''
      const offset = cancelledObjectives.length
      const page = await api.get<Objective[]>(
        `/objectives?status=cancelled&limit=${CANCELLED_PAGE_SIZE}&offset=${offset}${wsParam}`
      )
      setCancelledObjectives(prev => {
        const seen = new Set(prev.map(o => o.id))
        return [...prev, ...page.filter(o => !seen.has(o.id))]
      })
      setCancelledHasMore(page.length === CANCELLED_PAGE_SIZE)
      setCancelledLoaded(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load retired objectives')
    } finally {
      setCancelledLoading(false)
    }
  }, [wsKey, cancelledObjectives.length])

  const createObjective = useCallback(async (data: CreateObjectiveRequest) => {
    return api.post<Objective>('/objectives', data)
  }, [])

  const updateObjective = useCallback(async (id: number, data: UpdateObjectiveRequest) => {
    return api.put<Objective>(`/objectives/${id}`, data)
  }, [])

  const changeStatus = useCallback(async (id: number, status: ObjectiveStatus) => {
    // Optimistic update — move the card immediately. Done/cancelled leave the
    // live pipeline so they cannot bounce back into Working/Needs You, and park
    // in the lazy Done/Retired lists so the column merge still shows them.
    if (status === 'done' || status === 'cancelled') locallyDoneIds.current.add(id)
    else locallyDoneIds.current.delete(id)
    setObjectives(prev => {
      const found = prev.find(o => o.id === id)
      if (status === 'done' || status === 'cancelled') {
        if (found) {
          const parked = { ...found, status }
          if (status === 'done') setDoneObjectives(d => upsertFront(d, parked))
          else setCancelledObjectives(d => upsertFront(d, parked))
        }
        return prev.filter(o => o.id !== id)
      }
      setDoneObjectives(d => d.filter(o => o.id !== id))
      setCancelledObjectives(d => d.filter(o => o.id !== id))
      if (!found) return prev
      return prev.map(o => o.id === id ? { ...o, status } : o)
    })

    try {
      return await api.patch<Objective>(`/objectives/${id}/status`, { status })
    } catch (err) {
      locallyDoneIds.current.delete(id)
      // Revert on error — refetch objectives (no single-objective GET route exists).
      // MUST carry the active workspace scope: an unscoped GET /objectives returns
      // every workspace for admins, which would bleed other orgs' cards into a
      // single-workspace board (filter-lapse, obj 700082). Mirror the initial fetch.
      try {
        const q = workspaceQuery(wsKey ? (wsKey.split(',') as Workspace[]) : [])
        const params = q ? `?${q}` : ''
        const objectives = await api.get<Objective[]>(`/objectives${params}`)
        setObjectives(objectives)
        setDoneObjectives(d => d.filter(o => o.id !== id))
        setCancelledObjectives(d => d.filter(o => o.id !== id))
      } catch {}
      throw err
    }
  }, [wsKey])

  const deleteObjective = useCallback(async (id: number) => {
    await api.del(`/objectives/${id}`)
  }, [])

  return {
    objectives,
    loading,
    error,
    connected,
    connectionState,
    createObjective,
    updateObjective,
    changeStatus,
    deleteObjective,
    send,
    // Lazy Done column (obj 700512)
    doneObjectives,
    doneLoading,
    doneLoaded,
    doneHasMore,
    loadMoreDone,
    // Lazy Retired column (obj 700872)
    cancelledObjectives,
    cancelledLoading,
    cancelledLoaded,
    cancelledHasMore,
    loadMoreCancelled,
  }
}
