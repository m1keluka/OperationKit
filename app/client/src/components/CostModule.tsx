/**
 * Dashboard module: total cost over a selectable time window. Backed by
 * GET /api/costs/range, which buckets days against an IANA timezone (Eastern
 * here) so EST/EDT day boundaries are real local days, not UTC.
 */
import { useState, useEffect, useCallback } from 'react'
import { api } from '../lib/api'
import { Card, CardHeader, CardBody, Tabs, Alert, Skeleton, cn, type TabItem } from './ui'

const TZ = 'America/New_York'

interface RangeResp {
  start: string
  end: string
  tz: string
  today: string
  totals: { cost_usd: number; tokens: number; sessions: number }
  all_time_usd: number
  by_account: Array<{ account_id: string; cost_usd: number; tokens: number; sessions: number }>
}

type Period = 'today' | '7d' | 'month' | 'lastMonth' | 'custom'

const PERIODS: Array<{ id: Period; label: string }> = [
  { id: 'today', label: 'Today' },
  { id: '7d', label: 'Last 7 days' },
  { id: 'month', label: 'This month' },
  { id: 'lastMonth', label: 'Last month' },
  { id: 'custom', label: 'Custom' },
]

const PERIOD_TABS: TabItem[] = PERIODS.map(p => ({ key: p.id, label: p.label }))

const ACCT_LABELS: Record<string, string> = {
  a: 'A', b: 'B', c: 'C', d: 'D', codex: 'Codex', unknown: 'Untracked',
}

// Eastern "YYYY-MM-DD" for an instant (default now), regardless of the viewer's browser TZ.
function eKey(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
}
// Shift a YYYY-MM-DD key by N days (noon-UTC anchor dodges DST edges).
function shiftKey(key: string, days: number): string {
  const d = new Date(`${key}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function rangeFor(period: Period, cs: string, ce: string): { start: string; end: string } {
  const today = eKey(new Date())
  const [y, m] = today.split('-').map(Number)
  switch (period) {
    case 'today': return { start: today, end: today }
    case '7d': return { start: shiftKey(today, -6), end: today }
    case 'month': return { start: `${today.slice(0, 7)}-01`, end: today }
    case 'lastMonth': {
      const pm = m === 1 ? 12 : m - 1
      const py = m === 1 ? y - 1 : y
      const last = new Date(Date.UTC(py, pm, 0)).getUTCDate()
      const mm = String(pm).padStart(2, '0')
      return { start: `${py}-${mm}-01`, end: `${py}-${mm}-${String(last).padStart(2, '0')}` }
    }
    default: return { start: cs || today, end: ce || today }
  }
}

function fmtTokens(t: number): string {
  if (t >= 1_000_000) return `${(t / 1_000_000).toFixed(1)}M`
  if (t >= 1_000) return `${(t / 1_000).toFixed(1)}K`
  return `${t}`
}

export function CostModule() {
  const [period, setPeriod] = useState<Period>('today')
  const [customStart, setCustomStart] = useState('')
  const [customEnd, setCustomEnd] = useState('')
  const [data, setData] = useState<RangeResp | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    const { start, end } = rangeFor(period, customStart, customEnd)
    setLoading(true)
    setError('')
    try {
      const d = await api.get<RangeResp>(`/costs/range?tz=${encodeURIComponent(TZ)}&start=${start}&end=${end}`)
      setData(d)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load costs')
    } finally {
      setLoading(false)
    }
  }, [period, customStart, customEnd])

  useEffect(() => {
    // For custom, wait until both ends are picked.
    if (period === 'custom' && (!customStart || !customEnd)) return
    void load()
  }, [load, period, customStart, customEnd])

  const dateInputCls =
    'min-h-[36px] rounded-md border border-line bg-surface-2 px-2.5 font-mono text-[12.5px] text-fg-1 ' +
    'transition-colors duration-fast hover:border-line-strong focus:border-[color:var(--accent-line)] focus:outline-none focus:ring-2 focus:ring-accent/40'

  return (
    <Card inset>
      <CardHeader
        title="Cost"
        eyebrow="Usage spend"
        actions={
          <Tabs
            items={PERIOD_TABS}
            value={period}
            onChange={k => setPeriod(k as Period)}
          />
        }
      />
      <CardBody>
        {period === 'custom' && (
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <input
              type="date"
              value={customStart}
              max={customEnd || undefined}
              onChange={e => setCustomStart(e.target.value)}
              className={dateInputCls}
            />
            <span className="font-mono text-[12px] text-fg-3">→</span>
            <input
              type="date"
              value={customEnd}
              min={customStart || undefined}
              onChange={e => setCustomEnd(e.target.value)}
              className={dateInputCls}
            />
          </div>
        )}

        {error && (
          <Alert tone="alarm" className="mb-3">{error}</Alert>
        )}

        {data ? (
          <>
            <div className="flex flex-wrap items-end gap-x-6 gap-y-1">
              <div>
                <div className="font-mono text-3xl font-semibold tabular-nums text-fg-0">${data.totals.cost_usd.toFixed(2)}</div>
                <div className="mt-1 font-mono text-[11px] text-fg-3">
                  {data.start === data.end ? data.start : `${data.start} → ${data.end}`} · Eastern
                </div>
              </div>
              <div className="pb-1 font-mono text-[13px] text-fg-2">
                {fmtTokens(data.totals.tokens)} tokens · {data.totals.sessions} sessions
              </div>
            </div>

            {data.by_account.length > 0 && (
              <div className="mt-4 border-t border-line-soft pt-3">
                <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.1em] text-fg-3">By account</div>
                <div className="flex flex-wrap gap-x-6 gap-y-1 font-mono text-[13px]">
                  {data.by_account.map(a => (
                    <div key={a.account_id} className="text-fg-2">
                      <span className="text-fg-1">{ACCT_LABELS[a.account_id] || a.account_id}</span>
                      {': '}<span className="tabular-nums">${a.cost_usd.toFixed(2)}</span>
                      <span className="text-fg-3"> · {fmtTokens(a.tokens)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : loading ? (
          // Skeleton mirrors the loaded layout (big mono total + meta line) so the
          // card holds its height and content cross-fades in instead of hard-swapping.
          <div className="flex flex-wrap items-end gap-x-6 gap-y-1">
            <div>
              <Skeleton className="h-9 w-32" />
              <Skeleton className="mt-2 h-3 w-40" />
            </div>
            <Skeleton className="mb-1 h-3.5 w-36" />
          </div>
        ) : (
          <div className="text-[13px] text-fg-3">No data</div>
        )}
      </CardBody>
    </Card>
  )
}
