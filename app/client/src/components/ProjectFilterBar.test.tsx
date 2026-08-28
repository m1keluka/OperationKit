// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import type { Project } from '@command-center/shared'

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

const PROJECTS = [project(7, 'Data Sourcing', 3), project(8, 'Billing', 1)]

const onSelect = vi.fn()
const onCreate = vi.fn((_name: string) => Promise.resolve(project(9, 'Fresh')))
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

  async function mount(selection: ProjectSelection = ALL_PROJECTS, projects = PROJECTS) {
    flushSync(() => root.render(
      <ProjectFilterBar
        projects={projects}
        selection={selection}
        onSelect={onSelect}
        workspace="example"
        onCreate={onCreate}
        onRename={onRename}
        onDelete={onDelete}
      />
    ))
    await flush()
    return container.querySelector('[data-testid="project-filter-bar"]') as HTMLElement
  }

  function click(el: Element | null | undefined) {
    flushSync(() => el?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  }

  it('lists All projects, every project, and a No project bucket', async () => {
    const bar = await mount()
    expect(chipsOf(bar)).toEqual(['All projects', 'Data Sourcing3', 'Billing1', 'No project'])
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
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, 'Data Sourcing 2')
    flushSync(() => input.dispatchEvent(new Event('input', { bubbles: true })))
    flushSync(() => (bar.querySelector('form') as HTMLFormElement)
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    await flush()
    expect(onCreate).toHaveBeenCalledWith('Data Sourcing 2')
    // Newly-created folder becomes the open one.
    expect(onSelect).toHaveBeenCalledWith(9)
  })

  it('renames the OPEN project from the picker', async () => {
    const bar = await mount(7)
    click(bar.querySelector('[aria-label="Rename Data Sourcing"]'))
    await flush()
    const input = bar.querySelector('input[aria-label="Rename project"]') as HTMLInputElement
    expect(input.value).toBe('Data Sourcing')
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
    click(bar.querySelector('[aria-label="Delete Data Sourcing"]'))
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
