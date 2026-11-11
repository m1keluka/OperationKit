// Low-disk warning strip for the board (obj 718070). Polls GET /api/system/disk
// (the disk watchdog's last 5-min tick) and renders nothing unless the host is
// under 15% free or below the 2 GiB write floor — the ENOSPC outages on the old
// host were all preceded by days of exactly this state with nobody looking.
import { useState, useEffect, useCallback } from 'react'
import { api } from '../lib/api'

const POLL_INTERVAL_MS = 5 * 60 * 1000

export interface SystemDisk {
  usedPct: number | null
  freePct: number | null
  availBytes: number | null
  totalBytes: number | null
  low: boolean
  action: 'ok' | 'warn' | 'clean' | 'block'
  checkedAt: string
}

function gib(bytes: number | null): string {
  return bytes == null ? '?' : (bytes / (1024 * 1024 * 1024)).toFixed(1)
}

export function DiskLowBanner() {
  const [disk, setDisk] = useState<SystemDisk | null>(null)

  const refresh = useCallback(async () => {
    try {
      setDisk(await api.get<SystemDisk>('/system/disk'))
    } catch {
      // Silent — a failed probe must not paint a scary banner
    }
  }, [])

  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [refresh])

  if (!disk || !(disk.low || disk.action === 'block')) return null
  const critical = disk.action === 'block'
  return (
    <div
      role="alert"
      className="mx-3 mt-2 flex items-center gap-2 rounded-md border border-line bg-surface-1 px-3 py-1.5 text-xs"
      style={{ color: critical ? 'var(--ok-alarm)' : 'var(--ok-amber)' }}
      title={`Checked ${new Date(disk.checkedAt).toLocaleString()}`}
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: 'currentColor' }} aria-hidden="true" />
      <span className="font-medium">{critical ? 'Disk critically full' : 'Disk space low'}</span>
      <span className="text-fg-2">
        {disk.freePct ?? '?'}% free ({gib(disk.availBytes)} of {gib(disk.totalBytes)} GiB)
        {critical ? ' — new messages will be refused until cleanup frees space.' : ' — finished-card worktrees are being swept.'}
      </span>
    </div>
  )
}
