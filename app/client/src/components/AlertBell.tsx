/**
 * Notifications panel (the bell). UI only — obj 900495 cleaned up layout,
 * grouping, read/unread, empty state and copy. Delivery (email/Slack, #900368)
 * is untouched; this reads the same endpoints as before:
 *
 *   GET  /api/alerts?unacked=true&limit=50   unread
 *   GET  /api/alerts?limit=50                all (read = acked)
 *   POST /api/alerts/:id/ack                 mark read
 *   POST /api/alerts/ack-all                 mark all read
 */
import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { BellOff } from 'lucide-react'
import type { Alert } from '@operationkit/shared'
import { api } from '../lib/api'
import { cn } from './ui'

const POLL_INTERVAL_MS = 30_000

type Filter = 'unread' | 'all'

/** Only severities that change what you do get a label; "normal" stays quiet. */
const SEVERITY: Record<Alert['severity'], { label: string | null; text: string; dot: string }> = {
  normal:    { label: null,     text: 'text-fg-0',          dot: 'bg-accent' },
  high:      { label: 'High',   text: 'text-signal-amber',  dot: 'bg-signal-amber' },
  emergency: { label: 'Urgent', text: 'text-signal-alarm',  dot: 'bg-signal-alarm' },
}

/** Alert timestamps are SQLite UTC without a zone suffix. */
function parseTs(iso: string): number {
  return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso.replace(' ', 'T') + 'Z').getTime()
}

export function formatRelative(iso: string, now = Date.now()): string {
  const ms = now - parseTs(iso)
  if (!Number.isFinite(ms) || ms < 0) return 'just now'
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const days = Math.floor(hr / 24)
  return `${days}d ago`
}

export type DayGroup = 'Today' | 'Yesterday' | 'Earlier'

/** Bucket by the viewer's local calendar day. */
export function dayGroup(iso: string, now = new Date()): DayGroup {
  const t = new Date(parseTs(iso))
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (t.getTime() >= startToday) return 'Today'
  if (t.getTime() >= startToday - 86_400_000) return 'Yesterday'
  return 'Earlier'
}

export function groupByDay(alerts: Alert[], now = new Date()): { label: DayGroup; items: Alert[] }[] {
  const order: DayGroup[] = ['Today', 'Yesterday', 'Earlier']
  const map = new Map<DayGroup, Alert[]>()
  for (const a of alerts) {
    const g = dayGroup(a.created_at, now)
    map.set(g, [...(map.get(g) ?? []), a])
  }
  return order.filter(g => map.has(g)).map(g => ({ label: g, items: map.get(g)! }))
}

export function AlertBell() {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState<Filter>('unread')
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async (which: Filter = filter) => {
    try {
      const q = which === 'unread' ? '/alerts?unacked=true&limit=50' : '/alerts?limit=50'
      const data = await api.get<{ alerts: Alert[]; unacked_count: number }>(q)
      setAlerts(data.alerts)
      setUnreadCount(data.unacked_count)
      setLoaded(true)
    } catch {
      // Silent — the notifications UI shouldn't surface its own failures
    }
  }, [filter])

  useEffect(() => {
    refresh()
    const timer = setInterval(() => refresh(), POLL_INTERVAL_MS)
    const onVisible = () => { if (!document.hidden) refresh() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [refresh])

  // Close on outside click or Escape
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [])

  const markRead = async (id: number) => {
    try {
      await api.post(`/alerts/${id}/ack`)
      const at = new Date().toISOString()
      setAlerts(prev => filter === 'unread'
        ? prev.filter(a => a.id !== id)
        : prev.map(a => (a.id === id ? { ...a, acked_at: at } : a)))
      setUnreadCount(n => Math.max(0, n - 1))
    } catch {}
  }

  const markAllRead = async () => {
    try {
      await api.post('/alerts/ack-all')
      const at = new Date().toISOString()
      setAlerts(prev => (filter === 'unread' ? [] : prev.map(a => (a.acked_at ? a : { ...a, acked_at: at }))))
      setUnreadCount(0)
    } catch {}
  }

  const toggle = () => {
    const next = !open
    setOpen(next)
    if (next) refresh()
  }

  const changeFilter = (f: Filter) => {
    setFilter(f)
    void refresh(f)
  }

  const groups = useMemo(() => groupByDay(alerts), [alerts])

  return (
    <div ref={ref} className="relative">
      <button
        onClick={toggle}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="relative flex items-center justify-center rounded-md p-1.5 text-fg-2 outline-none transition-colors duration-fast ease-out hover:bg-surface-3 hover:text-fg-0 focus-visible:ring-2 focus-visible:ring-accent/60"
        aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications'}
      >
        <BellIcon className="h-5 w-5" />
        {unreadCount > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--t-alarm)] px-1 font-mono text-[12px] font-medium leading-none text-surface-0">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Notifications"
          // 390px: pinned to the viewport edges (the bell is not at the screen edge, so a
          // w-80 panel anchored to it used to run off the left side). Desktop: anchored.
          className="fixed inset-x-2 top-14 z-50 flex max-h-[75vh] flex-col overflow-hidden rounded-lg border border-line bg-surface-1 shadow-float sm:absolute sm:inset-x-auto sm:right-0 sm:top-full sm:mt-1.5 sm:w-96"
        >
          <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
            <div className="flex items-baseline gap-2">
              <span className="text-sm font-semibold text-fg-0">Notifications</span>
              {unreadCount > 0 && <span className="font-mono text-[12px] text-fg-3">{unreadCount} unread</span>}
            </div>
            {unreadCount > 0 && (
              <button
                onClick={markAllRead}
                className="rounded px-1.5 py-1 text-xs font-medium text-accent-hover outline-none transition-colors duration-fast ease-out hover:text-accent focus-visible:ring-2 focus-visible:ring-accent/60"
              >
                Mark all read
              </button>
            )}
          </div>

          <div role="tablist" aria-label="Filter notifications" className="flex gap-1 border-b border-line-soft px-3 py-1.5">
            {(['unread', 'all'] as Filter[]).map(f => (
              <button
                key={f}
                role="tab"
                aria-selected={filter === f}
                onClick={() => changeFilter(f)}
                className={cn(
                  'rounded-md px-2.5 py-1 text-xs font-medium outline-none transition-colors duration-fast ease-out focus-visible:ring-2 focus-visible:ring-accent/60',
                  filter === f ? 'bg-surface-3 text-fg-0' : 'text-fg-2 hover:bg-surface-2 hover:text-fg-0',
                )}
              >
                {f === 'unread' ? 'Unread' : 'All'}
              </button>
            ))}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {loaded && alerts.length === 0 ? (
              <div data-testid="notifications-empty" className="flex flex-col items-center gap-2 px-6 py-10 text-center">
                <BellOff className="h-5 w-5 text-fg-3" strokeWidth={1.6} aria-hidden />
                <div className="text-sm font-medium text-fg-1">
                  {filter === 'unread' ? 'You’re all caught up' : 'No notifications yet'}
                </div>
                <p className="max-w-[16rem] text-xs leading-snug text-fg-3">
                  Problems the platform spots on its own — failed jobs, deploy drift, low disk — show up here.
                </p>
              </div>
            ) : (
              groups.map(group => (
                <section key={group.label} aria-label={group.label}>
                  <h4 className="sticky top-0 z-[1] bg-surface-1 px-3 pb-1 pt-2.5 text-[12px] uppercase tracking-[0.12em] text-fg-3 font-semibold tracking-[0.06em]">
                    {group.label}
                  </h4>
                  <ul>
                    {group.items.map(alert => (
                      <NotificationRow key={alert.id} alert={alert} onMarkRead={markRead} />
                    ))}
                  </ul>
                </section>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function NotificationRow({ alert, onMarkRead }: { alert: Alert; onMarkRead: (id: number) => void }) {
  const unread = !alert.acked_at
  const sev = SEVERITY[alert.severity] ?? SEVERITY.normal
  return (
    <li
      data-testid="notification"
      data-unread={unread ? 'true' : 'false'}
      className="border-t border-line-soft first:border-t-0"
    >
      <div className={cn('flex items-start gap-2.5 px-3 py-2.5 transition-colors duration-fast ease-out hover:bg-surface-2', !unread && 'opacity-70')}>
        <span
          aria-label={unread ? 'Unread' : 'Read'}
          className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', unread ? sev.dot : 'bg-transparent ring-1 ring-line-strong')}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className={cn('min-w-0 text-sm leading-snug', unread ? 'font-semibold' : 'font-normal', unread ? sev.text : 'text-fg-1')}>
              {sev.label && (
                <span className="mr-1.5 text-[12px] uppercase tracking-[0.08em] font-semibold tracking-[0.06em]">{sev.label}</span>
              )}
              <span className="break-words">{alert.title}</span>
            </div>
            <span className="shrink-0 font-mono text-[12px] text-fg-3" title={alert.created_at}>
              {formatRelative(alert.created_at)}
            </span>
          </div>
          {alert.message && (
            <p className="mt-0.5 line-clamp-2 whitespace-pre-wrap break-words text-xs leading-snug text-fg-2">{alert.message}</p>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
            <span className="font-mono text-fg-3">{alert.source}</span>
            {alert.email_sent_at && <span className="text-fg-3" title={`Emailed at ${alert.email_sent_at}`}>emailed</span>}
            <span className="ml-auto flex items-center gap-3">
              {alert.url && (
                <a
                  href={alert.url}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-accent-hover transition-colors duration-fast ease-out hover:text-accent hover:underline"
                >
                  Open
                </a>
              )}
              {unread && (
                <button
                  onClick={() => onMarkRead(alert.id)}
                  className="font-medium text-fg-2 transition-colors duration-fast ease-out hover:text-fg-0"
                >
                  Mark read
                </button>
              )}
            </span>
          </div>
        </div>
      </div>
    </li>
  )
}

function BellIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0" />
    </svg>
  )
}
