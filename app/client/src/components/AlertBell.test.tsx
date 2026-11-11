// @vitest-environment jsdom
/**
 * obj 900495 — notifications panel UI: Unread/All, day groups, read state,
 * empty state. Same /api/alerts calls as before (delivery is untouched).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import type { Alert } from '@operationkit/shared'
import { AlertBell, groupByDay, dayGroup } from './AlertBell'

const { apiMock } = vi.hoisted(() => ({ apiMock: { get: vi.fn(), post: vi.fn() } }))
vi.mock('../lib/api', () => ({ api: apiMock }))

const sqlite = (d: Date) => d.toISOString().replace('T', ' ').slice(0, 19)
const mk = (id: number, ageH: number, over: Partial<Alert> = {}): Alert => ({
  id, severity: 'normal', source: 'drift-guard', title: `Alert ${id}`, message: 'm', dedup_key: null, url: null,
  email_sent_at: null, acked_at: null, acked_by: null, created_at: sqlite(new Date(Date.now() - ageH * 3_600_000)), ...over,
})

async function flush() {
  for (let i = 0; i < 6; i++) { await new Promise(r => setTimeout(r, 0)); flushSync(() => {}) }
}

describe('notification grouping', () => {
  it('buckets by local day in Today / Yesterday / Earlier order', () => {
    const now = new Date(2026, 10, 11, 12, 0, 0)
    const at = (d: Date) => sqlite(d)
    expect(dayGroup(at(new Date(2026, 10, 11, 9)), now)).toBe('Today')
    expect(dayGroup(at(new Date(2026, 10, 10, 23)), now)).toBe('Yesterday')
    expect(dayGroup(at(new Date(2026, 10, 2)), now)).toBe('Earlier')
    const groups = groupByDay([mk(1, 0), mk(2, 24 * 9), mk(3, 0.5)], now)
    expect(groups.map(g => g.label)).toEqual(['Today', 'Earlier'])
  })
})

describe('AlertBell panel', () => {
  let host: HTMLDivElement
  let root: Root
  beforeEach(() => {
    apiMock.get.mockReset(); apiMock.post.mockReset()
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  })
  afterEach(() => { flushSync(() => root.unmount()); host.remove() })

  const open = async () => {
    flushSync(() => root.render(<AlertBell />))
    await flush()
    flushSync(() => (host.querySelector('button[aria-haspopup="dialog"]') as HTMLButtonElement).click())
    await flush()
  }

  it('shows a real empty state when nothing is unread', async () => {
    apiMock.get.mockResolvedValue({ alerts: [], unacked_count: 0 })
    await open()
    expect(host.querySelector('[data-testid="notifications-empty"]')?.textContent).toContain('You’re all caught up')
    expect(host.textContent).not.toContain('Mark all read')
    expect(host.querySelector('button[aria-haspopup="dialog"]')?.getAttribute('aria-label')).toBe('Notifications')
  })

  it('unread view: unread rows, count, Mark read removes the row', async () => {
    apiMock.get.mockResolvedValue({ alerts: [mk(1, 0, { severity: 'emergency', title: 'Disk low' }), mk(2, 0)], unacked_count: 2 })
    apiMock.post.mockResolvedValue({ ok: true })
    await open()
    expect(host.querySelector('button[aria-haspopup="dialog"]')?.getAttribute('aria-label')).toBe('Notifications, 2 unread')
    const rows = host.querySelectorAll('[data-testid="notification"]')
    expect(rows).toHaveLength(2)
    expect(rows[0].getAttribute('data-unread')).toBe('true')
    expect(rows[0].textContent).toContain('Urgent')
    expect(host.textContent).toContain('Today')
    const markRead = Array.from(rows[0].querySelectorAll('button')).find(b => b.textContent === 'Mark read')!
    flushSync(() => markRead.click())
    await flush()
    expect(apiMock.post).toHaveBeenCalledWith('/alerts/1/ack')
    expect(host.querySelectorAll('[data-testid="notification"]')).toHaveLength(1)
  })

  it('All view asks for read + unread and renders read rows as read', async () => {
    apiMock.get.mockImplementation((url: string) => Promise.resolve(
      url.includes('unacked=true')
        ? { alerts: [], unacked_count: 0 }
        : { alerts: [mk(5, 30, { acked_at: sqlite(new Date()) })], unacked_count: 0 },
    ))
    await open()
    const allTab = Array.from(host.querySelectorAll('[role="tab"]')).find(t => t.textContent === 'All') as HTMLButtonElement
    flushSync(() => allTab.click())
    await flush()
    expect(apiMock.get).toHaveBeenCalledWith('/alerts?limit=50')
    const row = host.querySelector('[data-testid="notification"]')!
    expect(row.getAttribute('data-unread')).toBe('false')
    expect(row.textContent).not.toContain('Mark read')
  })
})
