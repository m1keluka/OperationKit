import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { SettingsPage } from './SettingsPage'

const auth = vi.hoisted(() => ({
  user: { id: 1, username: 'mike', role: 'admin', workspaces: [] } as {
    id: number; username: string; role: string; workspaces: { role: string }[]
  },
}))

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ user: auth.user }),
}))

describe('SettingsPage tabs', () => {
  let container: HTMLElement
  let root: Root

  beforeEach(() => {
    auth.user = { id: 1, username: 'mike', role: 'admin', workspaces: [] }
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  function mount(path: string) {
    flushSync(() => {
      root.render(
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/settings" element={<SettingsPage />}>
              <Route path="you" element={<div>you-pane</div>} />
              <Route path="secrets" element={<div>secrets-pane</div>} />
              <Route path="org" element={<div>org-pane</div>} />
            </Route>
          </Routes>
        </MemoryRouter>,
      )
    })
  }

  it('shows You / Secrets / Org / Agents / Platform for a global admin', () => {
    mount('/settings/you')
    const labels = Array.from(container.querySelectorAll('[role="tab"]')).map(t => t.textContent)
    expect(labels).toEqual(['You', 'Secrets', 'Org', 'Agents', 'Platform'])
    expect(container.textContent).toContain('you-pane')
  })

  it('hides org/agents/platform for a member and only shows You', () => {
    auth.user = { id: 2, username: 'ava', role: 'member', workspaces: [{ role: 'member' }] }
    mount('/settings/you')
    const labels = Array.from(container.querySelectorAll('[role="tab"]')).map(t => t.textContent)
    expect(labels).toEqual(['You'])
  })
})
