import { useState, useEffect, useCallback, useRef } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import { ModelsModule } from './ModelsModule'
import { CostModule } from './CostModule'
import { SeatPool } from './settings/SettingsSeats'
import {
  PageContainer,
  PageHeader,
  Card,
  CardHeader,
  CardBody,
  Badge,
  Button,
  Alert,
  DataTable,
  Skeleton,
  SkeletonText,
  cn,
} from './ui'
import type { Column } from './ui'

interface WindowUsage {
  tokens: number
  cost: number
  resetsAt: string | null
}

interface AccountInfo {
  id: string
  label: string
  kind?: 'claude' | 'codex' | 'grok'
  homeDir: string
  sessionsToday: number
  tokensToday: number
  costToday: number
  lastRateLimit: string | null
  rateLimitResetsAt: string | null
  authFailedAt?: string | null
  // 'needs_admin' = org disabled subscription access (re-login won't fix it)
  authFailureReason?: 'needs_admin' | 'needs_reconnect' | null
  activeSessions: string[]
  available: boolean
  windows: {
    sessionWindow: WindowUsage
    weeklyWindow: WindowUsage
  }
}

interface AccountsData {
  accounts: AccountInfo[]
  queue: Array<{ objectiveId: number; queuedAt: string }>
  earliestReset: string | null
  // Today's usage not (yet) attributed to a rotation slot — mostly in-progress
  // sessions. Folded into the headline totals so they match the cost panel.
  untrackedToday?: { cost: number; tokens: number; sessions: number }
}

interface SystemData {
  cpu: { cores: number; model: string; usagePercent: number; loadAvg: number[] }
  memory: { total: number; used: number; free: number; usagePercent: number }
  disk: { total: number; used: number; available: number; usagePercent: number }
  uptime: number
  processCount: number
  hostname: string
  platform: string
  timestamp: string
}

interface RateLimitEvent {
  timestamp: string
  accountId: string
  label: string
  tokensAtLimit: number
  sessionsAtLimit: number
  costAtLimit: number
  activeSessions: number
  resetTime: string
  triggerMessage?: string
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`
  return `${tokens}`
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const mins = Math.floor((seconds % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h ${mins}m`
  if (hours > 0) return `${hours}h ${mins}m`
  return `${mins}m`
}

function formatTimeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ${mins % 60}m ago`
  return `${Math.floor(hours / 24)}d ago`
}

function formatTimeUntil(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now()
  if (diff <= 0) return 'now'
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins} min`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} hr ${mins % 60} min`
  const days = Math.floor(hours / 24)
  return `${days}d ${hours % 24} hr`
}

// Usage-bar fill follows the signal-token thresholds (track = surface-3).
function barFill(percent: number): string {
  if (percent >= 90) return 'bg-signal-alarm'
  if (percent >= 70) return 'bg-signal-amber'
  return 'bg-signal-verify'
}

function UsageBar({ percent }: { percent: number }) {
  return (
    <div className="h-2 w-full rounded-full bg-surface-3">
      <div
        className={cn('h-2 rounded-full transition-[width] duration-slow ease-out', barFill(percent))}
        style={{ width: `${Math.min(percent, 100)}%` }}
      />
    </div>
  )
}

// Codex / Grok are flat-rate subscriptions surfaced alongside the Claude rotation,
// not members of it.
function isSubscriptionAccount(account: AccountInfo): boolean {
  return account.id === 'codex' || account.id === 'grok' || account.kind === 'codex' || account.kind === 'grok'
}

// Compact headline metric tile. Mono number + uppercase mono eyebrow.
function MetricCard({
  label,
  value,
  sub,
}: {
  label: string
  value: React.ReactNode
  sub?: React.ReactNode
}) {
  return (
    <Card>
      <div className="font-mono text-[11px] uppercase tracking-[0.12em] text-fg-3">{label}</div>
      <div className="mt-1 font-mono text-2xl font-semibold tabular-nums text-fg-0">{value}</div>
      {sub && <div className="mt-0.5 font-mono text-[11px] text-fg-3">{sub}</div>}
    </Card>
  )
}

// Mono uppercase eyebrow heading, matching the primitive CardHeader kicker.
function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-3 font-mono text-[11px] uppercase tracking-[0.12em] text-fg-3">{children}</h3>
  )
}

export function Dashboard() {
  const [accounts, setAccounts] = useState<AccountsData | null>(null)
  const [system, setSystem] = useState<SystemData | null>(null)
  const [rateLimitHistory, setRateLimitHistory] = useState<RateLimitEvent[]>([])
  const [error, setError] = useState<string | null>(null)

  // Monotonic request counter: a slow poll tick that started before a label
  // save can resolve AFTER the save's own refetch, and a bare `setAccounts`
  // would then clobber the just-saved name with the stale pre-save payload
  // (obj 718892 — nicknames reverting on poll/recheck). Only the response
  // from the most recently-STARTED fetchData call is applied; anything older
  // that resolves late is discarded.
  const fetchSeq = useRef(0)

  const fetchData = useCallback(async () => {
    const reqId = ++fetchSeq.current
    try {
      const [acc, sys, rl] = await Promise.all([
        api.get<AccountsData>('/admin/accounts').catch(() => null),
        api.get<SystemData>('/admin/system').catch(() => null),
        api.get<RateLimitEvent[]>('/admin/rate-limits?limit=20').catch(() => null),
      ])
      if (reqId !== fetchSeq.current) return // superseded by a newer fetch — drop this stale response
      if (acc) setAccounts(acc)
      if (sys) setSystem(sys)
      if (rl) setRateLimitHistory(rl)
      setError(null)
    } catch {
      if (reqId !== fetchSeq.current) return
      setError('Failed to fetch dashboard data')
    }
  }, [])

  useEffect(() => {
    fetchData()
    const interval = setInterval(fetchData, 5000)
    return () => clearInterval(interval)
  }, [fetchData])

  if (error && !accounts && !system) {
    return (
      <PageContainer width="wide">
        <PageHeader title="System Dashboard" />
        <Alert tone="alarm" title="Dashboard unavailable">
          {error}
        </Alert>
      </PageContainer>
    )
  }

  const totalActiveSessions = accounts?.accounts.reduce((sum, a) => sum + a.activeSessions.length, 0) ?? 0
  // Headline "today" totals include the untracked bucket (in-progress sessions
  // not yet attributed to a slot) so they reconcile with the cost panel below,
  // which sums all of today's usage. Without this the headline under-reported.
  const untracked = accounts?.untrackedToday ?? { cost: 0, tokens: 0, sessions: 0 }
  const totalSessionsToday = (accounts?.accounts.reduce((sum, a) => sum + a.sessionsToday, 0) ?? 0) + untracked.sessions
  const totalCostToday = (accounts?.accounts.reduce((sum, a) => sum + a.costToday, 0) ?? 0) + untracked.cost
  const totalTokensToday = (accounts?.accounts.reduce((sum, a) => sum + a.tokensToday, 0) ?? 0) + untracked.tokens
  // The "Accounts available" headline must measure the Claude ROTATION pool only
  // (what pickAccount() actually draws from). Codex is a flat-rate ChatGPT
  // subscription with priority 99 — explicitly not in the rotation — so folding it
  // into the fraction made the one number an operator reads to answer "can a new
  // session get an account right now?" structurally wrong (e.g. it could never
  // legitimately read 0 while Codex auth was present). Count rotation slots here
  // and surface Codex separately on its own card.
  const rotationAccounts = accounts?.accounts.filter((a) => !isSubscriptionAccount(a)) ?? []
  const availableCount = rotationAccounts.filter((a) => a.available).length
  const totalAccounts = rotationAccounts.length
  // First rotation slot to recover, from the server's bench timers (rotation-only —
  // getEarliestResetTime ignores Codex). Lets us show honest recovery context under
  // the headline whenever the pool is degraded, instead of a bare red "0".
  const nextResetLabel =
    availableCount < totalAccounts && accounts?.earliestReset
      ? `next free in ${formatTimeUntil(accounts.earliestReset)}`
      : 'available'

  const loading = !accounts && !system

  const rateLimitColumns: Column<RateLimitEvent>[] = [
    {
      key: 'when',
      header: 'When',
      sortable: true,
      sortValue: (e) => new Date(e.timestamp).getTime(),
      className: 'w-40',
      cell: (e) => (
        <span className="font-mono text-xs text-fg-2">
          {new Date(e.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}{' '}
          {new Date(e.timestamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
        </span>
      ),
    },
    {
      key: 'account',
      header: 'Account',
      cell: (e) => (
        <span className="flex items-center gap-1.5">
          <Badge tone="alarm" mono>{e.accountId.toUpperCase()}</Badge>
          <span className="text-xs text-fg-3">{e.label}</span>
        </span>
      ),
    },
    {
      key: 'tokens',
      header: 'Tokens',
      mono: true,
      align: 'right',
      sortable: true,
      sortValue: (e) => e.tokensAtLimit,
      cell: (e) => <span className="text-fg-0">{formatTokens(e.tokensAtLimit)}</span>,
    },
    {
      key: 'sessions',
      header: 'Sessions',
      mono: true,
      align: 'right',
      sortable: true,
      sortValue: (e) => e.sessionsAtLimit,
      cell: (e) => <span className="text-fg-0">{e.sessionsAtLimit}</span>,
    },
    {
      key: 'cost',
      header: 'Cost',
      mono: true,
      align: 'right',
      sortable: true,
      sortValue: (e) => e.costAtLimit,
      cell: (e) => <span className="text-fg-0">${e.costAtLimit.toFixed(2)}</span>,
    },
    {
      key: 'reset',
      header: 'Reset After',
      mono: true,
      align: 'right',
      cell: (e) => {
        const resetDuration = Math.round(
          (new Date(e.resetTime).getTime() - new Date(e.timestamp).getTime()) / 60000
        )
        return (
          <span className="text-xs text-fg-3">
            {resetDuration > 60 ? `${Math.round(resetDuration / 60)}h ${resetDuration % 60}m` : `${resetDuration}m`}
          </span>
        )
      },
    },
  ]

  return (
    <PageContainer width="wide">
      <PageHeader
        title="System Dashboard"
        description={system ? `${system.hostname} · ${system.platform}` : undefined}
        actions={<Badge tone="neutral" mono>auto-refresh · 5s</Badge>}
      />

      <div className="space-y-6">
        {/* Summary metrics */}
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          {loading ? (
            Array.from({ length: 5 }).map((_, i) => (
              <Card key={i}>
                <Skeleton className="h-3 w-16" />
                <Skeleton className="mt-2 h-7 w-12" />
              </Card>
            ))
          ) : (
            <>
              <MetricCard label="Active" value={totalActiveSessions} sub="sessions" />
              <MetricCard label="Today" value={totalSessionsToday} sub="sessions" />
              <MetricCard
                label="Accounts"
                value={
                  <span>
                    <span
                      className={cn(
                        availableCount === 0
                          ? 'text-signal-alarm'
                          : availableCount < 3
                            ? 'text-signal-amber'
                            : 'text-signal-verify'
                      )}
                    >
                      {availableCount}
                    </span>
                    <span className="text-base text-fg-3"> / {totalAccounts}</span>
                  </span>
                }
                sub={nextResetLabel}
              />
              <MetricCard label="Tokens" value={formatTokens(totalTokensToday)} sub="today" />
              <MetricCard label="Cost" value={`$${totalCostToday.toFixed(2)}`} sub="today" />
            </>
          )}
        </div>

        {/* Reconciliation note: today's totals above fold in usage that isn't yet
            attributed to a rotation slot (mostly in-progress sessions). Without
            naming it, the per-account cards visibly under-sum the headline and the
            numbers read as inconsistent. Surface it so the math closes. */}
        {!loading && untracked.sessions > 0 && (
          <div className="font-mono text-[11px] text-fg-3">
            Today’s totals include {untracked.sessions} in-progress session
            {untracked.sessions === 1 ? '' : 's'} not yet attributed to an account
            {' · '}${untracked.cost.toFixed(2)}
            {' · '}{formatTokens(untracked.tokens)} tokens
          </div>
        )}

        {/* Cost over a selectable time window (Eastern day boundaries) */}
        <CostModule />

        {/* VPS Compute */}
        {loading && !system ? (
          <Card inset>
            <CardHeader title="VPS Compute" eyebrow="Host" />
            <CardBody>
              <SkeletonText lines={3} />
            </CardBody>
          </Card>
        ) : system ? (
          <Card inset>
            <CardHeader title="VPS Compute" eyebrow="Host" />
            <CardBody>
              <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
                <div>
                  <div className="mb-2 flex items-baseline justify-between">
                    <span className="text-sm text-fg-2">CPU</span>
                    <span className="font-mono text-sm font-medium text-fg-0">{system.cpu.usagePercent}%</span>
                  </div>
                  <UsageBar percent={system.cpu.usagePercent} />
                  <div className="mt-1.5 font-mono text-xs text-fg-3">
                    {system.cpu.cores} cores &middot; Load {system.cpu.loadAvg.join(' / ')}
                  </div>
                </div>
                <div>
                  <div className="mb-2 flex items-baseline justify-between">
                    <span className="text-sm text-fg-2">Memory</span>
                    <span className="font-mono text-sm font-medium text-fg-0">{system.memory.usagePercent}%</span>
                  </div>
                  <UsageBar percent={system.memory.usagePercent} />
                  <div className="mt-1.5 font-mono text-xs text-fg-3">
                    {formatBytes(system.memory.used)} / {formatBytes(system.memory.total)}
                  </div>
                </div>
                <div>
                  <div className="mb-2 flex items-baseline justify-between">
                    <span className="text-sm text-fg-2">Disk</span>
                    <span className="font-mono text-sm font-medium text-fg-0">{system.disk.usagePercent}%</span>
                  </div>
                  <UsageBar percent={system.disk.usagePercent} />
                  <div className="mt-1.5 font-mono text-xs text-fg-3">
                    {formatBytes(system.disk.used)} / {formatBytes(system.disk.total)}
                  </div>
                </div>
                <div>
                  <div className="mb-2 flex items-baseline justify-between">
                    <span className="text-sm text-fg-2">Uptime</span>
                    <span className="font-mono text-sm font-medium text-fg-0">{formatUptime(system.uptime)}</span>
                  </div>
                  <div className="mt-1 font-mono text-xs text-fg-3">{system.processCount} processes</div>
                </div>
              </div>
            </CardBody>
          </Card>
        ) : null}

        {/* Subscription seats — the same list and actions as Settings → Seats,
            so there is one way to add, sign in, reconnect and remove a seat. */}
        <section aria-labelledby="dashboard-seats">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 id="dashboard-seats" className="font-mono text-[11px] uppercase tracking-[0.12em] text-fg-3">Subscription seats</h3>
            <Link
              to="/settings/seats"
              className="inline-flex min-h-[44px] items-center rounded-md px-2 text-[12.5px] font-medium text-accent-hover underline-offset-2 transition-colors duration-fast ease-out hover:text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 sm:min-h-[32px]"
            >
              Manage seats
            </Link>
          </div>
          <SeatPool refreshMs={15_000} />
        </section>

        {/* Models configuration */}
        <ModelsModule />

        {/* Queue */}
        {accounts && accounts.queue.length > 0 && (
          <Alert tone="amber" title={`Queued Sessions (${accounts.queue.length})`}>
            <div className="space-y-1">
              {accounts.queue.map((q, i) => (
                <div key={i}>
                  Objective <span className="font-mono">#{q.objectiveId}</span> &middot; queued{' '}
                  <span className="font-mono">{formatTimeAgo(q.queuedAt)}</span>
                </div>
              ))}
            </div>
            {accounts.earliestReset && (
              <div className="mt-2 font-mono text-xs text-fg-3">
                Next account available in {formatTimeUntil(accounts.earliestReset)}
              </div>
            )}
          </Alert>
        )}

        {/* Rate Limit History */}
        {rateLimitHistory.length > 0 && (
          <div>
            <SectionHeading>Rate Limit History</SectionHeading>
            <DataTable
              columns={rateLimitColumns}
              rows={rateLimitHistory}
              rowKey={(e) => `${e.accountId}-${e.timestamp}`}
              mobileTitle={(e) => e.accountId.toUpperCase()}
              initialSort={{ key: 'when', dir: 'desc' }}
              empty={{ title: 'No rate-limit events', description: 'Accounts have not hit a limit recently.' }}
            />
            {rateLimitHistory.length >= 3 && (
              <Card inset className="mt-4">
                <CardBody>
                  <div className="font-mono text-[11px] uppercase tracking-[0.12em] text-fg-3">
                    Observed limits (avg at time of rate limit)
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-6 text-sm">
                    <div>
                      <span className="text-fg-3">Avg tokens: </span>
                      <span className="font-mono font-medium text-fg-0">
                        {formatTokens(Math.round(rateLimitHistory.reduce((s, e) => s + e.tokensAtLimit, 0) / rateLimitHistory.length))}
                      </span>
                    </div>
                    <div>
                      <span className="text-fg-3">Avg sessions: </span>
                      <span className="font-mono font-medium text-fg-0">
                        {Math.round(rateLimitHistory.reduce((s, e) => s + e.sessionsAtLimit, 0) / rateLimitHistory.length)}
                      </span>
                    </div>
                    <div>
                      <span className="text-fg-3">Avg cost: </span>
                      <span className="font-mono font-medium text-fg-0">
                        ${(rateLimitHistory.reduce((s, e) => s + e.costAtLimit, 0) / rateLimitHistory.length).toFixed(2)}
                      </span>
                    </div>
                  </div>
                </CardBody>
              </Card>
            )}
          </div>
        )}
      </div>
    </PageContainer>
  )
}
