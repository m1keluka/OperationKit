// @vitest-environment jsdom
// obj 900681: My Secrets folded into Settings → Secrets as the "Mine" sub-tab.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

const auth = vi.hoisted(() => ({ user: null as null | { id: number; role: string; workspaces: { role: string }[] } }))
vi.mock('../../context/AuthContext', () => ({ useAuth: () => ({ user: auth.user }) }))
vi.mock('../SecretsPage', () => ({ SecretsPage: () => <div>shared-store</div> }))
vi.mock('../TestCredentialsPage', () => ({ TestCredentialsPage: () => <div>test-creds</div> }))
vi.mock('../account-settings/MySecretsSection', () => ({ MySecretsSection: () => <section>my-secrets</section> }))

import { SettingsSecrets, canManageSharedSecrets } from './SettingsSecrets'

let root: Root
let container: HTMLDivElement
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  flushSync(() => root.unmount())
  container.remove()
})

function mount(path = '/settings/secrets') {
  flushSync(() => root.render(<MemoryRouter initialEntries={[path]}><SettingsSecrets /></MemoryRouter>))
}
const tabs = () => Array.from(container.querySelectorAll('[role="tab"]')).map(t => t.textContent)

describe('Settings → Secrets structure', () => {
  it('a plain member sees only their own secrets, with no admin sub-tabs', () => {
    auth.user = { id: 2, role: 'member', workspaces: [{ role: 'member' }] }
    mount()
    expect(container.textContent).toContain('my-secrets')
    expect(container.textContent).not.toContain('shared-store')
    expect(tabs()).toEqual([])
  })

  it('a member cannot deep-link into Shared', () => {
    auth.user = { id: 2, role: 'member', workspaces: [{ role: 'member' }] }
    mount('/settings/secrets?view=shared')
    expect(container.textContent).toContain('my-secrets')
    expect(container.textContent).not.toContain('shared-store')
  })

  it('an admin gets Shared / Mine / Test credentials and lands on Shared', () => {
    auth.user = { id: 1, role: 'admin', workspaces: [] }
    mount()
    expect(tabs()).toEqual(['Shared', 'Mine', 'Test credentials'])
    expect(container.textContent).toContain('shared-store')
  })

  it('?view=mine opens the Mine sub-tab, and clicking a tab switches', async () => {
    auth.user = { id: 1, role: 'admin', workspaces: [] }
    mount('/settings/secrets?view=mine')
    expect(container.textContent).toContain('my-secrets')
    const test = Array.from(container.querySelectorAll('[role="tab"]')).find(t => t.textContent === 'Test credentials') as HTMLElement
    flushSync(() => test.click())
    await vi.waitFor(() => expect(container.textContent).toContain('test-creds'))
  })

  it('canManageSharedSecrets matches the old Secrets tab gate', () => {
    expect(canManageSharedSecrets({ role: 'admin', workspaces: [] })).toBe(true)
    expect(canManageSharedSecrets({ role: 'member', workspaces: [{ role: 'admin' }] })).toBe(true)
    expect(canManageSharedSecrets({ role: 'member', workspaces: [{ role: 'member' }] })).toBe(false)
    expect(canManageSharedSecrets(null)).toBe(false)
  })
})
