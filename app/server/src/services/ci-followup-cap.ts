/**
 * Shared, cross-source per-PR cap on AUTOMATIC "your PR's CI is red" follow-ups.
 *
 * WHY: a token audit found ~$1.5k / 30 days of worker-session restarts caused by
 * automatic CI-failure follow-ups. Several independent engines can each restart a
 * card's worker because its PR is red, and each had (at best) its OWN cap:
 *   - ci-feedback-bridge      (poller; own cap MAX_CI_BRIDGE_NUDGES, default 5)
 *   - external-remediation    (webhook; own cap maxRemediationAttempts)
 *   - ci-green-gate handback  (completion gate `hold` → sendFollowUp; holdCount bound)
 *   - pr-health-watchdog      (`refire-remediation` on a stale red PR)
 * Per-engine caps multiply (5 + 5 + 2 + N per PR). This module is ONE ceiling that
 * every automatic CI-failure follow-up path consults BEFORE restarting a session,
 * counting across ALL sources over a rolling 30-day window keyed on (repo, pr_number).
 * The per-engine caps still apply; this is an additional, cross-source ceiling.
 *
 * Contract for callers:
 *   1. `checkCiFollowupCap(db, {...})` — if `!allowed`, do NOT send. Call
 *      `noteCiFollowupCapExhausted(db, {...})` (console + activity_log + has_blockers,
 *      once per PR per window) and return a cap-exhausted outcome.
 *   2. After a follow-up is actually delivered, `recordCiFollowup(db, {...})`.
 *
 * Default cap 3 per PR; override with settings.ci_followup_cap_per_pr. The table is
 * created lazily (CREATE TABLE IF NOT EXISTS) so no schema migration is needed.
 */
import type { Database } from 'better-sqlite3'

export const DEFAULT_CI_FOLLOWUP_CAP = 3
export const CI_FOLLOWUP_WINDOW_DAYS = 30
export const CI_FOLLOWUP_CAP_SETTING = 'ci_followup_cap_per_pr'

export type CiFollowupSource =
  | 'ci-feedback-bridge'
  | 'external-remediation'
  | 'ci-green-gate'
  | 'pr-health-watchdog'
  | (string & {})

export interface CiFollowupKey {
  repo: string | null | undefined
  prNumber: number
  objectiveId?: number | null
  source: CiFollowupSource
  /** Injected clock for tests. */
  now?: Date
}

export interface CiFollowupCapResult {
  allowed: boolean
  count: number
  cap: number
  windowDays: number
}

export function ensureCiFollowupTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ci_followup_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      objective_id INTEGER,
      source TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'sent',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ci_followup_log_pr ON ci_followup_log (repo, pr_number, kind, created_at);
  `)
}

/** Two repos can reach us with different casing (`your-org` vs `your-org`). */
function normRepo(repo: string | null | undefined): string {
  return (repo || '').trim().toLowerCase()
}

function cutoffIso(now: Date): string {
  return new Date(now.getTime() - CI_FOLLOWUP_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString()
}

/** settings.ci_followup_cap_per_pr (positive integer) or the default 3. */
export function ciFollowupCapPerPr(db: Database): number {
  try {
    const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(CI_FOLLOWUP_CAP_SETTING) as
      | { value: string }
      | undefined
    const n = parseInt((row?.value ?? '').trim(), 10)
    if (Number.isInteger(n) && n > 0) return n
  } catch { /* settings table missing → default */ }
  return DEFAULT_CI_FOLLOWUP_CAP
}

function countSent(db: Database, repo: string, prNumber: number, now: Date): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM ci_followup_log
        WHERE repo = ? AND pr_number = ? AND kind = 'sent' AND created_at > ?`,
    )
    .get(repo, prNumber, cutoffIso(now)) as { n: number } | undefined
  return row?.n || 0
}

/** May an automatic CI-failure follow-up be sent for this PR right now? Never throws
 *  (fails OPEN on a DB error — a broken counter must not wedge remediation). */
export function checkCiFollowupCap(db: Database, key: CiFollowupKey): CiFollowupCapResult {
  const cap = ciFollowupCapPerPr(db)
  try {
    ensureCiFollowupTable(db)
    const count = countSent(db, normRepo(key.repo), key.prNumber, key.now ?? new Date())
    return { allowed: count < cap, count, cap, windowDays: CI_FOLLOWUP_WINDOW_DAYS }
  } catch (err) {
    console.warn('[ci-followup-cap] check failed (failing open):', (err as Error).message)
    return { allowed: true, count: 0, cap, windowDays: CI_FOLLOWUP_WINDOW_DAYS }
  }
}

/** Record a DELIVERED automatic CI-failure follow-up. Best-effort. */
export function recordCiFollowup(db: Database, key: CiFollowupKey): void {
  try {
    ensureCiFollowupTable(db)
    db.prepare(
      `INSERT INTO ci_followup_log (repo, pr_number, objective_id, source, kind, created_at)
       VALUES (?, ?, ?, ?, 'sent', ?)`,
    ).run(normRepo(key.repo), key.prNumber, key.objectiveId ?? null, key.source, (key.now ?? new Date()).toISOString())
  } catch (err) {
    console.warn('[ci-followup-cap] record failed:', (err as Error).message)
  }
}

/**
 * A follow-up was refused by the shared cap. Always logs a console line; ONCE per PR
 * per window it also writes a 'blocker' activity_log row and flags has_blockers on the
 * objective so a human sees the loop has stopped. Returns true when this call was the
 * first (escalating) one. Best-effort, never throws.
 */
export function noteCiFollowupCapExhausted(
  db: Database,
  key: CiFollowupKey,
  result: Pick<CiFollowupCapResult, 'count' | 'cap'>,
): boolean {
  const repo = normRepo(key.repo)
  const now = key.now ?? new Date()
  console.warn(
    `[ci-followup-cap] BLOCKED ${key.source} follow-up for ${repo || '(no repo)'}#${key.prNumber}` +
      ` (obj ${key.objectiveId ?? '?'}): ${result.count}/${result.cap} automatic CI follow-ups already sent` +
      ` in the last ${CI_FOLLOWUP_WINDOW_DAYS}d — not restarting the session.`,
  )
  try {
    ensureCiFollowupTable(db)
    const prior = db
      .prepare(
        `SELECT COUNT(*) AS n FROM ci_followup_log
          WHERE repo = ? AND pr_number = ? AND kind = 'blocked' AND created_at > ?`,
      )
      .get(repo, key.prNumber, cutoffIso(now)) as { n: number }
    db.prepare(
      `INSERT INTO ci_followup_log (repo, pr_number, objective_id, source, kind, created_at)
       VALUES (?, ?, ?, ?, 'blocked', ?)`,
    ).run(repo, key.prNumber, key.objectiveId ?? null, key.source, now.toISOString())
    if (prior.n > 0 || !key.objectiveId || key.objectiveId <= 0) return false

    const title = `CI follow-up cap reached (${result.cap}/PR) — ${repo}#${key.prNumber}`
    const detail =
      `Automatic "your PR's CI is red" follow-ups for ${repo}#${key.prNumber} hit the shared ` +
      `${result.cap}-per-PR cap (${CI_FOLLOWUP_WINDOW_DAYS}-day window, all sources). The ${key.source} ` +
      `follow-up was NOT sent and the worker was NOT restarted. Needs a human. ` +
      `Raise settings.${CI_FOLLOWUP_CAP_SETTING} to allow more.`
    try {
      db.prepare(
        `INSERT INTO activity_log (project, workspace, objective_id, session_id, event_type, title, detail)
         SELECT COALESCE(project, ''), COALESCE(workspace, 'example'), id, session_id, 'blocker', ?, ?
           FROM objectives WHERE id = ?`,
      ).run(title, detail, key.objectiveId)
    } catch (err) {
      console.warn('[ci-followup-cap] activity_log write failed:', (err as Error).message)
    }
    try {
      db.prepare("UPDATE objectives SET has_blockers = 1, updated_at = datetime('now') WHERE id = ?").run(key.objectiveId)
    } catch { /* best-effort */ }
    return true
  } catch (err) {
    console.warn('[ci-followup-cap] note failed:', (err as Error).message)
    return false
  }
}
