import { useState, useEffect, useCallback, useMemo } from 'react'
import { useAuth } from '../context/AuthContext'
import { api } from '../lib/api'
import {
  PageContainer,
  PageHeader,
  Button,
  EmptyState,
  Skeleton,
  Alert,
  useConfirm,
} from './ui'
import {
  ALL, STATUSES, PROJECT_KEYS, PROJECT_LABEL, todayISO,
  type Loop, type LoopStatus, type BulkResult,
} from './loops/types'
import { NewLoopModal } from './loops/NewLoopModal'
import { LoopDetailModal } from './loops/LoopDetailModal'
import { Lane } from './loops/Lane'
import { BulkActionBar } from './loops/BulkActionBar'
import { Scratchpad } from './loops/Scratchpad'
import { ReviewQueue } from './loops/ReviewQueue'

// Admin-only surface for the Loops tracker (personal / holdco threads-with-people).
// Backend: /api/loops/* (requireAuth + requireAdmin). Reads the second-brain `loops/`
// markdown stream; manual-add + body edit + project/due/People(party)/tag edit + a
// 3-stage Kanban move (queued -> working -> done).
//
// r5 redesign (2026-06-20): the old open|closed table is now a mobile-first Kanban.
// A "loop" = a task/thread that moves queued -> working -> done. It is either a thread
// with a person (People/party) or a party-less personal to-do. Each loop has a CREATED
// date (opened) and an optional DUE date (overdue-flagged), a single-select PROJECT
// (org axis), optional People + tags. Loops are auto-suggested by the granola-intake
// nightly session AND manually added here. Cards move via TAP controls (no drag-drop,
// per CC convention) + a checkbox quick-complete. Usable at 390px and on desktop.

export function LoopsPage() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'

  const [loops, setLoops] = useState<Loop[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [projectFilter, setProjectFilter] = useState<string>(ALL)
  const [peopleFilter, setPeopleFilter] = useState<string>(ALL)
  const [detail, setDetail] = useState<string | null>(null) // slug of open detail
  const [showNew, setShowNew] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkBusy, setBulkBusy] = useState(false)
  const { confirm, confirmDialog } = useConfirm()

  const loadAll = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await api.get<{ loops: Loop[] }>('/loops')
      setLoops(res.loops)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load loops')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (isAdmin) loadAll()
    else setLoading(false)
  }, [isAdmin, loadAll])

  const updateLoop = useCallback((loop: Loop) => {
    setLoops(prev => prev.map(l => (l.slug === loop.slug ? loop : l)))
  }, [])

  const onCreated = useCallback((loop: Loop) => {
    setLoops(prev => [loop, ...prev])
    setShowNew(false)
  }, [])

  const moveStatus = useCallback(
    async (slug: string, status: LoopStatus) => {
      // optimistic
      setLoops(prev => prev.map(l => (l.slug === slug ? { ...l, status, closed: status === 'done' ? l.closed || todayISO() : '' } : l)))
      try {
        const res = await api.patch<{ loop: Loop }>(`/loops/${encodeURIComponent(slug)}/status`, { status })
        updateLoop(res.loop)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to move loop')
        loadAll() // resync on failure
      }
    },
    [updateLoop, loadAll],
  )

  // remove a single loop from the board (after archive)
  const removeLoop = useCallback((slug: string) => {
    setLoops(prev => prev.filter(l => l.slug !== slug))
    setSelected(prev => {
      if (!prev.has(slug)) return prev
      const next = new Set(prev)
      next.delete(slug)
      return next
    })
    setDetail(d => (d === slug ? null : d))
  }, [])

  const toggleSelect = useCallback((slug: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(slug)) next.delete(slug)
      else next.add(slug)
      return next
    })
  }, [])

  const clearSelection = useCallback(() => setSelected(new Set()), [])

  // apply succeeded slugs to local state; surface failures inline
  const applyBulkResult = useCallback(
    (res: BulkResult, apply: (slug: string) => void) => {
      const okSlugs = res.results.filter(r => r.ok).map(r => r.slug)
      okSlugs.forEach(apply)
      const failed = res.results.filter(r => !r.ok)
      if (failed.length > 0) {
        setError(`${failed.length} loop(s) failed: ${failed.map(f => f.error || f.slug).join(', ')}`)
      } else {
        setError(null)
      }
      // drop everything we tried; leave any failed selected for retry
      const failedSet = new Set(failed.map(f => f.slug))
      setSelected(prev => new Set([...prev].filter(s => failedSet.has(s))))
    },
    [],
  )

  const bulkMove = useCallback(
    async (status: LoopStatus) => {
      const slugs = [...selected]
      if (slugs.length === 0) return
      setBulkBusy(true)
      try {
        const res = await api.post<BulkResult>('/loops/bulk', { slugs, action: 'status', status })
        applyBulkResult(res, slug =>
          setLoops(prev =>
            prev.map(l =>
              l.slug === slug ? { ...l, status, closed: status === 'done' ? l.closed || todayISO() : '' } : l,
            ),
          ),
        )
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Bulk move failed')
      } finally {
        setBulkBusy(false)
      }
    },
    [selected, applyBulkResult],
  )

  const bulkArchive = useCallback(async () => {
    const slugs = [...selected]
    if (slugs.length === 0) return
    if (!(await confirm({
      title: `Archive ${slugs.length} loop(s)?`,
      message: 'They will be removed from the board (reversible).',
      confirmLabel: 'Archive',
      danger: true,
    }))) return
    setBulkBusy(true)
    try {
      const res = await api.post<BulkResult>('/loops/bulk', { slugs, action: 'archive' })
      applyBulkResult(res, slug => setLoops(prev => prev.filter(l => l.slug !== slug)))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Bulk archive failed')
    } finally {
      setBulkBusy(false)
    }
  }, [selected, applyBulkResult, confirm])

  const allPeople = useMemo(() => Array.from(new Set(loops.map(l => l.party).filter(Boolean))).sort(), [loops])

  const filtered = useMemo(
    () =>
      loops.filter(l => {
        if (projectFilter !== ALL && l.project !== projectFilter) return false
        if (peopleFilter !== ALL && l.party !== peopleFilter) return false
        return true
      }),
    [loops, projectFilter, peopleFilter],
  )

  const byStatus = useMemo(
    () => ({
      queued: filtered.filter(l => l.status === 'queued'),
      working: filtered.filter(l => l.status === 'working'),
      done: filtered.filter(l => l.status === 'done'),
    }),
    [filtered],
  )

  // Pending review-queue loops (auto-detected, awaiting approve/deny). Respects
  // the same project/people filters as the board.
  const pending = useMemo(() => filtered.filter(l => l.status === 'pending'), [filtered])

  // Approve → moves the loop to `queued` (locally reflect the new status so it
  // leaves the review queue and appears on the board). Deny → archive/remove.
  const approveLoop = useCallback(
    async (slug: string) => {
      try {
        const res = await api.post<{ loop: Loop }>(`/loops/${encodeURIComponent(slug)}/approve`)
        updateLoop(res.loop)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to accept loop')
        loadAll()
      }
    },
    [updateLoop, loadAll],
  )

  const denyLoop = useCallback(
    async (slug: string) => {
      try {
        await api.post(`/loops/${encodeURIComponent(slug)}/deny`)
        removeLoop(slug)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to ignore loop')
        loadAll()
      }
    },
    [removeLoop, loadAll],
  )

  const detailLoop = detail ? loops.find(l => l.slug === detail) || null : null

  if (!isAdmin) {
    return (
      <PageContainer width="wide">
        <EmptyState title="Access denied" description="This surface is admin-only." />
      </PageContainer>
    )
  }

  return (
    <PageContainer width="wide">
      <PageHeader
        title="Notes & Loops"
        description="A private scratchpad up top; below, tasks & threads moving queued → working → done — auto-suggested from meetings (accept to add) + manually tracked."
        actions={
          <>
            <Button variant="secondary" onClick={loadAll}>
              Refresh
            </Button>
            <Button variant="primary" onClick={() => setShowNew(true)}>
              New loop
            </Button>
          </>
        }
      />

      {/* Scratchpad — private per-user markdown, autosaves. Always at the top. */}
      <Scratchpad />

      {error && (
        <Alert tone="alarm" className="mb-4">
          {error}
        </Alert>
      )}

      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            size="sm"
            variant={projectFilter === ALL ? 'primary' : 'secondary'}
            onClick={() => setProjectFilter(ALL)}
          >
            All projects
          </Button>
          {PROJECT_KEYS.map(p => (
            <Button
              key={p}
              size="sm"
              variant={projectFilter === p ? 'primary' : 'secondary'}
              onClick={() => setProjectFilter(p)}
            >
              {PROJECT_LABEL[p]}
            </Button>
          ))}
        </div>
        {allPeople.length > 0 && (
          <select
            value={peopleFilter}
            onChange={e => setPeopleFilter(e.target.value)}
            className="min-h-[44px] rounded-md border border-line bg-surface-2 px-2 py-1.5 text-xs text-fg-1 outline-none transition-colors duration-fast focus:border-accent sm:min-h-[36px]"
          >
            <option value={ALL}>All people</option>
            {allPeople.map(p => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        )}
      </div>

      {/* Review queue — pending (auto-detected) loops, above the board */}
      {!loading && <ReviewQueue loops={pending} onApprove={approveLoop} onDeny={denyLoop} />}

      {/* Board */}
      {loading ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 md:gap-4">
          {STATUSES.map(s => (
            <div key={s} className="flex flex-col gap-2.5">
              <div className="mb-2 flex items-center gap-2 border-b border-line-soft pb-2">
                <Skeleton className="h-5 w-20 rounded-full" />
                <Skeleton className="ml-auto h-4 w-6" />
              </div>
              {[0, 1, 2].map(i => (
                <Skeleton key={i} className="h-28 w-full rounded-lg" />
              ))}
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          title="No loops yet"
          description="Track a task or thread to get started — auto-suggested from meetings or added manually."
          action={
            <Button variant="primary" onClick={() => setShowNew(true)}>
              New loop
            </Button>
          }
        />
      ) : (
        <>
          {selected.size > 0 && (
            <BulkActionBar
              count={selected.size}
              busy={bulkBusy}
              onMove={bulkMove}
              onArchive={bulkArchive}
              onClear={clearSelection}
            />
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 md:gap-4">
            {STATUSES.map(s => (
              <Lane
                key={s}
                status={s}
                loops={byStatus[s]}
                onOpen={l => setDetail(l.slug)}
                onStatus={moveStatus}
                selected={selected}
                onToggleSelect={toggleSelect}
              />
            ))}
          </div>
        </>
      )}

      {showNew && <NewLoopModal onClose={() => setShowNew(false)} onCreated={onCreated} />}
      {detailLoop && (
        <LoopDetailModal
          loop={detailLoop}
          onClose={() => setDetail(null)}
          onUpdated={updateLoop}
          onArchived={removeLoop}
        />
      )}
      {confirmDialog}
    </PageContainer>
  )
}
