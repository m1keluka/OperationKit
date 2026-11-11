import { useState, useEffect, useCallback } from 'react'
import { RefreshCw, Activity, ShieldCheck } from 'lucide-react'
import { api, ApiError } from '../lib/api'
import {
  PageContainer,
  PageHeader,
  Toolbar,
  Card,
  Badge,
  Button,
  Alert,
  DataTable,
  EmptyState,
  cn,
  type Column,
} from './ui'

interface ResponseTimeSample {
  datetime: string
  value: number
}

interface Monitor {
  id: number
  friendly_name: string
  url: string
  status: number
  status_label: 'paused' | 'not_checked_yet' | 'up' | 'seems_down' | 'down' | 'unknown'
  last_check: string | null
  response_time: number | null
  response_times: ResponseTimeSample[]
  uptime_ratio_30d: number | null
}

interface MonitorsResponse {
  configured: boolean
  fetched_at: string
  monitors: Monitor[]
}

interface UptimeEvent {
  id: number
  received_at: string
  event_at: string
  monitor_id: number | null
  monitor_name: string | null
  monitor_url: string | null
  alert_type: string | null
  alert_type_friendly_name: string | null
  alert_details: string | null
  alert_duration: number | null
  response_time: number | null
}

interface EventsResponse {
  events: UptimeEvent[]
  days: number
  limit: number
}

function formatTimeAgo(iso: string | null): string {
  if (!iso) return 'never'
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 0) return 'just now'
  const secs = Math.floor(diff / 1000)
  if (secs < 60) return `${secs}s ago`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function formatDuration(seconds: number | null): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return ''
  const s = Math.floor(seconds)
  if (s < 60) return `${s}s`
  const mins = Math.floor(s / 60)
  const remSecs = s % 60
  if (mins < 60) return remSecs > 0 ? `${mins}m ${remSecs}s` : `${mins}m`
  const hours = Math.floor(mins / 60)
  const remMins = mins % 60
  if (hours < 24) return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`
  const days = Math.floor(hours / 24)
  const remHours = hours % 24
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`
}

function formatAbsolute(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

type BadgeTone = 'neutral' | 'accent' | 'verify' | 'amber' | 'alarm' | 'info'

interface PillSpec {
  label: string
  tone: BadgeTone
}

function statusPill(label: Monitor['status_label']): PillSpec {
  switch (label) {
    case 'up':
      return { label: 'Up', tone: 'verify' }
    case 'down':
      return { label: 'Down', tone: 'alarm' }
    case 'seems_down':
      return { label: 'Seems Down', tone: 'amber' }
    case 'paused':
      return { label: 'Paused', tone: 'neutral' }
    case 'not_checked_yet':
      return { label: 'Not checked yet', tone: 'neutral' }
    default:
      return { label: 'Unknown', tone: 'neutral' }
  }
}

function alertPill(alertType: string | null, friendly: string | null): PillSpec {
  // UR alert_type: 1=down, 2=up, 3=paused, 4=started
  const t = alertType || ''
  if (t === '2' || /up/i.test(friendly || '')) {
    return { label: friendly || 'Up', tone: 'verify' }
  }
  if (t === '1' || /down/i.test(friendly || '')) {
    return { label: friendly || 'Down', tone: 'alarm' }
  }
  return { label: friendly || alertType || 'Event', tone: 'neutral' }
}

/* 24h response-time sparkline — token-bound: each segment is colored by whether
   it climbed (slower = alarm) or held/fell (verify). Mirrors CostsPage DailyChart's
   var(--…) inline-SVG approach; no hardcoded hex. */
function Sparkline({ samples }: { samples: ResponseTimeSample[] }) {
  if (!samples || samples.length === 0) {
    return <span className="font-mono text-[10px] text-fg-3">no data</span>
  }
  const width = 96
  const height = 24
  const values = samples.map(s => s.value)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1
  const stepX = samples.length > 1 ? width / (samples.length - 1) : 0
  const coords = samples.map((s, i) => ({
    x: i * stepX,
    y: height - ((s.value - min) / range) * height,
    v: s.value,
  }))

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="block overflow-visible"
      aria-label="24h response time sparkline"
    >
      {coords.slice(1).map((pt, i) => {
        const prev = coords[i]
        // Rising response time (worse) = alarm; flat/falling = verify.
        const rising = pt.v > prev.v
        return (
          <line
            key={i}
            x1={prev.x.toFixed(1)}
            y1={prev.y.toFixed(1)}
            x2={pt.x.toFixed(1)}
            y2={pt.y.toFixed(1)}
            stroke={rising ? 'var(--ok-alarm)' : 'var(--ok-verify)'}
            strokeWidth={1.25}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )
      })}
    </svg>
  )
}

export function StatusPage() {
  const [monitorsData, setMonitorsData] = useState<MonitorsResponse | null>(null)
  const [eventsData, setEventsData] = useState<EventsResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [initialLoad, setInitialLoad] = useState(true)

  const fetchAll = useCallback(async () => {
    setLoading(true)
    let err: string | null = null
    try {
      const [monitors, events] = await Promise.all([
        api.get<MonitorsResponse>('/status/monitors').catch((e: unknown) => {
          if (e instanceof ApiError && e.status === 404) {
            err = 'Status API not available (server may need a restart)'
          } else {
            err = e instanceof Error ? e.message : 'Failed to fetch monitors'
          }
          return null
        }),
        api.get<EventsResponse>('/status/events?days=30&limit=100').catch(() => null),
      ])

      if (monitors) setMonitorsData(monitors)
      if (events) setEventsData(events)
    } catch {
      err = 'Network error fetching status data'
    } finally {
      setError(err)
      setLoading(false)
      setInitialLoad(false)
    }
  }, [])

  useEffect(() => {
    fetchAll()
    const interval = setInterval(fetchAll, 60_000)
    return () => clearInterval(interval)
  }, [fetchAll])

  const fetchedAt = monitorsData?.fetched_at
  const configured = monitorsData?.configured
  const monitors = monitorsData?.monitors || []
  const events = eventsData?.events || []

  const upCount = monitors.filter(m => m.status_label === 'up').length
  const totalCount = monitors.length

  const monitorColumns: Column<Monitor>[] = [
    {
      key: 'name',
      header: 'Monitor',
      cell: m => (
        <div className="flex min-w-0 items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate font-display text-[13px] font-medium text-fg-0">
              {m.friendly_name}
            </div>
            <div className="truncate font-mono text-[11px] text-fg-3">{m.url}</div>
          </div>
          <div className="shrink-0">
            <Sparkline samples={m.response_times} />
          </div>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: m => {
        const p = statusPill(m.status_label)
        return <Badge tone={p.tone}>{p.label}</Badge>
      },
    },
    {
      key: 'response',
      header: 'Response',
      mono: true,
      align: 'right',
      sortable: true,
      sortValue: m => m.response_time ?? -1,
      cell: m => (m.response_time !== null ? `${m.response_time}ms` : '—'),
    },
    {
      key: 'last_check',
      header: 'Last check',
      mono: true,
      align: 'right',
      hideOnMobile: true,
      sortable: true,
      sortValue: m => m.last_check ?? '',
      cell: m => formatTimeAgo(m.last_check),
    },
    {
      key: 'uptime',
      header: '30d uptime',
      mono: true,
      align: 'right',
      sortable: true,
      sortValue: m => m.uptime_ratio_30d ?? -1,
      cell: m => (
        <span className="font-medium text-fg-0">
          {m.uptime_ratio_30d !== null ? `${m.uptime_ratio_30d.toFixed(2)}%` : '—'}
        </span>
      ),
    },
  ]

  const incidentColumns: Column<UptimeEvent>[] = [
    {
      key: 'monitor',
      header: 'Monitor',
      cell: ev => (
        <div className="min-w-0">
          <div className="truncate font-display text-[13px] font-medium text-fg-0">
            {ev.monitor_name || ev.monitor_url || `Monitor #${ev.monitor_id ?? '?'}`}
          </div>
          {ev.alert_details && (
            <div className="truncate text-[11px] text-fg-3">{ev.alert_details}</div>
          )}
        </div>
      ),
    },
    {
      key: 'type',
      header: 'Event',
      cell: ev => {
        const p = alertPill(ev.alert_type, ev.alert_type_friendly_name)
        return <Badge tone={p.tone}>{p.label}</Badge>
      },
    },
    {
      key: 'duration',
      header: 'Duration',
      mono: true,
      align: 'right',
      hideOnMobile: true,
      cell: ev => formatDuration(ev.alert_duration) || '—',
    },
    {
      key: 'when',
      header: 'When',
      mono: true,
      align: 'right',
      sortable: true,
      sortValue: ev => ev.event_at,
      cell: ev => (
        <span title={formatAbsolute(ev.event_at)}>{formatTimeAgo(ev.event_at)}</span>
      ),
    },
  ]

  return (
    <PageContainer width="default">
      <PageHeader
        title="Status"
        breadcrumbs={[{ label: 'OperationKit' }, { label: 'Status' }]}
        description={
          totalCount > 0
            ? `${upCount}/${totalCount} monitors up${fetchedAt ? ` · updated ${formatTimeAgo(fetchedAt)}` : ''}`
            : fetchedAt
              ? `Updated ${formatTimeAgo(fetchedAt)}`
              : 'Loading…'
        }
        actions={
          <Button
            variant="secondary"
            onClick={fetchAll}
            disabled={loading}
            leftIcon={<RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} strokeWidth={1.75} />}
          >
            Refresh
          </Button>
        }
      />

      <Toolbar
        left={
          <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-fg-3">
            Auto-refresh 60s
          </span>
        }
      />

      {error && (
        <Alert tone="alarm" title="Status data unavailable" className="mb-4">
          <div className="flex items-center justify-between gap-3">
            <span>{error}</span>
            <Button variant="danger" size="sm" onClick={fetchAll}>Retry</Button>
          </div>
        </Alert>
      )}

      {/* UptimeRobot not configured */}
      {!initialLoad && configured === false && (
        <Card className="mb-6">
          <EmptyState
            icon={<Activity className="h-5 w-5" strokeWidth={1.6} />}
            title="UptimeRobot not configured"
            description="UPTIMEROBOT_API_KEY is not set. Add it to env-master and restart the container."
          />
        </Card>
      )}

      {/* Monitors */}
      {configured !== false && (
        <section className="mb-6 space-y-2">
          <h3 className="font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-fg-3">
            Monitors{totalCount > 0 && <span className="text-fg-3/70"> ({totalCount})</span>}
          </h3>
          <DataTable
            columns={monitorColumns}
            rows={monitors}
            rowKey={m => m.id}
            loading={initialLoad && monitors.length === 0 && !error}
            initialSort={{ key: 'uptime', dir: 'asc' }}
            mobileTitle={m => m.friendly_name}
            empty={{
              icon: <Activity className="h-5 w-5" strokeWidth={1.6} />,
              title: 'No monitors configured',
              description: 'Add a monitor in UptimeRobot to see it here.',
            }}
          />
        </section>
      )}

      {/* Incidents */}
      <section className="space-y-2">
        <h3 className="font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-fg-3">
          Recent Incidents <span className="text-fg-3/70">(30d)</span>
        </h3>
        <DataTable
          columns={incidentColumns}
          rows={events}
          rowKey={ev => ev.id}
          loading={initialLoad && !eventsData && !error}
          initialSort={{ key: 'when', dir: 'desc' }}
          mobileTitle={ev => ev.monitor_name || ev.monitor_url || `Monitor #${ev.monitor_id ?? '?'}`}
          empty={{
            icon: <ShieldCheck className="h-5 w-5" strokeWidth={1.6} />,
            title: 'No incidents in the last 30 days',
            description: 'All monitored endpoints have stayed healthy.',
          }}
        />
      </section>
    </PageContainer>
  )
}
