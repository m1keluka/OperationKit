/**
 * Content nav entry (restored after obj 720115 removed it).
 *
 * Content is per-person provisioning — `has_content` from GET /api/auth/me,
 * backed by a `content_owners` row — not a role. A member with a row (Ava)
 * must see it; an admin without one must not. The mobile bottom bar stays at
 * ≤4 tabs + More even when an admin is also a content owner.
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

describe('Layout — Content nav entry', () => {
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
  const mobileTabLabels = () => {
    const bar = container.querySelector('nav.fixed')!
    return Array.from(bar.querySelectorAll(':scope > div > a')).map(a => a.getAttribute('href'))
  }

  it('shows Content to a member who is a content owner (Ava)', () => {
    mount({ id: 2, username: 'ava', role: 'member', workspaces: [{ role: 'member' }], has_content: true })
    expect(contentLinks().length).toBeGreaterThan(0)
    expect(contentLinks()[0].textContent).toContain('Content')
    expect(mobileTabLabels()).toEqual(['/chat', '/', '/knowledge', '/granola'])
    // The first tab carries the Bots label from #659; nothing is labelled "Chat".
    const bar = container.querySelector('nav.fixed')!
    expect(bar.querySelector('a[href="/chat"]')!.textContent).toContain('Bots')
    expect(bar.textContent).not.toMatch(/\bChat\b/)
  })

  it('hides Content from anyone without a content_owners row, admin included', () => {
    mount({ id: 1, username: 'admin', role: 'admin', workspaces: [], has_content: false })
    expect(contentLinks()).toHaveLength(0)
    mount({ id: 3, username: 'member', role: 'member', workspaces: [{ role: 'member' }] })
    expect(contentLinks()).toHaveLength(0)
  })

  it('keeps the mobile bar at 4 tabs + More for an admin content owner (Jobs spills to More)', () => {
    mount({ id: 1, username: 'mike', role: 'admin', workspaces: [], has_content: true })
    expect(mobileTabLabels()).toEqual(['/chat', '/', '/knowledge', '/granola'])
    // Jobs is still reachable from the desktop nav.
    expect(container.querySelector('a[href="/jobs"]')).not.toBeNull()
  })

  it('admin without content keeps Jobs as the fourth mobile tab', () => {
    mount({ id: 1, username: 'admin', role: 'admin', workspaces: [] })
    expect(mobileTabLabels()).toEqual(['/chat', '/', '/knowledge', '/jobs'])
  })
})
