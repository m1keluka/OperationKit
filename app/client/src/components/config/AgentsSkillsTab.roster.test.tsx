// @vitest-environment jsdom
/**
 * obj 900684 — the roster on Agents & Skills → Registry must show agents that
 * are not flat persona files. The built-in Knowledge Base Setup agent ships as a
 * chat-agent folder outside the agents dir, so the old file-only roster never
 * listed it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'

async function flush() {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve()
    await new Promise(r => setTimeout(r, 0))
    flushSync(() => {})
  }
}

const base = { size: 100, modifiedAt: null, assignable: false, kind: 'routing-only' as const, file_path: null, definition: null, open_href: null, pack: null, note: null }
const ROSTER = {
  agents: [
    { ...base, id: 'persona:cto', name: 'cto', filename: 'cto.md', slug: 'cto', label: 'CTO', kind: 'executive' as const, assignable: true, source: 'persona', file_path: 'agents/cto.md', description: '' },
    { ...base, id: 'builtin:kb-setup', name: 'Knowledge Base Setup', filename: '', slug: 'kb-setup', label: 'Knowledge Base Setup', source: 'builtin', description: 'Sets up your knowledge base.', definition: '---\nname: Knowledge Base Setup\n---\nYou are the Knowledge Base Setup agent.', open_href: '/chat/kb-setup', note: 'Ships with the app.' },
    { ...base, id: 'starter-pack:kb-librarian', name: 'kb librarian', filename: '', slug: 'kb-librarian', label: 'Librarian', source: 'starter-pack', description: 'Keeps the KB organized.', definition: '# Agent: Librarian', pack: { id: 'knowledge-import', name: 'Knowledge base file import', enabled: false }, note: 'Comes with the "Knowledge base file import" starter pack, which is switched off on this install.' },
  ],
  skills: [
    { name: 'outreach', dirname: 'outreach', description: 'Outbound', size: 10, fileCount: 1, parent: null },
    { name: 'outreach/cold-email', dirname: 'outreach/cold-email', description: 'Cold', size: 10, fileCount: 1, parent: 'outreach' },
  ],
}

const get = vi.fn(async (url: string) => {
  if (url === '/admin/agents') return ROSTER
  if (url === '/admin/skill-graph') return {}
  if (url.startsWith('/admin/file')) return { content: 'persona body' }
  throw new Error(url)
})
vi.mock('../../lib/api', () => ({ api: { get: (u: string) => get(u) } }))

import { AgentsSkillsTab, agentForSlug, type AgentInfo } from './AgentsSkillsTab'

let container: HTMLElement
let root: Root
beforeEach(() => {
  get.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  flushSync(() => root.unmount())
  container.remove()
})

const buttonWith = (text: string) =>
  Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes(text))!

describe('AgentsSkillsTab roster (obj 900684)', () => {
  it('lists the built-in Knowledge Base Setup agent and the starter-pack Librarian', async () => {
    flushSync(() => root.render(<AgentsSkillsTab />))
    await flush()
    expect(container.textContent).toContain('agents (3)')
    expect(container.textContent).toContain('Knowledge Base Setup')
    expect(container.textContent).toContain('built-in')
    expect(container.textContent).toContain('Librarian')
    expect(container.textContent).toContain('starter pack')
  })

  it('shows the inline definition, the reason note and a Bots link without a file read', async () => {
    flushSync(() => root.render(<AgentsSkillsTab />))
    await flush()
    flushSync(() => buttonWith('Knowledge Base Setup').click())
    await flush()
    expect(container.querySelector('[data-testid="agent-note"]')?.textContent).toContain('Ships with the app')
    expect(container.querySelector('a[href="/chat/kb-setup"]')).not.toBeNull()
    flushSync(() => buttonWith('View definition').click())
    expect(container.textContent).toContain('You are the Knowledge Base Setup agent.')
    expect(get.mock.calls.some(([u]) => String(u).startsWith('/admin/file'))).toBe(false)
  })

  it('explains why the Librarian is not active', async () => {
    flushSync(() => root.render(<AgentsSkillsTab />))
    await flush()
    flushSync(() => buttonWith('Librarian').click())
    await flush()
    expect(container.querySelector('[data-testid="agent-note"]')?.textContent).toMatch(/switched off/)
  })

  it('lists sub-skills under their parent', async () => {
    flushSync(() => root.render(<AgentsSkillsTab />))
    await flush()
    flushSync(() => buttonWith('skills (').click())
    expect(container.textContent).toContain('sub-skill')
  })

  it('a slug cross-link prefers the persona file', () => {
    const list = [
      { slug: 'x', source: 'chat', id: 'chat:x' },
      { slug: 'x', source: 'persona', id: 'persona:x' },
    ] as AgentInfo[]
    expect(agentForSlug(list, 'x')?.id).toBe('persona:x')
  })
})
