import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const {
  getMonitors,
  getUptimeRobotApiKey,
  statusLabel,
  toIso,
  UptimeRobotConfigError,
  _resetCacheForTests,
} = await import('./uptimerobot.js')

const mockFetch = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch)
  mockFetch.mockReset()
  _resetCacheForTests()
  delete process.env.UPTIMEROBOT_API_KEY
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function okResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as Response
}

describe('getUptimeRobotApiKey', () => {
  it('returns null when env var is missing', () => {
    expect(getUptimeRobotApiKey()).toBeNull()
  })

  it('returns null when env var is empty / whitespace', () => {
    process.env.UPTIMEROBOT_API_KEY = '   '
    expect(getUptimeRobotApiKey()).toBeNull()
  })

  it('returns trimmed key when set', () => {
    process.env.UPTIMEROBOT_API_KEY = '  ur-key-123  '
    expect(getUptimeRobotApiKey()).toBe('ur-key-123')
  })
})

describe('statusLabel', () => {
  it('maps UR status codes to labels', () => {
    expect(statusLabel(0)).toBe('paused')
    expect(statusLabel(1)).toBe('not_checked_yet')
    expect(statusLabel(2)).toBe('up')
    expect(statusLabel(8)).toBe('seems_down')
    expect(statusLabel(9)).toBe('down')
    expect(statusLabel(42)).toBe('unknown')
  })
})

describe('toIso', () => {
  it('converts unix seconds to ISO', () => {
    expect(toIso(1700000000)).toBe(new Date(1700000000 * 1000).toISOString())
  })

  it('converts numeric strings', () => {
    expect(toIso('1700000000')).toBe(new Date(1700000000 * 1000).toISOString())
  })

  it('returns null for 0 / negative / undefined / null', () => {
    expect(toIso(0)).toBeNull()
    expect(toIso(-1)).toBeNull()
    expect(toIso(undefined)).toBeNull()
    expect(toIso(null)).toBeNull()
  })
})

describe('getMonitors', () => {
  it('throws UptimeRobotConfigError when API key is missing', async () => {
    await expect(getMonitors()).rejects.toBeInstanceOf(UptimeRobotConfigError)
  })

  it('POSTs form-encoded body with documented params and returns parsed JSON', async () => {
    process.env.UPTIMEROBOT_API_KEY = 'test-ur-key'
    mockFetch.mockResolvedValueOnce(okResponse({ stat: 'ok', monitors: [] }))

    const result = await getMonitors()
    expect(result).toEqual({ stat: 'ok', monitors: [] })

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, opts] = mockFetch.mock.calls[0]
    expect(url).toBe('https://api.uptimerobot.com/v2/getMonitors')
    expect(opts.method).toBe('POST')
    expect(opts.headers['Content-Type']).toBe('application/x-www-form-urlencoded')
    expect(opts.body).toContain('api_key=test-ur-key')
    expect(opts.body).toContain('format=json')
    expect(opts.body).toContain('response_times=1')
    expect(opts.body).toContain('response_times_limit=24')
    expect(opts.body).toContain('logs=0')
    expect(opts.body).toContain('custom_uptime_ratios=30')
  })

  it('caches results for 30s — repeat calls within window do NOT hit fetch', async () => {
    process.env.UPTIMEROBOT_API_KEY = 'test-ur-key'
    mockFetch.mockResolvedValueOnce(okResponse({ stat: 'ok', monitors: [{ id: 1 }] }))

    const a = await getMonitors()
    const b = await getMonitors()
    const c = await getMonitors()

    expect(a).toBe(b)
    expect(b).toBe(c)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('refetches after cache TTL expires', async () => {
    process.env.UPTIMEROBOT_API_KEY = 'test-ur-key'
    mockFetch
      .mockResolvedValueOnce(okResponse({ stat: 'ok', monitors: [{ id: 1 }] }))
      .mockResolvedValueOnce(okResponse({ stat: 'ok', monitors: [{ id: 2 }] }))

    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-26T10:00:00Z'))
    const first = await getMonitors()
    expect(first.monitors?.[0].id).toBe(1)

    // 31 seconds later — should refetch
    vi.setSystemTime(new Date('2026-04-26T10:00:31Z'))
    const second = await getMonitors()
    expect(second.monitors?.[0].id).toBe(2)
    expect(mockFetch).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('force=true bypasses cache', async () => {
    process.env.UPTIMEROBOT_API_KEY = 'test-ur-key'
    mockFetch
      .mockResolvedValueOnce(okResponse({ stat: 'ok', monitors: [{ id: 1 }] }))
      .mockResolvedValueOnce(okResponse({ stat: 'ok', monitors: [{ id: 2 }] }))

    await getMonitors()
    await getMonitors({ force: true })
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('throws on UR stat=fail response', async () => {
    process.env.UPTIMEROBOT_API_KEY = 'test-ur-key'
    mockFetch.mockResolvedValueOnce(okResponse({ stat: 'fail', error: { message: 'bad key' } }))
    await expect(getMonitors()).rejects.toThrow(/bad key/)
  })

  it('throws on HTTP non-2xx', async () => {
    process.env.UPTIMEROBOT_API_KEY = 'test-ur-key'
    mockFetch.mockResolvedValueOnce({ ok: false, status: 502, json: async () => ({}) } as Response)
    await expect(getMonitors()).rejects.toThrow(/HTTP 502/)
  })
})
