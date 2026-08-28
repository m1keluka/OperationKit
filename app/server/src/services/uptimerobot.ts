/**
 * UptimeRobot integration helpers.
 *
 * The API key lives only on the server — never include it in any /api response.
 * In production it's sourced from Doppler (example.prd → UPTIMEROBOT_API_KEY) and
 * hydrated from the native secrets store at boot, so process.env.UPTIMEROBOT_API_KEY
 * is set before this module is imported.
 */

const UR_API_URL = 'https://api.uptimerobot.com/v2/getMonitors'
const CACHE_TTL_MS = 30 * 1000

export class UptimeRobotConfigError extends Error {
  constructor(message = 'UPTIMEROBOT_API_KEY is not configured') {
    super(message)
    this.name = 'UptimeRobotConfigError'
  }
}

export class UptimeRobotApiError extends Error {
  constructor(message: string, public status?: number) {
    super(message)
    this.name = 'UptimeRobotApiError'
  }
}

export function getUptimeRobotApiKey(): string | null {
  const key = process.env.UPTIMEROBOT_API_KEY
  if (!key || key.trim() === '') return null
  return key.trim()
}

// UR getMonitors response (only the bits we use). Their API is well-documented
// at https://uptimerobot.com/api/ — we ask for response_times (last 24h),
// custom_uptime_ratios=30 (30-day uptime %), and skip log entries.
export interface UptimeRobotMonitor {
  id: number
  friendly_name: string
  url: string
  status: number  // 0=paused, 1=not checked yet, 2=up, 8=seems down, 9=down
  // UR returns last_check / create_datetime as either unix seconds or 0 when never checked
  // Their docs are inconsistent — handle both number and string.
  last_check?: number | string
  custom_uptime_ratio?: string  // e.g. "99.876"
  response_times?: Array<{ datetime: number; value: number }>
  average_response_time?: string
}

export interface UptimeRobotResponse {
  stat: 'ok' | 'fail'
  monitors?: UptimeRobotMonitor[]
  error?: { type?: string; message?: string }
  pagination?: { offset: number; limit: number; total: number }
}

interface CacheEntry {
  fetchedAt: number
  data: UptimeRobotResponse
}

let cache: CacheEntry | null = null

export function _resetCacheForTests(): void {
  cache = null
}

/**
 * Fetch the full monitor list from UptimeRobot. Cached in-memory for 30s so
 * multiple connected clients refreshing the status page don't each round-trip
 * to UR. The cache is process-local — fine for a single container.
 */
export async function getMonitors(opts: { force?: boolean } = {}): Promise<UptimeRobotResponse> {
  const apiKey = getUptimeRobotApiKey()
  if (!apiKey) {
    throw new UptimeRobotConfigError()
  }

  const now = Date.now()
  if (!opts.force && cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.data
  }

  const body = new URLSearchParams({
    api_key: apiKey,
    format: 'json',
    response_times: '1',
    response_times_limit: '24',
    logs: '0',
    custom_uptime_ratios: '30',
  })

  let res: Response
  try {
    res = await fetch(UR_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cache-Control': 'no-cache',
      },
      body: body.toString(),
    })
  } catch (err) {
    throw new UptimeRobotApiError(
      `Failed to reach UptimeRobot: ${err instanceof Error ? err.message : 'network error'}`
    )
  }

  if (!res.ok) {
    throw new UptimeRobotApiError(`UptimeRobot returned HTTP ${res.status}`, res.status)
  }

  let json: UptimeRobotResponse
  try {
    json = await res.json() as UptimeRobotResponse
  } catch (err) {
    throw new UptimeRobotApiError(
      `Failed to parse UptimeRobot response: ${err instanceof Error ? err.message : 'invalid JSON'}`
    )
  }

  if (json.stat !== 'ok') {
    throw new UptimeRobotApiError(
      `UptimeRobot API error: ${json.error?.message || JSON.stringify(json.error) || 'unknown'}`
    )
  }

  cache = { fetchedAt: now, data: json }
  return json
}

export type StatusLabel = 'paused' | 'not_checked_yet' | 'up' | 'seems_down' | 'down' | 'unknown'

export function statusLabel(status: number): StatusLabel {
  switch (status) {
    case 0: return 'paused'
    case 1: return 'not_checked_yet'
    case 2: return 'up'
    case 8: return 'seems_down'
    case 9: return 'down'
    default: return 'unknown'
  }
}

// UR returns last_check as either a unix-second integer, "0", or sometimes a string.
// Normalize to ISO string or null.
export function toIso(value: number | string | undefined | null): string | null {
  if (value === undefined || value === null) return null
  const n = typeof value === 'string' ? parseInt(value, 10) : value
  if (!Number.isFinite(n) || n <= 0) return null
  return new Date(n * 1000).toISOString()
}
