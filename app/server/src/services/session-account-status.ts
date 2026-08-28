/**
 * Account-router dashboard overlay + queue-drain callback wiring —
 * extracted from session-manager.ts (behavior frozen).
 */
import { getDb } from '../db/index.js'
import {
  getRouterStatus,
  startQueueDrain,
} from './account-router.js'
import { easternDayKey } from '../lib/eastern-day.js'
import {
  extractFinalUsage,
  extractUsageForSessionId,
} from './session-usage.js'
import {
  codexAuthAvailable,
  CODEX_ACCOUNT_ID,
  CODEX_HOME_DIR,
  grokAuthAvailable,
  GROK_ACCOUNT_ID,
  GROK_HOME_DIR,
} from './session-spawn-command.js'
import { activeSessions } from './session-registry.js'
import { isSessionActive } from './session-control.js'

/**
 * Wraps router status with FRESH per-account totals computed from authoritative
 * sources on every call. Ignores the persisted accumulator (`tokensToday` /
 * `costToday` / `usageLog` / `sessionsToday` on AccountSlot) because that
 * accumulator double-counts on followup re-spawns: each `proc.on('exit')`
 * during a multi-turn session fires `recordSessionEnd` again, which adds the
 * cumulative JSONL total a second time.
 *
 * Authoritative sources:
 *   - `session_intel` table — one row per completed session, account_id +
 *     ended_at + total_tokens + total_cost_usd. INSERT-OR-REPLACEd by
 *     session-intel.ts so the latest extraction wins.
 *   - Live JSONL files — for sessions currently in the in-memory map.
 *     `extractFinalUsage` re-parses the file and sums all `result` events,
 *     giving the up-to-the-second cumulative usage for the live session.
 *
 * Dedup: a session may be both in session_intel (from an earlier process exit)
 * and in the live map (because a followup spawned a new process). We prefer
 * the live JSONL value because it is more current.
 */
const SESSION_WINDOW_MS = 5 * 60 * 60 * 1000     // 5 hours
const WEEKLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

interface IntelRow {
  session_id: string
  account_id: string | null
  started_at: string
  ended_at: string
  total_tokens: number
  total_cost_usd: number
}

export function getAccountRouterStatus() {
  const status = getRouterStatus()
  const now = Date.now()
  const today = easternDayKey(new Date())
  // Exact per-Eastern-day "today" totals from the attributed usage table (same
  // source as the cost dashboard). Long multi-day sessions no longer dump their
  // whole cost onto today — only the portion that actually ran today counts.
  const todayByAccount = new Map<string, { cost: number; tok: number; sess: number }>()
  try {
    const rows = getDb().prepare(
      `SELECT COALESCE(account_id,'unknown') account_id, SUM(cost_usd) cost, SUM(tokens) tok, COUNT(DISTINCT session_id) sess
       FROM session_usage_daily WHERE day = ? GROUP BY COALESCE(account_id,'unknown')`
    ).all(today) as Array<{ account_id: string; cost: number; tok: number; sess: number }>
    for (const r of rows) todayByAccount.set(r.account_id, { cost: r.cost, tok: r.tok, sess: r.sess })
  } catch (err) {
    console.error('[session-manager] getAccountRouterStatus: session_usage_daily query failed:', err)
  }
  // The 'unknown' bucket = today's usage whose account_id isn't (yet) recorded —
  // mostly in-progress sessions (the daily-usage backfill writes their rows
  // before the session ends and gets attributed). It's a real part of today's
  // spend but belongs to no slot in the rotation, so the per-account loop below
  // drops it. Surface it separately so the dashboard headline (sum of accounts
  // + untracked) reconciles with the cost panel instead of under-reporting.
  const untracked = todayByAccount.get('unknown') ?? { cost: 0, tok: 0, sess: 0 }
  const weeklyCutoffIso = new Date(now - WEEKLY_WINDOW_MS).toISOString()
  const sessionCutoffIso = new Date(now - SESSION_WINDOW_MS).toISOString()

  let intelRows: IntelRow[] = []
  try {
    intelRows = getDb().prepare(
      `SELECT session_id, account_id, started_at, ended_at, total_tokens, total_cost_usd
       FROM session_intel
       WHERE ended_at > ? AND account_id IS NOT NULL`
    ).all(weeklyCutoffIso) as IntelRow[]
  } catch (err) {
    console.error('[session-manager] getAccountRouterStatus: session_intel query failed:', err)
  }

  // Backfill stale rows where total_tokens=0 but cost>0 — these are leftovers
  // from the old broken extractor. Re-parse the jsonl for the authoritative
  // value so the dashboard shows real tokens for legacy sessions too.
  for (const row of intelRows) {
    if (row.total_tokens === 0 && row.total_cost_usd > 0) {
      const usage = extractUsageForSessionId(row.session_id)
      if (usage.tokens > 0) row.total_tokens = usage.tokens
      // trust the recomputed cost when it's larger; the old extractor sometimes
      // captured only the last turn so persisted cost can also be too low
      if (usage.cost > row.total_cost_usd) row.total_cost_usd = usage.cost
    }
  }

  // Build a per-account view of live (in-memory) sessions
  type LiveEntry = { sessionId: string; tokens: number; cost: number; startedAtIso: string }
  const livePerAccount = new Map<string, LiveEntry[]>()
  for (const sessionId of activeSessions.keys()) {
    if (!isSessionActive(sessionId)) continue // ghost — getSessionState already cleaned it up
    const session = activeSessions.get(sessionId)
    if (!session?.accountId) continue
    const usage = extractFinalUsage(session.jsonlPath)
    const startedAtIso = new Date(session.startedAt).toISOString()
    const list = livePerAccount.get(session.accountId) || []
    list.push({ sessionId, tokens: usage.tokens, cost: usage.cost, startedAtIso })
    livePerAccount.set(session.accountId, list)
  }

  for (const account of status.accounts) {
    const live = livePerAccount.get(account.id) || []
    const liveIds = new Set(live.map(l => l.sessionId))

    // Intel rows for this account, excluding any session that is currently live
    // (live JSONL is more current than the latest intel snapshot).
    const intel = intelRows.filter(r => r.account_id === account.id && !liveIds.has(r.session_id))

    // ── Session window (5h) ──
    const swIntel = intel.filter(r => r.ended_at > sessionCutoffIso)
    const swLive = live.filter(l => l.startedAtIso > sessionCutoffIso)
    const swTokens =
      swIntel.reduce((s, r) => s + (r.total_tokens || 0), 0) +
      swLive.reduce((s, l) => s + l.tokens, 0)
    const swCost =
      swIntel.reduce((s, r) => s + (r.total_cost_usd || 0), 0) +
      swLive.reduce((s, l) => s + l.cost, 0)
    const swOldest = oldestIso([
      ...swIntel.map(r => r.ended_at),
      ...swLive.map(l => l.startedAtIso),
    ])
    const swResetsAt = swOldest ? new Date(new Date(swOldest).getTime() + SESSION_WINDOW_MS).toISOString() : null

    // ── Weekly window (7d) ──
    // intel is already pre-filtered to past 7 days at the SQL level
    const wTokens =
      intel.reduce((s, r) => s + (r.total_tokens || 0), 0) +
      live.reduce((s, l) => s + l.tokens, 0)
    const wCost =
      intel.reduce((s, r) => s + (r.total_cost_usd || 0), 0) +
      live.reduce((s, l) => s + l.cost, 0)
    const wOldest = oldestIso([
      ...intel.map(r => r.ended_at),
      ...live.map(l => l.startedAtIso),
    ])
    const wResetsAt = wOldest ? new Date(new Date(wOldest).getTime() + WEEKLY_WINDOW_MS).toISOString() : null

    // Override displayed fields with computed values. "Today" comes from the
    // per-day attribution table; the 5h/weekly windows stay rolling-from-now.
    const td = todayByAccount.get(account.id) ?? { cost: 0, tok: 0, sess: 0 }
    account.activeSessions = live.map(l => l.sessionId)
    account.sessionsToday = td.sess
    account.tokensToday = td.tok
    account.costToday = td.cost
    account.windows.sessionWindow = { tokens: swTokens, cost: swCost, resetsAt: swResetsAt }
    account.windows.weeklyWindow = { tokens: wTokens, cost: wCost, resetsAt: wResetsAt }
  }

  // ── Codex / Grok (flat-rate subscriptions) ────────────────────────────────
  // Not part of the Claude rotation. Upsert so a rename (which persists the
  // slot into router state) cannot duplicate the card, and so grok's
  // `available` flag uses grokAuthAvailable instead of Claude OAuth files.
  const upsertSub = (card: (typeof status.accounts)[number]) => {
    const i = status.accounts.findIndex(a => a.id === card.id)
    if (i >= 0) {
      const existing = status.accounts[i]
      status.accounts[i] = { ...existing, ...card, label: existing.label || card.label }
    } else {
      status.accounts.push(card)
    }
  }

  {
    const live = livePerAccount.get(CODEX_ACCOUNT_ID) || []
    const td = todayByAccount.get(CODEX_ACCOUNT_ID) ?? { cost: 0, tok: 0, sess: 0 }
    upsertSub({
      id: CODEX_ACCOUNT_ID,
      label: 'Codex (ChatGPT sub)',
      priority: 99,
      homeDir: CODEX_HOME_DIR,
      sessionsToday: td.sess,
      tokensToday: td.tok,
      costToday: 0,
      lastRateLimit: null,
      rateLimitResetsAt: null,
      activeSessions: live.map(l => l.sessionId),
      usageLog: [],
      available: codexAuthAvailable(),
      windows: {
        sessionWindow: { tokens: 0, cost: 0, resetsAt: null },
        weeklyWindow: { tokens: 0, cost: 0, resetsAt: null },
      },
    })
  }

  {
    const live = livePerAccount.get(GROK_ACCOUNT_ID) || []
    const td = todayByAccount.get(GROK_ACCOUNT_ID) ?? { cost: 0, tok: 0, sess: 0 }
    upsertSub({
      id: GROK_ACCOUNT_ID,
      label: 'Grok (xAI)',
      kind: 'grok',
      priority: 99,
      homeDir: GROK_HOME_DIR,
      sessionsToday: td.sess,
      tokensToday: td.tok,
      costToday: 0,
      lastRateLimit: null,
      rateLimitResetsAt: null,
      activeSessions: live.map(l => l.sessionId),
      usageLog: [],
      available: grokAuthAvailable(),
      windows: {
        sessionWindow: { tokens: 0, cost: 0, resetsAt: null },
        weeklyWindow: { tokens: 0, cost: 0, resetsAt: null },
      },
    })
  }

  return { ...status, untrackedToday: { cost: untracked.cost, tokens: untracked.tok, sessions: untracked.sess } }
}

function oldestIso(values: string[]): string | null {
  if (values.length === 0) return null
  let min = values[0]
  for (let i = 1; i < values.length; i++) {
    if (values[i] < min) min = values[i]
  }
  return min
}

// Initialize queue drain -- when an exhausted account recovers, auto-start queued objectives
// The drain callback needs access to the objectives routes to trigger a status change,
// so we expose a setter for the callback
let queueDrainCallback: ((objectiveId: number) => void) | null = null

export function setQueueDrainCallback(cb: (objectiveId: number) => void): void {
  queueDrainCallback = cb
  startQueueDrain((objectiveId) => {
    if (queueDrainCallback) {
      queueDrainCallback(objectiveId)
    }
  })
}
