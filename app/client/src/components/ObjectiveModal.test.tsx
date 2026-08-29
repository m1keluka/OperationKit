// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useState } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'

// Flush microtasks + a macrotask so api.get(...).then(setState) settles, then
// force any scheduled renders to commit. (The container ships a PRODUCTION React
// build, which omits `act`, so we drive commits with flushSync instead.)
async function flush() {
  await Promise.resolve()
  await new Promise(r => setTimeout(r, 0))
  flushSync(() => {})
  await Promise.resolve()
}
import type { Objective } from '@command-center/shared'

// obj 700128 — prove ObjectiveModal is memoized so board-level WebSocket
// broadcasts (which re-render KanbanBoard every few seconds while live sessions
// run) do NOT re-render the open modal. A broadcast-driven re-render reconciled
// ~36 attribute changes across the modal subtree, which dismissed any open
// native <select> in Chrome (the "bouncing/closing" bug). React.memo + the fact
// that all props from KanbanBoard are referentially stable means an identical-
// props parent re-render skips the modal entirely — while a changed `objective`
// prop (e.g. Edit a different card) still re-renders it.

// We count ObjectiveModalImpl renders by spying on useAuth, which it calls
// unconditionally at the top of every render. With everything else mocked,
// ObjectiveModalImpl is the only caller, so call-count == render-count.
// Mutable so a test can supply org subfolders; default is "no projects yet".
const { PROJECTS } = vi.hoisted(() => ({ PROJECTS: [] as Array<Record<string, unknown>> }))

const { useAuthSpy } = vi.hoisted(() => ({
  useAuthSpy: vi.fn(() => ({ user: { id: 1, role: 'admin', username: 'admin' } })),
}))

vi.mock('../context/AuthContext', () => ({ useAuth: () => useAuthSpy() }))

vi.mock('../hooks/useWorkspaces', () => ({
  useWorkspaces: () => ({
    slugs: ['example'],
    labelOf: (s: string) => s,
    agentPoolOf: () => [],
  }),
}))

vi.mock('../lib/api', () => ({
  api: {
    get: vi.fn((url: string) => {
      if (url === '/models') return Promise.resolve({ models: [], default: '' })
      if (url === '/admin/users') return Promise.resolve([])
      if (url === '/workspaces-config') return Promise.resolve({ workspaces: {} })
      // obj 708826 — the Project control now reads the projects table.
      if (url.startsWith('/projects')) return Promise.resolve(PROJECTS)
      return Promise.resolve([])
    }),
    post: vi.fn(() => Promise.resolve({})),
    put: vi.fn(() => Promise.resolve({})),
    del: vi.fn(() => Promise.resolve()),
  },
}))

// Pass children straight through so the modal body renders into the DOM.
vi.mock('./ui', () => ({
  Modal: ({ children }: { children: React.ReactNode }) => <div role="dialog">{children}</div>,
  useConfirm: () => ({ confirm: vi.fn(), confirmDialog: null }),
}))

import { ObjectiveModal } from './ObjectiveModal'
import { api } from '../lib/api'

// React 19 overrides the value setter on controlled inputs; go through the
// prototype descriptor so the synthetic change event carries the new value.
function setNativeValue(el: HTMLTextAreaElement, value: string) {
  const proto = Object.getPrototypeOf(el)
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
}
function setNativeSelectValue(el: HTMLSelectElement, value: string) {
  const proto = Object.getPrototypeOf(el)
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
}

// Module-level stable prop identities — these must NEVER change between renders,
// mirroring KanbanBoard's useCallback-stabilized handlers. If they changed,
// memo's shallow compare would (correctly) re-render and the test would be moot.
const onClose = vi.fn()
const onCreate = vi.fn((_data: unknown) => Promise.resolve({} as Objective))
const onUpdate = vi.fn(() => Promise.resolve({} as Objective))
const onDelete = vi.fn(() => Promise.resolve())

let forceParentRender: () => void = () => {}

function Harness({ objective }: { objective: Objective | null }) {
  const [, setTick] = useState(0)
  forceParentRender = () => setTick(t => t + 1)
  return (
    <ObjectiveModal
      objective={objective}
      workspace="example"
      onClose={onClose}
      onCreate={onCreate}
      onUpdate={onUpdate}
      onDelete={onDelete}
    />
  )
}

const SAMPLE_OBJECTIVE = { id: 42, title: 'Edit me', workspace: 'example' } as unknown as Objective

describe('ObjectiveModal — memoized against parent re-renders (obj 700128)', () => {
  let container: HTMLElement
  let root: Root

  beforeEach(() => {
    useAuthSpy.mockClear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  it('does NOT re-render when the parent re-renders with identical props', async () => {
    flushSync(() => root.render(<Harness objective={null} />))
    // Let mount-time async effects (api.get .then setState) settle so their
    // renders are already counted before we measure the delta.
    await flush()

    const before = useAuthSpy.mock.calls.length
    expect(before).toBeGreaterThan(0) // it did render at least once on mount

    // Force a parent re-render with byte-for-byte identical ObjectiveModal props.
    flushSync(() => forceParentRender())
    await flush()

    const after = useAuthSpy.mock.calls.length
    expect(after - before).toBe(0) // memo skipped it — zero extra renders
  })

  it('DOES re-render when the `objective` prop changes (Edit a different card)', async () => {
    flushSync(() => root.render(<Harness objective={null} />))
    await flush()

    const before = useAuthSpy.mock.calls.length

    // Re-render the tree with a different objective — memo must NOT block this.
    flushSync(() => root.render(<Harness objective={SAMPLE_OBJECTIVE} />))
    await flush()

    const after = useAuthSpy.mock.calls.length
    expect(after).toBeGreaterThan(before)
    // And the new objective's title is rendered (it really re-rendered with new props).
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain('Edit Objective')
  })
})

// ── obj 708877: model + delegate + assign + files restored to create form ─────
// The form must collect TITLE, DESCRIPTION, ORGANIZATION, PROJECT,
// MODEL, DELEGATOR MODE (admin), ASSIGN TO (admin), and FILES.
describe('ObjectiveModal — create form fields (obj 708877)', () => {
  let container: HTMLElement
  let root: Root

  beforeEach(() => {
    onCreate.mockClear()
    ;(api.get as unknown as { mockClear: () => void }).mockClear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  async function mount(objective: Objective | null) {
    flushSync(() => root.render(<Harness objective={objective} />))
    await flush()
    return container.querySelector('[role="dialog"]') as HTMLElement
  }

  it('renders two textareas (title, description)', async () => {
    const dialog = await mount(null)
    expect(dialog.querySelectorAll('textarea')).toHaveLength(2)
  })

  it('renders organization and project selects', async () => {
    const dialog = await mount(null)
    const labels = [...dialog.querySelectorAll('label')].map(l => l.textContent?.trim())
    expect(labels).toContain('Organization')
    expect(labels).toContain('Project')
  })

  it('has a file input for attachments', async () => {
    const dialog = await mount(null)
    expect(dialog.querySelectorAll('input[type="file"]')).toHaveLength(1)
  })

  it('has a delegator-mode checkbox for admins', async () => {
    // useAuthSpy defaults to admin role
    const dialog = await mount(null)
    expect(dialog.querySelectorAll('input[type="checkbox"]')).toHaveLength(1)
    const label = dialog.querySelector('label[for="delegate-mode"]')
    expect(label?.textContent?.toLowerCase()).toContain('delegator')
  })

  it('does NOT show delegator checkbox for non-admins', async () => {
    // mockImplementation (not Once) so every re-render triggered by async effects
    // also sees the member role — Once only covers the first call and re-renders
    // revert to the default admin mock, incorrectly re-rendering the checkbox.
    useAuthSpy.mockImplementation(() => ({ user: { id: 2, role: 'member', username: 'ava' } }))
    try {
      const dialog = await mount(null)
      expect(dialog.querySelectorAll('input[type="checkbox"]')).toHaveLength(0)
    } finally {
      useAuthSpy.mockImplementation(() => ({ user: { id: 1, role: 'admin', username: 'admin' } }))
    }
  })

  it('does not show the model select when registry returns no models', async () => {
    const dialog = await mount(null)
    const labels = [...dialog.querySelectorAll('label')].map(l => l.textContent?.trim())
    // models is empty (default mock), so the select is hidden
    expect(labels).not.toContain('Model')
  })

  // obj 708826 — single Project control bound to project_id
  it('has a single Project control from the projects table', async () => {
    const dialog = await mount(null)
    const labels = [...dialog.querySelectorAll('label')].map(l => l.textContent?.trim())
    expect(labels.filter(l => l === 'Project')).toHaveLength(1)
    expect(labels).not.toContain('Repository')
    const urls = (api.get as unknown as { mock: { calls: string[][] } }).mock.calls.map(c => c[0])
    expect(urls).not.toContain('/workspaces-config')
    expect(urls.some(u => u.startsWith('/projects?workspace='))).toBe(true)
  })

  it('submits project_id (not the repo-link project) when a project is selected', async () => {
    PROJECTS.splice(0, PROJECTS.length,
      { id: 7, workspace: 'example', name: 'Data Sourcing', description: null, color: null, sort_order: 0, archived: false, created_at: '', updated_at: '' },
    )
    try {
      const dialog = await mount(null)
      const selects = [...dialog.querySelectorAll('select')]
      const projectSelect = selects.find(s =>
        s.querySelector('option[value=""]')?.textContent === 'No project'
      ) as HTMLSelectElement
      expect(projectSelect).toBeTruthy()

      const title = dialog.querySelector('textarea') as HTMLTextAreaElement
      setNativeValue(title, 'Pull the MLS feed')
      flushSync(() => title.dispatchEvent(new Event('input', { bubbles: true })))
      setNativeSelectValue(projectSelect, '7')
      flushSync(() => projectSelect.dispatchEvent(new Event('change', { bubbles: true })))

      const form = dialog.querySelector('form') as HTMLFormElement
      flushSync(() => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
      await flush()

      expect(onCreate).toHaveBeenCalledTimes(1)
      const payload = onCreate.mock.calls[0][0] as Record<string, unknown>
      expect(payload.project_id).toBe(7)
      expect(payload).not.toHaveProperty('project')
    } finally {
      PROJECTS.length = 0
    }
  })

  it('edit mode shows all fields including title and description', async () => {
    const dialog = await mount(SAMPLE_OBJECTIVE)
    expect(dialog.textContent).toContain('Edit Objective')
    expect(dialog.querySelectorAll('textarea')).toHaveLength(2)
  })
})
