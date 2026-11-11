// @vitest-environment jsdom
/**
 * obj 900495 — System (was Dashboard): spend disclaimer, no seat widgets, one
 * link to Settings → Models, host stats labelled honestly and aged when stale.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { SystemPage, SPEND_DISCLAIMER } from './SystemPage'
import { MODELS_SETTINGS_ROUTE } from '../lib/routes'

const { apiMock } = vi.hoisted(() => ({
  apiMock: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
}))
vi.mock('../lib/api', () => ({ api: apiMock }))
vi.mock('./ModelsModule', () => ({ ModelsModule: () => null }))
vi.mock('./CostModule', () => ({ CostModule: () => null }))

const SYSTEM = {
  cpu: { cores: 32, model: 'x', usagePercent: 4.2, loadAvg: [1.61, 0.65, 0.35] },
  memory: { total: 270314835968, used: 7656488960, free: 262658347008, usagePercent: 2.8 },
  disk: { total: 941723856896, used: 335487381504, available: 558324105216, usagePercent: 38 },
  uptime: 385980,
  processCount: 10,
  hostname: 'd64a391ec50f',
  platform: 'Linux 6.8.0',
  inContainer: true,
  timestamp: new Date().toISOString(),
}
const ACCOUNTS = {
  accounts: [{ id: 'a', label: 'A', homeDir: '', sessionsToday: 3, tokensToday: 1_500_000, costToday: 12.5, lastRateLimit: null, rateLimitResetsAt: null, activeSessions: ['x'], available: true, windows: { sessionWindow: { tokens: 0, cost: 0, resetsAt: null }, weeklyWindow: { tokens: 0, cost: 0, resetsAt: null } } }],
  queue: [],
  earliestReset: null,
}

async function flush() {
  for (let i = 0; i < 6; i++) { await vi.advanceTimersByTimeAsync(1); flushSync(() => {}) }
}

describe('System page (obj 900495)', () => {
  let root: Root
  let host: HTMLDivElement
  let systemOk = true

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false })
    systemOk = true
    apiMock.get.mockReset()
    apiMock.get.mockImplementation((url: string) => {
      if (url === '/admin/system') return systemOk ? Promise.resolve(SYSTEM) : Promise.reject(new Error('down'))
      if (url === '/admin/accounts') return Promise.resolve(ACCOUNTS)
      return Promise.resolve(null)
    })
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })
  afterEach(() => {
    flushSync(() => root.unmount())
    host.remove()
    vi.useRealTimers()
  })

  const render = async () => {
    flushSync(() => root.render(<MemoryRouter><SystemPage /></MemoryRouter>))
    await flush()
  }

  it('is titled System and carries the exact spend disclaimer', async () => {
    await render()
    expect(host.querySelector('h1')?.textContent).toContain('System')
    expect(host.textContent).not.toContain('Dashboard')
    expect(host.querySelector('[data-testid="spend-disclaimer"]')?.textContent).toBe(SPEND_DISCLAIMER)
    expect(SPEND_DISCLAIMER).toBe('Spend is estimated from public token prices. If you use subscription accounts (Claude, Codex, Grok), this reflects your token volume, not what you are billed.')
  })

  it('labels a container hostname and the process scope honestly', async () => {
    await render()
    expect(host.querySelector('[data-testid="host-label"]')?.textContent).toBe('container d64a391ec50f · Linux 6.8.0')
    expect(host.textContent).toContain('10 processes visible to the server')
    expect(host.textContent).toContain('2.8%')
    expect(host.textContent).toContain('38%')
  })

  it('flags host numbers as stale when the server stops answering', async () => {
    await render()
    expect(host.textContent).not.toContain('stale')
    systemOk = false
    await vi.advanceTimersByTimeAsync(35_000)
    await flush()
    expect(host.textContent).toContain('stale')
    expect(host.textContent).toMatch(/these numbers are from \d+s ago/)
  })
})
