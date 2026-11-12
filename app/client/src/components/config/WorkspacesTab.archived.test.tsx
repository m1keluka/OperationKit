// @vitest-environment jsdom
/**
 * obj 900197 — an ARCHIVED organization must still be reachable from
 * Settings → Org.
 *
 * Archiving is a soft delete: `DELETE /api/admin/workspaces/:slug` sets
 * `archived = 1`, and `GET /api/workspaces` filters archived rows out. This tab
 * rendered only that filtered list, so an archived org disappeared from the
 * product with no way back: a restored org had to be un-archived directly in
 * SQLite plus a restart. The admin list has always carried archived
 * rows and PATCH has always accepted `archived: false`; the gap was this UI.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'

async function flush() {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve()
    await new Promise(r => setTimeout(r, 0))
    flushSync(() => {})
    await Promise.resolve()
  }
}

// Fictional orgs — see the note in OrgSwitcher.test.tsx.
const ACTIVE = {
  slug: 'acme', name: 'Acme', short_label: 'AC', badge_color: null,
  vault_path: null, doc_read_roots: [], doc_write_roots: [], default_agent_pool: [],
  archived: false, sort_order: 0, created_at: '', updated_at: '',
}
const ARCHIVED = { ...ACTIVE, slug: 'northwind', name: 'Northwind', short_label: 'NW', archived: true, sort_order: 1 }

const refreshWorkspaces = vi.fn(() => Promise.resolve())

vi.mock('../../hooks/useWorkspaces', () => ({
  // /api/workspaces hides archived rows — that is the whole point.
  useWorkspaces: () => ({
    workspaces: [ACTIVE], slugs: [ACTIVE.slug], loading: false,
    refresh: refreshWorkspaces,
    labelOf: (s: string) => s, shortOf: (s: string) => s,
    badgeOf: () => null, agentPoolOf: () => [],
  }),
}))

vi.mock('../../hooks/useAgents', () => ({
  useAgents: () => ({ slugs: [], loading: false, labelOf: (s: string) => s }),
}))

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 1, username: 'operator', role: 'admin' }, loading: false }),
}))

const patch = vi.fn((_path: string, _body?: unknown) => Promise.resolve({ ...ARCHIVED, archived: false }))
const get = vi.fn((path: string) => {
  // The ADMIN list is the only place an archived org is visible.
  if (path === '/admin/workspaces') return Promise.resolve([ACTIVE, ARCHIVED])
  if (path === '/workspaces-config') return Promise.resolve({ workspaces: {} })
  return Promise.resolve([])
})

vi.mock('../../lib/api', () => ({
  api: {
    get: (p: string) => get(p),
    post: vi.fn(() => Promise.resolve({})),
    patch: (p: string, b: unknown) => patch(p, b),
    del: vi.fn(() => Promise.resolve({})),
  },
}))

import { WorkspacesTab } from './WorkspacesTab'

describe('WorkspacesTab — archived organizations (obj 900197)', () => {
  let container: HTMLElement
  let root: Root

  beforeEach(() => {
    patch.mockClear(); refreshWorkspaces.mockClear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  async function mount() {
    flushSync(() => root.render(<WorkspacesTab />))
    await flush()
    return container
  }

  it('lists an archived org that /api/workspaces hides', async () => {
    const el = await mount()
    const section = el.querySelector('[data-testid="archived-organizations"]')
    expect(section).toBeTruthy()
    expect(section!.textContent).toContain('Northwind')
    expect(section!.textContent).toContain('northwind')
  })

  it('Restore un-archives it through the admin PATCH and refreshes the roster', async () => {
    const el = await mount()
    const section = el.querySelector('[data-testid="archived-organizations"]') as HTMLElement
    const restore = [...section.querySelectorAll('button')].find(b => b.textContent?.includes('Restore'))
    expect(restore).toBeTruthy()
    flushSync(() => restore!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await flush()
    expect(patch).toHaveBeenCalledWith('/admin/workspaces/northwind', { archived: false })
    expect(refreshWorkspaces).toHaveBeenCalled()
  })

  it('lists active orgs first and the archived group at the bottom (obj 900683)', async () => {
    const el = await mount()
    const active = el.querySelector('[data-testid="active-organizations"]') as HTMLElement
    const archived = el.querySelector('[data-testid="archived-organizations"]') as HTMLElement
    expect(active).toBeTruthy()
    expect(archived).toBeTruthy()
    // The archived group comes AFTER the active group in document order …
    expect(active.compareDocumentPosition(archived) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // … and nothing follows it: it is the last thing on the page.
    expect(archived.nextElementSibling).toBeNull()
    // Each group is labelled, and each org sits in exactly one group.
    expect(active.textContent).toContain('Active organizations (1)')
    expect(active.textContent).toContain('Acme')
    expect(active.textContent).not.toContain('Northwind')
    expect(archived.textContent).toContain('Archived organizations (1)')
    expect(archived.textContent).not.toContain('Acme')
  })

  it('does not show the archived section when every org is active', async () => {
    // Re-point the admin list so no org comes back archived.
    get.mockImplementation((path: string) => {
      if (path === '/admin/workspaces') return Promise.resolve([ACTIVE])
      if (path === '/workspaces-config') return Promise.resolve({ workspaces: {} })
      return Promise.resolve([])
    })
    const el = await mount()
    expect(el.querySelector('[data-testid="archived-organizations"]')).toBeNull()
  })
})
