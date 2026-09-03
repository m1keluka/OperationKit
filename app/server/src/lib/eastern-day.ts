// Single source of truth for "what calendar day is this instant" on the
// dashboard. Eastern (Mike's TZ + the /api/costs default) via Intl so EST/EDT
// transitions are handled correctly — a "day" is a real local day, not UTC.
export const EASTERN_TZ = 'America/New_York'

const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: EASTERN_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/** Eastern YYYY-MM-DD for an ISO string / epoch / Date (defaults to now). */
export function easternDayKey(at: string | number | Date = new Date()): string {
  return fmt.format(new Date(at))
}
