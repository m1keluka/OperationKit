import { useEffect, useRef, useState } from 'react'
import type { MentorThread, MentorSessionState } from '@operationkit/shared'

type ThreadStatus = 'working' | 'ready' | 'idle' | 'done'

interface ThreadListProps {
  threads: MentorThread[]
  activeThreadId: number | null
  activeThreadState: MentorSessionState
  sending: boolean
  loading: boolean
  error: string | null
  onSelect: (id: number) => void
  onNewThread: () => void
  onRename: (id: number, title: string) => Promise<void> | void
  onPin: (id: number, pinned: boolean) => Promise<void> | void
  onArchive: (id: number) => Promise<void> | void
  onDelete: (id: number) => Promise<void> | void
  onMarkDone: (id: number, done: boolean) => Promise<void> | void
}

const IDLE_THRESHOLD_MS = 60 * 60 * 1000

function parseTs(iso: string): number {
  if (!iso) return 0
  const s = /[zZ]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : iso.replace(' ', 'T') + 'Z'
  return new Date(s).getTime()
}

function getThreadStatus(
  thread: MentorThread,
  activeThreadId: number | null,
  activeThreadState: MentorSessionState,
  sending: boolean,
): ThreadStatus {
  if (thread.done) return 'done'
  const isActive = thread.id === activeThreadId
  if (isActive) {
    if (sending || activeThreadState === 'working') return 'working'
    if (activeThreadState === 'review') return 'ready'
  }
  const ageMs = Date.now() - parseTs(thread.updated_at)
  if (ageMs > IDLE_THRESHOLD_MS) return 'idle'
  if (thread.last_message_role === 'assistant') return 'ready'
  return 'idle'
}

function formatRelative(iso: string): string {
  if (!iso) return ''
  // SQLite datetime('now') returns "YYYY-MM-DD HH:MM:SS" in UTC without a Z.
  // Treat naive strings as UTC so the relative math is correct.
  const ts = /[zZ]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : iso.replace(' ', 'T') + 'Z'
  const diff = Date.now() - new Date(ts).getTime()
  if (Number.isNaN(diff)) return ''
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  return `${months}mo ago`
}

export function ThreadList(props: ThreadListProps) {
  const { threads, activeThreadId, activeThreadState, sending, loading, error, onSelect, onNewThread, onRename, onPin, onArchive, onDelete, onMarkDone } = props
  const [menuOpenFor, setMenuOpenFor] = useState<number | null>(null)
  const [renamingId, setRenamingId] = useState<number | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpenFor(null)
      }
    }
    if (menuOpenFor !== null) {
      document.addEventListener('mousedown', handleClick)
      return () => document.removeEventListener('mousedown', handleClick)
    }
  }, [menuOpenFor])

  function startRename(t: MentorThread) {
    setRenamingId(t.id)
    setRenameValue(t.title)
    setMenuOpenFor(null)
  }

  async function commitRename(id: number) {
    const next = renameValue.trim()
    if (next && next !== threads.find(t => t.id === id)?.title) {
      try {
        await onRename(id, next)
      } catch {
        // surface in calling component; keep input open so user can retry
        return
      }
    }
    setRenamingId(null)
    setRenameValue('')
  }

  async function handlePin(id: number, pinned: boolean) {
    setMenuOpenFor(null)
    try {
      await onPin(id, pinned)
    } catch {
      /* parent handles error display */
    }
  }

  async function handleArchive(id: number) {
    setMenuOpenFor(null)
    try {
      await onArchive(id)
    } catch {
      /* parent handles error display */
    }
  }

  async function handleDelete(id: number) {
    setMenuOpenFor(null)
    if (!window.confirm('Delete this thread? This cannot be undone.')) return
    try {
      await onDelete(id)
    } catch {
      /* parent handles error display */
    }
  }

  async function handleMarkDone(id: number, done: boolean) {
    setMenuOpenFor(null)
    try {
      await onMarkDone(id, done)
    } catch {
      /* parent handles error display */
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="sticky top-0 z-10 border-b border-line bg-surface-1 p-2">
        <button
          onClick={onNewThread}
          className="flex min-h-[44px] w-full items-center justify-center rounded-md border border-[color:var(--accent-line)] bg-[var(--accent-tint)] px-3 py-2 text-sm font-medium text-accent-hover transition-colors duration-fast ease-out hover:bg-accent hover:text-accent-fg sm:min-h-[38px]"
        >
          + New thread
        </button>
      </div>

      {loading && threads.length === 0 ? (
        <div className="flex-1 px-3 py-4 text-sm text-fg-3">Loading threads...</div>
      ) : error ? (
        <div className="flex-1 px-3 py-4 text-sm text-signal-alarm">{error}</div>
      ) : threads.length === 0 ? (
        <div className="flex-1 px-3 py-6 text-sm text-fg-3">
          No threads yet. Start one with the button above.
        </div>
      ) : (
        <ul className="flex-1 overflow-y-auto py-1">
          {(() => {
            const pinnedThreads = threads.filter(t => t.pinned)
            const unpinnedThreads = threads.filter(t => !t.pinned)
            const hasBoth = pinnedThreads.length > 0 && unpinnedThreads.length > 0

            function renderThread(thread: MentorThread) {
              const active = thread.id === activeThreadId
              const isRenaming = renamingId === thread.id
              const status = getThreadStatus(thread, activeThreadId, activeThreadState, sending)
              return (
                <li key={thread.id} className="relative">
                  <div
                    className={`group flex items-start gap-2 px-3 py-2 transition-colors duration-fast ${
                      active
                        ? 'bg-[var(--accent-tint)] text-accent-hover'
                        : 'text-fg-1 hover:bg-surface-2'
                    }`}
                  >
                    <button
                      onClick={() => onSelect(thread.id)}
                      className="min-h-[40px] flex-1 min-w-0 text-left"
                      disabled={isRenaming}
                    >
                      {isRenaming ? (
                        <input
                          autoFocus
                          value={renameValue}
                          onChange={e => setRenameValue(e.target.value)}
                          onKeyDown={e => {
                            if (e.key === 'Enter') {
                              e.preventDefault()
                              void commitRename(thread.id)
                            } else if (e.key === 'Escape') {
                              setRenamingId(null)
                              setRenameValue('')
                            }
                          }}
                          onBlur={() => void commitRename(thread.id)}
                          className="w-full rounded-sm border border-line bg-surface-0 px-2 py-1 text-sm text-fg-0 focus:border-accent focus:outline-none"
                        />
                      ) : (
                        <>
                          <div className="flex items-center gap-1.5 truncate">
                            {thread.pinned && <span className="shrink-0 text-accent">{'★'}</span>}
                            <span className="truncate text-sm font-medium">{thread.title}</span>
                          </div>
                          <div className="mt-0.5 flex items-center gap-1.5">
                            <StatusDot status={status} />
                            <span className="truncate font-mono text-[11px] text-fg-3">
                              {formatRelative(thread.updated_at)}
                            </span>
                          </div>
                        </>
                      )}
                    </button>
                    {!isRenaming && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          setMenuOpenFor(menuOpenFor === thread.id ? null : thread.id)
                        }}
                        className="rounded p-1 text-fg-3 opacity-0 transition group-hover:opacity-100 hover:bg-surface-3 hover:text-fg-0 focus:opacity-100"
                        aria-label="Thread actions"
                      >
                        <DotsIcon className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                  {menuOpenFor === thread.id && (
                    <div
                      ref={menuRef}
                      className="absolute right-2 top-full z-20 mt-0.5 w-36 rounded-md border border-line bg-surface-2 py-1 shadow-float"
                    >
                      <button
                        onClick={() => startRename(thread)}
                        className="block w-full px-3 py-1.5 text-left text-sm text-fg-1 hover:bg-surface-3 hover:text-fg-0"
                      >
                        Rename
                      </button>
                      <button
                        onClick={() => void handlePin(thread.id, !thread.pinned)}
                        className="block w-full px-3 py-1.5 text-left text-sm text-fg-1 hover:bg-surface-3 hover:text-fg-0"
                      >
                        {thread.pinned ? 'Unpin' : 'Pin'}
                      </button>
                      <button
                        onClick={() => void handleMarkDone(thread.id, !thread.done)}
                        className="block w-full px-3 py-1.5 text-left text-sm text-fg-1 hover:bg-surface-3 hover:text-fg-0"
                      >
                        {thread.done ? 'Reopen' : 'Mark done'}
                      </button>
                      <button
                        onClick={() => void handleArchive(thread.id)}
                        className="block w-full px-3 py-1.5 text-left text-sm text-fg-1 hover:bg-surface-3 hover:text-fg-0"
                      >
                        Archive
                      </button>
                      <button
                        onClick={() => void handleDelete(thread.id)}
                        className="block w-full px-3 py-1.5 text-left text-sm text-signal-alarm hover:bg-signal-alarm/10"
                      >
                        Delete
                      </button>
                    </div>
                  )}
                </li>
              )
            }

            return (
              <>
                {pinnedThreads.map(renderThread)}
                {hasBoth && (
                  <li className="px-3 py-1.5">
                    <div className="border-t border-line-soft" />
                  </li>
                )}
                {unpinnedThreads.map(renderThread)}
              </>
            )
          })()}
        </ul>
      )}
    </div>
  )
}

function StatusDot({ status }: { status: ThreadStatus }) {
  if (status === 'working') {
    return (
      <span title="Working" className="inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-status-working" />
    )
  }
  if (status === 'ready') {
    return (
      <span title="Ready" className="inline-block h-2 w-2 shrink-0 rounded-full bg-signal-verify" />
    )
  }
  if (status === 'done') {
    return (
      <span title="Done" className="inline-block h-2 w-2 shrink-0 rounded-full bg-fg-3/50" />
    )
  }
  // idle
  return (
    <span title="Idle" className="inline-block h-2 w-2 shrink-0 rounded-full bg-fg-3" />
  )
}

function DotsIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 20 20">
      <circle cx="4" cy="10" r="1.5" />
      <circle cx="10" cy="10" r="1.5" />
      <circle cx="16" cy="10" r="1.5" />
    </svg>
  )
}
