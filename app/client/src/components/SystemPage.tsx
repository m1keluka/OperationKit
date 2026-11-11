/**
 * System (obj 900495 — was "Dashboard", /dashboard → /system): AI usage,
 * estimated spend and host stats for this install.
 *
 * Subscription seats are deliberately NOT here any more — they are managed in
 * Settings → Models (MODELS_SETTINGS_ROUTE); this page carries one link there.
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import { Link } from 'react-router-dom'
import { Info } from 'lucide-react'
import { api } from '../lib/api'
import { MODELS_SETTINGS_ROUTE } from '../lib/routes'
import { CostModule } from './CostModule'
import {
  PageContainer,
  PageHeader,
  Card,
  CardHeader,
  CardBody,
  Badge,
  Button,
  Alert,
  Skeleton,
  SkeletonText,
  cn,
} from './ui'

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
  /** True when the server runs in a container: `hostname` is then a container id. */
  inContainer?: boolean
  timestamp: string
}

/** The exact disclaimer Operator asked for (obj 900495). Exported for the test. */
export const SPEND_DISCLAIMER =
  'Spend is estimated from public token prices. If you use subscription accounts (Claude, Codex, Grok), this reflects your token volume, not what you are billed.'

/** Host numbers older than this are flagged stale (the poll is every 5s). */
export const HOST_STALE_MS = 30_000

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

export function SystemPage() {
  const [accounts, setAccounts] = useState<AccountsData | null>(null)
  const [system, setSystem] = useState<SystemData | null>(null)
  // When the host numbers were last received. A failed poll used to leave the
  // previous numbers on screen with no sign they were old; now they age visibly.
  const [systemAt, setSystemAt] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())
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
      const [acc, sys] = await Promise.all([
        api.get<AccountsData>('/admin/accounts').catch(() => null),
        api.get<SystemData>('/admin/system').catch(() => null),
      ])
      if (reqId !== fetchSeq.current) return // superseded by a newer fetch — drop this stale response
      if (acc) setAccounts(acc)
      if (sys) { setSystem(sys); setSystemAt(Date.now()) }
      setError(null)
    } catch {
      if (reqId !== fetchSeq.current) return
      setError('Failed to fetch system data')
    }
  }, [])

  useEffect(() => {
    fetchData()
    const interval = setInterval(fetchData, 5000)
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => { clearInterval(interval); clearInterval(tick) }
  }, [fetchData])

  if (error && !accounts && !system) {
    return (
      <PageContainer width="wide">
        <PageHeader title="System" />
        <Alert tone="alarm" title="System data unavailable">
          {error}
        </Alert>
      </PageContainer>
    )
  }

  const hostAgeMs = systemAt != null ? Math.max(0, now - systemAt) : null
  const hostStale = hostAgeMs != null && hostAgeMs > HOST_STALE_MS
  const hostLabel = system
    ? `${system.inContainer ? `container ${system.hostname}` : system.hostname} · ${system.platform}`
    : undefined

  const totalActiveSessions = accounts?.accounts.reduce((sum, a) => sum + a.activeSessions.length, 0) ?? 0
  // Headline "today" totals include the untracked bucket (in-progress sessions
  // not yet attributed to a slot) so they reconcile with the cost panel below,
  // which sums all of today's usage. Without this the headline under-reported.
  const untracked = accounts?.untrackedToday ?? { cost: 0, tokens: 0, sessions: 0 }
  const totalSessionsToday = (accounts?.accounts.reduce((sum, a) => sum + a.sessionsToday, 0) ?? 0) + untracked.sessions
  const totalCostToday = (accounts?.accounts.reduce((sum, a) => sum + a.costToday, 0) ?? 0) + untracked.cost
  const totalTokensToday = (accounts?.accounts.reduce((sum, a) => sum + a.tokensToday, 0) ?? 0) + untracked.tokens
  // The seat-availability tile ("Accounts n/m") moved out with the seat list:
  // AI accounts are managed in Settings → Models (obj 900495).

  const loading = !accounts && !system

  return (
    <PageContainer width="wide">
      <PageHeader
        title="System"
        description="AI usage, estimated spend and host health for this install."
        actions={<Badge tone="neutral" mono>auto-refresh · 5s</Badge>}
      />

      <div className="space-y-6">
        {/* Summary metrics */}
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {loading ? (
            Array.from({ length: 4 }).map((_, i) => (
              <Card key={i}>
                <Skeleton className="h-3 w-16" />
                <Skeleton className="mt-2 h-7 w-12" />
              </Card>
            ))
          ) : (
            <>
              <MetricCard label="Active" value={totalActiveSessions} sub="sessions" />
              <MetricCard label="Today" value={totalSessionsToday} sub="sessions" />
              <MetricCard label="Tokens" value={formatTokens(totalTokensToday)} sub="today" />
              <MetricCard label="Est. spend" value={`$${totalCostToday.toFixed(2)}`} sub="today, at token prices" />
            </>
          )}
        </div>

        {/* Spend disclaimer (obj 900495): the dollar figures are token volume ×
            public list prices, which is NOT the bill on a flat-rate subscription. */}
        <p
          data-testid="spend-disclaimer"
          className="flex items-start gap-2 rounded-md border border-line bg-surface-1 px-3 py-2 text-[12.5px] leading-snug text-fg-2"
        >
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fg-3" strokeWidth={1.75} aria-hidden />
          <span>{SPEND_DISCLAIMER}</span>
        </p>

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

        {/* Host */}
        {loading && !system ? (
          <Card inset>
            <CardHeader title="Host" eyebrow="Server" />
            <CardBody>
              <SkeletonText lines={3} />
            </CardBody>
          </Card>
        ) : system ? (
          <Card inset>
            <CardHeader
              title="Host"
              eyebrow="Server"
              actions={
                <span className="flex items-center gap-2">
                  {hostStale && <Badge tone="amber" mono>stale</Badge>}
                  {hostAgeMs != null && (
                    <span data-testid="host-updated" className="font-mono text-[11px] text-fg-3">
                      updated {Math.round(hostAgeMs / 1000)}s ago
                    </span>
                  )}
                </span>
              }
            />
            <CardBody>
              {hostLabel && (
                <div data-testid="host-label" className="-mt-1 mb-4 truncate font-mono text-xs text-fg-3">{hostLabel}</div>
              )}
              {hostStale && (
                <Alert tone="amber" className="mb-4">
                  The server stopped answering; these numbers are from {Math.round((hostAgeMs ?? 0) / 1000)}s ago.
                </Alert>
              )}
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
                  <div className="mt-1 font-mono text-xs text-fg-3">
                    {system.processCount} processes visible to the server
                  </div>
                </div>
              </div>
            </CardBody>
          </Card>
        ) : null}

        {/* Seats are managed in Settings → Models (Sprint 4b) — one link, no widgets. */}
        <Link
          to={MODELS_SETTINGS_ROUTE}
          data-testid="manage-ai-accounts"
          className="inline-flex min-h-[44px] items-center rounded-md text-[12.5px] font-medium text-accent-hover underline-offset-2 transition-colors duration-fast ease-out hover:text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 sm:min-h-[32px]"
        >
          Manage AI accounts in Settings &gt; Models
        </Link>

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

      </div>
    </PageContainer>
  )
}
