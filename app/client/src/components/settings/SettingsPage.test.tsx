import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { SettingsPage } from './SettingsPage'

const auth = vi.hoisted(() => ({
  user: { id: 1, username: 'operator', role: 'admin', workspaces: [] } as {
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
    auth.user = { id: 1, username: 'operator', role: 'admin', workspaces: [] }
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    flushSync(() => root.unmount())
    container.remove()
  })

  function mount(path: string) {
    flushSync(() => {
      root.render(
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/settings" element={<SettingsPage />}>
              <Route path="models" element={<div>models-pane</div>} />
              <Route path="api-mcp" element={<div>api-mcp-pane</div>} />
              <Route path="integrations" element={<div>integrations-pane</div>} />
              <Route path="secrets" element={<div>secrets-pane</div>} />
              <Route path="workspaces" element={<div>workspaces-pane</div>} />
              <Route path="org" element={<div>org-pane</div>} />
              {/* Legacy paths still need to match so the router mounts SettingsPage,
                  which does the real redirect itself. */}
              <Route path="you" element={<div>you-pane</div>} />
              <Route path="connectors" element={<div>connectors-pane</div>} />
              <Route path="seats" element={<div>seats-pane</div>} />
            </Route>
          </Routes>
        </MemoryRouter>,
      )
    })
  }

  it('shows Models / API & MCP / Integrations / Secrets / Workspaces / Branding / Email for a global admin — no Agents & Skills copy (obj 900684), no Platform (obj 900686)', () => {
    mount('/settings/api-mcp')
    const labels = Array.from(container.querySelectorAll('[role="tab"]')).map(t => t.textContent)
    expect(labels).toEqual([
      'Models', 'API & MCP', 'Integrations', 'Secrets', 'Workspaces', 'Branding', 'Email',
    ])
    expect(container.textContent).toContain('api-mcp-pane')
  })

  it('hides models/org/agents/branding/email/platform for a member: API & MCP, Integrations and Secrets (Mine) only', () => {
    auth.user = { id: 2, username: 'member', role: 'member', workspaces: [{ role: 'member' }] }
    mount('/settings/api-mcp')
    const labels = Array.from(container.querySelectorAll('[role="tab"]')).map(t => t.textContent)
    expect(labels).toEqual(['API & MCP', 'Integrations', 'Secrets'])
  })

  it('shows the running build commit from /api/health in the footer (obj 720210)', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: 'ok', commit: '4212de2abcde' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      mount('/settings/api-mcp')
      await vi.waitFor(() => expect(container.querySelector('[data-testid="build-footer"]')?.textContent).toContain('4212de2abcde'))
      expect(fetchMock).toHaveBeenCalledWith('/api/health', expect.anything())
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('opens the Models pane for an admin', () => {
    mount('/settings/models')
    expect(container.textContent).toContain('models-pane')
  })

  it('keeps Secrets for a workspace admin who is not a global admin', () => {
    auth.user = { id: 3, username: 'wsadmin', role: 'member', workspaces: [{ role: 'admin' }] }
    mount('/settings/api-mcp')
    const labels = Array.from(container.querySelectorAll('[role="tab"]')).map(t => t.textContent)
    expect(labels).toEqual(['API & MCP', 'Integrations', 'Secrets'])
  })

  it('lets a plain member open /settings/secrets (their own secrets live there now, obj 900681)', () => {
    auth.user = { id: 2, username: 'member', role: 'member', workspaces: [{ role: 'member' }] }
    mount('/settings/secrets')
    expect(container.textContent).toContain('secrets-pane')
  })

  it('redirects the old /settings/you bookmark to /settings/api-mcp', async () => {
    mount('/settings/you')
    await vi.waitFor(() => expect(container.textContent).toContain('api-mcp-pane'))
  })

  it('redirects the old /settings/connectors bookmark to /settings/integrations', async () => {
    mount('/settings/connectors')
    await vi.waitFor(() => expect(container.textContent).toContain('integrations-pane'))
  })

  it('redirects the old /settings/seats bookmark to /settings/models', async () => {
    mount('/settings/seats')
    await vi.waitFor(() => expect(container.textContent).toContain('models-pane'))
  })

  it('opens Settings → Workspaces at /settings/workspaces with workspace copy (obj 900758)', () => {
    mount('/settings/workspaces')
    expect(container.textContent).toContain('workspaces-pane')
    expect(container.textContent).toContain('Workspaces and users.')
    expect(container.textContent).not.toMatch(/Organi[sz]ation/)
  })

  it('redirects the old /settings/org bookmark to /settings/workspaces (obj 900758)', async () => {
    mount('/settings/org')
    await vi.waitFor(() => expect(container.textContent).toContain('workspaces-pane'))
    expect(container.textContent).not.toContain('org-pane')
  })
})
