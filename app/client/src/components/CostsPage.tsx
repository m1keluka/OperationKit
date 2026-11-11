import { useState, useEffect, useCallback, useMemo, type ReactNode } from 'react'
import { RefreshCw, DollarSign } from 'lucide-react'
import { api, ApiError } from '../lib/api'
import {
  PageContainer,
  PageHeader,
  Toolbar,
  Tabs,
  Card,
  Badge,
  Button,
  Alert,
  DataTable,
  Skeleton,
  cn,
  type Column,
  type TabItem,
} from './ui'

interface DailyCost {
  date: string
  cost_usd: number
  tokens: number
  sessions: number
}

interface ObjectiveCost {
  objective_id: number
  title: string
  status: string
  project: string | null
  workspace: string | null
  cost_usd: number
  sessions: number
  last_session_at: string | null
}

interface AccountCost {
  account_id: string
  cost_usd: number
  sessions: number
  tokens: number
}

interface ModelCost {
  model: string
  cost_usd: number
  sessions: number
  tokens: number
}

interface RangeResponse {
  start: string
  end: string
  tz: string
  today: string
  totals: { cost_usd: number; tokens: number; sessions: number }
  all_time_usd: number
  all_time_tokens: number
  daily: DailyCost[]
  by_account: AccountCost[]
  by_model?: ModelCost[]
  by_objective: ObjectiveCost[]
}

function formatModelName(model: string): string {
  if (model === 'untracked') return 'Untracked (older sessions)'
  return model
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '')
}

const TZ_OPTIONS = [
  { value: 'America/New_York', label: 'Eastern (EST/EDT)' },
  { value: 'America/Chicago', label: 'Central' },
  { value: 'America/Denver', label: 'Mountain' },
  { value: 'America/Los_Angeles', label: 'Pacific' },
  { value: 'UTC', label: 'UTC' },
]

const TZ_STORAGE_KEY = 'costs.tz'
const DEFAULT_TZ = 'America/New_York'

type Preset = '7d' | '30d' | 'mtd' | 'custom'

function todayInTz(tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

function shiftDate(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function presetRange(preset: Exclude<Preset, 'custom'>, tz: string): { start: string; end: string } {
  const end = todayInTz(tz)
  if (preset === '7d') return { start: shiftDate(end, -6), end }
  if (preset === '30d') return { start: shiftDate(end, -29), end }
  return { start: `${end.slice(0, 7)}-01`, end } // mtd
}

function formatUsd(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '$0.00'
  return `$${n.toFixed(digits)}`
}

function formatTokens(tokens: number): string {
  if (!tokens) return '0'
  if (tokens >= 1_000_000_000) return `${(tokens / 1_000_000_000).toFixed(2)}B`
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`
  return `${tokens}`
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

function shortDate(iso: string): string {
  const d = new Date(iso + 'T00:00:00')
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

type BadgeTone = 'neutral' | 'accent' | 'verify' | 'amber' | 'alarm' | 'info'

const STATUS_TONE: Record<string, BadgeTone> = {
  inbox: 'neutral',
  next: 'info',
  active: 'verify',
  in_progress: 'verify',
  blocked: 'alarm',
  review: 'amber',
  done: 'neutral',
  archived: 'neutral',
}

function statusTone(status: string): BadgeTone {
  return STATUS_TONE[status] || 'neutral'
}

type ChartMetric = 'cost' | 'tokens'

function DailyChart({ data, metric }: { data: DailyCost[]; metric: ChartMetric }) {
  const width = 800
  const height = 160
  const padTop = 12
  const padBottom = 28
  const padLeft = 44
  const padRight = 8
  const innerW = width - padLeft - padRight
  const innerH = height - padTop - padBottom

  const value = useCallback(
    (d: DailyCost) => (metric === 'cost' ? d.cost_usd : d.tokens),
    [metric]
  )

  const bars = useMemo(() => {
    if (!data.length) return []
    const max = Math.max(...data.map(value), metric === 'cost' ? 0.01 : 1)
    const slot = innerW / data.length
    const barW = Math.max(1, slot - Math.min(2, slot * 0.2))
    return data.map((d, i) => {
      const v = value(d)
      const ratio = v / max
      const h = Math.max(v > 0 ? 2 : 0, ratio * innerH)
      const x = padLeft + i * slot + (slot - barW) / 2
      const y = padTop + (innerH - h)
      return { d, v, x, y, h, w: barW, max }
    })
  }, [data, value, metric, innerW, innerH])

  const max = bars[0]?.max ?? 0
  const yTicks = max > 0 ? [0, max / 2, max] : [0]
  const labelEvery = Math.max(1, Math.ceil(data.length / 8))

  const fmtTick = (v: number) =>
    metric === 'cost' ? `$${v.toFixed(v < 1 ? 2 : 0)}` : formatTokens(Math.round(v))

  if (!data.length) {
    return (
      <Card className="p-6 text-center text-[13px] text-fg-3">No daily data for this range.</Card>
    )
  }

  // Cost = Signal Orange accent; Tokens = neutral fg. Both token-bound (no hardcoded hex).
  const barFill = metric === 'cost' ? 'var(--accent)' : 'var(--fg-2)'

  return (
    <Card inset className="overflow-x-auto p-4">
      <svg
        width="100%"
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="block font-mono"
        aria-label={metric === 'cost' ? 'Daily spend' : 'Daily token usage'}
      >
        {yTicks.map((v, i) => {
          const y = padTop + innerH - (max > 0 ? (v / max) * innerH : 0)
          return (
            <g key={i}>
              <line
                x1={padLeft}
                x2={width - padRight}
                y1={y}
                y2={y}
                stroke="var(--line)"
                strokeWidth={1}
              />
              <text x={padLeft - 6} y={y + 3} fontSize={10} fill="var(--fg-3)" textAnchor="end">
                {fmtTick(v)}
              </text>
            </g>
          )
        })}

        {bars.map(({ d, v, x, y, h, w }) => (
          <g key={d.date}>
            <title>{`${d.date}\n${formatUsd(d.cost_usd)} · ${formatTokens(d.tokens)} tokens\n${d.sessions} sessions`}</title>
            <rect
              x={x}
              y={y}
              width={w}
              height={h}
              fill={v > 0 ? barFill : 'var(--surface-4)'}
              opacity={v > 0 ? 0.9 : 0.5}
              rx={1}
            />
          </g>
        ))}

        {bars.map(({ d, x, w }, i) => {
          const showLabel = i === 0 || i === bars.length - 1 || i % labelEvery === 0
          if (!showLabel) return null
          return (
            <text
              key={`lbl-${d.date}`}
              x={x + w / 2}
              y={height - 8}
              fontSize={10}
              fill="var(--fg-3)"
              textAnchor="middle"
            >
              {shortDate(d.date)}
            </text>
          )
        })}
      </svg>
    </Card>
  )
}

/* Horizontal breakdown bar — token-bound (accent fill, surface-3 track). */
function BreakdownBar({
  label,
  labelMuted,
  value,
  max,
  sessions,
  tokens,
}: {
  label: string
  labelMuted?: boolean
  value: number
  max: number
  sessions: number
  tokens: number
}) {
  return (
    <div className="flex items-center gap-3">
      <span
        className={cn(
          'w-32 shrink-0 truncate rounded-sm border border-line bg-surface-3 px-2 py-0.5 font-mono text-[11px] font-medium sm:w-36',
          labelMuted ? 'italic text-fg-3' : 'text-fg-1',
        )}
        title={label}
      >
        {label}
      </span>
      <div className="min-w-0 flex-1">
        <div className="h-2 rounded-full bg-surface-3">
          <div
            className={cn('h-2 rounded-full', labelMuted ? 'bg-surface-4' : 'bg-accent')}
            style={{ width: `${(value / max) * 100}%` }}
          />
        </div>
      </div>
      <div className="w-20 shrink-0 text-right font-mono text-[12.5px] font-medium tabular-nums text-fg-0">
        {formatUsd(value)}
      </div>
      <div className="hidden w-14 shrink-0 text-right font-mono text-[11px] tabular-nums text-fg-3 sm:block">
        {sessions}s
      </div>
      <div className="hidden w-14 shrink-0 text-right font-mono text-[11px] tabular-nums text-fg-3 sm:block">
        {formatTokens(tokens)}
      </div>
    </div>
  )
}

const PRESET_TABS: TabItem[] = [
  { key: '7d', label: '7D' },
  { key: '30d', label: '30D' },
  { key: 'mtd', label: 'MTD' },
]

const METRIC_TABS: TabItem[] = [
  { key: 'cost', label: 'Cost' },
  { key: 'tokens', label: 'Tokens' },
]

const dateInputCls =
  'min-h-[44px] rounded-md border border-line bg-surface-2 px-2.5 font-mono text-[12px] text-fg-1 [color-scheme:dark] transition-colors duration-fast hover:border-line-strong focus:border-[color:var(--accent-line)] focus:outline-none focus:ring-2 focus:ring-accent/40 sm:min-h-[36px]'

/* KPI tile — eyebrow + big mono value + sub. During first load the value slot
   shows a Skeleton; min-h reserves the loaded height so the row doesn't reflow. */
function KpiCard({
  label,
  value,
  sub,
  loading,
}: {
  label: string
  value: ReactNode
  sub: ReactNode
  loading: boolean
}) {
  return (
    <Card className="min-h-[88px]">
      <div className="font-mono text-[11px] uppercase tracking-[0.1em] text-fg-3">{label}</div>
      {loading ? (
        <>
          <Skeleton className="mt-1.5 h-[26px] w-20" />
          <Skeleton className="mt-1.5 h-3 w-24" />
        </>
      ) : (
        <>
          <div className="mt-1 font-mono text-[22px] font-semibold text-fg-0">{value}</div>
          <div className="font-mono text-[11px] text-fg-3">{sub}</div>
        </>
      )}
    </Card>
  )
}

export function CostsPage() {
  const [tz, setTz] = useState<string>(() => {
    try {
      const saved = localStorage.getItem(TZ_STORAGE_KEY)
      if (saved && TZ_OPTIONS.some(o => o.value === saved)) return saved
    } catch { /* ignore */ }
    return DEFAULT_TZ
  })
  const [preset, setPreset] = useState<Preset>('30d')
  const [range, setRange] = useState(() => presetRange('30d', tz))
  const [data, setData] = useState<RangeResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [initialLoad, setInitialLoad] = useState(true)

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ start: range.start, end: range.end, tz })
      const res = await api.get<RangeResponse>(`/costs/range?${params.toString()}`)
      setData(res)
      setError(null)
    } catch (e: unknown) {
      if (e instanceof ApiError && e.status === 404) {
        setError('Costs API not available (server may need a restart)')
      } else {
        setError(e instanceof Error ? e.message : 'Failed to fetch cost data')
      }
    } finally {
      setLoading(false)
      setInitialLoad(false)
    }
  }, [range.start, range.end, tz])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const changeTz = (next: string) => {
    setTz(next)
    try { localStorage.setItem(TZ_STORAGE_KEY, next) } catch { /* ignore */ }
    if (preset !== 'custom') setRange(presetRange(preset, next))
  }

  const changePreset = (next: Exclude<Preset, 'custom'>) => {
    setPreset(next)
    setRange(presetRange(next, tz))
  }

  const changeDate = (field: 'start' | 'end', value: string) => {
    if (!value) return
    setPreset('custom')
    setRange(prev => {
      const next = { ...prev, [field]: value }
      if (next.start > next.end) {
        return field === 'start' ? { start: value, end: value } : { start: value, end: value }
      }
      return next
    })
  }

  const avgPerDay = useMemo(() => {
    if (!data) return null
    const lastCounted = data.end <= data.today ? data.end : data.today
    if (lastCounted < data.start) return null
    const days =
      Math.round(
        (Date.parse(`${lastCounted}T00:00:00Z`) - Date.parse(`${data.start}T00:00:00Z`)) / 86_400_000
      ) + 1
    return {
      cost: data.totals.cost_usd / days,
      tokens: data.totals.tokens / days,
      days,
    }
  }, [data])

  const [metric, setMetric] = useState<ChartMetric>('cost')

  const accountMax = useMemo(() => {
    return Math.max(...(data?.by_account ?? []).map(a => a.cost_usd), 0.01)
  }, [data])

  const modelMax = useMemo(() => {
    return Math.max(...(data?.by_model ?? []).map(m => m.cost_usd), 0.01)
  }, [data])

  const rangeDays = useMemo(() => {
    return (
      Math.round(
        (Date.parse(`${range.end}T00:00:00Z`) - Date.parse(`${range.start}T00:00:00Z`)) / 86_400_000
      ) + 1
    )
  }, [range])

  const tzShort = TZ_OPTIONS.find(o => o.value === tz)?.label ?? tz
  const kpiLoading = initialLoad && !data

  const objectiveColumns: Column<ObjectiveCost>[] = [
    {
      key: 'title',
      header: 'Objective',
      cell: o => (
        <a
          href={`/?objective=${o.objective_id}`}
          className="block max-w-md truncate text-fg-0 transition-colors duration-fast hover:text-accent-hover"
          title={o.title}
        >
          {o.title}
        </a>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: o => <Badge tone={statusTone(o.status)}>{o.status}</Badge>,
    },
    {
      key: 'project',
      header: 'Project',
      mono: true,
      cell: o => o.project || '—',
    },
    {
      key: 'sessions',
      header: 'Sessions',
      mono: true,
      align: 'right',
      sortable: true,
      sortValue: o => o.sessions,
      cell: o => o.sessions,
    },
    {
      key: 'cost',
      header: 'Cost',
      mono: true,
      align: 'right',
      sortable: true,
      sortValue: o => o.cost_usd,
      cell: o => <span className="font-medium text-fg-0">{formatUsd(o.cost_usd)}</span>,
    },
    {
      key: 'last',
      header: 'Last Session',
      mono: true,
      align: 'right',
      sortable: true,
      sortValue: o => o.last_session_at ?? '',
      cell: o => formatTimeAgo(o.last_session_at),
    },
  ]

  return (
    <PageContainer width="wide">
      <PageHeader
        title="Costs"
        breadcrumbs={[{ label: 'OperationKit' }, { label: 'Costs' }]}
        description={`Token usage & spend · days bucketed in ${tzShort}`}
        actions={
          <Button
            variant="secondary"
            onClick={fetchData}
            disabled={loading}
            leftIcon={<RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} strokeWidth={1.75} />}
          >
            Refresh
          </Button>
        }
      />

      {/* Controls */}
      <Toolbar
        left={
          <>
            <Tabs items={PRESET_TABS} value={preset} onChange={k => changePreset(k as Exclude<Preset, 'custom'>)} />
            <div className="flex items-center gap-2 font-mono text-[12px] text-fg-3">
              <input
                type="date"
                value={range.start}
                max={range.end}
                onChange={e => changeDate('start', e.target.value)}
                className={dateInputCls}
                aria-label="Start date"
              />
              <span className="text-accent-hover">→</span>
              <input
                type="date"
                value={range.end}
                min={range.start}
                onChange={e => changeDate('end', e.target.value)}
                className={dateInputCls}
                aria-label="End date"
              />
              <span>({rangeDays}d)</span>
            </div>
          </>
        }
        right={
          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-fg-3">TZ</span>
            <select
              value={tz}
              onChange={e => changeTz(e.target.value)}
              className="min-h-[44px] rounded-md border border-line bg-surface-2 px-2.5 text-[12.5px] text-fg-1 transition-colors duration-fast hover:border-line-strong focus:border-[color:var(--accent-line)] focus:outline-none focus:ring-2 focus:ring-accent/40 sm:min-h-[36px]"
              aria-label="Timezone"
            >
              {TZ_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
        }
      />

      {error && (
        <Alert
          tone="alarm"
          title="Cost data unavailable"
          className="mb-4"
        >
          <div className="flex items-center justify-between gap-3">
            <span>{error}</span>
            <Button variant="danger" size="sm" onClick={fetchData}>Retry</Button>
          </div>
        </Alert>
      )}

      {/* KPI cards — while the first load is in flight we render a Skeleton in the
          value slot and reserve the card min-height so the row holds its layout and
          content cross-fades in instead of hard-swapping from a placeholder '—'. */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-4">
        <KpiCard
          label="Total Cost"
          loading={kpiLoading}
          value={data ? formatUsd(data.totals.cost_usd) : '—'}
          sub={data ? `${shortDate(data.start)} – ${shortDate(data.end)}` : ''}
        />
        <KpiCard
          label="Total Tokens"
          loading={kpiLoading}
          value={data ? formatTokens(data.totals.tokens) : '—'}
          sub={data ? `all-time ${formatTokens(data.all_time_tokens)}` : ''}
        />
        <KpiCard
          label="Sessions"
          loading={kpiLoading}
          value={data ? data.totals.sessions : '—'}
          sub="in range"
        />
        <KpiCard
          label="Avg / Day"
          loading={kpiLoading}
          value={avgPerDay ? formatUsd(avgPerDay.cost) : '—'}
          sub={avgPerDay ? `${formatTokens(Math.round(avgPerDay.tokens))} tok · ${avgPerDay.days}d` : ''}
        />
      </div>

      {/* Daily chart */}
      <section className="mb-6 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <h3 className="font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-fg-3">
              Daily {metric === 'cost' ? 'Spend' : 'Tokens'}
            </h3>
            <Tabs items={METRIC_TABS} value={metric} onChange={k => setMetric(k as ChartMetric)} />
          </div>
          <div className="font-mono text-[11px] text-fg-3">
            {data ? `All-time: ${formatUsd(data.all_time_usd)}` : ''}
          </div>
        </div>
        {initialLoad && !data ? (
          // Reserve the chart's height with a full-width Skeleton so the section
          // doesn't collapse-then-expand when the bars arrive.
          <Card inset className="p-4">
            <Skeleton className="h-[160px] w-full" />
          </Card>
        ) : (
          <DailyChart data={data?.daily ?? []} metric={metric} />
        )}
      </section>

      {/* Per-account breakdown */}
      {(data?.by_account.length ?? 0) > 0 && (
        <section className="mb-6 space-y-2">
          <h3 className="font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-fg-3">
            By Account <span className="text-fg-3/70">(selected range)</span>
          </h3>
          <Card className="space-y-2.5">
            {data!.by_account.map(a => (
              <BreakdownBar
                key={a.account_id}
                label={a.account_id.toUpperCase()}
                value={a.cost_usd}
                max={accountMax}
                sessions={a.sessions}
                tokens={a.tokens}
              />
            ))}
          </Card>
        </section>
      )}

      {/* Per-model breakdown */}
      {(data?.by_model?.length ?? 0) > 0 && (
        <section className="mb-6 space-y-2">
          <h3 className="font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-fg-3">
            By Model <span className="text-fg-3/70">(selected range)</span>
          </h3>
          <Card className="space-y-2.5">
            {data!.by_model!.map(m => (
              <BreakdownBar
                key={m.model}
                label={formatModelName(m.model)}
                labelMuted={m.model === 'untracked'}
                value={m.cost_usd}
                max={modelMax}
                sessions={m.sessions}
                tokens={m.tokens}
              />
            ))}
          </Card>
        </section>
      )}

      {/* Per-objective table */}
      <section className="space-y-2">
        <h3 className="font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-fg-3">
          By Objective <span className="text-fg-3/70">(selected range, top 50 by cost)</span>
        </h3>
        <DataTable
          columns={objectiveColumns}
          rows={data?.by_objective ?? []}
          rowKey={o => o.objective_id}
          loading={initialLoad && !data}
          initialSort={{ key: 'cost', dir: 'desc' }}
          mobileTitle={o => (
            <a
              href={`/?objective=${o.objective_id}`}
              className="text-fg-0 transition-colors duration-fast hover:text-accent-hover"
              title={o.title}
            >
              {o.title}
            </a>
          )}
          empty={{
            icon: <DollarSign className="h-5 w-5" strokeWidth={1.6} />,
            title: 'No objective costs in this range',
            description: 'Pick a wider date range or a different timezone.',
          }}
        />
      </section>
    </PageContainer>
  )
}
