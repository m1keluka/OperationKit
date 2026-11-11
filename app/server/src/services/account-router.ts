import fs from 'fs'
import path from 'path'
import { ACCOUNT_STATE_FILE, RATE_LIMIT_LOG as DEFAULT_RATE_LIMIT_LOG } from '../config.js'
import { SANDBOX_ACCOUNT_ID, sandboxAuthConfigured } from './sandbox-claude-auth.js'
import { jailEnabled } from './session-jail.js'
import { CODEX_HOME_DIR, GROK_HOME_DIR } from './session-spawn-command.js'
import {
  applyGoodTurn,
  applySeatFailure,
  pickSeat,
  seatHealth,
  seatKind,
  type SeatCredentialKind,
  type SeatHealth,
  type SeatKind,
} from './seat-pool.js'

// ── Types ──

export interface UsageEvent {
  timestamp: string    // ISO
  tokens: number
  cost: number
  sessionId?: string   // Used to dedupe: a single session can have many recordSessionEnd calls
                       // (once per process exit during followup re-spawns); we replace the
                       // existing entry for that sessionId rather than appending a duplicate.
}

/** Which engine a seat logs into. Many seats per kind (seat pool v2). */
export type AccountKind = SeatKind

export type AuthParkReason = 'needs_admin' | 'needs_reconnect'

export interface AccountSlot {
  id: string               // stable seat id (generated; never a person or a machine)
  label: string            // default human-readable name ("Seat 1", …)
  // Operator-set display name that overrides `label`. Persisted so a rename
  // sticks. Effective label = customLabel || label.
  customLabel?: string | null
  kind?: AccountKind       // default 'claude'
  priority: number         // lower = preferred. Seats are filled in priority order.
  homeDir: string          // HOME for this seat (CLI login files live here)
  // ── Seat pool v2 (all optional so v1 state files load unchanged) ──
  enabled?: boolean                         // false = operator disabled (never picked)
  credentialRef?: string | null             // secrets-store key holding a pasted setup token — the NAME only
  credentialKind?: SeatCredentialKind | null // setup_token (pasted) | cli_login (CLI login files in homeDir)
  credentialHint?: string | null            // last 4 chars at most, for the masked summary
  credentialAddedAt?: string | null         // ISO, when the credential was added/rotated
  credentialExpiresAt?: string | null       // ISO, when known
  creditsExhaustedAt?: string | null        // credits / spend cap hit — parked until a good turn / passing test
  consecutiveFailures?: number              // drives the rate-limit backoff
  sessionsToday: number
  tokensToday: number
  costToday: number
  lastRateLimit: string | null   // ISO timestamp
  rateLimitResetsAt: string | null // ISO — the seat's cooldown_until (name kept for state-file compatibility)
  // Set when the account's OAuth credential is dead (401: expired/revoked token,
  // invalid credentials). DISTINCT from a rate limit: a 401 is a CREDENTIAL
  // problem that never self-heals on a timer — the slot needs a re-login
  // (Reconnect), not a cooldown. Kept separate so it surfaces as "Reconnect
  // needed" instead of a fake 5h "Exhausted", and so pickAccount parks the slot
  // permanently (no re-bench loop) until it's re-authenticated.
  authFailedAt?: string | null   // ISO timestamp of the last 401 auth failure
  // WHY the slot is parked. 'needs_admin' = the seat's org disabled
  // subscription access (403, usually a past-due sub) — a re-login does NOT fix
  // it, an admin has to. 'needs_reconnect' = dead/expired OAuth (re-login fixes
  // it). Absent on pre-existing parks → treated as needs_reconnect.
  authFailureReason?: AuthParkReason | null
  activeSessions: string[]       // session IDs currently using this account
  usageLog: UsageEvent[]         // timestamped usage for rolling window calculations
}

export interface QueuedSession {
  objectiveId: number
  queuedAt: string
}

export interface RouterState {
  version?: number         // 2 = seat pool v2 fields migrated
  accounts: AccountSlot[]
  // Ids of seats an operator removed that the server would otherwise re-create
  // on the next load (a CC_SEAT_POOL_DEFAULTS seed, the server-token seat, the
  // legacy single Codex / Grok login). Without this, Remove "worked" and the
  // seat came straight back.
  removedSeatIds?: string[]
  queue: QueuedSession[]
  lastResetDate: string    // YYYY-MM-DD, resets daily counters
}

// ── Constants ──

// Env overrides exist so the test suite never reads/rewrites the live files
// (vitest.setup.ts points both at temp paths).
const STATE_FILE = process.env.CC_ACCOUNT_ROUTER_STATE_FILE || ACCOUNT_STATE_FILE
const RATE_LIMIT_LOG = process.env.CC_RATE_LIMIT_LOG || DEFAULT_RATE_LIMIT_LOG

// Rolling window durations (matching Claude's plan usage display)
const SESSION_WINDOW_MS = 5 * 60 * 60 * 1000   // 5 hours
const WEEKLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

/** Where new seats get their HOME (CLI login files). Under the data volume so no compose change is needed. */
export const SEAT_HOME_ROOT = process.env.CC_SEAT_HOME_ROOT || '/app/data/cc-accounts'

/**
 * Seed seats. There are no built-in seats: an install starts with an empty pool
 * (plus the server-token fallback seat for sandboxed sessions when that token is
 * set). An operator who wants seats pre-declared can point CC_SEAT_POOL_DEFAULTS
 * at a JSON array of `{ id, label?, kind?, priority?, homeDir? }`. Seats saved in
 * the state file always win over the seed (renames, priorities, history).
 */
export function loadSeatDefaults(file = process.env.CC_SEAT_POOL_DEFAULTS): AccountSlot[] {
  if (!file) return []
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown
    if (!Array.isArray(raw)) return []
    const out: AccountSlot[] = []
    for (const r of raw as Array<Partial<AccountSlot>>) {
      if (!r || typeof r.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(r.id)) continue
      const kind: AccountKind = r.kind === 'codex' || r.kind === 'grok' ? r.kind : 'claude'
      const slot = emptySlot(r.id, kind, typeof r.homeDir === 'string' && r.homeDir ? r.homeDir : path.join(SEAT_HOME_ROOT, r.id))
      if (typeof r.label === 'string' && r.label.trim()) slot.label = r.label.trim().slice(0, 60)
      if (typeof r.priority === 'number') slot.priority = r.priority
      out.push(slot)
    }
    return out
  } catch (err) {
    console.warn('[account-router] CC_SEAT_POOL_DEFAULTS unreadable, starting from saved state only:', err instanceof Error ? err.message : err)
    return []
  }
}

const RESERVED_IDS = new Set(['codex', 'grok', SANDBOX_ACCOUNT_ID])

/** The single pre-v2 Codex login dir (override for tests / other layouts). */
const LEGACY_CODEX_HOME = process.env.CC_LEGACY_CODEX_HOME || CODEX_HOME_DIR

/** True for a Claude seat (the only kind the legacy pickAccount() rotates). */
export function isClaudeRotationSlot(account: AccountSlot): boolean {
  return account.id !== 'codex' && account.id !== 'grok' && seatKind(account) === 'claude'
}

/**
 * Bring a seat record up to v2 without losing anything: kind defaults to claude,
 * enabled to true, and the credential kind is inferred (a pasted secret or the
 * server-token seat = setup_token, anything else = the CLI's own login files).
 */
export function migrateSeatRecord(slot: AccountSlot): AccountSlot {
  if (!slot.kind) slot.kind = slot.id === 'grok' ? 'grok' : slot.id === 'codex' ? 'codex' : 'claude'
  if (slot.enabled === undefined) slot.enabled = true
  if (!slot.credentialKind) {
    slot.credentialKind = slot.credentialRef || slot.id === SANDBOX_ACCOUNT_ID ? 'setup_token' : 'cli_login'
  }
  if (typeof slot.consecutiveFailures !== 'number') slot.consecutiveFailures = 0
  if (!Array.isArray(slot.activeSessions)) slot.activeSessions = []
  if (!Array.isArray(slot.usageLog)) slot.usageLog = []
  return slot
}

/**
 * Merge persisted router state onto the seed seats without wiping names.
 * - A saved seat wins over its seed entirely (priority, homeDir, history).
 * - customLabel always wins (and a saved.label that drifted off the seed label
 *   is promoted to customLabel — that is how pre-customLabel renames survive).
 * - Seats that exist only in the save are kept.
 */
export function mergeAccountRecords(defaults: AccountSlot[], saved: AccountSlot[], removed: string[] = []): AccountSlot[] {
  const savedById = new Map(saved.map(a => [a.id, a]))
  const gone = new Set(removed)
  const merged: AccountSlot[] = defaults.filter(def => savedById.has(def.id) || !gone.has(def.id)).map(def => {
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
      priority: typeof s.priority === 'number' ? s.priority : def.priority,
      homeDir: s.homeDir || def.homeDir,
      usageLog: s.usageLog || [],
    }
  })
  const defaultIds = new Set(merged.map(d => d.id))
  for (const s of saved) {
    if (defaultIds.has(s.id)) continue
    merged.push({
      ...emptySlot(s.id, s.kind || 'claude', s.homeDir || path.join(SEAT_HOME_ROOT, s.id)),
      ...s,
      customLabel: s.customLabel || s.label || null,
      usageLog: s.usageLog || [],
    })
  }
  return merged
}

function emptySlot(id: string, kind: AccountKind, homeDir: string, label?: string): AccountSlot {
  return {
    id,
    label: label || (id === 'grok' ? 'Grok' : id === 'codex' ? 'Codex' : `Seat ${id}`),
    kind,
    priority: 0,
    homeDir,
    enabled: true,
    credentialKind: 'cli_login',
    consecutiveFailures: 0,
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
  try { fs.chmodSync(homeDir, 0o777) } catch { /* ccuser needs to write .claude / .codex / .grok */ }
}

/** Next free generated id: `s1`, `s2`, … (never a letter that implies a person or a fixed slot). */
function nextSlotId(existing: AccountSlot[]): string {
  const used = new Set(existing.map(a => a.id).concat([...RESERVED_IDS]))
  for (let i = 1; i < 10_000; i++) {
    if (!used.has(`s${i}`)) return `s${i}`
  }
  return `s${Date.now().toString(36)}`
}

/** "Seat N" for the Nth seat of a kind — a neutral default display name. */
function nextSeatLabel(kind: AccountKind): string {
  const n = state.accounts.filter(a => seatKind(a) === kind).length + 1
  const engine = kind === 'claude' ? 'Claude' : kind === 'codex' ? 'Codex' : 'Grok'
  return `${engine} seat ${n}`
}

export interface AddSeatInput {
  label?: string
  kind?: AccountKind
  priority?: number
  credentialKind?: SeatCredentialKind
  credentialRef?: string | null
  credentialHint?: string | null
  credentialExpiresAt?: string | null
}

/** Operator: add a seat. Each seat gets its own HOME under SEAT_HOME_ROOT. */
export function addAccountSlot(opts: AddSeatInput = {}): AccountSlot {
  loadState()
  const kind: AccountKind = opts.kind === 'grok' || opts.kind === 'codex' ? opts.kind : 'claude'
  const name = (opts.label || '').trim().slice(0, 60)
  const id = nextSlotId(state.accounts)
  const homeDir = path.join(SEAT_HOME_ROOT, id)
  ensureAccountHome(homeDir)
  const slot = emptySlot(id, kind, homeDir, nextSeatLabel(kind))
  if (name) slot.customLabel = name
  if (typeof opts.priority === 'number' && Number.isFinite(opts.priority)) slot.priority = Math.round(opts.priority)
  slot.credentialKind = opts.credentialKind || (opts.credentialRef ? 'setup_token' : 'cli_login')
  if (opts.credentialRef) {
    slot.credentialRef = opts.credentialRef
    slot.credentialHint = opts.credentialHint ?? null
    slot.credentialAddedAt = new Date().toISOString()
  }
  if (opts.credentialExpiresAt) slot.credentialExpiresAt = opts.credentialExpiresAt
  state.accounts.push(slot)
  unmarkRemoved(id)
  saveState()
  return slot
}

function unmarkRemoved(id: string): void {
  if (state.removedSeatIds?.includes(id)) state.removedSeatIds = state.removedSeatIds.filter(x => x !== id)
}

function wasRemoved(id: string): boolean {
  return !!state.removedSeatIds?.includes(id)
}

// ── State Management ──

let state: RouterState = {
  version: 2,
  accounts: loadSeatDefaults(),
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

      // Saved seats win over the optional seed (CC_SEAT_POOL_DEFAULTS): renames,
      // priorities and homeDirs set from Settings survive a reload. Every record
      // is brought up to v2 in place — history (usageLog, the rate-limit log,
      // session attribution by seat id) is untouched.
      state.removedSeatIds = Array.isArray(loaded.removedSeatIds) ? loaded.removedSeatIds.filter(x => typeof x === 'string') : []
      state.accounts = mergeAccountRecords(loadSeatDefaults(), loaded.accounts || [], state.removedSeatIds).map(migrateSeatRecord)
      state.queue = loaded.queue || []
      state.lastResetDate = loaded.lastResetDate || todayStr()
      state.version = 2
    }
  } catch (err) {
    console.error('[account-router] Failed to load state, using defaults:', err)
  }

  // Legacy single server token (SESSION_JAIL_CLAUDE_OAUTH_TOKEN) for sandboxed
  // sessions, surfaced as one fallback seat. It is only USED when no pasted
  // Claude setup-token seat exists (see seatUsable), so an install with no seats
  // configured keeps working exactly as before.
  if (sandboxAuthConfigured() && !wasRemoved(SANDBOX_ACCOUNT_ID) && !state.accounts.some(a => a.id === SANDBOX_ACCOUNT_ID)) {
    state.accounts.push(migrateSeatRecord({
      id: SANDBOX_ACCOUNT_ID, label: 'Server Claude token (sandboxed sessions)', priority: 0,
      homeDir: path.join(SEAT_HOME_ROOT, SANDBOX_ACCOUNT_ID), sessionsToday: 0, tokensToday: 0, costToday: 0,
      lastRateLimit: null, rateLimitResetsAt: null, activeSessions: [], usageLog: [],
    }))
  }

  // Single-login Codex / Grok installs (one login dir, configured by env) become
  // one seat each, so an install that never opened Settings → Seats keeps
  // running exactly as before. Skipped as soon as any seat of that kind exists.
  for (const [kind, id, home] of [['codex', 'codex', LEGACY_CODEX_HOME], ['grok', 'grok', GROK_HOME_DIR]] as const) {
    if (wasRemoved(id) || state.accounts.some(a => seatKind(a) === kind)) continue
    const legacy = migrateSeatRecord(emptySlot(id, kind, home))
    try { if (fs.statSync(seatLoginFile(legacy)).size > 8) state.accounts.push(legacy) } catch { /* not connected */ }
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
    if (!(typeof oauth.refreshToken === 'string' && oauth.refreshToken.length > 0)) return false
    // obj 716791 (2026-10-17): a PRESENT refresh token is not enough — the
    // refresh token itself has its own expiry (`refreshTokenExpiresAt`). A
    // refresh token past that instant can never mint a new access token
    // either, so the account needs a full re-login, not a transparent
    // refresh. Six of seven pool accounts (b,c,d,e,f,g) were found silently
    // in exactly this state: an access token expired, a refresh token
    // present, but the refresh token itself dead for up to ~50h — this check
    // only existed for the access token, so pickAccount kept routing to
    // them and every spawn died with "OAuth session expired and could not
    // be refreshed" (0 tool calls, 0 cost — see isAuthFailureMessage below).
    const refreshTokenExpiresAt = typeof oauth.refreshTokenExpiresAt === 'number' ? oauth.refreshTokenExpiresAt : null
    if (refreshTokenExpiresAt !== null && refreshTokenExpiresAt <= now) return false
    return true
  } catch {
    return true // unparseable — let the spawn decide rather than false-bench
  }
}

// Presence check for a pasted credential (the secrets store owns the value).
// Registered by seat-credentials.ts so this module stays free of DB imports;
// permissive until registered — the spawn then fails loudly instead of the
// router silently benching a seat.
let credentialPresent: (ref: string) => boolean = () => true
export function registerSeatCredentialCheck(fn: (ref: string) => boolean): void {
  credentialPresent = fn
}

function hasSetupTokenSeat(kind: AccountKind): boolean {
  return state.accounts.some(a =>
    a.id !== SANDBOX_ACCOUNT_ID && seatKind(a) === kind && a.enabled !== false &&
    a.credentialKind === 'setup_token' && !!a.credentialRef)
}

/** CLI login file for a seat, by engine. */
export function seatLoginFile(account: Pick<AccountSlot, 'homeDir' | 'kind'>): string {
  const kind = seatKind(account)
  if (kind === 'codex') return path.join(account.homeDir, '.codex', 'auth.json')
  if (kind === 'grok') return path.join(account.homeDir, '.grok', 'auth.json')
  return path.join(account.homeDir, '.claude', '.credentials.json')
}

/**
 * Is the seat's credential reachable for a session started now? Health
 * (disabled / parked / cooling) is checked separately by seatHealth.
 */
export function seatCredentialUsable(account: AccountSlot, jail = jailEnabled()): boolean {
  const kind = seatKind(account)
  if (account.id === SANDBOX_ACCOUNT_ID) {
    // Legacy single token: a fallback only while no pasted Claude seat exists.
    return sandboxAuthConfigured() && !hasSetupTokenSeat('claude')
  }
  if (account.credentialKind === 'setup_token') {
    return kind === 'claude' && !!account.credentialRef && credentialPresent(account.credentialRef)
  }
  // CLI login files in the seat's HOME. A sandboxed Claude session cannot use
  // them: the jail never sees the seat's HOME, and copying a rotating refresh
  // token into a jail would log the seat out on the first refresh. Codex/Grok
  // login dirs are bind-mounted (not copied) into the one session assigned.
  if (jail && kind === 'claude') return false
  let raw: string
  try {
    raw = fs.readFileSync(seatLoginFile(account), 'utf-8')
  } catch {
    return false // not set up
  }
  if (kind === 'claude') return isOAuthTokenUsable(raw)
  return raw.trim().length > 8
}

function isAccountAvailable(account: AccountSlot): boolean {
  const now = Date.now()
  // Expired cooldown → clear it so the dashboard stops showing a stale bench.
  if (account.rateLimitResetsAt && Date.parse(account.rateLimitResetsAt) <= now) {
    account.lastRateLimit = null
    account.rateLimitResetsAt = null
  }
  // Dead credential (401/403), credits exhausted, disabled or cooling down →
  // out. Credential parks never auto-expire: only a passing test/reconnect
  // (clearAuthFailure) brings the seat back, which prevents the re-bench loop.
  if (seatHealth(account, now) !== 'healthy') return false
  return seatCredentialUsable(account)
}

/** Seat health for the API / UI (adds the credential check on top of seatHealth). */
export function seatStatusOf(account: AccountSlot): { health: SeatHealth; available: boolean } {
  const health = seatHealth(account, Date.now())
  return { health, available: health === 'healthy' && seatCredentialUsable(account) }
}

/**
 * Sandboxed sessions get their own seat while one is free (spread), and a
 * Codex/Grok CLI login is never shared by two live sandboxed sessions
 * (exclusive): both would refresh the same rotating token and one refresh
 * would invalidate the other's login. On the host (tmux) path sessions keep
 * sharing a login as before — the CLI rewrites one file in place.
 */
function pickOptions(kind: AccountKind, filter?: (account: AccountSlot) => boolean) {
  const jail = jailEnabled()
  return {
    kind,
    now: Date.now(),
    spread: jail,
    usable: (s: AccountSlot) => (!filter || filter(s)) && isAccountAvailable(s),
    exclusive: (s: AccountSlot) => jail && s.credentialKind === 'cli_login' && seatKind(s) !== 'claude',
  }
}

/** Pick the best available seat of an engine (null = every seat is down → caller queues). */
export function pickSeatOfKind(kind: AccountKind, filter?: (account: AccountSlot) => boolean): AccountSlot | null {
  loadState()
  const seats = state.accounts.filter(a => kind !== 'claude' || isClaudeRotationSlot(a))
  return pickSeat(seats, pickOptions(kind, filter))
}

/** Does this engine have at least one seat a new session could start on? */
export function hasAvailableSeat(kind: AccountKind): boolean {
  return pickSeatOfKind(kind) !== null
}

/** Number of seats configured for an engine (enabled or not). */
export function seatCount(kind: AccountKind): number {
  loadState()
  return state.accounts.filter(a => seatKind(a) === kind && (kind !== 'claude' || isClaudeRotationSlot(a))).length
}

/**
 * Pick the best available Claude seat for a new session.
 * Order: priority asc, fewest live sessions, fewest today, fewest tokens
 * (sandboxed sessions prefer an idle seat first). Null if all are down.
 */
export function pickAccount(filter?: (account: AccountSlot) => boolean): AccountSlot | null {
  return pickSeatOfKind('claude', filter)
}

/**
 * Pick the seat for a follow-up respawn. Follow-ups stay on the session's
 * original seat while it is healthy; if it is now parked, disabled, out of
 * credits or cooling down, re-pick on the same engine. Returns the seat to use
 * (null = none available → caller enqueues) and whether it moved.
 * `filter` is forwarded to the pick (tests / slot policy). (obj 717767)
 */
export function chooseFollowUpAccount(
  currentId: string | null,
  filter?: (account: AccountSlot) => boolean,
  kind: AccountKind = 'claude',
): { account: AccountSlot | null; rerouted: boolean; parkedReason: AuthParkReason | null } {
  loadState()
  const current = currentId ? state.accounts.find(a => a.id === currentId) : undefined
  const sameKind = current && seatKind(current) === kind && (kind !== 'claude' || isClaudeRotationSlot(current))
  if (current && sameKind && isAccountAvailable(current)) {
    return { account: current, rerouted: false, parkedReason: null }
  }
  const parkedReason = current?.authFailedAt ? (current.authFailureReason || 'needs_reconnect') : null
  return { account: pickSeatOfKind(kind, filter), rerouted: !!current, parkedReason }
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
  // No stated reset → exponential backoff from the seat's failure streak
  // (seat-pool.ts), capped at one 5h window. A known sooner reset is never
  // pushed later by a weaker signal.
  applySeatFailure(account, 'rate_limit', { now: now.getTime(), resetAt: resetTime || null })
  const resetAt = new Date(account.rateLimitResetsAt!)
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
  if (!account) return
  const was = account.rateLimitResetsAt
  // A good turn clears the cooldown, a credits park and the failure streak
  // (not a credential park — that needs a passing test or a reconnect).
  if (!applyGoodTurn(account)) return
  console.log(`[account-router] Good turn on ${accountId} (${getAccountLabel(accountId)}) — cleared cooldown${was ? ` (was resetting ${was})` : ''}`)
  saveState()
}

/**
 * Credits or the spend cap ran out. Parks the seat (no timer, no rotation
 * churn — siblings on the same org would hit the same cap). Cleared by a good
 * turn, a passing "Test now", or an operator.
 */
export function recordCreditsExhausted(accountId: string, triggerMessage?: string): void {
  loadState()
  const account = state.accounts.find(a => a.id === accountId)
  if (!account) return
  const now = new Date()
  applySeatFailure(account, 'credits_exhausted', { now: now.getTime() })
  saveState()
  appendRateLimitHistory({
    timestamp: now.toISOString(),
    accountId,
    label: getAccountLabel(accountId),
    tokensAtLimit: account.tokensToday,
    sessionsAtLimit: account.sessionsToday,
    costAtLimit: account.costToday,
    activeSessions: account.activeSessions.length,
    resetTime: now.toISOString(),
    triggerMessage: `[credits-exhausted] ${(triggerMessage || '').slice(0, 440)}`,
  })
  console.log(`[account-router] Seat ${accountId} (${getAccountLabel(accountId)}) parked: credits / spend cap exhausted`)
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
  const reason = authParkReason(triggerMessage || '')
  account.authFailedAt = now.toISOString()
  account.authFailureReason = reason
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
    triggerMessage: `[auth-failure:${reason}] ${(triggerMessage || '').slice(0, 440)}`,
  })
  console.log(`[account-router] Account ${accountId} (${account.label}) AUTH FAILURE — parked as "${reason === 'needs_admin' ? 'account needs admin' : 'reconnect needed'}". Trigger: ${(triggerMessage || '').slice(0, 120)}`)
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
  account.authFailureReason = null
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
 *
 * Also covers two credential-dead states that don't arrive as a 401:
 *  - HTTP 403 "Your organization has disabled Claude subscription access for
 *    Claude Code" — the seat's org turned off subscription access. It never
 *    self-heals on a timer, but it went unmatched, so the seat stayed in
 *    rotation and killed every session routed to it (obj 717763: 4 of 7 seats).
 *  - "OAuth session expired and could not be refreshed" — refresh token dead.
 *    The CLI exits with `api_error_status: null` before any API call (0 tool
 *    calls, $0), so only this text match catches it; either half of the
 *    phrase is matched so a copy tweak doesn't reopen the gap (obj 716791).
 */
export function isAuthFailureMessage(text: string): boolean {
  return authFailureKind(text) !== null
}

// Org-level "subscription access disabled" (403). Several phrasings so a CLI
// copy tweak doesn't silently drop the match: the full sentence, the
// "ask your admin to enable access" tail, and the org-disabled head. All are
// specific to this error, never normal assistant prose about auth.
const ORG_DISABLED_PATTERN =
  /disabled Claude subscription access|organization has disabled (?:Claude )?subscription|ask your admin to enable(?: Claude subscription)? access/i
const DEAD_CREDENTIAL_PATTERN =
  /invalid authentication credentials|authentication_failed|oauth session expired|could not be refreshed/i

/**
 * Classify an auth-failure message: 'org_disabled' (the seat's org turned off
 * subscription access — needs an admin, a re-login won't help) vs
 * 'dead_credential' (expired/revoked OAuth — a reconnect fixes it). null when
 * the text is not an auth failure.
 */
export function authFailureKind(text: string): 'org_disabled' | 'dead_credential' | null {
  if (!text) return null
  if (ORG_DISABLED_PATTERN.test(text)) return 'org_disabled'
  if (DEAD_CREDENTIAL_PATTERN.test(text)) return 'dead_credential'
  return null
}

/** Park reason for an auth-failure trigger message. Unclassified → needs_reconnect (the 401 default). */
export function authParkReason(text: string): AuthParkReason {
  return authFailureKind(text) === 'org_disabled' ? 'needs_admin' : 'needs_reconnect'
}

/**
 * Is this errored stream event an auth failure? 401 always is. A 403 counts
 * only when its body is the org-disabled text — a bare 403 can be a normal
 * permission error on some other resource, so it must not park a seat.
 */
export function isAuthFailureEvent(status: unknown, text: string): boolean {
  if (status === 401) return true
  if (status === 403) return authFailureKind(text) === 'org_disabled'
  return isAuthFailureMessage(text)
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
  accounts: Array<AccountSlot & { available: boolean; health: SeatHealth; credentialUsable: boolean; windows: AccountWindowUsage }>
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
      health: seatHealth(a, Date.now()),
      credentialUsable: seatCredentialUsable(a),
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
 * Operator-facing label for a slot (customLabel wins). Safe for alerts and card
 * text — it is a display name, never a credential. Falls back to "slot <id>".
 */
export function getAccountLabel(accountId: string): string {
  const account = state.accounts.find(a => a.id === accountId)
  if (!account) return `slot ${accountId}`
  return account.customLabel || account.label || `slot ${accountId}`
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
      account = migrateSeatRecord(emptySlot(accountId, accountId, accountId === 'grok' ? GROK_HOME_DIR : CODEX_HOME_DIR))
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

/**
 * The single pre-v2 Codex / Grok seat (id `codex` / `grok`, the env-configured
 * login dir). The Dashboard's one-click Connect still targets it; Settings →
 * Seats adds further seats with their own login dirs.
 */
export function ensureLegacySeat(kind: 'codex' | 'grok'): AccountSlot {
  loadState()
  let seat = state.accounts.find(a => a.id === kind)
  if (!seat) {
    const home = kind === 'grok' ? GROK_HOME_DIR : LEGACY_CODEX_HOME
    ensureAccountHome(home)
    seat = migrateSeatRecord(emptySlot(kind, kind, home))
    state.accounts.push(seat)
    unmarkRemoved(kind)
    saveState()
  }
  return seat
}

// ── Seat admin (Settings → Seats) ──
// Each mutator returns the seat (or null for an unknown id) and persists. The
// route layer audits; nothing here ever sees a credential value.

export interface SeatPatch {
  label?: string
  priority?: number
  enabled?: boolean
  credentialExpiresAt?: string | null
}

export function updateSeat(accountId: string, patch: SeatPatch): AccountSlot | null {
  loadState()
  const account = state.accounts.find(a => a.id === accountId)
  if (!account) return null
  if (typeof patch.label === 'string') {
    const trimmed = patch.label.trim().slice(0, 60)
    account.customLabel = trimmed.length > 0 ? trimmed : null
  }
  if (typeof patch.priority === 'number' && Number.isFinite(patch.priority)) {
    account.priority = Math.max(-1000, Math.min(1000, Math.round(patch.priority)))
  }
  if (typeof patch.enabled === 'boolean') account.enabled = patch.enabled
  if (patch.credentialExpiresAt !== undefined) {
    const t = patch.credentialExpiresAt ? Date.parse(patch.credentialExpiresAt) : NaN
    account.credentialExpiresAt = Number.isFinite(t) ? new Date(t).toISOString() : null
  }
  saveState()
  return account
}

/**
 * Point a seat at a (new) pasted credential. Rotating clears credential parks,
 * credits park and cooldown — a fresh credential deserves a fresh start; the
 * next test / turn re-parks it if it is still bad.
 */
export function setSeatCredential(
  accountId: string,
  cred: { ref: string; hint: string | null; expiresAt?: string | null },
): AccountSlot | null {
  loadState()
  const account = state.accounts.find(a => a.id === accountId)
  if (!account) return null
  account.credentialKind = 'setup_token'
  account.credentialRef = cred.ref
  account.credentialHint = cred.hint
  account.credentialAddedAt = new Date().toISOString()
  if (cred.expiresAt !== undefined) account.credentialExpiresAt = cred.expiresAt
  account.authFailedAt = null
  account.authFailureReason = null
  applyGoodTurn(account)
  saveState()
  return account
}

/** Remove a seat. Refused while a session is live on it. Returns the removed seat. */
export function removeSeat(accountId: string): { removed: AccountSlot | null; error?: string } {
  loadState()
  const idx = state.accounts.findIndex(a => a.id === accountId)
  if (idx < 0) return { removed: null, error: 'not_found' }
  const account = state.accounts[idx]
  if (account.activeSessions.length > 0) return { removed: null, error: 'seat_in_use' }
  state.accounts.splice(idx, 1)
  // Tombstone the id so a seed / legacy / server-token seat is not re-created
  // on the next load. Harmless for an ordinary seat (re-adding clears it).
  state.removedSeatIds = [...new Set([...(state.removedSeatIds || []), accountId])]
  saveState()
  return { removed: account }
}

/** Raw seat list (server-side only — callers must mask before returning it). */
export function listSeatRecords(): AccountSlot[] {
  loadState()
  return state.accounts
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
    const availableCount = state.accounts.filter(a => isAccountAvailable(a)).length
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
