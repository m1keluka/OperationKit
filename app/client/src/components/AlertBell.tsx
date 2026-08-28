import { useState, useEffect, useRef, useCallback } from 'react'
import type { Alert } from '@command-center/shared'
import { api } from '../lib/api'

const POLL_INTERVAL_MS = 30_000

const SEVERITY_COLOR: Record<Alert['severity'], string> = {
  normal: 'text-fg-2',
  high: 'text-signal-amber',
  emergency: 'text-signal-alarm',
}

const SEVERITY_DOT: Record<Alert['severity'], string> = {
  normal: 'bg-fg-3',
  high: 'bg-signal-amber',
  emergency: 'bg-signal-alarm',
}

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso + 'Z').getTime()
  if (!Number.isFinite(ms) || ms < 0) return iso
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const days = Math.floor(hr / 24)
  return `${days}d ago`
}

export function AlertBell() {
  const [open, setOpen] = useState(false)
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [unackedCount, setUnackedCount] = useState(0)
  const ref = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async () => {
    try {
      const data = await api.get<{ alerts: Alert[]; unacked_count: number }>('/alerts?unacked=true&limit=50')
      setAlerts(data.alerts)
      setUnackedCount(data.unacked_count)
    } catch {
      // Silent — alerts UI shouldn't surface its own failures
    }
  }, [])

  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, POLL_INTERVAL_MS)
    const onVisible = () => { if (!document.hidden) refresh() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [refresh])

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const handleAck = async (id: number) => {
    try {
      await api.post(`/alerts/${id}/ack`)
      setAlerts(prev => prev.filter(a => a.id !== id))
      setUnackedCount(n => Math.max(0, n - 1))
    } catch {}
  }

  const handleAckAll = async () => {
    try {
      await api.post('/alerts/ack-all')
      setAlerts([])
      setUnackedCount(0)
    } catch {}
  }

  const toggle = () => {
    const next = !open
    setOpen(next)
    if (next) refresh()
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={toggle}
        className="relative flex items-center justify-center rounded-md p-1.5 text-fg-2 transition-colors duration-fast ease-out hover:bg-surface-3 hover:text-fg-0"
        aria-label={`Alerts (${unackedCount} unacked)`}
      >
        <BellIcon className="h-5 w-5" />
        {unackedCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-signal-alarm px-1 text-[10px] font-medium text-fg-0">
            {unackedCount > 99 ? '99+' : unackedCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1.5 w-80 max-h-[70vh] overflow-y-auto rounded-lg border border-line bg-surface-1 shadow-float z-50">
          <div className="flex items-center justify-between border-b border-line px-3 py-2">
            <span className="text-sm font-medium text-fg-0">Alerts</span>
            {alerts.length > 0 && (
              <button
                onClick={handleAckAll}
                className="text-xs text-fg-2 transition-colors duration-fast ease-out hover:text-fg-0"
              >
                Ack all
              </button>
            )}
          </div>

          {alerts.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-fg-3">No unacked alerts</div>
          ) : (
            <ul>
              {alerts.map(alert => (
                <li key={alert.id} className="border-b border-line last:border-b-0">
                  <div className="px-3 py-2.5 transition-colors duration-fast ease-out hover:bg-surface-3">
                    <div className="flex items-start gap-2">
                      <span className={`mt-1.5 h-1.5 w-1.5 rounded-full ${SEVERITY_DOT[alert.severity]}`} />
                      <div className="min-w-0 flex-1">
                        <div className={`text-sm font-medium truncate ${SEVERITY_COLOR[alert.severity]}`}>
                          {alert.title}
                        </div>
                        <div className="text-xs text-fg-2 mt-0.5 line-clamp-2 whitespace-pre-wrap break-words">
                          {alert.message}
                        </div>
                        <div className="flex items-center gap-2 mt-1.5 text-[10px] text-fg-3">
                          <span>{alert.source}</span>
                          <span>·</span>
                          <span>{formatRelative(alert.created_at)}</span>
                          {alert.email_sent_at && (
                            <>
                              <span>·</span>
                              <span title={`Emailed at ${alert.email_sent_at}`}>emailed</span>
                            </>
                          )}
                        </div>
                        <div className="flex items-center gap-3 mt-1.5">
                          {alert.url && (
                            <a
                              href={alert.url}
                              target="_blank"
                              rel="noreferrer"
                              className="text-xs text-accent transition-colors duration-fast ease-out hover:text-accent-hover hover:underline"
                            >
                              Open
                            </a>
                          )}
                          <button
                            onClick={() => handleAck(alert.id)}
                            className="text-xs text-fg-2 transition-colors duration-fast ease-out hover:text-fg-0"
                          >
                            Ack
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

function BellIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0" />
    </svg>
  )
}
