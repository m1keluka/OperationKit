import fs from 'fs'
import path from 'path'

// ── Types ──

export interface UsageEvent {
  timestamp: string    // ISO
  tokens: number
  cost: number
  sessionId?: string   // Used to dedupe: a single session can have many recordSessionEnd calls
                       // (once per process exit during followup re-spawns); we replace the
                       // existing entry for that sessionId rather than appending a duplicate.
}

export type AccountKind = 'claude' | 'grok'

export interface AccountSlot {
  id: string               // 'a' | 'b' | 'c' | 'd' | 'e' | dynamically added
  label: string            // default human-readable name (from DEFAULT_ACCOUNTS)
  // Operator-set display name that overrides `label`. Persisted (NOT forced from
  // DEFAULT_ACCOUNTS on load) so a rename sticks. Effective label = customLabel || label.
  customLabel?: string | null
  kind?: AccountKind       // default 'claude' (rotation). 'grok' is a SuperGrok sub, not Claude rotation.
  priority: number         // lower = preferred. Accounts are filled in priority order;
                           // a higher number means "use this account last" (e.g. a personal
                           // account we want to avoid cooking until everything else is exhausted)
  homeDir: string          // HOME env for this account
  sessionsToday: number
  tokensToday: number
  costToday: number
  lastRateLimit: string | null   // ISO timestamp
  rateLimitResetsAt: string | null // ISO timestamp when limit resets
  // Set when the account's OAuth credential is dead (401: expired/revoked token,
  // invalid credentials). DISTINCT from a rate limit: a 401 is a CREDENTIAL
  // problem that never self-heals on a timer — the slot needs a re-login
  // (Reconnect), not a cooldown. Kept separate so it surfaces as "Reconnect
  // needed" instead of a fake 5h "Exhausted", and so pickAccount parks the slot
  // permanently (no re-bench loop) until it's re-authenticated. Optional so
  // existing persisted state / DEFAULT_ACCOUNTS need no migration.
  authFailedAt?: string | null   // ISO timestamp of the last 401 auth failure
  activeSessions: string[]       // session IDs currently using this account
  usageLog: UsageEvent[]         // timestamped usage for rolling window calculations
}

export interface QueuedSession {
  objectiveId: number
  queuedAt: string
}

export interface RouterState {
  accounts: AccountSlot[]
  queue: QueuedSession[]
  lastResetDate: string    // YYYY-MM-DD, resets daily counters
}

// ── Constants ──

const STATE_FILE = '/home/operator/transcripts/account-router-state.json'
const RATE_LIMIT_LOG = '/home/operator/transcripts/rate-limit-history.jsonl'
const ACCOUNT_HOME_BASE = '/home/ccuser'

// Default rate limit reset window (5 hours from when limit was hit)
const DEFAULT_RESET_HOURS = 5

// Rolling window durations (matching Claude's plan usage display)
const SESSION_WINDOW_MS = 5 * 60 * 60 * 1000   // 5 hours
const WEEKLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

const DEFAULT_ACCOUNTS: AccountSlot[] = [
  // priority 10 = personal account (dev@example.com, also used in the Claude app).
  // Deprioritized so it is only picked when every other account is rate-limited.
  { id: 'a', label: 'Primary (personal)', priority: 10, homeDir: `${ACCOUNT_HOME_BASE}-a`, sessionsToday: 0, tokensToday: 0, costToday: 0, lastRateLimit: null, rateLimitResetsAt: null, activeSessions: [], usageLog: [] },
  { id: 'b', label: 'Secondary', priority: 0, homeDir: `${ACCOUNT_HOME_BASE}-b`, sessionsToday: 0, tokensToday: 0, costToday: 0, lastRateLimit: null, rateLimitResetsAt: null, activeSessions: [], usageLog: [] },
  { id: 'c', label: 'Tertiary', priority: 0, homeDir: `${ACCOUNT_HOME_BASE}-c`, sessionsToday: 0, tokensToday: 0, costToday: 0, lastRateLimit: null, rateLimitResetsAt: null, activeSessions: [], usageLog: [] },
  { id: 'd', label: 'Quaternary', priority: 0, homeDir: `${ACCOUNT_HOME_BASE}-d`, sessionsToday: 0, tokensToday: 0, costToday: 0, lastRateLimit: null, rateLimitResetsAt: null, activeSessions: [], usageLog: [] },
  { id: 'e', label: 'Quinary (Pro Max)', priority: 0, homeDir: `${ACCOUNT_HOME_BASE}-e`, sessionsToday: 0, tokensToday: 0, costToday: 0, lastRateLimit: null, rateLimitResetsAt: null, activeSessions: [], usageLog: [] },
  // Dynamic slots live under the already-mounted /app/data (host:
  // /home/operator/data/command-center/cc-accounts/<slot>), so adding more needs no
  // compose volume and no container recreate. f, g added 2026-06-21.
  { id: 'f', label: 'Senary (Pro Max)', priority: 0, homeDir: '/app/data/cc-accounts/f', sessionsToday: 0, tokensToday: 0, costToday: 0, lastRateLimit: null, rateLimitResetsAt: null, activeSessions: [], usageLog: [] },
  { id: 'g', label: 'Septenary (Pro Max)', priority: 0, homeDir: '/app/data/cc-accounts/g', sessionsToday: 0, tokensToday: 0, costToday: 0, lastRateLimit: null, rateLimitResetsAt: null, activeSessions: [], usageLog: [] },
]

const DYNAMIC_HOME_ROOT = '/app/data/cc-accounts'
const RESERVED_IDS = new Set(['codex', 'grok'])

export function isClaudeRotationSlot(account: AccountSlot): boolean {
  return account.id !== 'codex' && account.id !== 'grok' && account.kind !== 'grok'
}

/**
 * Merge persisted router state onto the built-in slots without wiping names.
 * - Defaults provide id/priority/homeDir for known slots.
 * - customLabel always wins (and a saved.label that drifted off the default
 *   is promoted to customLabel — that is how pre-customLabel renames survive).
 * - Slots that exist only in the save (Add Account) are kept.
 */
export function mergeAccountRecords(defaults: AccountSlot[], saved: AccountSlot[]): AccountSlot[] {
  const savedById = new Map(saved.map(a => [a.id, a]))
  const merged: AccountSlot[] = defaults.map(def => {
    const s = savedById.get(def.id)
    if (!s) return { ...def }
    const custom =
      (s.customLabel && s.customLabel.trim()) ||
      (s.label && s.label !== def.label ? s.label : null) ||
      null
    return {
      ...def,
      ...s,
      label: def.label,
      customLabel: custom,
      priority: def.priority,
      homeDir: def.homeDir,
      usageLog: s.usageLog || [],
    }
  })
  const defaultIds = new Set(defaults.map(d => d.id))
  for (const s of saved) {
    if (defaultIds.has(s.id)) continue
    merged.push({
      ...emptySlot(s.id, s.kind || 'claude', s.homeDir || `${DYNAMIC_HOME_ROOT}/${s.id}`),
      ...s,
      customLabel: s.customLabel || s.label || null,
      usageLog: s.usageLog || [],
    })
  }
  return merged
}

function emptySlot(id: string, kind: AccountKind, homeDir: string): AccountSlot {
  return {
    id,
    label: id === 'grok' ? 'Grok (xAI)' : id === 'codex' ? 'Codex (ChatGPT sub)' : kind === 'grok' ? `Grok ${id}` : `Account ${id.toUpperCase()}`,
    kind,
    priority: kind === 'grok' ? 99 : 0,
    homeDir,
    sessionsToday: 0,
    tokensToday: 0,
    costToday: 0,
    lastRateLimit: null,
    rateLimitResetsAt: null,
    activeSessions: [],
    usageLog: [],
  }
}

function ensureAccountHome(homeDir: string): void {
  try { fs.mkdirSync(homeDir, { recursive: true, mode: 0o755 }) } catch { /* spawn fails loudly if unwritable */ }
  try { fs.chmodSync(homeDir, 0o777) } catch { /* ccuser needs to write .claude / .grok */ }
}

function nextSlotId(existing: AccountSlot[]): string {
  const used = new Set(existing.map(a => a.id).concat([...RESERVED_IDS]))
  const letters = 'abcdefghijklmnopqrstuvwxyz'
  for (const c of letters) {
    if (!used.has(c)) return c
  }
  for (let i = 0; i < 26; i++) {
    for (const c of letters) {
      const id = `${letters[i]}${c}`
      if (!used.has(id)) return id
    }
  }
  return `s${Date.now().toString(36)}`
}

/** Operator: add a Claude (or Grok) subscription slot. Home dir is created under /app/data. */
export function addAccountSlot(opts: { label?: string; kind?: AccountKind } = {}): AccountSlot {
  loadState()
  const kind = opts.kind === 'grok' ? 'grok' : 'claude'
  const name = (opts.label || '').trim().slice(0, 60)
  // Grok is a single SuperGrok subscription engine, not a Claude rotation letter.
  // Adding "Grok" upserts the canonical slot so we never mint unused homes
  // that spawn would ignore (spawn always uses GROK_HOME_DIR / id `grok`).
  if (kind === 'grok') {
    let slot = state.accounts.find(a => a.id === 'grok')
    if (!slot) {
      const homeDir = '/app/data/cc-accounts/grok'
      ensureAccountHome(homeDir)
      slot = emptySlot('grok', 'grok', homeDir)
      state.accounts.push(slot)
    }
    if (name) slot.customLabel = name
    saveState()
    return slot
  }
  const id = nextSlotId(state.accounts)
  const homeDir = `${DYNAMIC_HOME_ROOT}/${id}`
  ensureAccountHome(homeDir)
  const slot = emptySlot(id, kind, homeDir)
  if (name) slot.customLabel = name
  state.accounts.push(slot)
  saveState()
  return slot
}

// ── State Management ──

let state: RouterState = {
  accounts: JSON.parse(JSON.stringify(DEFAULT_ACCOUNTS)),
  queue: [],
  lastResetDate: todayStr(),
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10)
}

/** Prune usage log entries older than 7 days */
function pruneUsageLog(account: AccountSlot): void {
  const cutoff = Date.now() - WEEKLY_WINDOW_MS
  account.usageLog = (account.usageLog || []).filter(
    e => new Date(e.timestamp).getTime() > cutoff
  )
}

function loadState(): void {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf-8')
      const loaded = JSON.parse(raw) as RouterState

      // Merge loaded accounts with defaults (in case new accounts were added).
      // Static config fields (priority, homeDir) come from DEFAULT_ACCOUNTS so
      // code re-points take effect. Display names do NOT — operator renames live
      // in customLabel and must survive reload (they used to get wiped because
      // `label` was forced back to Primary/Secondary/…). Extra slots created via
      // "New account" are appended after the defaults.
      state.accounts = mergeAccountRecords(DEFAULT_ACCOUNTS, loaded.accounts || [])
      state.queue = loaded.queue || []
      state.lastResetDate = loaded.lastResetDate || todayStr()
    }
  } catch (err) {
    console.error('[account-router] Failed to load state, using defaults:', err)
  }

  // Reset daily counters if new day
  if (state.lastResetDate !== todayStr()) {
    console.log(`[account-router] New day detected (${state.lastResetDate} -> ${todayStr()}), resetting daily counters`)
    for (const account of state.accounts) {
      account.sessionsToday = 0
      account.tokensToday = 0
      account.costToday = 0
      // Clear rate limits that have expired
      if (account.rateLimitResetsAt && new Date(account.rateLimitResetsAt) < new Date()) {
        account.lastRateLimit = null
        account.rateLimitResetsAt = null
      }
    }
    state.lastResetDate = todayStr()
  }

  // Prune old usage logs
  for (const account of state.accounts) {
    pruneUsageLog(account)
  }

  saveState()
}

function saveState(): void {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
  } catch (err) {
    console.error('[account-router] Failed to save state:', err)
  }
}

// ── Rolling Window Calculations ──

function getUsageInWindow(account: AccountSlot, windowMs: number): { tokens: number; cost: number; oldestEvent: string | null } {
  const cutoff = Date.now() - windowMs
  const events = (account.usageLog || []).filter(e => new Date(e.timestamp).getTime() > cutoff)
  const tokens = events.reduce((sum, e) => sum + e.tokens, 0)
  const cost = events.reduce((sum, e) => sum + e.cost, 0)
  const oldestEvent = events.length > 0 ? events[0].timestamp : null
  return { tokens, cost, oldestEvent }
}

/** Compute when the rolling window resets (when the oldest event in the window falls off) */
function getWindowResetTime(account: AccountSlot, windowMs: number): string | null {
  const cutoff = Date.now() - windowMs
  const events = (account.usageLog || []).filter(e => new Date(e.timestamp).getTime() > cutoff)
  if (events.length === 0) return null
  // The window "resets" (decreases) when the oldest event ages out
  const oldest = events.reduce((min, e) => {
    const t = new Date(e.timestamp).getTime()
    return t < min ? t : min
  }, Infinity)
  return new Date(oldest + windowMs).toISOString()
}

// ── Account Selection ──

/**
 * The Claude CLI refreshes an expired access token transparently *only if* a
 * refresh token is present. When the access token is expired AND there is no
 * refresh token, every request dies with `401 Invalid authentication
 * credentials` and there is no way to recover without an interactive re-login.
 * Such an account must leave the rotation until it is re-authenticated.
 *
 * This was the obj 913 crash-loop: slot c's access token expired with no refresh
 * token, but isAccountAvailable only checked that the creds *file existed*, so c
 * stayed "available", kept getting picked, and the objective's pinned
 * `--resume` re-targeted c on every retry → instant 401, 0 tools, repeat.
 *
 * Permissive on uncertainty: an unparseable file or a missing expiresAt returns
 * true so a parse hiccup never benches a genuinely working account — we only
 * return false when we can positively prove the token is expired-and-unrefreshable.
 */
export function isOAuthTokenUsable(credentialsRaw: string, now = Date.now()): boolean {
  try {
    const parsed = JSON.parse(credentialsRaw)
    const oauth = parsed.claudeAiOauth || parsed
    const expiresAt = typeof oauth.expiresAt === 'number' ? oauth.expiresAt : null
    if (expiresAt === null) return true // unknown shape — don't block
    if (expiresAt > now) return true    // access token still valid
    // Expired: usable only if a refresh token can mint a new one.
    return typeof oauth.refreshToken === 'string' && oauth.refreshToken.length > 0
  } catch {
    return true // unparseable — let the spawn decide rather than false-bench
  }
}

function isAccountAvailable(account: AccountSlot): boolean {
  // Dead credential (401): parked until a re-login clears it. A cooldown timer
  // can't fix an expired/revoked token, so — unlike a rate limit — this does not
  // auto-expire. clearAuthFailure() (on a successful OAuth probe / reconnect)
  // is the only way back into rotation. Prevents the re-bench loop where a slot
  // with a dead token gets picked, 401s, benches, clears, gets re-picked…
  if (account.authFailedAt) {
    return false
  }

  // Check if rate limit has expired
  if (account.rateLimitResetsAt) {
    if (new Date(account.rateLimitResetsAt) > new Date()) {
      return false // still rate limited
    }
    // Rate limit expired, clear it
    account.lastRateLimit = null
    account.rateLimitResetsAt = null
  }

  // Codex / Grok are not Claude OAuth slots. The dashboard overlays their
  // real auth (codexAuthAvailable / grokAuthAvailable). Don't require
  // ~/.claude/.credentials.json or they always look dead, and a grok
  // follow-up would rotate onto a Claude account.
  if (!isClaudeRotationSlot(account)) {
    return true
  }

  // Check if the account home dir exists and has claude auth
  const claudeJson = path.join(account.homeDir, '.claude', '.credentials.json')
  let credentialsRaw: string
  try {
    credentialsRaw = fs.readFileSync(claudeJson, 'utf-8')
  } catch {
    return false // account not set up
  }

  // Expired OAuth token with no refresh token cannot authenticate — keep it out
  // of rotation until re-auth (see isOAuthTokenUsable).
  if (!isOAuthTokenUsable(credentialsRaw)) {
    return false
  }

  return true
}

/**
 * Pick the best available account for a new session.
 * Strategy: among available accounts, pick the one with the fewest active sessions,
 * breaking ties by fewest sessions today.
 * Returns null if all accounts are exhausted.
 */
export function pickAccount(): AccountSlot | null {
  // Ensure state is fresh
  loadState()

  const available = state.accounts.filter(a => isClaudeRotationSlot(a) && isAccountAvailable(a))

  if (available.length === 0) {
    return null
  }

  // Sort by: lowest priority number first (so a high-priority-number account like the
  // personal one is only reached when all lower-number accounts are unavailable), then
  // fewest active sessions, then fewest sessions today, then fewest tokens.
  available.sort((a, b) => {
    const pa = a.priority ?? 0
    const pb = b.priority ?? 0
    if (pa !== pb) {
      return pa - pb
    }
    if (a.activeSessions.length !== b.activeSessions.length) {
      return a.activeSessions.length - b.activeSessions.length
    }
    if (a.sessionsToday !== b.sessionsToday) {
      return a.sessionsToday - b.sessionsToday
    }
    return a.tokensToday - b.tokensToday
  })

  return available[0]
}

/**
 * Get the earliest time any exhausted account will become available again.
 * Returns null if no accounts are rate-limited (meaning none are set up).
 */
export function getEarliestResetTime(): Date | null {
  const rateLimited = state.accounts.filter(a => isClaudeRotationSlot(a) && a.rateLimitResetsAt)
  if (rateLimited.length === 0) return null

  const times = rateLimited.map(a => new Date(a.rateLimitResetsAt!).getTime())
  return new Date(Math.min(...times))
}

// ── Event Recording ──

export function recordSessionStart(accountId: string, sessionId: string): void {
  const account = state.accounts.find(a => a.id === accountId)
  if (!account) return

  // Idempotent: a single session triggers recordSessionStart multiple times
  // (initial spawn + every followup re-spawn). Only count it once per day.
  const isNewlyTracked = !account.activeSessions.includes(sessionId)
  if (isNewlyTracked) {
    account.activeSessions.push(sessionId)
  }
  // Count toward sessionsToday only if no usageLog row already attributes this
  // session_id to this account today.
  const today = todayStr()
  const alreadyCountedToday = (account.usageLog || []).some(
    e => e.sessionId === sessionId && e.timestamp.slice(0, 10) === today
  )
  if (isNewlyTracked && !alreadyCountedToday) {
    account.sessionsToday++
  }
  saveState()
  console.log(`[account-router] Session ${sessionId} started on account ${accountId} (${account.label}). Active: ${account.activeSessions.length}, Today: ${account.sessionsToday}`)
}

export function recordSessionEnd(accountId: string, sessionId: string, tokensUsed?: number, costUsd?: number): void {
  const account = state.accounts.find(a => a.id === accountId)
  if (!account) return

  account.activeSessions = account.activeSessions.filter(s => s !== sessionId)

  const tokens = tokensUsed || 0
  const cost = costUsd || 0

  if (tokens > 0 || cost > 0) {
    if (!account.usageLog) account.usageLog = []
    // Idempotent: extractFinalUsage returns the cumulative JSONL total. On every
    // followup re-spawn this function fires again with a larger total. Replace
    // the existing row for this session rather than appending a duplicate, and
    // add only the delta to tokensToday/costToday.
    const existingIdx = account.usageLog.findIndex(e => e.sessionId === sessionId)
    if (existingIdx >= 0) {
      const prior = account.usageLog[existingIdx]
      const tokenDelta = Math.max(0, tokens - prior.tokens)
      const costDelta = Math.max(0, cost - prior.cost)
      account.tokensToday += tokenDelta
      account.costToday += costDelta
      account.usageLog[existingIdx] = {
        timestamp: new Date().toISOString(),
        tokens,
        cost,
        sessionId,
      }
    } else {
      account.tokensToday += tokens
      account.costToday += cost
      account.usageLog.push({
        timestamp: new Date().toISOString(),
        tokens,
        cost,
        sessionId,
      })
    }
  }

  saveState()
  console.log(`[account-router] Session ${sessionId} ended on account ${accountId}. Active: ${account.activeSessions.length}, Tokens today: ${account.tokensToday}`)
}

export interface RateLimitEvent {
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

function appendRateLimitHistory(event: RateLimitEvent): void {
  try {
    fs.mkdirSync(path.dirname(RATE_LIMIT_LOG), { recursive: true })
    fs.appendFileSync(RATE_LIMIT_LOG, JSON.stringify(event) + '\n')
  } catch (err) {
    console.error('[account-router] Failed to write rate limit history:', err)
  }
}

export function getRateLimitHistory(limit = 50): RateLimitEvent[] {
  try {
    if (!fs.existsSync(RATE_LIMIT_LOG)) return []
    const lines = fs.readFileSync(RATE_LIMIT_LOG, 'utf-8').trim().split('\n').filter(Boolean)
    // Return most recent first
    return lines.slice(-limit).reverse().map(line => JSON.parse(line))
  } catch {
    return []
  }
}

export function recordRateLimit(accountId: string, resetTime?: Date, triggerMessage?: string): void {
  const account = state.accounts.find(a => a.id === accountId)
  if (!account) return

  const now = new Date()
  let resetAt = resetTime || new Date(now.getTime() + DEFAULT_RESET_HOURS * 60 * 60 * 1000)
  // Never push recovery LATER than an already-known future reset. A weak signal
  // (the 5h fallback, or a mis-parsed text message) must not clobber a sooner,
  // more accurate reset that an earlier structured rate_limit_event recorded —
  // that was the bug benching working accounts for hours past their real reset
  // (e.g. session-limit "resets 6:40pm" fell back to now+5h and overwrote the
  // correct 18:40Z). Keep the earliest known future reset.
  const existing = account.rateLimitResetsAt ? new Date(account.rateLimitResetsAt) : null
  if (existing && existing.getTime() > now.getTime() && existing.getTime() < resetAt.getTime()) {
    resetAt = existing
  }
  account.lastRateLimit = now.toISOString()
  account.rateLimitResetsAt = resetAt.toISOString()
  saveState()

  // Append to persistent history
  appendRateLimitHistory({
    timestamp: now.toISOString(),
    accountId,
    label: account.label,
    tokensAtLimit: account.tokensToday,
    sessionsAtLimit: account.sessionsToday,
    costAtLimit: account.costToday,
    activeSessions: account.activeSessions.length,
    resetTime: resetAt.toISOString(),
    triggerMessage: triggerMessage?.slice(0, 500),
  })

  console.log(`[account-router] Account ${accountId} (${account.label}) hit rate limit at ${account.tokensToday} tokens, ${account.sessionsToday} sessions. Resets at ${account.rateLimitResetsAt}`)
}

/**
 * Clear a stale rate-limit flag because the account just proved it is serving
 * traffic. Rate-limit tracking was one-directional — set on a weak signal,
 * cleared only when the timer expired — so an account that recovered (or was
 * benched on a transient blip while a sibling session ran fine) stayed "dead"
 * on paper, shrinking the usable pool and queuing objectives that could run.
 * A completed turn with real token usage is hard proof the account is live, so
 * we drop the flag and let it back into rotation immediately. If it is in fact
 * still limited, the very next pick re-benches it on the first rejection — the
 * tracking is now self-correcting rather than pessimistic.
 */
export function clearRateLimit(accountId: string): void {
  const account = state.accounts.find(a => a.id === accountId)
  if (!account || !account.rateLimitResetsAt) return
  console.log(`[account-router] Clearing rate-limit on ${accountId} (${account.label}) — account served a successful turn (was resetting ${account.rateLimitResetsAt})`)
  account.lastRateLimit = null
  account.rateLimitResetsAt = null
  saveState()
}

/**
 * Admin: force-clear a stale rate-limit bench on an account, unconditionally.
 *
 * Unlike clearRateLimit (which is a no-op when no bench is set and is meant to
 * fire automatically after a successful turn), this is the operator escape hatch
 * for a *false* bench — e.g. a rate_limit_event misattributed from another
 * account during auto-resume rotation benched a healthy slot, and there is no
 * live session on it to trigger the automatic clear.
 *
 * Operates on the in-memory `state` (then persists) so the clear sticks: the
 * state file is rewritten ~every poll by loadState→saveState, so a hand-edit of
 * the JSON can be clobbered, but a mutation of the shared in-memory object is
 * authoritative. Returns the account (for the caller to report) or null if the
 * id is unknown.
 */
export function forceClearRateLimit(accountId: string): AccountSlot | null {
  loadState()
  const account = state.accounts.find(a => a.id === accountId)
  if (!account) return null
  const had = account.rateLimitResetsAt
  account.lastRateLimit = null
  account.rateLimitResetsAt = null
  saveState()
  console.log(`[account-router] Admin cleared bench on ${accountId} (${account.label}) — was resetting ${had ?? '(none)'}`)
  return account
}

/**
 * @deprecated Renamed to {@link forceClearRateLimit} (pairs with `clearRateLimit`
 * and matches the operator escape-hatch naming). Retained as a thin alias so any
 * in-flight branch still importing the old name keeps compiling. Prefer
 * `forceClearRateLimit` in new code.
 */
export const clearAccountBench = forceClearRateLimit

/**
 * Mark an account's OAuth credential as dead (401 auth failure). This is the
 * auth-failure counterpart to recordRateLimit: a 401 means expired/revoked
 * token or invalid credentials, which a cooldown timer can never fix — the slot
 * needs a re-login. We therefore set `authFailedAt` (which isAccountAvailable
 * parks on permanently) and CLEAR any rate-limit flag so the dashboard shows a
 * truthful "Reconnect needed" state rather than a bogus 5h "Exhausted". Keeps an
 * audit trail in rate-limit-history so the event is still visible to operators.
 */
export function recordAuthFailure(accountId: string, triggerMessage?: string): void {
  loadState()
  const account = state.accounts.find(a => a.id === accountId)
  if (!account) return
  const now = new Date()
  account.authFailedAt = now.toISOString()
  account.lastRateLimit = null
  account.rateLimitResetsAt = null
  saveState()
  appendRateLimitHistory({
    timestamp: now.toISOString(),
    accountId,
    label: account.label,
    tokensAtLimit: account.tokensToday,
    sessionsAtLimit: account.sessionsToday,
    costAtLimit: account.costToday,
    activeSessions: account.activeSessions.length,
    resetTime: now.toISOString(),
    triggerMessage: `[auth-failure] ${(triggerMessage || '').slice(0, 460)}`,
  })
  console.log(`[account-router] Account ${accountId} (${account.label}) AUTH FAILURE — parked as "reconnect needed" (credential dead, re-login required). Trigger: ${(triggerMessage || '').slice(0, 120)}`)
}

/**
 * Clear an account's auth-failure flag — called after a successful OAuth probe
 * (admin recheck) or reconnect proves the credential is live again. Returns the
 * account (for the caller to report) or null if unknown / not flagged.
 */
export function clearAuthFailure(accountId: string): AccountSlot | null {
  loadState()
  const account = state.accounts.find(a => a.id === accountId)
  if (!account) return null
  if (!account.authFailedAt) return account
  console.log(`[account-router] Cleared auth-failure on ${accountId} (${account.label}) — credential re-authenticated`)
  account.authFailedAt = null
  saveState()
  return account
}

// ── Queue Management ──

export function enqueueSession(objectiveId: number): void {
  if (!state.queue.find(q => q.objectiveId === objectiveId)) {
    state.queue.push({ objectiveId, queuedAt: new Date().toISOString() })
    saveState()
    console.log(`[account-router] Objective ${objectiveId} queued. Queue depth: ${state.queue.length}`)
  }
}

export function dequeueSession(): QueuedSession | null {
  if (state.queue.length === 0) return null
  const next = state.queue.shift()!
  saveState()
  return next
}

export function getQueueDepth(): number {
  return state.queue.length
}

// ── Rate Limit Detection ──

// Patterns that indicate rate limiting in stderr or stream-json
const RATE_LIMIT_PATTERNS = [
  /you[''\u2019]ve hit your limit/i,
  // "hit your session limit", "hit your weekly limit", "hit your daily limit".
  // The optional qualifier word(s) between "your" and "limit" are why the bare
  // /hit your limit/ pattern missed these — a recheck probe on a genuinely
  // rate-limited account then couldn't classify it (fell through to
  // "inconclusive", or on a fast response FALSELY cleared the bench).
  /hit your (?:[\w''\u2019]+ )*limit/i,
  /usage limit/i,
  /rate.?limit/i,
  /too many requests/i,
  /quota exceeded/i,
  // Monthly / org spend-cap exits: "You've hit your (org's) monthly spend limit
  // - raise it at claude.ai/admin-settings/usage". Neither /usage limit/ (the
  // word "usage" only appears inside the URL path) nor /you've hit your limit/
  // ("monthly spend" breaks the literal sequence) matched this, so a spend-capped
  // account was never cooled down and a resume could re-pick it. (obj 337)
  /spend limit/i,
  /admin-settings\/usage/i,
]

/**
 * Check if a text string indicates a rate limit.
 * Call this on stderr output and on stream-json error events.
 */
export function isRateLimitMessage(text: string): boolean {
  return RATE_LIMIT_PATTERNS.some(pattern => pattern.test(text))
}

// Monthly / org spend cap — a strict subset of the rate-limit messages above.
// Unlike a session/usage/weekly rate limit, a spend cap does NOT recover in
// hours: it clears only when an admin raises the cap or the billing month
// rolls over. Retrying it (rotation across the org pool, or a 5h drain
// re-resume) can therefore never succeed and just loops every ~5h forever.
const SPEND_CAP_PATTERNS = [
  /monthly spend limit/i,
  /admin-settings\/usage/i,
]

/**
 * True when an exit message is a monthly/org spend cap rather than a recoverable
 * rate limit. The caller must PARK the objective for human/admin action (raise
 * the cap) instead of auto-rotating or enqueuing for the drain timer — siblings
 * share the org cap, so rotation re-hits it instantly and the drain re-resume
 * re-hits it ~5h later, ad infinitum.
 */
export function isSpendCapMessage(text: string): boolean {
  return SPEND_CAP_PATTERNS.some(pattern => pattern.test(text))
}

/**
 * Detect an Anthropic API authentication failure (HTTP 401) in an errored
 * result/error event's text. The CLI emits
 * "Failed to authenticate. API Error: 401 Invalid authentication credentials"
 * (and the raw stream carries `error: "authentication_failed"`) when the
 * account's credential is expired/rotated. Unlike a 429 this is a CREDENTIAL
 * problem, not a quota problem — see the 401 branch in
 * session-manager.handleSessionDeath for why we bench the account on it.
 *
 * Kept narrow on purpose: only the auth-failure wire phrases, never the bare
 * word "authentication" (which appears in normal output), so it can't false-
 * positive on assistant text. The primary signal is `api_error_status === 401`;
 * this text match is the fallback for events that carry the message but not the
 * structured status.
 */
export function isAuthFailureMessage(text: string): boolean {
  return /invalid authentication credentials|authentication_failed/i.test(text)
}

/**
 * Parse reset time from rate limit messages if available.
 * Claude sometimes includes "resets at HH:MM" or "try again in X hours".
 *
 * The clock branch must handle the real wire format the CLI emits on a
 * session-limit exit: "You've hit your session limit · resets 6:40pm (UTC)".
 * The previous regex required the literal word "at" ("resets AT 6:40pm"), so
 * this never matched — every session-limit message fell through to the 5h
 * fallback in recordRateLimit and benched a working account for hours longer
 * than its real reset. We now accept an optional "at", a bare hour ("6pm"),
 * 12h or 24h clocks, and honor an explicit "(UTC)" marker so the parse is
 * timezone-correct regardless of the container's local TZ.
 */
export function parseResetTime(text: string): Date | null {
  // "resets at 2:00 PM", "resets 6:40pm (UTC)", "resets 6pm", "resets at 14:00"
  const clock = text.match(/resets?(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i)
  if (clock) {
    let hour = parseInt(clock[1], 10)
    const minute = clock[2] ? parseInt(clock[2], 10) : 0
    const ampm = clock[3]?.toLowerCase()
    if (ampm === 'pm' && hour < 12) hour += 12
    if (ampm === 'am' && hour === 12) hour = 0
    const now = new Date()
    const useUtc = /utc/i.test(text)
    let parsed = useUtc
      ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute, 0, 0))
      : new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0)
    // If the parsed time is already past, it refers to the next occurrence (tomorrow).
    if (parsed.getTime() <= now.getTime()) {
      parsed = new Date(parsed.getTime() + 24 * 60 * 60 * 1000)
    }
    return parsed
  }

  // "try again in X hours"
  const hoursMatch = text.match(/try again in\s+(\d+)\s*hours?/i)
  if (hoursMatch) {
    return new Date(Date.now() + parseInt(hoursMatch[1]) * 60 * 60 * 1000)
  }

  // "try again in X minutes"
  const minutesMatch = text.match(/try again in\s+(\d+)\s*minutes?/i)
  if (minutesMatch) {
    return new Date(Date.now() + parseInt(minutesMatch[1]) * 60 * 1000)
  }

  return null
}

// ── Status / Diagnostics ──

export interface AccountWindowUsage {
  sessionWindow: { tokens: number; cost: number; resetsAt: string | null }
  weeklyWindow: { tokens: number; cost: number; resetsAt: string | null }
}

export function getRouterStatus(): {
  accounts: Array<AccountSlot & { available: boolean; windows: AccountWindowUsage }>
  queue: QueuedSession[]
  earliestReset: string | null
} {
  loadState()
  return {
    accounts: state.accounts.map(a => ({
      ...a,
      label: a.customLabel || a.label, // effective display name (operator override wins)
      usageLog: [], // don't send full log to client
      available: isAccountAvailable(a),
      windows: {
        sessionWindow: {
          ...getUsageInWindow(a, SESSION_WINDOW_MS),
          resetsAt: getWindowResetTime(a, SESSION_WINDOW_MS),
        },
        weeklyWindow: {
          ...getUsageInWindow(a, WEEKLY_WINDOW_MS),
          resetsAt: getWindowResetTime(a, WEEKLY_WINDOW_MS),
        },
      },
    })),
    queue: state.queue,
    earliestReset: getEarliestResetTime()?.toISOString() || null,
  }
}

/**
 * Find which account a session is running on.
 */
export function getAccountForSession(sessionId: string): AccountSlot | null {
  return state.accounts.find(a => a.activeSessions.includes(sessionId)) || null
}

/**
 * Look up a single account slot by id (for admin recheck/reconnect flows that
 * need the slot's homeDir to spawn a probe or login as the right ccuser HOME).
 * Reads through loadState so a caller sees the current merged config (homeDir is
 * authoritative from DEFAULT_ACCOUNTS). Returns null for an unknown id.
 */
export function getAccountById(accountId: string): AccountSlot | null {
  loadState()
  return state.accounts.find(a => a.id === accountId) || null
}

/**
 * Set (or clear) an operator display name for a slot. Persists as `customLabel`,
 * which loadState preserves and getRouterStatus surfaces as the effective label.
 * Passing an empty string clears the override (reverts to the DEFAULT_ACCOUNTS
 * label). Returns the account or null for an unknown id.
 */
export function setAccountLabel(accountId: string, label: string): AccountSlot | null {
  loadState()
  let account = state.accounts.find(a => a.id === accountId)
  if (!account) {
    if (accountId === 'grok' || accountId === 'codex') {
      account = emptySlot(accountId, accountId === 'grok' ? 'grok' : 'claude', accountId === 'grok' ? '/app/data/cc-accounts/grok' : '/home/ccuser-codex')
      state.accounts.push(account)
    } else {
      return null
    }
  }
  const trimmed = label.trim().slice(0, 60)
  account.customLabel = trimmed.length > 0 ? trimmed : null
  saveState()
  return account
}

// ── Queue Drain Timer ──
// Periodically check if a rate-limited account has recovered and drain queued sessions

let drainTimer: ReturnType<typeof setInterval> | null = null

export type DrainCallback = (objectiveId: number) => void

export function startQueueDrain(onReady: DrainCallback): void {
  if (drainTimer) return

  drainTimer = setInterval(() => {
    if (state.queue.length === 0) return

    // Fan out: release up to one queued objective per currently-available account
    // each tick, instead of a single objective total. The old 1-per-30s drain
    // serialized recovery — a 12-deep backlog took 6 minutes just to *start* even
    // when all 5 accounts had freed up at once, fighting "everything in parallel".
    // onReady → startSession re-picks the account itself and re-enqueues if the
    // pool fills, so a batch can never exceed real capacity; it just stops the
    // dribble. Sizing the batch to available-account count avoids a thundering
    // herd that would instantly re-cook the pool.
    const availableCount = state.accounts.filter(a => isClaudeRotationSlot(a) && isAccountAvailable(a)).length
    if (availableCount === 0) return // still all exhausted

    let released = 0
    while (state.queue.length > 0 && released < availableCount) {
      const queued = dequeueSession()
      if (!queued) break
      console.log(`[account-router] Draining queue: objective ${queued.objectiveId} (${released + 1}/${availableCount} this tick, ${state.queue.length} remaining)`)
      onReady(queued.objectiveId)
      released++
    }
  }, 30_000) // check every 30s

  console.log('[account-router] Queue drain timer started')
}

export function stopQueueDrain(): void {
  if (drainTimer) {
    clearInterval(drainTimer)
    drainTimer = null
  }
}

// ── Reconciliation ──

/**
 * The container restart wipes the in-memory `activeSessions` Map in session-manager,
 * but the persisted `account.activeSessions[]` survives — so after a restart it is
 * full of session IDs whose underlying processes are gone. Clear them at startup;
 * new sessions populate the list via `recordSessionStart`.
 *
 * Safe to call only at module init / server startup, before any session can run.
 */
export function clearStaleActiveSessions(): void {
  let cleared = 0
  for (const account of state.accounts) {
    cleared += account.activeSessions.length
    account.activeSessions = []
  }
  if (cleared > 0) {
    saveState()
    console.log(`[account-router] Cleared ${cleared} stale activeSessions entries from persisted state`)
  }
}

/**
 * Reconcile each account's tokensToday / costToday / usageLog from the canonical
 * record (jsonl transcripts, mapped to accounts via session_intel). Used at server
 * startup so that the dashboard reflects historical work even when a previous
 * version of `extractFinalUsage` recorded zero tokens.
 *
 * `extractUsage` is injected by the caller (session-manager re-parses the jsonl
 * with current field paths) — keeps account-router free of session-manager imports.
 */
export function reconcileFromHistory(
  intelRows: Array<{ session_id: string; account_id: string | null; ended_at: string }>,
  extractUsage: (sessionId: string) => { tokens: number; cost: number },
): void {
  const today = todayStr()
  const weekCutoff = Date.now() - WEEKLY_WINDOW_MS

  for (const account of state.accounts) {
    account.usageLog = []
    account.tokensToday = 0
    account.costToday = 0
  }

  // Sessions today also count toward sessionsToday.
  const sessionsTodayCount = new Map<string, number>()

  for (const row of intelRows) {
    if (!row.account_id) continue
    const account = state.accounts.find(a => a.id === row.account_id)
    if (!account) continue

    const endedMs = new Date(row.ended_at).getTime()
    if (Number.isNaN(endedMs)) continue

    const isToday = row.ended_at.slice(0, 10) === today
    const inWeek = endedMs > weekCutoff

    if (isToday) {
      sessionsTodayCount.set(row.account_id, (sessionsTodayCount.get(row.account_id) || 0) + 1)
    }

    if (!inWeek && !isToday) continue

    const { tokens, cost } = extractUsage(row.session_id)
    if (tokens === 0 && cost === 0) continue

    if (inWeek) {
      account.usageLog.push({ timestamp: row.ended_at, tokens, cost, sessionId: row.session_id })
    }
    if (isToday) {
      account.tokensToday += tokens
      account.costToday += cost
    }
  }

  for (const account of state.accounts) {
    account.usageLog.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
    const todayCount = sessionsTodayCount.get(account.id) || 0
    if (todayCount > account.sessionsToday) account.sessionsToday = todayCount
  }

  saveState()
  console.log('[account-router] Reconciled account stats from history')
}

// ── Initialize ──

loadState()
clearStaleActiveSessions()
console.log(`[account-router] Initialized with ${state.accounts.filter(a => isClaudeRotationSlot(a) && isAccountAvailable(a)).length}/${state.accounts.filter(isClaudeRotationSlot).length} accounts available`)
