/**
 * Same-title duplicate-card guard (obj 64, Part C).
 *
 * Evidence: twin pairs of cards — same title, same workspace, filed minutes apart
 * by different paths (a human on the board, an agent key, a delegator's bulk POST,
 * a routine fire) — that BOTH ran, doubling spend and producing competing PRs.
 *
 * Rule: a card whose NORMALIZED title + workspace matches an OPEN card (status not
 * done/cancelled, not soft-deleted) CREATED within the guard window (default 24h)
 * is a duplicate. Every create path refuses it and hands back the existing card's id
 * instead; the caller can override with `force: true`. A refusal never merges or
 * edits the existing card — no description is folded in silently.
 *
 * Normalization (`normalizeTitle`) is deterministic, in this order:
 *   1. Unicode NFKC, lowercase, trim.
 *   2. Strip ONE OR MORE trailing copy-style suffixes: "(2)", "( 3 )", "(copy)",
 *      "(copy 2)", "copy", "copy 2", "- copy", "— copy 3". A bare trailing number is
 *      NOT stripped ("Phase 2" stays distinct from "Phase 3").
 *   3. Every character that is not a Unicode letter, number, or whitespace
 *      (punctuation, symbols, emoji) becomes a space.
 *   4. Collapse whitespace runs to one space, trim.
 * An empty result (a title of only punctuation/emoji) is never treated as a twin.
 *
 * Config (read at the point of use, so it flips without a restart):
 *   settings.duplicate_guard_enabled      '0'/'false'/'off' disables (default ON);
 *                                         env CC_DUPLICATE_GUARD_ENABLED is the fallback.
 *   settings.duplicate_guard_window_hours positive number (default 24);
 *                                         env CC_DUPLICATE_GUARD_WINDOW_HOURS is the fallback.
 *
 * Query shape: one `workspace = ? AND created_at >= ?` SELECT (idx_objectives_workspace
 * narrows it; the window bound keeps the row set to roughly a day of cards), then the
 * normalized compare and the exact window check run in JS. The SQL bound is padded by
 * a day because a few legacy insert paths store ISO-8601 `created_at` ("…T…Z") rather
 * than SQLite's "YYYY-MM-DD HH:MM:SS", and the two do not compare correctly as text.
 *
 * Metrics: `recordDedupe` writes one activity_log row per refusal/override
 * (event_type 'decision', metadata.kind = 'duplicate_refused' | 'duplicate_forced',
 * metadata.source = the route/spawner), so dedupe volume is queryable per source.
 */
import type { Database } from 'better-sqlite3'
import { logActivity } from '../routes/feed.js'

export const DEFAULT_DUPLICATE_WINDOW_HOURS = 24

/** One or more trailing copy-style suffixes, matched on the lowercased title. */
const COPY_SUFFIX_RE = /\s*(?:\(\s*(?:copy(?:\s*\d+)?|\d+)\s*\)|[-–—_:]?\s*\bcopy(?:\s*\d+)?)\s*$/u

/** Deterministic title key — see the module header for the exact steps. */
export function normalizeTitle(title: string | null | undefined): string {
  let s = (title ?? '').normalize('NFKC').toLowerCase().trim()
  // Strip stacked suffixes ("Foo (copy) (2)") until stable; bounded so a hostile
  // title cannot spin.
  for (let i = 0; i < 5; i++) {
    const next = s.replace(COPY_SUFFIX_RE, '')
    if (next === s) break
    s = next
  }
  return s
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function settingValue(db: Database, key: string): string | undefined {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value?: string } | undefined
    return row?.value ?? undefined
  } catch {
    return undefined
  }
}

/** Kill switch. Default ON; settings wins over env. */
export function isDuplicateGuardEnabled(db: Database, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = settingValue(db, 'duplicate_guard_enabled') ?? env.CC_DUPLICATE_GUARD_ENABLED
  if (raw == null || raw.trim() === '') return true
  return !['0', 'false', 'off', 'no'].includes(raw.trim().toLowerCase())
}

/** Guard window in hours. Default 24; settings wins over env; non-positive/garbage → default. */
export function duplicateGuardWindowHours(db: Database, env: NodeJS.ProcessEnv = process.env): number {
  for (const raw of [settingValue(db, 'duplicate_guard_window_hours'), env.CC_DUPLICATE_GUARD_WINDOW_HOURS]) {
    if (raw == null || raw.trim() === '') continue
    const n = Number(raw)
    if (Number.isFinite(n) && n > 0) return n
  }
  return DEFAULT_DUPLICATE_WINDOW_HOURS
}

export interface OpenDuplicate {
  id: number
  title: string
  status: string
  workspace: string
  created_at: string
  parent_id: number | null
  routine_id: number | null
}

export interface FindDuplicateOptions {
  title: string
  workspace: string
  /** Defaults to the configured window (settings/env/24). */
  windowHours?: number
  /** The card itself (start path). */
  excludeId?: number | null
  /** A parent/child pair is never a twin: pass the candidate's parent id here
   *  (and/or its own id via excludeId — a child of the candidate is skipped too). */
  excludeParentId?: number | null
  /** Cards from this routine are governed by the routine's own queue-depth guard. */
  excludeRoutineId?: number | null
  /** Only count twins in these statuses (start path: ['working','ai_review']).
   *  Default: every open status. */
  statuses?: readonly string[]
  /** Clock override for tests. */
  now?: Date
}

/** SQLite "YYYY-MM-DD HH:MM:SS" (UTC) for a Date. */
function sqliteUtc(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ')
}

/** created_at → epoch ms. SQLite's bare "YYYY-MM-DD HH:MM:SS" is UTC. */
function parseCreatedAt(v: string): number {
  const s = String(v || '').trim()
  if (!s) return NaN
  const iso = s.includes('T') ? s : s.replace(' ', 'T')
  return Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : `${iso}Z`)
}

/**
 * The oldest open card in `workspace` created inside the window whose normalized
 * title equals `title`'s, or null. Never throws (a guard failure must not block a
 * create) — on a DB error it logs and returns null.
 */
export function findOpenDuplicate(db: Database, opts: FindDuplicateOptions): OpenDuplicate | null {
  const key = normalizeTitle(opts.title)
  if (!key) return null
  const windowHours = opts.windowHours ?? duplicateGuardWindowHours(db)
  const now = (opts.now ?? new Date()).getTime()
  const cutoff = now - windowHours * 3600_000
  // Pad the SQL prefilter by a day (see header: mixed created_at formats).
  const sqlBound = sqliteUtc(new Date(cutoff - 24 * 3600_000))
  let rows: OpenDuplicate[]
  try {
    rows = db
      .prepare(
        `SELECT id, title, status, workspace, created_at, parent_id, routine_id
           FROM objectives
          WHERE workspace = ? AND created_at >= ?
            AND status NOT IN ('done', 'cancelled') AND deleted_at IS NULL
          ORDER BY id ASC`,
      )
      .all(opts.workspace, sqlBound) as OpenDuplicate[]
  } catch (err) {
    console.warn('[duplicate-guard] lookup failed (allowing create):', (err as Error).message)
    return null
  }
  for (const r of rows) {
    if (opts.excludeId != null && r.id === opts.excludeId) continue
    if (opts.excludeParentId != null && r.id === opts.excludeParentId) continue
    if (opts.excludeId != null && r.parent_id === opts.excludeId) continue
    if (opts.excludeRoutineId != null && r.routine_id === opts.excludeRoutineId) continue
    if (opts.statuses && !opts.statuses.includes(r.status)) continue
    const created = parseCreatedAt(r.created_at)
    if (!Number.isFinite(created) || created < cutoff) continue
    if (normalizeTitle(r.title) === key) return r
  }
  return null
}

export type DedupeEvent = 'duplicate_refused' | 'duplicate_forced'

export interface RecordDedupeInput {
  event: DedupeEvent
  /** Route or spawner, e.g. 'POST /api/objectives', 'routine-scheduler'. */
  source: string
  title: string
  workspace: string
  existingId: number
  /** The card that was created anyway (forced) or that was refused a start. */
  newId?: number | null
  project?: string | null
}

/** One activity_log row per refusal / override. Never throws. */
export function recordDedupe(input: RecordDedupeInput): void {
  try {
    logActivity({
      project: input.project || input.workspace,
      workspace: input.workspace,
      objective_id: input.newId ?? input.existingId,
      // activity_log.event_type is CHECK-constrained; the dedupe kind rides in metadata.
      event_type: 'decision',
      title:
        input.event === 'duplicate_refused'
          ? `Duplicate refused: "${input.title}" (open twin #${input.existingId})`
          : `Duplicate forced: "${input.title}" despite open twin #${input.existingId}`,
      detail: `source=${input.source}`,
      metadata: {
        kind: input.event,
        source: input.source,
        existing_id: input.existingId,
        new_id: input.newId ?? null,
        normalized_title: normalizeTitle(input.title),
      },
    })
  } catch (err) {
    console.warn('[duplicate-guard] failed to record dedupe metric:', (err as Error).message)
  }
}

/** The fields of a card the start-path guard reads. */
export interface StartCandidate {
  id: number
  title: string
  workspace: string
  status: string
  parent_id?: number | null
  routine_id?: number | null
}

/** Twin statuses that mean "the other copy is already running". */
export const RUNNING_TWIN_STATUSES = ['working', 'ai_review'] as const

/**
 * Start-path guard for a queue → working transition: the RUNNING twin (another open
 * card with the same normalized title + workspace, created in the window, currently
 * working/ai_review) or null. Deliberately narrow so existing flows keep working:
 *   - only a `queue` card (reopen from done / restart from review is not a twin start);
 *   - never the card itself, its parent, or its children;
 *   - a routine-spawned card (routine_id set) is skipped: fireRoutine already ran
 *     the create-time guard and the routine's queue-depth guard owns same-routine
 *     cards, so its stranded-card re-spawn must not be blocked here;
 *   - nothing when the kill switch is off.
 */
export function findRunningTwinForStart(db: Database, card: StartCandidate): OpenDuplicate | null {
  if (card.status !== 'queue' || card.routine_id != null) return null
  if (!isDuplicateGuardEnabled(db)) return null
  return findOpenDuplicate(db, {
    title: card.title,
    workspace: card.workspace,
    excludeId: card.id,
    excludeParentId: card.parent_id ?? null,
    statuses: RUNNING_TWIN_STATUSES,
  })
}

/** 409 body for a refused start (the twin is already running). */
export function duplicateStartConflictBody(dup: OpenDuplicate, windowHours: number): Record<string, unknown> {
  return {
    ...duplicateConflictBody(dup, windowHours),
    error: `Twin card #${dup.id} ("${dup.title}") with the same title is already ${dup.status} (created in the last ${windowHours}h). Pass "force": true to start this one anyway.`,
  }
}

/** Standard 409 body for a refused duplicate. */
export function duplicateConflictBody(dup: OpenDuplicate, windowHours: number): Record<string, unknown> {
  return {
    error: `Duplicate of open card #${dup.id} ("${dup.title}", ${dup.status}) created in the last ${windowHours}h. Pass "force": true to create anyway.`,
    reason: 'duplicate_24h',
    duplicate: true,
    existing_id: dup.id,
    existing: { id: dup.id, title: dup.title, status: dup.status, created_at: dup.created_at },
  }
}
