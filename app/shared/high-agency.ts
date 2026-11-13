/**
 * High Agency schedule math (obj 900748) — shared so the bot settings panel's
 * live "Wakes at …" preview and the server's routine cron can never disagree.
 *
 * A bot with High Agency on wakes `times` times a day, spread evenly over a
 * 12-hour working window that starts at `firstHour` (UTC, like every routine:
 * the scheduler matches cron against server time and the container runs UTC).
 * The minute past the hour is derived from the bot's slug, so several bots
 * switched on at "9:00" do not all spawn a session in the same scheduler tick.
 */

/** Wakes per day the panel offers. 6 = every two hours across the window. */
export const HIGH_AGENCY_CADENCES = [1, 2, 3, 4, 6] as const
export type HighAgencyCadence = (typeof HIGH_AGENCY_CADENCES)[number]

export const WAKE_WINDOW_HOURS = 12
export const DEFAULT_FIRST_HOUR = 9
/** Upper bound on new board cards one wake may file (stated in the wake's brief). */
export const MAX_CARDS_PER_WAKE = 3

export function isHighAgencyCadence(n: unknown): n is HighAgencyCadence {
  return typeof n === 'number' && (HIGH_AGENCY_CADENCES as readonly number[]).includes(n)
}

/** The UTC hours a bot wakes at, ascending. */
export function wakeHours(times: HighAgencyCadence, firstHour: number): number[] {
  const step = times > 1 ? WAKE_WINDOW_HOURS / times : 0
  const hours = new Set<number>()
  for (let i = 0; i < times; i++) hours.add((firstHour + Math.round(i * step)) % 24)
  return [...hours].sort((a, b) => a - b)
}

/** Stable minute past the hour for this bot (0–59). */
export function wakeMinute(slug: string): number {
  let h = 0
  for (const ch of slug) h = (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0
  return h % 60
}

/** The 5-field cron of a bot's wake routine. */
export function highAgencyCron(slug: string, times: HighAgencyCadence, firstHour: number): string {
  return `${wakeMinute(slug)} ${wakeHours(times, firstHour).join(',')} * * *`
}

/** "09:17", "15:17" — UTC wall-clock wake times. */
export function wakeTimes(slug: string, times: HighAgencyCadence, firstHour: number): string[] {
  const m = String(wakeMinute(slug)).padStart(2, '0')
  return wakeHours(times, firstHour).map(h => `${String(h).padStart(2, '0')}:${m}`)
}
