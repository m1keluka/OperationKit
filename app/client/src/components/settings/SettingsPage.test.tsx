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
              <Route path="seats" element={<div>seats-pane</div>} />
              <Route path="org" element={<div>org-pane</div>} />
            </Route>
          </Routes>
        </MemoryRouter>,
      )
    })
  }

  it('shows You / Connectors / Secrets / Seats / Org / Agents / Platform for a global admin', () => {
    mount('/settings/you')
    const labels = Array.from(container.querySelectorAll('[role="tab"]')).map(t => t.textContent)
    expect(labels).toEqual(['You', 'Connectors', 'Secrets', 'Seats', 'Org', 'Agents', 'Platform'])
    expect(container.textContent).toContain('you-pane')
  })

  it('hides secrets/seats/org/agents/platform for a member: You and Connectors only', () => {
    auth.user = { id: 2, username: 'member', role: 'member', workspaces: [{ role: 'member' }] }
    mount('/settings/you')
    const labels = Array.from(container.querySelectorAll('[role="tab"]')).map(t => t.textContent)
    expect(labels).toEqual(['You', 'Connectors'])
  })

  it('shows the running build commit from /api/health in the footer (obj 720210)', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: 'ok', commit: '4212de2abcde' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      mount('/settings/you')
      await vi.waitFor(() => expect(container.querySelector('[data-testid="build-footer"]')?.textContent).toContain('4212de2abcde'))
      expect(fetchMock).toHaveBeenCalledWith('/api/health', expect.anything())
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('opens the Seats pane for an admin', () => {
    mount('/settings/seats')
    expect(container.textContent).toContain('seats-pane')
  })

  it('keeps Seats from a workspace admin who is not a global admin', () => {
    auth.user = { id: 3, username: 'wsadmin', role: 'member', workspaces: [{ role: 'admin' }] }
    mount('/settings/you')
    const labels = Array.from(container.querySelectorAll('[role="tab"]')).map(t => t.textContent)
    expect(labels).toEqual(['You', 'Connectors', 'Secrets'])
  })
})
