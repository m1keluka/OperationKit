// @vitest-environment jsdom
/**
 * Seats on the System page (formerly Dashboard).
 *
 * History: obj 720368 made the Dashboard's subscription panel the SAME seat list
 * as Settings → Seats. obj 900495 (Sprint 4a) removed every seat widget from the
 * page — the seat list, the "Accounts n/m" tile and the per-seat rate-limit table —
 * and replaced them with ONE link to Settings > Models (MODELS_SETTINGS_ROUTE).
 * Seat-list behaviour itself is still covered on SeatPool (SeatPool.rename.test.tsx,
 * settings/SeatPool.oneplace.test.tsx). This file pins the new contract.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { SystemPage } from './SystemPage'
import { MODELS_SETTINGS_ROUTE } from '../lib/routes'

const { apiMock } = vi.hoisted(() => ({
  apiMock: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
}))
vi.mock('../lib/api', () => ({ api: apiMock }))
vi.mock('./ModelsModule', () => ({ ModelsModule: () => null }))
vi.mock('./CostModule', () => ({ CostModule: () => null }))

const win = { tokens: 0, cost: 0, resetsAt: null }
const account = (id: string, kind: string) => ({
  id, label: id, kind, homeDir: '', sessionsToday: 1, tokensToday: 10, costToday: 1, lastRateLimit: null,
  rateLimitResetsAt: null, activeSessions: [], available: true, windows: { sessionWindow: win, weeklyWindow: win },
})

describe('System page — no seat widgets (obj 900495)', () => {
  let root: Root
  let host: HTMLDivElement

  beforeEach(() => {
    vi.useFakeTimers()
    apiMock.get.mockReset()
    apiMock.get.mockImplementation((url: string) => {
      if (url === '/admin/accounts') return Promise.resolve({ accounts: [account('a', 'claude'), account('codex', 'codex')], queue: [], earliestReset: null })
      if (url === '/admin/seats') return Promise.resolve({ seats: [] })
      if (url.startsWith('/admin/rate-limits')) return Promise.resolve([{ timestamp: new Date().toISOString(), accountId: 'a', label: 'a', tokensAtLimit: 1, sessionsAtLimit: 1, costAtLimit: 1, activeSessions: 1, resetTime: new Date().toISOString() }])
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

  it('renders no seat list, no Accounts tile, no rate-limit table — one Models link instead', async () => {
    flushSync(() => root.render(<MemoryRouter><SystemPage /></MemoryRouter>))
    for (let i = 0; i < 6; i++) { await vi.advanceTimersByTimeAsync(1); flushSync(() => {}) }
    expect(host.textContent).toContain('Tokens') // data has landed
    expect(apiMock.get).not.toHaveBeenCalledWith('/admin/seats')
    expect(apiMock.get).not.toHaveBeenCalledWith(expect.stringMatching(/^\/admin\/rate-limits/))
    expect(host.querySelector('[data-testid^="seat-"]')).toBeNull()
    expect(host.textContent).not.toMatch(/Subscription seats|Manage seats|Add Claude seat|Rate Limit History|available/i)
    const link = host.querySelector('[data-testid="manage-ai-accounts"]') as HTMLAnchorElement
    expect(link.textContent).toBe('Manage AI accounts in Settings > Models')
    expect(link.getAttribute('href')).toBe(MODELS_SETTINGS_ROUTE)
  })
})
