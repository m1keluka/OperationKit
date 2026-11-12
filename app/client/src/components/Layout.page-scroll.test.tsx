// @vitest-environment jsdom
/**
 * obj 900680 — Settings scrolls the PAGE, not a nested inner scroller.
 * The inner scroller (PageContainer's h-full overflow-y-auto inside <main>
 * overflow-hidden) cut off the bottom of Settings. In page-scroll mode the
 * shell grows with its content, <main> does not clip, the top bars stick, and
 * nothing on the way down from the shell to the page content is a vertical
 * scroll container. The board keeps its fixed-height shell.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { Layout } from './Layout'
import { PageContainer } from './ui/PageContainer'
import { usesPageScroll } from '../lib/routes'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 1, username: 'operator', role: 'admin', workspaces: [] }, logout: vi.fn() }),
}))
vi.mock('../context/nav', () => ({ useNavigate: () => vi.fn() }))
vi.mock('../preview/BoardShell', () => ({ useBoardTheme: () => ({ theme: 'dark', toggleTheme: vi.fn() }) }))
vi.mock('../hooks/useWorkspaces', () => ({
  useWorkspaces: () => ({ workspaces: [], slugs: [], labelOf: (s: string) => s, shortOf: (s: string) => s, loading: false }),
}))
vi.mock('./CommandPalette', () => ({ CommandPalette: () => null }))
vi.mock('./AlertBell', () => ({ AlertBell: () => null }))
vi.mock('../lib/optional-pages', () => ({ HAS_CHAT_PAGE: true }))

/** Tailwind classes that make an element a vertical scroller or clip it. */
const SCROLL_OR_CLIP_Y = /(^|\s)(overflow-(y-)?(auto|scroll|hidden)|h-full|h-screen)(\s|$)/

describe('usesPageScroll', () => {
  it('is on for every Settings URL and off elsewhere', () => {
    expect(usesPageScroll('/settings')).toBe(true)
    expect(usesPageScroll('/settings/models')).toBe(true)
    expect(usesPageScroll('/settings/api-mcp')).toBe(true)
    expect(usesPageScroll('/')).toBe(false)
    expect(usesPageScroll('/w/example')).toBe(false)
    expect(usesPageScroll('/jobs')).toBe(false)
    expect(usesPageScroll('/settingsx')).toBe(false)
  })
})

describe('Layout + PageContainer — single page scroll (obj 900680)', () => {
  let host: HTMLElement
  let root: Root
  beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host) })
  afterEach(() => { flushSync(() => root.unmount()); host.remove() })

  const mount = (pageScroll: boolean) => {
    flushSync(() => root.render(
      <Layout selectedWorkspaces={[]} onWorkspacesChange={() => {}} pageScroll={pageScroll}>
        <PageContainer scroll={pageScroll ? 'page' : 'container'}><div data-testid="content">settings</div></PageContainer>
      </Layout>,
    ))
    return host.querySelector('[data-testid="content"]') as HTMLElement
  }

  it('page-scroll: no ancestor of the content is a vertical scroller or clipper', () => {
    const content = mount(true)
    const offenders: string[] = []
    for (let el = content.parentElement; el && el !== host; el = el.parentElement) {
      if (SCROLL_OR_CLIP_Y.test(el.className)) offenders.push(`<${el.tagName.toLowerCase()} class="${el.className}">`)
    }
    expect(offenders).toEqual([])
    const shell = host.querySelector('[data-scroll-mode]') as HTMLElement
    expect(shell.dataset.scrollMode).toBe('page')
    expect(shell.className).toContain('min-h-full')
    // Horizontal guarantee kept, via clip (which does not create a scroll container).
    expect(shell.className).toContain('overflow-x-clip')
  })

  it('page-scroll: both top bars stick to the top of the viewport', () => {
    mount(true)
    const headers = Array.from(host.querySelectorAll('header'))
    expect(headers.length).toBe(2)
    for (const h of headers) expect(h.className).toMatch(/(^|\s)sticky top-0(\s|$)/)
  })

  it('default (board) keeps the fixed-height shell with one inner scroller', () => {
    mount(false)
    const shell = host.querySelector('[data-scroll-mode]') as HTMLElement
    expect(shell.dataset.scrollMode).toBe('container')
    expect(shell.className).toContain('h-full')
    expect(host.querySelector('main')!.className).toContain('overflow-hidden')
    expect(host.querySelector('.overflow-y-auto')).not.toBeNull()
    for (const h of Array.from(host.querySelectorAll('header'))) expect(h.className).not.toContain('sticky')
  })
})
