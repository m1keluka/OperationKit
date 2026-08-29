// Single source of truth for "what calendar day is this instant" on the
// dashboard. Resolved via Intl so DST transitions are handled correctly — a
// "day" is a real local day in the dashboard timezone, not UTC.
//
// Set DASHBOARD_TIMEZONE to any IANA zone (e.g. "Europe/Berlin") to move the
// day boundary. The default stays America/New_York for backwards compatibility
// with existing installs and the /api/costs default.
export const DEFAULT_DASHBOARD_TZ = 'America/New_York'

function resolveDashboardTz(): string {
  const raw = (process.env.DASHBOARD_TIMEZONE || '').trim()
  if (!raw) return DEFAULT_DASHBOARD_TZ
  try {
    // Throws RangeError on an unknown / malformed IANA zone.
    new Intl.DateTimeFormat('en-CA', { timeZone: raw })
    return raw
  } catch {
    console.warn(
      `[eastern-day] invalid DASHBOARD_TIMEZONE="${raw}" — falling back to ${DEFAULT_DASHBOARD_TZ}`,
    )
    return DEFAULT_DASHBOARD_TZ
  }
}

/**
 * The dashboard's calendar timezone. Still exported as EASTERN_TZ so existing
 * import sites keep working; the value is now configurable.
 */
export const EASTERN_TZ = resolveDashboardTz()

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
