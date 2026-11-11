/**
 * Durable retry/attempt accounting and FINITE job ceilings (obj 900322, C4 + C9).
 *
 * Two problems, one table (`db/schema/job-accounting.ts`):
 *
 * 1. **Retries reset on every deploy.** `noopRespawnCounts`, `autoResumeCounts`,
 *    `overloadRetryCounts` and `turnsContinueCounts` are module-level `Map`s. A
 *    restart — including an in-session self-deploy — empties them, so a card that
 *    has already burned its whole respawn budget starts over at zero. The budget
 *    is therefore not a budget. `bumpAttempt`/`getAttempts` put the counter in
 *    SQLite so a restart changes nothing.
 *
 * 2. **There is no per-card cost or time ceiling.** `WATCHDOG_WALLCLOCK_MS` is a
 *    per-SPAWN wall-clock backstop read from the process env; it is not
 *    per-objective, it is not cumulative across resumes, and there is no cost
 *    analogue at all. `recordSpend`/`evaluateCeiling` give the card a cumulative,
 *    restart-durable budget.
 *
 * ## No guessed numeric production defaults
 *
 * `cost_ceiling_usd` and `wallclock_ceiling_ms` are NULL until something
 * explicitly sets them, and {@link resolveConfiguredCeiling} never invents one:
 * it looks at the card row, then `settings.job_cost_ceiling_usd:<workspace>`,
 * then `settings.job_cost_ceiling_usd`, and returns `absent` if none exists.
 * "Absent" is a first-class, reportable state — NOT silently "unlimited" and NOT
 * a number this module made up. {@link guardAutoStartCeiling} turns that state
 * into an explicit refusal on the auto-start path, which is the whole point:
 * a job nobody gave a budget must not quietly acquire an infinite one.
 */
import type { Database } from 'better-sqlite3'

export type AttemptKind =
  | 'noop_respawn'
  | 'turns_continue'
  | 'overload_retry'
  | 'limit_rotate'
  | 'ci_followup'

export interface ConfiguredCeiling {
  /** Dollars. Finite and > 0 when present. */
  costUsd: number | null
  /** Milliseconds of cumulative wall-clock. Finite and > 0 when present. */
  wallclockMs: number | null
  /** Where the value came from — `objective` | `workspace:<ws>` | `global` | `none`. */
  source: string
}

export interface CeilingVerdict {
  /** `ok` — under budget. `exceeded` — at/over it. `absent` — none configured. */
  state: 'ok' | 'exceeded' | 'absent'
  ceiling: ConfiguredCeiling
  spentUsd: number
  elapsedMs: number
  /** Human-readable, specific. Always set for `exceeded` and `absent`. */
  reason: string | null
}

const ROW_SQL = 'SELECT * FROM objective_job_accounting WHERE objective_id = ?'

interface AccountingRow {
  objective_id: number
  cost_ceiling_usd: number | null
  wallclock_ceiling_ms: number | null
  ceiling_source: string | null
  spent_usd: number
  elapsed_ms: number
  ceiling_hit_at: string | null
  ceiling_hit_reason: string | null
}

function ensureRow(db: Database, objectiveId: number): AccountingRow {
  db.prepare(
    'INSERT OR IGNORE INTO objective_job_accounting (objective_id) VALUES (?)',
  ).run(objectiveId)
  return db.prepare(ROW_SQL).get(objectiveId) as AccountingRow
}

/**
 * A ceiling must be a finite, strictly positive number. `Infinity`, `NaN`, `0`
 * and negatives are REJECTED rather than coerced: an infinite ceiling is exactly
 * the failure mode this module exists to prevent, and silently clamping it would
 * hide the misconfiguration instead of reporting it.
 */
export function isFiniteCeiling(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/** Parse a settings value into a finite ceiling, or null. Never throws. */
export function parseFiniteCeiling(raw: string | null | undefined): number | null {
  if (raw == null) return null
  const trimmed = String(raw).trim()
  if (!trimmed) return null
  const n = Number(trimmed)
  return isFiniteCeiling(n) ? n : null
}

function readSetting(db: Database, key: string): string | null {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string | null }
      | undefined
    return row?.value ?? null
  } catch {
    return null
  }
}

/**
 * The configured finite ceiling for a card, resolved objective → workspace →
 * global. Returns `source: 'none'` with both values null when nothing is
 * configured anywhere; it does NOT substitute a default.
 */
export function resolveConfiguredCeiling(
  db: Database,
  objectiveId: number,
  workspace?: string | null,
): ConfiguredCeiling {
  const row = db.prepare(ROW_SQL).get(objectiveId) as AccountingRow | undefined
  if (row && (isFiniteCeiling(row.cost_ceiling_usd) || isFiniteCeiling(row.wallclock_ceiling_ms))) {
    return {
      costUsd: isFiniteCeiling(row.cost_ceiling_usd) ? row.cost_ceiling_usd : null,
      wallclockMs: isFiniteCeiling(row.wallclock_ceiling_ms) ? row.wallclock_ceiling_ms : null,
      source: row.ceiling_source || 'objective',
    }
  }
  if (workspace) {
    const cost = parseFiniteCeiling(readSetting(db, `job_cost_ceiling_usd:${workspace}`))
    const ms = parseFiniteCeiling(readSetting(db, `job_wallclock_ceiling_ms:${workspace}`))
    if (cost !== null || ms !== null) {
      return { costUsd: cost, wallclockMs: ms, source: `workspace:${workspace}` }
    }
  }
  const cost = parseFiniteCeiling(readSetting(db, 'job_cost_ceiling_usd'))
  const ms = parseFiniteCeiling(readSetting(db, 'job_wallclock_ceiling_ms'))
  if (cost !== null || ms !== null) {
    return { costUsd: cost, wallclockMs: ms, source: 'global' }
  }
  return { costUsd: null, wallclockMs: null, source: 'none' }
}

/**
 * Pin a finite ceiling onto the card. Throws on a non-finite value so a caller
 * cannot write `Infinity` and call it a budget.
 */
export function setObjectiveCeiling(
  db: Database,
  objectiveId: number,
  opts: { costUsd?: number | null; wallclockMs?: number | null; source?: string },
): ConfiguredCeiling {
  const { costUsd = null, wallclockMs = null, source = 'objective' } = opts
  if (costUsd !== null && !isFiniteCeiling(costUsd)) {
    throw new Error(`cost ceiling must be a finite positive number (got ${String(costUsd)})`)
  }
  if (wallclockMs !== null && !isFiniteCeiling(wallclockMs)) {
    throw new Error(`wall-clock ceiling must be a finite positive number (got ${String(wallclockMs)})`)
  }
  if (costUsd === null && wallclockMs === null) {
    throw new Error('setObjectiveCeiling needs at least one finite ceiling')
  }
  ensureRow(db, objectiveId)
  db.prepare(
    `UPDATE objective_job_accounting
        SET cost_ceiling_usd = ?, wallclock_ceiling_ms = ?, ceiling_source = ?,
            ceiling_set_at = datetime('now'), updated_at = datetime('now')
      WHERE objective_id = ?`,
  ).run(costUsd, wallclockMs, source, objectiveId)
  return { costUsd, wallclockMs, source }
}

/**
 * Add measured spend to the card's CUMULATIVE totals. Additive on purpose — a
 * resume, a respawn and a post-restart continuation all add to the same running
 * total, so a retry cannot reset the budget by starting a new session.
 */
export function recordSpend(
  db: Database,
  objectiveId: number,
  delta: { usd?: number; ms?: number },
): { spentUsd: number; elapsedMs: number } {
  const usd = Number.isFinite(delta.usd) ? Math.max(0, delta.usd as number) : 0
  const ms = Number.isFinite(delta.ms) ? Math.max(0, delta.ms as number) : 0
  ensureRow(db, objectiveId)
  db.prepare(
    `UPDATE objective_job_accounting
        SET spent_usd = spent_usd + ?, elapsed_ms = elapsed_ms + ?, updated_at = datetime('now')
      WHERE objective_id = ?`,
  ).run(usd, ms, objectiveId)
  const row = db.prepare(ROW_SQL).get(objectiveId) as AccountingRow
  return { spentUsd: row.spent_usd, elapsedMs: row.elapsed_ms }
}

/**
 * Current cumulative spend for the card.
 *
 * `elapsedMs` is the sum of two durable sources, and that is the whole point of
 * the corrections round: the explicitly-recorded `elapsed_ms` column PLUS the
 * per-session wall-clock the runner observes while a job is alive
 * ({@link observeSessionElapsed}). Before this, `elapsed_ms` had no producer in
 * the runner at all, so a "wall-clock ceiling" could only ever be hit by a test
 * that wrote the number itself. Summing the per-session rows makes the total
 * cumulative ACROSS retries, resumes and respawns and immune to a restart —
 * a new attempt adds a row, it does not reset the total.
 */
export function getSpend(db: Database, objectiveId: number): { spentUsd: number; elapsedMs: number } {
  const row = db.prepare(ROW_SQL).get(objectiveId) as AccountingRow | undefined
  return {
    spentUsd: row?.spent_usd ?? 0,
    elapsedMs: (row?.elapsed_ms ?? 0) + getObservedSessionMs(db, objectiveId),
  }
}

/**
 * Record "session `sessionId` of this card has now been alive `ms`
 * milliseconds". Idempotent per session by construction: the stored value is the
 * MAX of what we already had and what we just saw, so the poller may call this
 * on every 3s tick without inflating the total, and a restart that re-observes
 * the same live session re-converges on the truth instead of double counting.
 *
 * A negative/non-finite reading (clock skew, unreadable stat) is ignored rather
 * than clamped into the ledger.
 */
export function observeSessionElapsed(
  db: Database,
  objectiveId: number,
  sessionId: string,
  ms: number,
): number {
  if (!sessionId || !Number.isFinite(ms) || ms < 0) return getObservedSessionMs(db, objectiveId)
  const rounded = Math.round(ms)
  try {
    db.prepare(
      `INSERT INTO objective_job_session_time (objective_id, session_id, elapsed_ms)
       VALUES (?, ?, ?)
       ON CONFLICT(objective_id, session_id) DO UPDATE
         SET elapsed_ms = MAX(elapsed_ms, excluded.elapsed_ms), last_at = datetime('now')`,
    ).run(objectiveId, sessionId, rounded)
  } catch { /* table absent in a minimal DB → observation is simply not durable */ }
  return getObservedSessionMs(db, objectiveId)
}

/** Sum of observed wall-clock across EVERY session this card has ever had. */
export function getObservedSessionMs(db: Database, objectiveId: number): number {
  try {
    const row = db
      .prepare('SELECT COALESCE(SUM(elapsed_ms), 0) AS total FROM objective_job_session_time WHERE objective_id = ?')
      .get(objectiveId) as { total: number } | undefined
    return row?.total ?? 0
  } catch {
    return 0
  }
}

/**
 * Is the card at or over its configured ceiling right now?
 *
 * `absent` is returned when nothing configured a ceiling. Callers must NOT read
 * that as `ok` — it means "this job has no budget", which is a reportable
 * condition, not a permission.
 */
export function evaluateCeiling(
  db: Database,
  objectiveId: number,
  workspace?: string | null,
): CeilingVerdict {
  const ceiling = resolveConfiguredCeiling(db, objectiveId, workspace)
  const { spentUsd, elapsedMs } = getSpend(db, objectiveId)
  if (ceiling.costUsd === null && ceiling.wallclockMs === null) {
    return {
      state: 'absent',
      ceiling,
      spentUsd,
      elapsedMs,
      reason:
        'No finite job ceiling is configured for this objective (checked the card, ' +
        'settings.job_cost_ceiling_usd:<workspace> and settings.job_cost_ceiling_usd). ' +
        'No default was assumed.',
    }
  }
  if (ceiling.costUsd !== null && spentUsd >= ceiling.costUsd) {
    return {
      state: 'exceeded',
      ceiling,
      spentUsd,
      elapsedMs,
      reason: `Cost ceiling reached: $${spentUsd.toFixed(4)} spent against a $${ceiling.costUsd} ceiling (source: ${ceiling.source}).`,
    }
  }
  if (ceiling.wallclockMs !== null && elapsedMs >= ceiling.wallclockMs) {
    return {
      state: 'exceeded',
      ceiling,
      spentUsd,
      elapsedMs,
      reason: `Wall-clock ceiling reached: ${Math.round(elapsedMs / 1000)}s used against a ${Math.round(ceiling.wallclockMs / 1000)}s ceiling (source: ${ceiling.source}).`,
    }
  }
  return { state: 'ok', ceiling, spentUsd, elapsedMs, reason: null }
}

/** Mark the moment a card's ceiling stopped it, so the stop is auditable. */
export function markCeilingHit(db: Database, objectiveId: number, reason: string): void {
  ensureRow(db, objectiveId)
  db.prepare(
    `UPDATE objective_job_accounting
        SET ceiling_hit_at = COALESCE(ceiling_hit_at, datetime('now')),
            ceiling_hit_reason = COALESCE(ceiling_hit_reason, ?),
            updated_at = datetime('now')
      WHERE objective_id = ?`,
  ).run(reason, objectiveId)
}

// ── Attempt counters ────────────────────────────────────────────────────────

/** Durable attempt count for one objective + kind. 0 when never recorded. */
export function getAttempts(db: Database, objectiveId: number, kind: AttemptKind): number {
  try {
    const row = db
      .prepare('SELECT attempts FROM objective_job_attempts WHERE objective_id = ? AND kind = ?')
      .get(objectiveId, kind) as { attempts: number } | undefined
    return row?.attempts ?? 0
  } catch {
    return 0
  }
}

/** Increment and return the NEW attempt count. Survives a restart by construction. */
export function bumpAttempt(db: Database, objectiveId: number, kind: AttemptKind): number {
  db.prepare(
    `INSERT INTO objective_job_attempts (objective_id, kind, attempts)
     VALUES (?, ?, 1)
     ON CONFLICT(objective_id, kind) DO UPDATE
       SET attempts = attempts + 1, last_at = datetime('now')`,
  ).run(objectiveId, kind)
  return getAttempts(db, objectiveId, kind)
}

/**
 * Clear a budget. Reserved for the signal that the card genuinely made progress
 * (the existing in-memory semantics: a clean turn resets the breaker) — NOT for
 * a restart, which is the whole bug.
 */
export function resetAttempts(db: Database, objectiveId: number, kind: AttemptKind): void {
  try {
    db.prepare('DELETE FROM objective_job_attempts WHERE objective_id = ? AND kind = ?').run(objectiveId, kind)
  } catch { /* table missing → nothing to reset */ }
}

// ── What a ceiling can and cannot actually guarantee ─────────────────────────

/**
 * Which ceiling dimensions the RUNNER actually enforces at run time, as opposed
 * to merely storing. This constant exists because the first round of this
 * objective shipped a "cost ceiling" that read like a spend cap and was not one.
 *
 * - **time — ENFORCED.** The poller observes each live session's wall-clock on
 *   every tick ({@link observeSessionElapsed}) and stops the job when the
 *   cumulative total crosses a configured finite `wallclockMs`. The measurement
 *   is first-party (our own clock, our own process), so the guarantee is real.
 *
 * - **cost — ADVISORY ONLY.** Nothing in this system collects measured provider
 *   spend. Sessions run on subscription seats through the Claude CLI; there is
 *   no per-call billing feed into this process, and `spent_usd` only ever holds
 *   what somebody explicitly passed to {@link recordSpend}. A dollar figure
 *   derived from token counts is an ESTIMATE of list-price value, NOT a
 *   subscription charge and NOT a billing cap. So `cost_ceiling_usd` is honoured
 *   as a gate on recorded numbers and reported as a budget *intent*, and this
 *   module deliberately does not claim it stops money being spent.
 *
 * Anything that surfaces a ceiling to a human should surface this distinction
 * with it; {@link describeCeilingSupport} is the one sentence to use.
 */
export const CEILING_ENFORCEMENT = {
  time: 'enforced',
  cost: 'advisory',
} as const

/** One honest sentence about what the configured ceiling will actually do. */
export function describeCeilingSupport(ceiling: ConfiguredCeiling): string {
  const parts: string[] = []
  if (ceiling.wallclockMs !== null) {
    parts.push(
      `a ${Math.round(ceiling.wallclockMs / 1000)}s cumulative wall-clock ceiling, which the runner ENFORCES (first-party clock)`,
    )
  }
  if (ceiling.costUsd !== null) {
    parts.push(
      `a $${ceiling.costUsd} cost ceiling, which is ADVISORY: no measured provider spend is collected, so this gates only explicitly recorded estimates and is not a billing cap`,
    )
  }
  if (!parts.length) return 'No finite ceiling is configured, so nothing is enforced.'
  return `Configured (${ceiling.source}): ` + parts.join('; ') + '.'
}

// ── Auto-start guard + rollout policy ────────────────────────────────────────

/**
 * Which auto-start path is asking.
 *
 * This distinction is the correction at the heart of this round. The first
 * version of the guard was written for "the new bounded chat MVP", but its only
 * call site is the **pre-existing** delegate_mode child auto-start loop in
 * `routes/internal-create.ts`. Because the guard defaults ON and nothing seeds a
 * ceiling anywhere, shipping it as-is turns every existing delegator's children
 * into blocked cards the moment it deploys — a silent breaking change to
 * automation that worked yesterday.
 *
 * Refusing to start an unbudgeted job is still the right end state. Imposing it
 * retroactively, with no migration and no operator signal, is not. So the policy
 * is per-path:
 *
 * - `delegate_child` — the legacy path. Default **observe**: the job starts, and
 *   the absent budget is reported loudly (log + diagnostic row + a counter the
 *   operator can read) so the gap is visible before it is fatal. An operator
 *   opts in to enforcement per workspace or globally when they have chosen the
 *   numbers.
 * - `bounded` — any NEW bounded-execution entry point. Default **enforce**: it
 *   has no installed base to break, and the objective's requirement is explicit
 *   — a bounded start with no finite ceiling must be refused, not guessed.
 *
 * No numeric default is introduced by either policy. "Observe" does not invent a
 * budget; it reports that there isn't one.
 */
export type AutoStartPath = 'delegate_child' | 'bounded'

/** `enforce` — refuse. `observe` — start, but report. `off` — guard disabled. */
export type CeilingPolicy = 'enforce' | 'observe' | 'off'

const DEFAULT_POLICY: Record<AutoStartPath, CeilingPolicy> = {
  delegate_child: 'observe',
  bounded: 'enforce',
}

function parsePolicy(raw: string | null | undefined): CeilingPolicy | null {
  const v = (raw ?? '').trim().toLowerCase()
  if (v === 'enforce' || v === 'observe' || v === 'off') return v
  // Backwards compatibility with the shipped kill switch, which is a boolean.
  if (v === '0') return 'off'
  if (v === '1') return 'enforce'
  return null
}

export interface ResolvedPolicy {
  policy: CeilingPolicy
  /** `default:<path>` | `settings.<key>` — so a surprise is traceable to a row. */
  source: string
}

/**
 * Resolve the rollout policy for one auto-start path, most specific first:
 *
 *   settings.job_ceiling_policy:<path>:<workspace>
 *   settings.job_ceiling_policy:<path>
 *   settings.job_ceiling_policy
 *   settings.job_ceiling_guard_enabled  ('0' → off, kept for compatibility)
 *   built-in default for the path
 *
 * Note what is NOT here: a numeric default. Policy answers "do we refuse?",
 * never "how much?".
 */
export function resolveAutoStartPolicy(
  db: Database,
  path: AutoStartPath,
  workspace?: string | null,
): ResolvedPolicy {
  const keys = [
    workspace ? `job_ceiling_policy:${path}:${workspace}` : null,
    `job_ceiling_policy:${path}`,
    'job_ceiling_policy',
    'job_ceiling_guard_enabled',
  ].filter((k): k is string => k !== null)
  for (const key of keys) {
    const parsed = parsePolicy(readSetting(db, key))
    if (parsed) return { policy: parsed, source: `settings.${key}` }
  }
  return { policy: DEFAULT_POLICY[path], source: `default:${path}` }
}

export interface AutoStartGuardVerdict {
  /** May this job start? In `observe` this is true even when unbudgeted. */
  allowed: boolean
  /** Specific, card-displayable reason when `allowed` is false. */
  reason: string | null
  ceiling: ConfiguredCeiling
  /** The policy that decided, and where it came from. */
  policy: CeilingPolicy
  policySource: string
  /** True when an `enforce` policy WOULD have refused this start. */
  wouldRefuse: boolean
  /** Why it would refuse — set whenever `wouldRefuse`, even in `observe`. */
  diagnostic: string | null
  /** `no_ceiling` | `ceiling_exceeded` | null. */
  code: 'auto_start_no_ceiling' | 'auto_start_ceiling_exceeded' | null
}

/**
 * Kill switch, retained. `settings.job_ceiling_guard_enabled = '0'` disables the
 * refusal on every path. Prefer the per-path policy keys — a global off is the
 * blunt instrument, and the point of the policy split is to make the blunt
 * instrument unnecessary.
 */
export function isCeilingGuardEnabled(db: Database): boolean {
  const raw = readSetting(db, 'job_ceiling_guard_enabled')
  if (raw == null) return true
  return String(raw).trim() !== '0'
}

/**
 * Decide whether a card may be AUTO-started — a start with no human present at
 * the moment it begins.
 *
 * Returns a verdict that ALWAYS carries the diagnostic, even when the policy
 * allows the start. That is deliberate: "observe" must not mean "silent". The
 * caller is expected to record `diagnostic` where an operator will see it, so
 * the unbudgeted population is countable before anybody flips `enforce`.
 *
 * A human-initiated start never reaches this function.
 */
export function guardAutoStartCeiling(
  db: Database,
  objective: { id: number; workspace?: string | null },
  opts: { path?: AutoStartPath } = {},
): AutoStartGuardVerdict {
  const path = opts.path ?? 'bounded'
  const ceiling = resolveConfiguredCeiling(db, objective.id, objective.workspace)
  const { policy, source } = resolveAutoStartPolicy(db, path, objective.workspace)

  const base = { ceiling, policy, policySource: source }

  if (ceiling.costUsd === null && ceiling.wallclockMs === null) {
    const diagnostic =
      `No finite job ceiling is configured for objective ${objective.id} ` +
      `(checked the card, settings.job_cost_ceiling_usd:${objective.workspace || '<workspace>'} and settings.job_cost_ceiling_usd; ` +
      'wall-clock equivalents too). No default was assumed.'
    if (policy === 'enforce') {
      return {
        ...base,
        allowed: false,
        wouldRefuse: true,
        code: 'auto_start_no_ceiling',
        diagnostic,
        reason:
          `Auto-start refused (policy ${policy} from ${source}, path ${path}): ` +
          'no finite job ceiling is configured for this objective. Checked the card, ' +
          `settings.job_cost_ceiling_usd:${objective.workspace || '<workspace>'} and ` +
          'settings.job_cost_ceiling_usd (and the job_wallclock_ceiling_ms equivalents). ' +
          'No default budget is assumed, and an unbudgeted job is not started automatically. ' +
          'Set a finite wall-clock ceiling (ENFORCED by the runner) or cost ceiling (ADVISORY - ' +
          'no measured provider spend is collected, so it is not a billing cap). ' +
          `(Per-path opt-out: settings.job_ceiling_policy:${path} = 'observe'. ` +
          'Global kill switch: settings.job_ceiling_guard_enabled = 0.)',
      }
    }
    if (policy === 'off') {
      // The explicit global kill switch. Still reported, never refused.
      return {
        ...base,
        allowed: true,
        wouldRefuse: false,
        code: 'auto_start_no_ceiling',
        diagnostic: `${diagnostic} The ceiling guard is switched OFF (${source}), so nothing is refused anywhere.`,
        reason: null,
      }
    }
    return {
      ...base,
      allowed: true,
      wouldRefuse: true,
      code: 'auto_start_no_ceiling',
      diagnostic:
        `${diagnostic} Policy is '${policy}' (${source}) for the '${path}' path, so the start proceeds UNBUDGETED and is reported instead of refused. ` +
        `Set settings.job_ceiling_policy:${path} = 'enforce' once ceilings are configured.`,
      reason: null,
    }
  }

  const verdict = evaluateCeiling(db, objective.id, objective.workspace)
  if (verdict.state === 'exceeded') {
    const diagnostic = `${verdict.reason} The budget is cumulative and survives restarts, so a retry does not reset it.`
    if (policy === 'enforce' || policy === 'observe') {
      // An EXCEEDED budget is refused on both paths. "Observe" is a migration
      // affordance for cards nobody has given a budget yet — it is not licence
      // to blow through a budget somebody deliberately set. Only the explicit
      // global `off` kill switch suppresses this.
      return {
        ...base,
        allowed: false,
        wouldRefuse: true,
        code: 'auto_start_ceiling_exceeded',
        diagnostic,
        reason: `Auto-start refused: ${diagnostic}`,
      }
    }
  }
  return { ...base, allowed: true, wouldRefuse: false, code: null, diagnostic: null, reason: null }
}
