// @vitest-environment jsdom
/** obj 900495 — host cron lives under Jobs, is explained, and has no big empty state. */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import type { ReactElement } from 'react'
import { HostCronJobs, HOST_CRON_EXPLAINER } from './HostCronJobs'

vi.mock('../../lib/api', () => ({ api: { get: vi.fn() } }))

let root: Root | null = null
let host: HTMLDivElement | null = null
afterEach(() => { if (root) flushSync(() => root!.unmount()); host?.remove() })
const render = (el: ReactElement) => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  flushSync(() => root!.render(el))
  return host
}

describe('HostCronJobs', () => {
  it('explains what the list is and collapses to one line when empty', () => {
    const h = render(<HostCronJobs initial={[]} />)
    expect(h.querySelector('#host-cron')).not.toBeNull()
    expect(h.textContent).toContain(HOST_CRON_EXPLAINER)
    expect(h.textContent).not.toContain('No cron jobs found')
    expect(h.querySelector('[data-testid="host-cron-none"]')?.textContent).toBe('None tagged on this server.')
  })

  it('lists tagged jobs', () => {
    const h = render(<HostCronJobs initial={[{ name: 'disk-cleanup', schedule: '0 3 * * *', scheduleHuman: 'Daily at 3:00', scriptPath: '/x/disk-cleanup.sh', logFile: '', logTail: '', logSize: 0, timezone: 'UTC' }]} />)
    expect(h.textContent).toContain('Daily at 3:00')
    expect(h.textContent).toContain('disk-cleanup.sh')
  })
})
