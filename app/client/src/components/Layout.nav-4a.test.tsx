// @vitest-environment jsdom
/**
 * obj 900495 (Sprint 4a) — there is no "More" section. Its items live in the
 * account dropdown: Settings + Archive for everyone, Admin → System / Agents
 * for global admins. The 390px bottom bar is ≤4 tabs with no overflow.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { Layout } from './Layout'

type TestUser = { id: number; username: string; role: string; workspaces: { role: string; workspace: string }[] }
const auth = vi.hoisted(() => ({ user: null as TestUser | null }))

vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: auth.user, logout: vi.fn() }) }))
vi.mock('../context/nav', () => ({ useNavigate: () => vi.fn() }))
vi.mock('../preview/BoardShell', () => ({ useBoardTheme: () => ({ theme: 'dark', toggleTheme: vi.fn() }) }))
vi.mock('../hooks/useWorkspaces', () => ({
  useWorkspaces: () => ({ workspaces: [], slugs: [], labelOf: (s: string) => s, shortOf: (s: string) => s, loading: false }),
}))
vi.mock('./CommandPalette', () => ({ CommandPalette: () => null }))
vi.mock('./AlertBell', () => ({ AlertBell: () => null }))
vi.mock('../lib/optional-pages', () => ({ HAS_CHAT_PAGE: true }))

const admin: TestUser = { id: 1, username: 'operator', role: 'admin', workspaces: [] }
const member: TestUser = { id: 2, username: 'casey', role: 'member', workspaces: [{ role: 'member', workspace: 'a' }] }

describe('Layout — Sprint 4a navigation', () => {
  let host: HTMLElement
  let root: Root
  beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host) })
  afterEach(() => { flushSync(() => root.unmount()); host.remove() })

  const mount = (u: TestUser) => {
    auth.user = u
    flushSync(() => root.render(<Layout selectedWorkspaces={[]} onWorkspacesChange={() => {}}><div>page</div></Layout>))
  }
  const openAccountMenu = (which: 0 | 1 = 0) => {
    const btn = host.querySelectorAll('button[aria-label="Account menu"]')[which] as HTMLButtonElement
    flushSync(() => btn.click())
    return host.querySelector('[role="menu"]') as HTMLElement
  }
  const menuHrefs = (menu: HTMLElement) => Array.from(menu.querySelectorAll('a')).map(a => a.getAttribute('href'))

  it('has no "More" entry anywhere in the chrome, desktop or mobile', () => {
    mount(admin)
    const labels = Array.from(host.querySelectorAll('a, button')).map(e => (e.textContent ?? '').trim())
    expect(labels).not.toContain('More')
    expect(host.querySelector('a[href="/dashboard"]')).toBeNull()
    expect(host.querySelector('a[href="/agent-templates"]')).toBeNull()
  })

  it('admin dropdown: Settings, Archive, then Admin → System, Agents, then Log out', () => {
    mount(admin)
    const menu = openAccountMenu()
    expect(menuHrefs(menu)).toEqual(['/settings', '/archive', '/system', '/agents'])
    expect(menu.textContent).toContain('Admin')
    expect(menu.textContent).toContain('System')
    expect(menu.textContent).toContain('Log out')
  })

  it('a member sees Settings and Archive only — no Admin section', () => {
    mount(member)
    const menu = openAccountMenu()
    expect(menuHrefs(menu)).toEqual(['/settings', '/archive'])
    expect(menu.textContent).not.toContain('Admin')
  })

  it('the mobile avatar opens the same menu', () => {
    mount(admin)
    const menu = openAccountMenu(1)
    expect(menuHrefs(menu)).toEqual(['/settings', '/archive', '/system', '/agents'])
  })

  it('mobile bottom bar is at most 4 tabs and has no overflow button', () => {
    mount(admin)
    const bar = host.querySelectorAll('nav[aria-label="Primary"]')[1] as HTMLElement
    expect(Array.from(bar.querySelectorAll('a')).map(a => a.getAttribute('href'))).toEqual(['/chat', '/', '/knowledge', '/jobs'])
    expect(bar.querySelector('button')).toBeNull()
  })

  it('Escape closes the account menu', () => {
    mount(admin)
    openAccountMenu()
    flushSync(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(host.querySelector('[role="menu"]')).toBeNull()
  })
})
