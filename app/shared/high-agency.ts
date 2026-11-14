/**
 * High Agency schedule math (obj 900748, levels since obj 900794) — shared so the
 * bot settings panel's live "Wakes at …" preview and the server's routine cron
 * can never disagree.
 *
 * A bot's High Agency LEVEL (1–10) sets how many times a day it wakes:
 *
 *   runs_per_day = round(1 + (level - 1) * 23 / 9)
 *
 *   level        1  2  3  4   5   6   7   8   9  10
 *   runs/day     1  4  6  9  11  14  16  19  21  24
 *
 * Level 1 is one wake at night; level 10 is one wake every hour. The wakes are
 * spread across the whole 24-hour day, anchored on the night hour, in the
 * INSTALL timezone (America/New_York unless the operator sets another one).
 *
 * The routine scheduler fires on whole minutes of a 5-field cron, so a wake sits
 * on a whole hour: wake i is at hour NIGHT_HOUR + round(i * 24 / runs). The gaps
 * are therefore as even as whole hours allow — every gap is floor(24/runs) or
 * ceil(24/runs) hours, and exactly equal when runs divides 24 (levels 1, 2, 3,
 * 10). The minute past the hour comes from the bot's slug, so several bots
 * switched on together do not all spawn a session in the same scheduler tick.
 *
 * The routine scheduler matches cron against SERVER-local time (UTC in the
 * container). highAgencyCron() converts the install-timezone wake hours into
 * server time with the offset in force at `at`; the server re-derives it
 * periodically, so a DST change moves the cron with the clocks.
 */

export const HIGH_AGENCY_LEVELS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const
export type HighAgencyLevel = (typeof HIGH_AGENCY_LEVELS)[number]

export const MIN_LEVEL: HighAgencyLevel = 1
export const MAX_LEVEL: HighAgencyLevel = 10
/** The level a bot gets the first time it is switched on (one night-time wake). */
export const DEFAULT_LEVEL: HighAgencyLevel = 1

/** Level 1's single wake, in the install timezone: 02:xx at night. Every level's schedule includes it. */
export const NIGHT_HOUR = 2

/** The install/operator timezone when none is configured. */
export const DEFAULT_INSTALL_TIMEZONE = 'America/New_York'

/**
 * New projects one wake may file. The operating loop is "close out what you own,
 * then choose ONE next project" — so one, not a handful of cards.
 */
export const MAX_NEW_PROJECTS_PER_WAKE = 1

export function isHighAgencyLevel(n: unknown): n is HighAgencyLevel {
  return typeof n === 'number' && (HIGH_AGENCY_LEVELS as readonly number[]).includes(n)
}

/** Wakes per day for a level: 1, 4, 6, 9, 11, 14, 16, 19, 21, 24. */
export function runsPerDay(level: HighAgencyLevel): number {
  return Math.round(1 + ((level - 1) * 23) / 9)
}

/** The install-timezone hours a bot at `level` wakes at, ascending. */
export function wakeHours(level: HighAgencyLevel): number[] {
  const runs = runsPerDay(level)
  const hours = new Set<number>()
  for (let i = 0; i < runs; i++) hours.add((NIGHT_HOUR + Math.round((i * 24) / runs)) % 24)
  return [...hours].sort((a, b) => a - b)
}

/** Stable minute past the hour for this bot (0–59). */
export function wakeMinute(slug: string): number {
  let h = 0
  for (const ch of slug) h = (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0
  return h % 60
}

const pad = (n: number) => String(n).padStart(2, '0')

/** "02:17", "08:17" … — install-timezone wall-clock wake times. */
export function wakeTimes(slug: string, level: HighAgencyLevel): string[] {
  const m = pad(wakeMinute(slug))
  return wakeHours(level).map(h => `${pad(h)}:${m}`)
}

/** Plain-language cadence: "Once a day, at night", "Every hour", "9 times a day (every 2–3 hours)". */
export function levelSummary(level: HighAgencyLevel): string {
  const runs = runsPerDay(level)
  if (runs === 1) return 'Once a day, at night'
  if (runs === 24) return 'Every hour'
  const lo = Math.floor(24 / runs)
  const hi = Math.ceil(24 / runs)
  return `${runs} times a day (every ${lo === hi ? lo : `${lo}–${hi}`} hours)`
}

/** True when `tz` is an IANA timezone this runtime knows. */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz.trim()) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** Minutes `tz` is ahead of UTC at instant `at` (America/New_York: -300 in winter, -240 in summer). */
export function tzOffsetMinutes(tz: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
  }).formatToParts(at)
  const get = (t: string) => Number(parts.find(p => p.type === t)?.value)
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'))
  const atMinute = Math.floor(at.getTime() / 60_000) * 60_000
  return Math.round((asUtc - atMinute) / 60_000)
}

/**
 * The 5-field cron of a bot's wake routine, in SERVER-local time (what the
 * routine scheduler matches against), for the install-timezone schedule as it
 * stands at `at`. Level 10 is `M * * * *`.
 */
export function highAgencyCron(
  slug: string,
  level: HighAgencyLevel,
  opts: { timeZone: string; at?: Date; serverOffsetMinutes?: number },
): string {
  const at = opts.at ?? new Date()
  const local = tzOffsetMinutes(opts.timeZone, at)
  const server = opts.serverOffsetMinutes ?? -at.getTimezoneOffset()
  const shift = server - local
  const minute = wakeMinute(slug)
  const hours = new Set<number>()
  let serverMinute = minute
  for (const h of wakeHours(level)) {
    const t = (((h * 60 + minute + shift) % 1440) + 1440) % 1440
    hours.add(Math.floor(t / 60))
    serverMinute = t % 60 // one offset for the whole day, so every wake shares this minute
  }
  if (hours.size === 24) return `${serverMinute} * * * *`
  return `${serverMinute} ${[...hours].sort((a, b) => a - b).join(',')} * * *`
}
