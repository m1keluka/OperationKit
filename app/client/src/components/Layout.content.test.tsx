/**
 * Content is NOT a product section (obj 900450, reverting the #644 restore).
 *
 * Content drafting is a scheduled job (e.g. drafts written into a Google
 * Sheet), not a nav tab, so the product stays industry-agnostic. Nobody gets a
 * Content entry — not even a user whose GET /api/auth/me carries
 * `has_content: true` (a `content_owners` row). The mobile bar is the plain
 * four tabs + More.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { Layout } from './Layout'

type TestUser = { id: number; username: string; role: string; workspaces: { role: string }[]; has_content?: boolean }

const auth = vi.hoisted(() => ({ user: null as TestUser | null }))

vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: auth.user, logout: vi.fn() }) }))
vi.mock('../context/nav', () => ({ useNavigate: () => vi.fn() }))
vi.mock('../preview/BoardShell', () => ({ useBoardTheme: () => ({ theme: 'light', toggleTheme: vi.fn() }) }))
vi.mock('../hooks/useWorkspaces', () => ({
  useWorkspaces: () => ({ workspaces: [], slugs: [], labelOf: (s: string) => s, shortOf: (s: string) => s, loading: false }),
}))
vi.mock('./CommandPalette', () => ({ CommandPalette: () => null }))
vi.mock('./AlertBell', () => ({ AlertBell: () => null }))
vi.mock('../lib/optional-pages', () => ({ HAS_CHAT_PAGE: true }))

describe('Layout — no Content nav entry', () => {
  let container: HTMLElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    flushSync(() => root.unmount())
    container.remove()
  })

  function mount(user: TestUser) {
    auth.user = user
    flushSync(() => {
      root.render(
        <Layout selectedWorkspaces={[]} onWorkspacesChange={() => {}}>
          <div>page</div>
        </Layout>,
      )
    })
  }

  const contentLinks = () => Array.from(container.querySelectorAll('a[href="/granola"]'))
  const navText = () => Array.from(container.querySelectorAll('nav')).map(n => n.textContent ?? '').join(' ')
  const mobileTabLabels = () => {
    const bar = container.querySelector('nav.fixed')!
    return Array.from(bar.querySelectorAll(':scope > div > a')).map(a => a.getAttribute('href'))
  }

  const users: [string, TestUser][] = [
    ['member content owner', { id: 2, username: 'casey', role: 'member', workspaces: [{ role: 'member' }], has_content: true }],
    ['admin content owner', { id: 1, username: 'operator', role: 'admin', workspaces: [], has_content: true }],
    ['admin', { id: 1, username: 'admin', role: 'admin', workspaces: [] }],
    ['member', { id: 3, username: 'member', role: 'member', workspaces: [{ role: 'member' }] }],
  ]

  it.each(users)('shows no Content link on desktop or mobile for a %s', (_label, user) => {
    mount(user)
    expect(contentLinks()).toHaveLength(0)
    expect(navText()).not.toMatch(/\bContent\b/)
  })

  it('member content owner gets the plain mobile tabs', () => {
    mount(users[0][1])
    expect(mobileTabLabels()).toEqual(['/chat', '/', '/knowledge'])
  })

  it('admin keeps Jobs as the fourth mobile tab, content owner or not', () => {
    mount(users[1][1])
    expect(mobileTabLabels()).toEqual(['/chat', '/', '/knowledge', '/jobs'])
    mount(users[2][1])
    expect(mobileTabLabels()).toEqual(['/chat', '/', '/knowledge', '/jobs'])
  })
})
