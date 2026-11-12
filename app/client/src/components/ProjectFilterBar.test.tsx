// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import type React from 'react'
import type { Project } from '@operationkit/shared'

// Same harness idiom as ObjectiveModal.test.tsx: the container ships a PRODUCTION
// React build (no `act`), so commits are driven with flushSync.
async function flush() {
  await Promise.resolve()
  await new Promise(r => setTimeout(r, 0))
  flushSync(() => {})
  await Promise.resolve()
}

// Auto-accept the delete confirmation so the DELETE path is exercised.
vi.mock('./ui', () => ({
  useConfirm: () => ({ confirm: () => Promise.resolve(true), confirmDialog: null }),
}))

import { ProjectFilterBar } from './ProjectFilterBar'
import { ALL_PROJECTS, UNASSIGNED_PROJECT, type ProjectSelection } from '../lib/projectFilter'

const project = (id: number, name: string, count = 0): Project => ({
  id, workspace: 'example', name, description: null, color: null,
  sort_order: 0, archived: false, objective_count: count,
  created_at: '', updated_at: '',
})

const PROJECTS = [project(7, 'Designer', 3), project(8, 'Billing', 1)]

const onSelect = vi.fn()
const onCreate = vi.fn((_name: string, _workspace?: string) => Promise.resolve(project(9, 'Fresh')))
const onRename = vi.fn(() => Promise.resolve(project(7, 'Renamed')))
const onDelete = vi.fn(() => Promise.resolve({ detached_objectives: 3 }))

function chipsOf(el: HTMLElement) {
  return [...el.querySelectorAll('[role="group"] button')].map(b => (b.textContent || '').trim())
}

describe('ProjectFilterBar — the org subfolder picker (obj 708826)', () => {
  let container: HTMLElement
  let root: Root

  beforeEach(() => {
    onSelect.mockClear(); onCreate.mockClear(); onRename.mockClear(); onDelete.mockClear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  async function mount(
    selection: ProjectSelection = ALL_PROJECTS,
    projects = PROJECTS,
    extra: Partial<React.ComponentProps<typeof ProjectFilterBar>> = {},
  ) {
    flushSync(() => root.render(
      <ProjectFilterBar
        projects={projects}
        selection={selection}
        onSelect={onSelect}
        workspace="example"
        {...extra}
        onCreate={onCreate}
        onRename={onRename}
        onDelete={onDelete}
      />
    ))
    await flush()
    const bar = container.querySelector('[data-testid="project-filter-bar"]') as HTMLElement
    // obj 900666: the list lives in a dropdown — open it the way a user would.
    flushSync(() => bar.querySelector('[data-dropdown-trigger]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await flush()
    return bar
  }

  function click(el: Element | null | undefined) {
    flushSync(() => el?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  }

  it('lists All projects, every project, and a No project bucket', async () => {
    const bar = await mount()
    expect(chipsOf(bar)).toEqual(['All projects', 'Designer3', 'Billing1', 'No project'])
  })

  it('All projects is the pressed chip by default', async () => {
    const bar = await mount(ALL_PROJECTS)
    const all = bar.querySelector('[role="group"] button') as HTMLElement
    expect(all.getAttribute('aria-pressed')).toBe('true')
  })

  it('clicking a project chip selects that project id', async () => {
    const bar = await mount()
    click(bar.querySelector('[data-project-id="7"]'))
    expect(onSelect).toHaveBeenCalledWith(7)
  })

  it('clicking No project selects the unassigned bucket', async () => {
    const bar = await mount()
    const chips = [...bar.querySelectorAll('[role="group"] button')]
    click(chips[chips.length - 1])
    expect(onSelect).toHaveBeenCalledWith(UNASSIGNED_PROJECT)
  })

  it('creates a project inline from the picker and opens it', async () => {
    const bar = await mount()
    click([...bar.querySelectorAll('button')].find(b => b.textContent?.includes('New project')))
    await flush()
    const input = bar.querySelector('input[aria-label="New project name"]') as HTMLInputElement
    expect(input).toBeTruthy()
    const proto = Object.getPrototypeOf(input)
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, 'Designer 2')
    flushSync(() => input.dispatchEvent(new Event('input', { bubbles: true })))
    flushSync(() => (bar.querySelector('form') as HTMLFormElement)
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    await flush()
    // Second arg is the explicit org, undefined in a single-org view.
    expect(onCreate).toHaveBeenCalledWith('Designer 2', undefined)
    // Newly-created folder becomes the open one.
    expect(onSelect).toHaveBeenCalledWith(9)
  })

  it('renames the OPEN project from the picker', async () => {
    const bar = await mount(7)
    click(bar.querySelector('[aria-label="Rename Designer"]'))
    await flush()
    const input = bar.querySelector('input[aria-label="Rename project"]') as HTMLInputElement
    expect(input.value).toBe('Designer')
    const proto = Object.getPrototypeOf(input)
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, 'Sourcing')
    flushSync(() => input.dispatchEvent(new Event('input', { bubbles: true })))
    flushSync(() => (bar.querySelector('form') as HTMLFormElement)
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    await flush()
    expect(onRename).toHaveBeenCalledWith(7, 'Sourcing')
  })

  it('deletes the OPEN project and falls back to All projects', async () => {
    const bar = await mount(7)
    click(bar.querySelector('[aria-label="Delete Designer"]'))
    await flush()
    expect(onDelete).toHaveBeenCalledWith(7)
    expect(onSelect).toHaveBeenCalledWith(ALL_PROJECTS)
  })

  it('offers rename/delete only for the project that is actually open', async () => {
    const bar = await mount(ALL_PROJECTS)
    expect(bar.querySelector('[aria-label^="Rename "]')).toBeNull()
    expect(bar.querySelector('[aria-label^="Delete "]')).toBeNull()
  })

  it('still offers "New project" when the organization has none yet', async () => {
    const bar = await mount(ALL_PROJECTS, [])
    expect(chipsOf(bar)).toEqual(['All projects'])
    expect([...bar.querySelectorAll('button')].some(b => b.textContent?.includes('New project'))).toBe(true)
  })
})

/**
 * obj 900197 — in the All-Organizations view the bar used to be omitted
 * entirely, so the board had no project filter at all most of the time. It now
 * renders with org-prefixed chips and a create form that asks which org.
 */
describe('ProjectFilterBar — cross-organization view (obj 900197)', () => {
  let container: HTMLElement
  let root: Root

  // Fictional orgs: the OSS publish pipeline rewrites real identities, and a
  // slug and its display name go through different rules there.
  const CROSS = [
    { ...project(7, 'Designer', 3), workspace: 'acme' },
    { ...project(8, 'Billing', 1), workspace: 'northwind' },
  ]
  const ORGS = [
    { slug: 'acme', label: 'Acme' },
    { slug: 'northwind', label: 'Northwind' },
  ]

  beforeEach(() => {
    onSelect.mockClear(); onCreate.mockClear(); onRename.mockClear(); onDelete.mockClear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  async function mountCross(orgOptions: { slug: string; label: string }[] = ORGS) {
    flushSync(() => root.render(
      <ProjectFilterBar
        projects={CROSS}
        selection={ALL_PROJECTS}
        onSelect={onSelect}
        workspace={null}
        orgOptions={orgOptions}
        orgLabelOf={(slug: string) => ORGS.find(o => o.slug === slug)?.label ?? slug}
        onCreate={onCreate}
        onRename={onRename}
        onDelete={onDelete}
      />
    ))
    await flush()
    const bar = container.querySelector('[data-testid="project-filter-bar"]') as HTMLElement
    // obj 900666: the list lives in a dropdown — open it the way a user would.
    flushSync(() => bar.querySelector('[data-dropdown-trigger]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await flush()
    return bar
  }

  it('renders instead of disappearing, and prefixes each chip with its org', async () => {
    const bar = await mountCross()
    expect(bar).toBeTruthy()
    expect(chipsOf(bar)).toEqual([
      'All projects', 'Acme · Designer3', 'Northwind · Billing1', 'No project',
    ])
  })

  it('still filters: clicking a chip selects that project id', async () => {
    const bar = await mountCross()
    flushSync(() => bar.querySelector('[data-project-id="8"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onSelect).toHaveBeenCalledWith(8)
  })

  it('creating a project asks which organization and passes it through', async () => {
    const bar = await mountCross()
    flushSync(() => [...bar.querySelectorAll('button')]
      .find(b => b.textContent?.includes('New project'))
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await flush()
    const select = bar.querySelector('select[aria-label="Organization for the new project"]') as HTMLSelectElement
    expect(select).toBeTruthy()
    const selProto = Object.getPrototypeOf(select)
    Object.getOwnPropertyDescriptor(selProto, 'value')!.set!.call(select, 'northwind')
    flushSync(() => select.dispatchEvent(new Event('change', { bubbles: true })))
    const input = bar.querySelector('input[aria-label="New project name"]') as HTMLInputElement
    const proto = Object.getPrototypeOf(input)
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, 'Outbound')
    flushSync(() => input.dispatchEvent(new Event('input', { bubbles: true })))
    flushSync(() => (bar.querySelector('form') as HTMLFormElement)
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    await flush()
    expect(onCreate).toHaveBeenCalledWith('Outbound', 'northwind')
  })

  it('hides create when there is no organization to create into', async () => {
    const bar = await mountCross([])
    expect([...bar.querySelectorAll('button')].some(b => b.textContent?.includes('New project'))).toBe(false)
  })
})

describe('ProjectFilterBar — closed trigger (obj 900666)', () => {
  it('is one compact control that names the open project', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    flushSync(() => root.render(
      <ProjectFilterBar
        projects={PROJECTS}
        selection={8}
        onSelect={onSelect}
        workspace="example"
        onCreate={onCreate}
        onRename={onRename}
        onDelete={onDelete}
      />
    ))
    await flush()
    const trigger = container.querySelector('[data-dropdown-trigger]') as HTMLElement
    expect(trigger.textContent).toContain('Billing')
    // Closed: no option list is in the DOM until the user opens it.
    expect(container.querySelector('[role="group"]')).toBeNull()
  })
})
