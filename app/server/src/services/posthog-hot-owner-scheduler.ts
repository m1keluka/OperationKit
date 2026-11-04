// PostHog hot_owner sync scheduler (obj 900091) — the Command Center schedule that
// replaces the Grok routine "Refresh PostHog hot_owner flag".
//
// Design notes:
// - Lightweight minute-tick scheduler (mirrors briefing-nudge.ts). It does NOT spawn a
//   Claude session — every fire runs runHotOwnerSync() directly. Deterministic, no LLM.
// - Fires every 30 min, weekdays only, 08:00-19:30 America/New_York (DST-aware via Intl,
//   same technique as briefing-nudge.ts). The underlying routines-table cron matcher only
//   understands server-local/UTC time, so a fixed UTC cron would drift an hour off the
//   requested ET window across the DST change — this ticker checks real ET wall time
//   every minute instead.
// - Gated by settings key `posthog_hot_owner_sync_enabled` (default ON), independent of
//   the routines-table kill switch and every other schedule in this repo.
// - Silent on success. Alerts Mike (notify(), high severity) only when a run makes the
//   consecutive-failure streak hit exactly 3 (shouldAlert()), so an ongoing outage pages
//   once, not every 30 minutes.
import { getDb } from '../db/index.js'
import { notify } from './notifier.js'
import {
  runHotOwnerSync,
  failureStreak,
  shouldAlert,
  HOT_OWNER_COHORT_ID,
  type HotOwnerChange,
} from '../lib/posthog-hot-owner-sync.js'

const CHECK_INTERVAL_MS = 60 * 1000
const EASTERN_TZ = 'America/New_York'
const WINDOW_START_MIN = 8 * 60 // 08:00
const WINDOW_END_MIN = 19 * 60 + 30 // 19:30
const SETTINGS_KEY = 'posthog_hot_owner_sync_enabled'

let schedulerTimer: ReturnType<typeof setInterval> | null = null
let lastFiredSlot: string | null = null // "YYYY-MM-DD HH:MM" (ET) of the last fired slot

// Current wall-clock in Eastern time, DST-aware, as zero-padded parts + weekday (0=Sun).
function nowEastern(at: Date = new Date()): { date: string; hour: number; minute: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: EASTERN_TZ,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  }).formatToParts(at)
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? ''
  const hour = get('hour') === '24' ? 0 : parseInt(get('hour'), 10)
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hour,
    minute: parseInt(get('minute'), 10),
    weekday: weekdayMap[get('weekday')] ?? -1,
  }
}

/** Weekday, on a 30-min boundary, inside [08:00, 19:30] ET inclusive. */
export function isWithinSchedule(at: Date = new Date()): boolean {
  const { hour, minute, weekday } = nowEastern(at)
  if (weekday < 1 || weekday > 5) return false
  if (minute !== 0 && minute !== 30) return false
  const minutesOfDay = hour * 60 + minute
  return minutesOfDay >= WINDOW_START_MIN && minutesOfDay <= WINDOW_END_MIN
}

export function hotOwnerSyncEnabled(): boolean {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(SETTINGS_KEY) as { value: string } | undefined
  return row ? row.value === '1' : true // default ON
}

export function setHotOwnerSyncEnabled(enabled: boolean): void {
  getDb()
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(SETTINGS_KEY, enabled ? '1' : '0')
}

export interface HotOwnerRunSummary {
  ok: boolean
  runId: number
  cohortMembers?: number
  flaggedBefore?: number
  setTrue?: number
  setFalse?: number
  changes: number
  error?: string
  alerted?: boolean
}

/** One run: records the run row, diffs+writes, logs the undo rows BEFORE sending, and
 *  alerts on the 3rd consecutive failure. Never throws — callers get ok:false + error. */
export async function runOnce(source: 'schedule' | 'run-now', dryRun = false): Promise<HotOwnerRunSummary> {
  const db = getDb()
  const insert = db
    .prepare('INSERT INTO posthog_hot_owner_sync_runs (source, dry_run, status) VALUES (?, ?, ?)')
    .run(source, dryRun ? 1 : 0, 'running')
  const runId = Number(insert.lastInsertRowid)

  const logChanges = async (changes: HotOwnerChange[]): Promise<void> => {
    const stmt = db.prepare(
      `INSERT INTO posthog_hot_owner_undo_log (run_id, person_uuid, distinct_id, property, previous_value, new_value, reason)
       VALUES (?, ?, ?, 'hot_owner', ?, ?, ?)`
    )
    const insertMany = db.transaction((rows: HotOwnerChange[]) => {
      for (const c of rows) {
        stmt.run(runId, c.uuid, c.distinctId, JSON.stringify(c.previous ?? null), c.next ? 1 : 0, c.reason)
      }
    })
    insertMany(changes)
  }

  try {
    const result = await runHotOwnerSync({ dryRun, onChanges: logChanges })
    db.prepare(
      `UPDATE posthog_hot_owner_sync_runs
       SET status = 'ok', finished_at = datetime('now'), cohort_members = ?, flagged_before = ?, set_true = ?, set_false = ?
       WHERE id = ?`
    ).run(result.cohortMembers, result.flaggedBefore, result.setTrue, result.setFalse, runId)
    return {
      ok: true,
      runId,
      cohortMembers: result.cohortMembers,
      flaggedBefore: result.flaggedBefore,
      setTrue: result.setTrue,
      setFalse: result.setFalse,
      changes: result.changes.length,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    db.prepare(
      "UPDATE posthog_hot_owner_sync_runs SET status = 'error', finished_at = datetime('now'), error = ? WHERE id = ?"
    ).run(message.slice(0, 1000), runId)

    let alerted = false
    if (!dryRun) {
      const recent = db
        .prepare(
          "SELECT status FROM posthog_hot_owner_sync_runs WHERE dry_run = 0 AND status != 'running' ORDER BY started_at DESC LIMIT 5"
        )
        .all() as { status: string }[]
      const streak = failureStreak(recent.map((r) => r.status))
      if (shouldAlert(streak)) {
        await notify({
          severity: 'high',
          source: 'posthog-hot-owner-sync',
          title: `PostHog hot_owner sync failed ${streak} runs in a row`,
          message: `#website hot-visitor pings may be out of sync with cohort ${HOT_OWNER_COHORT_ID}. Latest error: ${message.slice(0, 300)}`,
          dedup_key: 'posthog-hot-owner-sync-streak-3',
        })
        alerted = true
        db.prepare('UPDATE posthog_hot_owner_sync_runs SET alerted = 1 WHERE id = ?').run(runId)
      }
    }
    return { ok: false, runId, error: message, changes: 0, alerted }
  }
}

/**
 * Start the PostHog hot_owner sync scheduler.
 * Fires every 30 min, weekdays 08:00-19:30 America/New_York (DST-aware).
 * Controlled by settings.posthog_hot_owner_sync_enabled (default: on).
 */
export function startPostHogHotOwnerScheduler(): void {
  if (schedulerTimer) return

  schedulerTimer = setInterval(() => {
    if (!hotOwnerSyncEnabled()) return
    const now = new Date()
    if (!isWithinSchedule(now)) return
    const { date, hour, minute } = nowEastern(now)
    const slot = `${date} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
    if (lastFiredSlot === slot) return
    lastFiredSlot = slot
    runOnce('schedule')
      .then((r) => console.log(`[posthog-hot-owner-sync] ${slot} ET: ${r.ok ? `ok (${r.changes} changes)` : `FAILED: ${r.error}`}`))
      .catch((err) => console.error('[posthog-hot-owner-sync] scheduled run threw:', err))
  }, CHECK_INTERVAL_MS)

  console.log('[posthog-hot-owner-sync] Scheduler started — weekdays 08:00-19:30 America/New_York, every 30 min')
}

export function stopPostHogHotOwnerScheduler(): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer)
    schedulerTimer = null
  }
  lastFiredSlot = null
}
