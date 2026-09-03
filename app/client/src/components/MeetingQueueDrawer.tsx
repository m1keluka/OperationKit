import { useState, useEffect, useCallback } from 'react'
import { Modal, Skeleton } from './ui'

const POLL_INTERVAL_MS = 60_000

interface MeetingActionItem {
  id: string
  meeting_id: string
  title: string
  description: string
  workspace: string
  priority: number
  owner: string | null
  deadline: string | null
  source_excerpt: string | null
  meeting_title: string | null
  meeting_date: string | null
}

const WORKSPACE_BADGE: Record<string, string> = {
  example: 'bg-status-working/20 text-status-working',
  'example-project': 'bg-green-500/20 text-green-400',
  'personal': 'bg-status-planning/20 text-status-planning',
  example2: 'bg-amber-500/20 text-amber-400',
  'shabo-dl': 'bg-teal-500/20 text-teal-400',
  personal: 'bg-surface-3/20 text-fg-2',
}

const WORKSPACE_LABEL: Record<string, string> = {
  example: 'Example',
  'example-project': 'Example Project',
  'personal': 'Mike Luka',
  example2: 'Example3',
  'shabo-dl': 'Shabo Dental Lab',
  personal: 'Personal',
}

const PRIORITY_BADGE: Record<number, { label: string; className: string }> = {
  1: { label: 'High', className: 'bg-signal-alarm/20 text-signal-alarm' },
  2: { label: 'Medium', className: 'bg-signal-amber/20 text-signal-amber' },
  3: { label: 'Low', className: 'bg-surface-3/20 text-fg-2' },
}

export function MeetingBell() {
  const [count, setCount] = useState(0)
  const [drawerOpen, setDrawerOpen] = useState(false)

  const fetchCount = useCallback(async () => {
    try {
      const res = await fetch('/api/meeting-queue/count', { credentials: 'include' })
      if (!res.ok) return
      const data = await res.json() as { count: number }
      setCount(data.count)
    } catch {}
  }, [])

  useEffect(() => {
    fetchCount()
    const timer = setInterval(fetchCount, POLL_INTERVAL_MS)
    const onVisible = () => { if (!document.hidden) fetchCount() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [fetchCount])

  const handleItemResolved = useCallback(() => {
    setCount(n => Math.max(0, n - 1))
  }, [])

  return (
    <>
      <button
        onClick={() => setDrawerOpen(true)}
        className="relative flex items-center justify-center rounded-md p-1.5 text-fg-2 hover:bg-surface-overlay hover:text-fg-0 transition-colors duration-fast ease-out"
        aria-label={`Meeting actions (${count} pending)`}
        title="Meeting action items"
      >
        <BellIcon className="h-5 w-5" />
        {count > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-signal-alarm px-1 text-[10px] font-medium text-fg-0 leading-none">
            {count > 99 ? '99+' : count}
          </span>
        )}
      </button>

      {drawerOpen && (
        <MeetingQueueDrawer
          onClose={() => setDrawerOpen(false)}
          onItemResolved={handleItemResolved}
        />
      )}
    </>
  )
}

interface DrawerProps {
  onClose: () => void
  onItemResolved: () => void
}

function MeetingQueueDrawer({ onClose, onItemResolved }: DrawerProps) {
  const [items, setItems] = useState<MeetingActionItem[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/meeting-queue', { credentials: 'include' })
      .then(r => r.json())
      .then((data: MeetingActionItem[]) => {
        setItems(data)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  const handleApprove = async (id: string) => {
    setItems(prev => prev.filter(i => i.id !== id))
    onItemResolved()
    try {
      await fetch(`/api/meeting-queue/${id}/approve`, { method: 'POST', credentials: 'include' })
    } catch {}
  }

  const handleDismiss = async (id: string) => {
    setItems(prev => prev.filter(i => i.id !== id))
    onItemResolved()
    try {
      await fetch(`/api/meeting-queue/${id}/dismiss`, { method: 'POST', credentials: 'include' })
    } catch {}
  }

  return (
    <Modal
      open
      onClose={onClose}
      variant="sheet"
      labelledBy="meeting-queue-title"
      panelClassName="flex flex-col bg-surface-raised sm:w-96 sm:max-w-[90vw]"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3 flex-shrink-0">
        <span id="meeting-queue-title" className="text-sm font-semibold text-fg-0">Meeting Actions</span>
        <button
          onClick={onClose}
          className="flex items-center justify-center rounded-md p-1 text-fg-2 hover:bg-surface-overlay hover:text-fg-0 transition-colors duration-fast ease-out"
          aria-label="Close"
        >
          <CloseIcon className="h-4 w-4" />
        </button>
      </div>

      {/* Scrollable list */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <ul className="divide-y divide-border">
            {Array.from({ length: 4 }).map((_, i) => (
              <li key={i} className="p-4">
                <Skeleton className="h-3 w-32 mb-2" />
                <Skeleton className="h-4 w-3/4 mb-2" />
                <Skeleton className="h-3 w-full mb-1" />
                <Skeleton className="h-3 w-5/6 mb-3" />
                <div className="flex items-center gap-1.5 mb-3">
                  <Skeleton className="h-4 w-12 rounded" />
                  <Skeleton className="h-4 w-10 rounded" />
                </div>
                <div className="flex items-center gap-2">
                  <Skeleton className="h-7 flex-1 rounded-md" />
                  <Skeleton className="h-7 flex-1 rounded-md" />
                </div>
              </li>
            ))}
          </ul>
        ) : items.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 gap-2 text-fg-3">
              <CheckCircleIcon className="h-8 w-8 text-fg-3" />
              <span className="text-sm">No pending meeting actions</span>
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {items.map(item => {
                const priority = PRIORITY_BADGE[item.priority] ?? PRIORITY_BADGE[3]
                const wsBadge = WORKSPACE_BADGE[item.workspace] ?? 'bg-surface-3/20 text-fg-2'
                const wsLabel = WORKSPACE_LABEL[item.workspace] ?? item.workspace
                return (
                  <li key={item.id} className="p-4 hover:bg-surface-overlay/50 transition-colors duration-fast ease-out">
                    {/* Meeting title + date */}
                    {item.meeting_title && (
                      <div className="text-xs text-fg-3 mb-1.5 truncate">
                        {item.meeting_title}
                        {item.meeting_date && (
                          <span className="ml-2 tabular-nums">{item.meeting_date}</span>
                        )}
                      </div>
                    )}

                    {/* Suggested objective title */}
                    <div className="text-sm font-semibold text-fg-0 mb-1.5 leading-snug">
                      {item.title}
                    </div>

                    {/* Description */}
                    {item.description && (
                      <p className="text-xs text-fg-2 mb-2 line-clamp-3 leading-relaxed">
                        {item.description}
                      </p>
                    )}

                    {/* Workspace + priority badges */}
                    <div className="flex items-center gap-1.5 mb-2">
                      <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${wsBadge}`}>
                        {wsLabel}
                      </span>
                      <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${priority.className}`}>
                        {priority.label}
                      </span>
                    </div>

                    {/* Source excerpt */}
                    {item.source_excerpt && (
                      <p className="text-xs text-fg-3 italic mb-2 line-clamp-2 leading-relaxed">
                        &ldquo;{item.source_excerpt}&rdquo;
                      </p>
                    )}

                    {/* Owner / deadline */}
                    {(item.owner || item.deadline) && (
                      <div className="flex items-center gap-3 text-[11px] text-fg-3 mb-2">
                        {item.owner && <span>Owner: <span className="text-fg-2">{item.owner}</span></span>}
                        {item.deadline && <span>Due: <span className="text-fg-2">{item.deadline}</span></span>}
                      </div>
                    )}

                    {/* Action buttons */}
                    <div className="flex items-center gap-2 mt-3">
                      <button
                        onClick={() => handleApprove(item.id)}
                        className="flex-1 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-fg-0 hover:bg-accent/80 transition-colors duration-fast ease-out"
                      >
                        Add to Board
                      </button>
                      <button
                        onClick={() => handleDismiss(item.id)}
                        className="flex-1 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-fg-2 hover:bg-surface-overlay hover:text-fg-0 transition-colors duration-fast ease-out"
                      >
                        Dismiss
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
      </div>
    </Modal>
  )
}

function BellIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0" />
    </svg>
  )
}

function CloseIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
    </svg>
  )
}

function CheckCircleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  )
}
