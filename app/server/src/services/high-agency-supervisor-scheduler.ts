/**
 * The daily tick for the High Agency supervisor (obj 900795). The review itself
 * is `high-agency-supervisor.ts`; this file only decides WHEN to run it and
 * leaves one line in the activity feed afterwards.
 *
 * Settings (read at point of use, no restart):
 *   high_agency_supervisor_enabled   '0'/'false'/'off' turns the daily run off.
 *                                    Default ON: the run only reads the board and
 *                                    writes routed review items, so it is safe to
 *                                    leave on. Env CC_HIGH_AGENCY_SUPERVISOR_ENABLED
 *                                    is the fallback.
 *   high_agency_supervisor_hour      Hour of the operator's day (America/New_York,
 *                                    0–23) from which the daily run may fire.
 *                                    Default 6, so flags are ready before the
 *                                    morning. A schedule, not a threshold.
 *
 * Started only on the real host instance (index.ts host-daemon block), never on
 * a scratch server.
 */
import { getDb } from '../db/index.js'
import { logActivity } from '../routes/feed.js'
import { listAgents } from './agent-chat/engine.js'
import {
  operatorHour,
  recordSupervisorFailure,
  runSupervisor,
  type SupervisorRunResult,
} from './high-agency-supervisor.js'
import type Database from 'better-sqlite3'

export const DEFAULT_SUPERVISOR_HOUR = 6
const TICK_MS = 5 * 60_000

function setting(db: Database.Database, key: string): string | undefined {
  try {
    return (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value?: string } | undefined)?.value ?? undefined
  } catch {
    return undefined
  }
}

export function supervisorEnabled(db: Database.Database, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = setting(db, 'high_agency_supervisor_enabled') ?? env.CC_HIGH_AGENCY_SUPERVISOR_ENABLED
  if (raw == null || raw.trim() === '') return true
  return !['0', 'false', 'off', 'no'].includes(raw.trim().toLowerCase())
}

export function supervisorHour(db: Database.Database): number {
  const n = Number(setting(db, 'high_agency_supervisor_hour'))
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : DEFAULT_SUPERVISOR_HOUR
}

/**
 * Slugs of the installed bot files. Unreadable OR empty → undefined, which makes
 * the review trust the High Agency rows: an agents dir that is briefly missing
 * must not call every bot "removed" and flag all of its cards as orphaned.
 */
export function installedBots(): string[] | undefined {
  try {
    const slugs = listAgents().agents.map((a) => a.slug)
    return slugs.length ? slugs : undefined
  } catch {
    return undefined
  }
}

/** One line in the activity feed — only when the run changed something. */
function logRun(r: SupervisorRunResult): void {
  if (r.skipped || (!r.filed && !r.withdrawn)) return
  const bot = r.flags.filter((f) => f.route === 'bot').length
  const human = r.flags.length - bot
  try {
    logActivity({
      project: 'operationkit',
      event_type: 'decision',
      title: `Supervisor daily review: ${r.filed} new flag${r.filed === 1 ? '' : 's'}, ${r.withdrawn} cleared`,
      detail:
        `${r.cards} card(s) across ${r.bots.length} High Agency bot(s). Live flags: ${bot} routed to bots, ${human} to a human. ` +
        (r.checks_off.length ? `Off: ${r.checks_off.map((c) => c.check).join(', ')}.` : ''),
      metadata: {
        kind: 'high_agency_supervisor_review',
        run_id: r.run_id,
        trigger: r.trigger,
        filed: r.filed,
        withdrawn: r.withdrawn,
        resurfaced: r.resurfaced,
        settled: r.settled,
        flags: r.flags.map((f) => ({ kind: f.kind, objective_id: f.objective_id, routed_to: f.routed_to })),
      },
    })
  } catch { /* the activity feed is best-effort */ }
}

/** Run now (operator) or on the tick (schedule). Never throws. */
export function runSupervisorNow(trigger: 'schedule' | 'manual', now: Date = new Date()): SupervisorRunResult | { error: string } {
  const db = getDb()
  try {
    const r = runSupervisor(db, { trigger, now, knownBots: installedBots() })
    if (!r.skipped) {
      console.log(`[supervisor] ${trigger} review ${r.run_date}: ${r.cards} card(s), ${r.flags.length} flag(s), ${r.filed} filed, ${r.withdrawn} withdrawn`)
    }
    logRun(r)
    return r
  } catch (err) {
    console.error('[supervisor] review failed:', err instanceof Error ? err.message : err)
    recordSupervisorFailure(db, trigger, err, now)
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/** Should the daily run fire on this tick? Exported for tests. */
export function dueNow(db: Database.Database, now: Date, env: NodeJS.ProcessEnv = process.env): boolean {
  return supervisorEnabled(db, env) && operatorHour(now) >= supervisorHour(db)
}

let timer: ReturnType<typeof setInterval> | null = null

export function startHighAgencySupervisor(): void {
  if (timer) return
  const tick = () => {
    try {
      const now = new Date()
      // runSupervisor itself refuses a second scheduled run on the same day
      // (UNIQUE index), so a restart or a slow tick cannot double-file.
      if (dueNow(getDb(), now)) runSupervisorNow('schedule', now)
    } catch (err) {
      console.error('[supervisor] tick failed:', err instanceof Error ? err.message : err)
    }
  }
  timer = setInterval(tick, TICK_MS)
  timer.unref?.()
  console.log(`[supervisor] High Agency supervisor scheduled — daily from ${supervisorHour(getDb())}:00 America/New_York`)
}
