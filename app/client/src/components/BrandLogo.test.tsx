/**
 * Header / sign-in brand mark (obj 900543): the install's uploaded logo when
 * set, the shipped default mark otherwise — never a hardcoded glyph.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import type { ReactNode } from 'react'

// No @testing-library in this repo: mount with createRoot + flushSync and
// poll for async effects (same pattern as hooks/useObjectives.test.tsx).
function mount(node: ReactNode): HTMLElement {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const root = createRoot(el)
  flushSync(() => root.render(node))
  return el
}
async function until(fn: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now()
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for condition')
    await new Promise(r => setTimeout(r, 10))
  }
}
import { BrandLogo, pickBrandMark } from './BrandLogo'
import { DEFAULT_BRANDING, invalidateBranding, type Branding } from '../hooks/useBranding'

const custom = (over: Partial<Branding>): Branding => ({ ...DEFAULT_BRANDING, ...over })

describe('pickBrandMark', () => {
  it('prefers the uploaded wordmark, and its dark variant on dark', () => {
    const b = custom({ wordmark_url: '/w.svg?v=1', wordmark_dark_url: '/wd.svg?v=1', icon_url: '/i.svg' })
    expect(pickBrandMark(b, 'light')).toEqual({ kind: 'wordmark', src: '/w.svg?v=1' })
    expect(pickBrandMark(b, 'dark')).toEqual({ kind: 'wordmark', src: '/wd.svg?v=1' })
  })
  it('falls back to the light wordmark on dark when no dark variant exists', () => {
    expect(pickBrandMark(custom({ wordmark_url: '/w.svg' }), 'dark')).toEqual({ kind: 'wordmark', src: '/w.svg' })
  })
  it('uses the icon when there is no wordmark, or when the slot is too small for one', () => {
    expect(pickBrandMark(custom({ icon_url: '/i.png' }), 'light')).toEqual({ kind: 'icon', src: '/i.png' })
    expect(pickBrandMark(custom({ wordmark_url: '/w.svg', icon_url: '/i.png' }), 'light', { allowWordmark: false }))
      .toEqual({ kind: 'icon', src: '/i.png' })
  })
  it('renders a monogram of the brand name — never a default mark — when nothing is uploaded', () => {
    expect(pickBrandMark(custom({ name: 'northwind Ops', white_label: true }), 'light')).toEqual({ kind: 'monogram', letter: 'N' })
  })
})

describe('<BrandLogo /> with live /api/branding', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  function mockBranding(b: Partial<Branding>) {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(b), { status: 200 }))
  }

  it('shows the uploaded logo once branding loads (not a placeholder, not a glyph)', async () => {
    mockBranding({ name: 'Northwind Ops', icon_url: '/api/branding/icon?v=42', wordmark_url: null, white_label: true })
    await invalidateBranding()
    const el = mount(<BrandLogo theme="light" />)
    const logo = () => el.querySelector('[data-testid="brand-logo"]')
    await until(() => logo()?.getAttribute('data-mark') === 'icon')
    expect(el.querySelector('img')?.getAttribute('src')).toBe('/api/branding/icon?v=42')
    expect(el.textContent).toContain('Northwind Ops')
    expect(el.textContent).not.toContain('›')
  })

  it('shows the shipped default wordmark on a default install', async () => {
    mockBranding({ name: 'Operation Kit', wordmark_url: '/api/branding/wordmark?v=1', icon_url: '/api/branding/icon?v=1' })
    await invalidateBranding()
    const el = mount(<BrandLogo theme="light" />)
    await until(() => el.querySelector('[data-testid="brand-logo"]')?.getAttribute('data-mark') === 'wordmark')
    expect(el.querySelector('img')?.getAttribute('src')).toBe('/api/branding/wordmark?v=1')
    expect(el.querySelector('img')?.getAttribute('alt')).toBe('Operation Kit')
  })

  it('updates every mounted logo immediately after the Branding panel saves', async () => {
    mockBranding({ name: 'Before', icon_url: '/a.png' })
    await invalidateBranding()
    const el = mount(<BrandLogo theme="light" />)
    await until(() => (el.textContent ?? '').includes('Before'))
    await invalidateBranding({ name: 'After', icon_url: '/b.png?v=2' })
    await until(() => (el.textContent ?? '').includes('After'))
    expect(el.querySelector('img')?.getAttribute('src')).toBe('/b.png?v=2')
    expect(document.title).toBe('After')
  })
})
