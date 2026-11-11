// @vitest-environment jsdom
/**
 * obj 900495 — every moved page keeps its old URL as a redirect. Drives the
 * SAME LEGACY_REDIRECTS table App.tsx renders through a real router.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { LEGACY_REDIRECTS, REMOVED_ROUTES, SYSTEM_ROUTE, MODELS_SETTINGS_ROUTE } from './routes'

function Where() {
  const l = useLocation()
  return <div data-testid="where">{l.pathname + l.search + l.hash}</div>
}

let root: Root | null = null
let host: HTMLDivElement | null = null
afterEach(() => { if (root) flushSync(() => root!.unmount()); host?.remove(); root = null; host = null })

async function landOn(from: string): Promise<string> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  flushSync(() => {
    root!.render(
      <MemoryRouter initialEntries={[from]}>
        <Routes>
          {LEGACY_REDIRECTS.map(r => <Route key={r.from} path={r.from} element={<Navigate to={r.to} replace />} />)}
          {REMOVED_ROUTES.map(p => <Route key={p} path={p} element={<Navigate to="/" replace />} />)}
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>,
    )
  })
  for (let i = 0; i < 4; i++) { await new Promise(r => setTimeout(r, 0)); flushSync(() => {}) }
  return host!.querySelector('[data-testid="where"]')?.textContent ?? ''
}

describe('legacy redirects (obj 900495)', () => {
  it.each([
    ['/dashboard', '/system'],
    ['/costs', '/system'],
    ['/agent-templates', '/agents?tab=templates'],
    ['/settings/agents', '/agents?tab=registry'],
    ['/settings/platform', '/jobs#host-cron'],
  ])('%s → %s', async (from, to) => {
    expect(await landOn(from)).toBe(to)
  })

  it('the new System URL is not itself redirected', async () => {
    expect(await landOn(SYSTEM_ROUTE)).toBe('/system')
  })

  it('the Models link resolves to a route that exists today (4b flips it to /settings/models)', () => {
    expect(['/settings/seats', '/settings/models']).toContain(MODELS_SETTINGS_ROUTE)
  })
})

describe('removed unfinished surfaces redirect to the board (obj 900543)', () => {
  it.each([
    '/loops', '/feed', '/strategies', '/strategy', '/strategy/12',
    '/development', '/development/DEV-4', '/feedback', '/status', '/contacts',
  ])('%s → /', async (from) => {
    expect(await landOn(from)).toBe('/')
  })

  it('does not swallow live routes that share a prefix', async () => {
    expect(await landOn('/knowledge/setup')).toBe('/knowledge/setup')
    expect(await landOn('/jobs')).toBe('/jobs')
  })
})
