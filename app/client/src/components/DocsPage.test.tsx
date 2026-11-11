import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'

/**
 * Knowledge base page (obj 720348): ONE knowledge base, no SOURCE picker.
 * Mounted with the createRoot idiom used by AgentsPage.test.tsx.
 */

const calls: string[] = []
vi.mock('../lib/api', () => ({
  api: {
    get: (url: string) => {
      calls.push(url)
      return Promise.resolve({
        root: '/kb',
        label: 'Knowledge base',
        folders: [{ path: '/kb', label: 'Knowledge base' }, { path: '/old/beta', label: 'beta' }],
        writeRoots: ['/kb'],
        tree: [
          { name: 'workspaces', path: '/kb/workspaces', type: 'dir', children: [] },
          { name: 'index.md', path: '/kb/index.md', type: 'file' },
        ],
      })
    },
    put: () => Promise.resolve({}),
  },
}))
// The editor and the import panel are not under test here.
vi.mock('@blocknote/react', () => ({ useCreateBlockNote: () => ({}) }))
vi.mock('@blocknote/mantine', () => ({ BlockNoteView: () => null }))
vi.mock('@blocknote/core', () => ({ BlockNoteSchema: { create: () => ({}) }, defaultBlockSpecs: {} }))
vi.mock('@blocknote/mantine/style.css', () => ({}))
vi.mock('./docs-page.css', () => ({}))
vi.mock('./docs/MermaidBlock', () => ({ mermaidBlockSpec: () => ({}) }))
vi.mock('./KnowledgeImport', () => ({ KnowledgeImportPanel: () => null, useKnowledgeImportEnabled: () => true }))

const { DocsPage, pageLocation } = await import('./DocsPage')

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = false

async function settle() {
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0))
}

let container: HTMLElement
let root: Root

beforeEach(() => {
  calls.length = 0
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  flushSync(() => { root.unmount() })
  container.remove()
})

describe('DocsPage — one knowledge base', () => {
  it('has no source picker and loads one tree', async () => {
    flushSync(() => { root.render(<DocsPage workspace="all" />) })
    await settle()
    expect(container.querySelector('select')).toBeNull()
    expect(container.textContent).not.toMatch(/Source/)
    expect(container.textContent).not.toMatch(/Second brain|AI workspace|Projects/)
    expect(container.textContent).toMatch(/Knowledge base/)
    expect(container.textContent).toMatch(/workspaces/)
    expect(container.textContent).toMatch(/index/)
    // A single request for the whole knowledge base — never a ?root= source switch.
    expect(calls).toEqual(['/docs/tree'])
  })
})

describe('pageLocation', () => {
  const folders = [{ path: '/kb', label: 'Knowledge base' }, { path: '/old/beta', label: 'beta' }]
  it('is the path inside the knowledge base', () => {
    expect(pageLocation('/kb/workspaces/acme/people/dana.md', '/kb', folders)).toBe('workspaces/acme/people/dana.md')
  })
  it('keeps the folder label for a folder stored outside the root', () => {
    expect(pageLocation('/old/beta/notes.md', '/kb', folders)).toBe('beta/notes.md')
  })
})
