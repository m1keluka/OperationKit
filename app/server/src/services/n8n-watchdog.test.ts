/**
 * n8n-watchdog on hosts WITHOUT n8n (obj 900746).
 *
 * The live OVH install has no n8n containers, yet every boot paged HIGH
 * "n8n is degraded" (n8n=unknown/unknown, n8n-db=unknown/unknown, public
 * healthz=unreachable) with a link to the n8n.example.com placeholder. These tests
 * pin the fix: absent n8n never starts the poll and never alerts, 'absent' is never
 * titled 'degraded', and alert links/probes come only from a real N8N_PUBLIC_URL.
 * Docker, fetch and the alerts table are all injected — nothing here touches the host.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import os from 'os'
import path from 'path'

process.env.DB_PATH = path.join(os.tmpdir(), `cc-n8n-watchdog-${process.pid}-${Date.now()}.db`)

// Belt and braces: emitAlert is injected below, but stub the real sinks so an
// accidental fall-through can never write the alerts table or broadcast.
vi.mock('../ws/index.js', () => ({ broadcast: vi.fn() }))
vi.mock('./notifier.js', () => ({ insertAlert: vi.fn(() => null) }))

const W = await import('./n8n-watchdog.js')
type ContainerState = import('./n8n-watchdog.js').ContainerState

const absent = (name: string): ContainerState =>
  ({ name, exists: false, status: 'absent', health: 'none', exitCode: null, running: false })
const running = (name: string, health = 'healthy'): ContainerState =>
  ({ name, exists: true, status: 'running', health, exitCode: 0, running: true })

function harness(containers: Record<string, ContainerState>, env: NodeJS.ProcessEnv = {}) {
  const alerts: Array<Record<string, unknown>> = []
  const fetchHealthz = vi.fn(async () => ({ ok: true, httpCode: 200, ms: 5 }))
  W.__setN8nWatchdogDepsForTest({
    inspect: name => containers[name] ?? absent(name),
    fetchHealthz,
    emitAlert: a => { alerts.push({ ...a }) },
    env,
  })
  return { alerts, fetchHealthz }
}

beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}) })
afterEach(() => { W.__setN8nWatchdogDepsForTest(); vi.restoreAllMocks() })

describe('host without n8n installed', () => {
  it('does not start on app boot and emits no alert', async () => {
    const h = harness({})
    expect(W.startN8nWatchdog()).toBe(false)
    await new Promise(r => setTimeout(r, 10))
    expect(h.alerts).toEqual([])
    expect(W.getN8nHealth()).toBeNull()
    expect(h.fetchHealthz).not.toHaveBeenCalled()
  })

  it('a forced/manual check classifies it as absent, never degraded, and does not alert', async () => {
    const h = harness({}, { N8N_WATCHDOG: '1', N8N_PUBLIC_URL: 'https://n8n.example.com' })
    expect(W.startN8nWatchdog()).toBe(true)
    const health = await W.refreshN8nHealth()
    expect(health?.status).toBe('absent')
    expect(health?.ok).toBe(false)
    expect(h.alerts).toEqual([])
    expect(h.fetchHealthz).not.toHaveBeenCalled()
  })

  it('manual restart refuses instead of running docker start', () => {
    harness({})
    expect(W.manualRestart()).toEqual({ success: false, detail: expect.stringContaining('not installed') })
  })

  it('N8N_WATCHDOG=0 disables even when n8n is present', () => {
    harness({ n8n: running('n8n') }, { N8N_WATCHDOG: '0' })
    expect(W.startN8nWatchdog()).toBe(false)
  })
})

describe('deriveStatus', () => {
  it('absent n8n is absent, never degraded', () => {
    expect(W.deriveStatus(absent('n8n'), absent('n8n-db'))).toBe('absent')
    expect(W.deriveStatus(absent('n8n'), running('n8n-db'))).toBe('absent')
  })
  it('degraded only for a present, running, unhealthy instance', () => {
    expect(W.deriveStatus(running('n8n', 'unhealthy'), running('n8n-db'))).toBe('degraded')
    expect(W.deriveStatus(running('n8n'), running('n8n-db', 'unhealthy'))).toBe('degraded')
    expect(W.deriveStatus(running('n8n'), running('n8n-db'))).toBe('up')
  })
  it('n8n-db is optional (SQLite installs)', () => {
    expect(W.deriveStatus(running('n8n'), absent('n8n-db'))).toBe('up')
  })
  it('a present but stopped container is down', () => {
    expect(W.deriveStatus({ ...running('n8n'), status: 'exited', running: false }, running('n8n-db'))).toBe('down')
  })
})

describe('installed n8n still pages', () => {
  it('unhealthy instance alerts "n8n is degraded" with no link when N8N_PUBLIC_URL is unset', async () => {
    const h = harness({ n8n: running('n8n', 'unhealthy'), 'n8n-db': running('n8n-db') })
    expect(W.startN8nWatchdog()).toBe(true)
    const health = await W.refreshN8nHealth()
    expect(health?.status).toBe('degraded')
    expect(health?.publicHealthz.configured).toBe(false)
    expect(h.fetchHealthz).not.toHaveBeenCalled()
    const down = h.alerts.find(a => a.dedup_key === 'n8n-watchdog-down')
    expect(down?.title).toBe('n8n is degraded')
    expect(down?.url).toBeUndefined()
    expect(String(down?.message)).toContain('public healthz=not configured')
  })

  it('uses a real N8N_PUBLIC_URL for the probe and alert link', async () => {
    const h = harness({ n8n: running('n8n', 'unhealthy') }, { N8N_PUBLIC_URL: 'https://n8n.acme.io/' })
    await W.refreshN8nHealth()
    expect(h.fetchHealthz).toHaveBeenCalledWith('https://n8n.acme.io/healthz')
    expect(h.alerts[0]?.url).toBe('https://n8n.acme.io/')
  })
})

describe('resolveN8nPublicUrl', () => {
  it('rejects unset, malformed and placeholder hosts', () => {
    for (const v of [undefined, '', 'not a url', 'ftp://n8n.acme.io', 'https://n8n.example.com/',
      'https://example.com', 'http://n8n.example.org', 'https://n8n.local.test', 'https://foo.invalid']) {
      expect(W.resolveN8nPublicUrl({ N8N_PUBLIC_URL: v })).toBeNull()
    }
  })
  it('accepts a real URL and trims the trailing slash', () => {
    expect(W.resolveN8nPublicUrl({ N8N_PUBLIC_URL: 'https://n8n.acme.io/' })).toBe('https://n8n.acme.io')
  })
})
