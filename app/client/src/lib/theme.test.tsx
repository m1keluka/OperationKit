/**
 * Theme persistence (obj 900543). One store (`ok-theme`) painted on
 * <html data-theme>; the topbar toggle must flip the WHOLE app, persist across
 * reloads, migrate the old board-only key, and follow the OS when unset.
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
import { initTheme, setTheme, resolveTheme, THEME_KEY, LEGACY_THEME_KEY } from './theme'
import { BoardThemeProvider, BoardShell, useBoardTheme } from '../preview/BoardShell'

function mockSystem(dark: boolean) {
  window.matchMedia = vi.fn().mockImplementation((q: string) => ({
    matches: dark && q.includes('dark'),
    media: q,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia
}

function Toggle() {
  const { theme, toggleTheme } = useBoardTheme()
  return <button onClick={toggleTheme}>theme:{theme}</button>
}

describe('theme store', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
    mockSystem(false)
  })

  it('follows the OS preference when the user never chose', () => {
    mockSystem(true)
    expect(initTheme()).toBe('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    mockSystem(false)
    expect(initTheme()).toBe('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  })

  it('an explicit choice wins over the OS and persists across reloads', () => {
    mockSystem(true)
    setTheme('light')
    expect(localStorage.getItem(THEME_KEY)).toBe('light')
    document.documentElement.removeAttribute('data-theme') // "reload"
    expect(initTheme()).toBe('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  })

  it('migrates the old board-only key once, then removes it', () => {
    localStorage.setItem(LEGACY_THEME_KEY, 'dark')
    expect(initTheme()).toBe('dark')
    expect(localStorage.getItem(THEME_KEY)).toBe('dark')
    expect(localStorage.getItem(LEGACY_THEME_KEY)).toBeNull()
  })

  it('the topbar toggle repaints <html> (not just the board) and persists', () => {
    setTheme('light')
    const el = mount(
      <BoardThemeProvider>
        <Toggle />
        <BoardShell><div>board</div></BoardShell>
      </BoardThemeProvider>,
    )
    const btn = () => el.querySelector('button') as HTMLButtonElement
    expect(btn().textContent).toBe('theme:light')
    flushSync(() => btn().click())
    expect(btn().textContent).toBe('theme:dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(localStorage.getItem(THEME_KEY)).toBe('dark')
    expect(resolveTheme()).toBe('dark')
    // The board no longer carries its own theme attribute that could disagree.
    expect(document.querySelector('.cc-ws')?.hasAttribute('data-theme')).toBe(false)
    flushSync(() => btn().click())
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    expect(localStorage.getItem(THEME_KEY)).toBe('light')
  })
})
