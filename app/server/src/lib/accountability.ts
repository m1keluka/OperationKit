/**
 * The accountability classifier — §3.3 of
 * `architecture/2026-11-08-accountable-leads-and-decision-queue.md`.
 *
 * A PURE function over card state. No DB handle, no clock of its own, no model
 * call, no I/O — `now` is an argument so every row of the truth table is a unit
 * test (A14). The server is the only thing allowed to assign `stalled`, and it
 * is the ONLY inferred state in the table; everything else is something a human,
 * a worker or a reviewer DECLARED.
 *
 * Why this exists at all: today `waiting`, `blocked` and `stalled` are conflated
 * — everything lands in `review` and the pile grows. The distinction that
 * matters most is `waiting` vs `stalled`: a paused thing is not a crashed thing.
 * (Same invariant n8n encodes by excluding `waiting` from its crashable
 * execution statuses.)
 */

/** The four states. `on_track` and `stalled` are derived; the rest are declared. */
export type AccountabilityState = 'on_track' | 'waiting' | 'blocked' | 'stalled'

/** Parsed form of the typed `waiting_on` column (§3.2). */
export interface WaitingOn {
  /** `nobody` when nothing is being waited on. */
  party: 'nobody' | 'human' | 'agent' | 'external' | 'secret' | 'ci'
  /** The thing after the colon — a username, a lead, a vendor, a SECRET name, a PR. */
  name: string | null
  /** The original text, so a caller can round-trip an unrecognised value unchanged. */
  raw: string | null
}

const KNOWN_PARTIES = new Set(['human', 'agent', 'external', 'secret', 'ci'])

/**
 * Parse the typed `waiting_on` value.
 *
 * An UNRECOGNISED prefix degrades to `external` with the whole string as the
 * name rather than throwing or silently becoming `nobody`. That direction is
 * chosen deliberately: mis-parsing a declared wait into "waiting on nobody"
 * would let the classifier call a genuinely-waiting card `stalled` and page a
 * human about it — the exact false alarm this table exists to prevent. Keeping
 * it a wait is the safe failure.
 */
export function parseWaitingOn(raw: string | null | undefined): WaitingOn {
  const text = (raw ?? '').trim()
  if (!text || text.toLowerCase() === 'nobody') return { party: 'nobody', name: null, raw: raw ?? null }
  const idx = text.indexOf(':')
  if (idx > 0) {
    const prefix = text.slice(0, idx).trim().toLowerCase()
    const name = text.slice(idx + 1).trim() || null
    if (KNOWN_PARTIES.has(prefix)) return { party: prefix as WaitingOn['party'], name, raw: text }
  }
  return { party: 'external', name: text, raw: text }
}

/** Render a WaitingOn back to column form. Round-trips `parseWaitingOn`. */
export function formatWaitingOn(w: Pick<WaitingOn, 'party' | 'name'>): string {
  if (w.party === 'nobody') return 'nobody'
  return w.name ? `${w.party}:${w.name}` : w.party
}

/** The typed terminal reasons (§3.3). Prefix forms carry a `:<detail>` suffix. */
export const TERMINAL_REASON_PREFIXES = ['superseded_by', 'failed', 'expired_waiting_on'] as const
export const TERMINAL_REASON_EXACT = ['delivered_merged', 'delivered_no_pr', 'cancelled_by_human', 'abandoned_no_output'] as const

export function isValidTerminalReason(reason: string | null | undefined): boolean {
  const text = (reason ?? '').trim()
  if (!text) return false
  if ((TERMINAL_REASON_EXACT as readonly string[]).includes(text)) return true
  return TERMINAL_REASON_PREFIXES.some((p) => text.startsWith(`${p}:`) && text.length > p.length + 1)
}

/** Statuses that mean the card has STOPPED and therefore owes a terminal reason. */
export const TERMINAL_STATUSES = new Set(['done', 'cancelled'])

/** The card state the classifier reads. Deliberately a narrow structural type. */
export interface AccountabilityCard {
  status: string
  has_blockers?: number | boolean | null
  blocked_reason?: string | null
  ai_review_verdict?: string | null
  /** JSON array of {name, reason} — a worker waiting on a secret only a human can supply. */
  needs_secret?: string | null
  waiting_on?: string | null
  next_check_at?: string | null
  last_meaningful_progress_at?: string | null
  updated_at?: string | null
  /** Non-null while a session is live on the card. */
  session_id?: string | null
}

export interface ClassifyOptions {
  /**
   * How long a card may show no meaningful progress before the server is
   * willing to call it `stalled`, in minutes.
   *
   * There is NO default here and that is the point. The expectation window is a
   * tolerance call that belongs to Operator (design §10 M3), not an engineering
   * constant, so the caller must pass one; `classifyAccountability` with no
   * window never returns `stalled` at all. That makes the inference default-OFF
   * until somebody sets a number, rather than inventing one and paging on it.
   */
  stalledAfterMinutes?: number | null
  /** True while a live session is attached (the caller knows this better than the row does). */
  sessionLive?: boolean
}

export interface AccountabilityVerdict {
  state: AccountabilityState
  /** One sentence a human can read, built from card state only — never from prose. */
  why: string
  /** Parsed `waiting_on`. */
  waiting_on: WaitingOn
  /**
   * Which timestamp the staleness judgement was made on.
   * `last_meaningful_progress_at` = the real signal.
   * `updated_at` = FALLBACK for a card that predates the column; weaker, and
   *   labelled so a reader is never misled about which one answered.
   * `none` = no basis at all; the card is never called `stalled` on no evidence.
   */
  basis: 'last_meaningful_progress_at' | 'updated_at' | 'none'
  /** Minutes since `basis`, or null when there is no basis. */
  idle_minutes: number | null
  /**
   * Does this belong in the human decision queue right now (§3.3, last column)?
   * `blocked` always; `waiting` only once `next_check_at` has passed OR the
   * waitee is a human; `stalled` yes; `on_track` no.
   */
  needs_human: boolean
}

function truthy(v: number | boolean | null | undefined): boolean {
  return v === true || (typeof v === 'number' && v > 0)
}

function parseTime(v: string | null | undefined): number | null {
  if (!v) return null
  // SQLite datetime('now') writes "YYYY-MM-DD HH:MM:SS" with no zone; treat the
  // space form as UTC, which is what SQLite actually stores. Left as-is, Date
  // would read it as LOCAL time and the idle minutes would be off by the host's
  // offset — on a UTC box that is invisible in tests and wrong in production.
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(v) ? `${v.replace(' ', 'T')}Z` : v
  const t = Date.parse(normalized)
  return Number.isFinite(t) ? t : null
}

function secretCount(needsSecret: string | null | undefined): number {
  if (!needsSecret) return 0
  try {
    const parsed = JSON.parse(needsSecret)
    return Array.isArray(parsed) ? parsed.length : 0
  } catch {
    return 0
  }
}

/**
 * Classify ONE card against the §3.3 truth table.
 *
 * Order matters and encodes the table's precedence:
 *   1. blocked   — somebody DECLARED an impediment. Loudest, always queued.
 *   2. waiting   — somebody named a party. Not a failure, and never `stalled`.
 *   3. on_track  — a live session, or progress inside the window.
 *   4. stalled   — nobody declared anything and the window has passed. Inferred.
 */
export function classifyAccountability(
  card: AccountabilityCard,
  now: Date = new Date(),
  opts: ClassifyOptions = {},
): AccountabilityVerdict {
  const waiting = parseWaitingOn(card.waiting_on)
  const nowMs = now.getTime()

  const meaningful = parseTime(card.last_meaningful_progress_at)
  const updated = parseTime(card.updated_at)
  const basis: AccountabilityVerdict['basis'] =
    meaningful !== null ? 'last_meaningful_progress_at' : updated !== null ? 'updated_at' : 'none'
  const basisMs = meaningful ?? updated
  const idleMinutes = basisMs === null ? null : Math.max(0, Math.floor((nowMs - basisMs) / 60000))

  const base = { waiting_on: waiting, basis, idle_minutes: idleMinutes }

  // 1. BLOCKED — declared, never inferred. Four independent declarations count:
  //    a raised blocker, a reviewer verdict of `blocked`, and an outstanding
  //    secret request (only a human can supply it, so it is an impediment by
  //    definition). A blocked card goes to the queue IMMEDIATELY.
  const secrets = secretCount(card.needs_secret)
  if (secrets > 0) {
    return { ...base, state: 'blocked', needs_human: true, why: `Blocked: waiting on ${secrets} secret${secrets === 1 ? '' : 's'} only a human can supply` }
  }
  if (card.ai_review_verdict === 'blocked') {
    const detail = card.blocked_reason ? ` (${card.blocked_reason})` : ''
    return { ...base, state: 'blocked', needs_human: true, why: `Blocked: reviewer could not verify it${detail}` }
  }
  if (truthy(card.has_blockers)) {
    const detail = card.blocked_reason ? ` (${card.blocked_reason})` : ''
    return { ...base, state: 'blocked', needs_human: true, why: `Blocked: a blocker was raised${detail}` }
  }

  // 2. WAITING — a named party plus (normally) a next_check_at. NOT a failure,
  //    and categorically distinct from stalled: a card that is waiting is never
  //    reported as stalled no matter how long the wait, because somebody is
  //    accountable for it and said so.
  if (waiting.party !== 'nobody') {
    const who = waiting.name ? `${waiting.party}:${waiting.name}` : waiting.party
    const checkMs = parseTime(card.next_check_at)
    const overdue = checkMs !== null && checkMs <= nowMs
    // A human waitee always surfaces — nothing moves until a person acts, so
    // sitting on it silently is the failure mode. A machine wait surfaces only
    // once its own check time has passed. A wait with NO next_check_at has no
    // self-clearing condition and no scheduled review, so it surfaces too rather
    // than becoming an invisible forever-wait.
    const needs_human = waiting.party === 'human' || overdue || checkMs === null
    const why = waiting.party === 'human'
      ? `Waiting on ${who} — nothing moves until they act`
      : overdue
        ? `Waiting on ${who}; the check time has passed`
        : checkMs === null
          ? `Waiting on ${who} with no next_check_at set — nothing will re-examine this`
          : `Waiting on ${who} until ${card.next_check_at}`
    return { ...base, state: 'waiting', needs_human, why }
  }

  // 3. ON TRACK — a live session is progress by definition.
  if (opts.sessionLive ?? Boolean(card.session_id)) {
    return { ...base, state: 'on_track', needs_human: false, why: 'A session is live on this card' }
  }

  // 4. STALLED — the ONLY inferred state, and the server is the only thing that
  //    assigns it. Requires ALL of: an expectation window configured by a human,
  //    a timestamp to measure from, and that window exceeded. Any missing
  //    ingredient means on_track, because we would be guessing.
  const window = opts.stalledAfterMinutes
  if (window != null && window > 0 && idleMinutes !== null && idleMinutes >= window) {
    const qualifier = basis === 'updated_at' ? ' (measured from updated_at — this card predates meaningful-progress tracking)' : ''
    return {
      ...base,
      state: 'stalled',
      needs_human: true,
      why: `Nobody declared anything and there has been no meaningful progress for ${idleMinutes} min${qualifier}`,
    }
  }

  return { ...base, state: 'on_track', needs_human: false, why: idleMinutes === null ? 'No impediment declared' : `Last meaningful progress ${idleMinutes} min ago` }
}

/**
 * A card that STOPPED without a typed terminal reason is itself a queue item
 * (§3.3). Pure, so the reconcile tick that will consume it in a later stage can
 * be tested without one.
 */
export function needsTerminalReasonItem(card: Pick<AccountabilityCard, 'status'> & { terminal_reason?: string | null }): boolean {
  if (!TERMINAL_STATUSES.has(card.status)) return false
  return !isValidTerminalReason(card.terminal_reason)
}
