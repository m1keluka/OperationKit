import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

/* obj 900370 — side threads / concurrent task lanes, on the screen.

   The server-side proofs live in the two Vitest suites under
   app/server/src (isolation, concurrency, "main unchanged"). What is asserted
   HERE is the thing only the page can get wrong: that every request it makes
   carries the lane it is looking at. A Clear in a side thread that posted to the
   bare /messages URL would wipe the MAIN conversation — the page, not the
   server, is the only place that bug can live, so it is asserted directly. */

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 2, username: 'jordan', role: 'member' }, loading: false }),
}))

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = false
Element.prototype.scrollTo = function scrollTo() {}

async function settle(n = 12) {
  for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0))
}

const BOT = {
  slug: 'librarian', name: 'Librarian', description: 'Keeps the notes.', avatar: 'LI', colour: 'blue',
  knowledge_folders: [], tools: [], model: null, provider: null,
  version: null, author: 'Test', source: 'file', answered_by: { id: 'demo', model: 'scripted' },
}

const thread = (id: number, title: string) => ({
  id, title, pinned: false, archived: false, last_active_at: null,
  created_at: '2026-11-09 09:00:00', updated_at: '2026-11-09 09:00:00', message_count: 1,
})

const message = (id: number, content: string) => ({
  id, role: 'user', content, provider: null, model: null, tool_name: null, meta: null, created_at: '2026-11-09 09:00:00',
})

/** Per-lane histories, so a cross-lane read would be visible on the screen. */
const HISTORY: Record<string, { messages: unknown[]; drafts: unknown[]; cards: unknown[] }> = {
  main: { messages: [message(1, 'main-only-text')], drafts: [], cards: [] },
  '7': { messages: [message(2, 'lane-seven-text')], drafts: [], cards: [] },
  '8': { messages: [message(3, 'lane-eight-text')], drafts: [], cards: [] },
}

let calls: { url: string; method: string; body: string | null }[] = []
let threads: ReturnType<typeof thread>[] = []
let nextThreadId = 9
let root: Root
let host: HTMLDivElement

function mount(path = '/chat/librarian') {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  return import('./AgentChatPage').then(({ AgentChatPage }) => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/chat" element={<AgentChatPage />} />
          <Route path="/chat/:slug" element={<AgentChatPage />} />
        </Routes>
      </MemoryRouter>,
    )
  })
}

const buttons = () => [...host.querySelectorAll('button')]
const byText = (t: string) => buttons().find(b => (b.textContent ?? '').trim() === t)
const urls = (method = 'GET') => calls.filter(c => c.method === method).map(c => c.url)

/** The confirm dialog renders outside the page host. */
const confirmButton = (label: string) =>
  [...document.body.querySelectorAll('button')].find(b => b.textContent === label && !host.contains(b))

beforeEach(() => {
  calls = []
  threads = [thread(7, 'Quarterly numbers'), thread(8, 'Supplier audit')]
  nextThreadId = 9
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({ url, method, body: typeof init?.body === 'string' ? init.body : null })
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } })
    if (url === '/api/agent-chat/agents') {
      return json({ agents: [BOT], demo: false, providers: { demo: true }, default_provider: null })
    }
    if (url.includes('/threads')) {
      if (method === 'POST') {
        const title = JSON.parse(String(init?.body ?? '{}')).title as string
        const t = thread(nextThreadId++, title)
        threads = [t, ...threads]
        return json({ thread: t }, 201)
      }
      if (method === 'PATCH') {
        const id = Number(url.split('/').pop())
        const patch = JSON.parse(String(init?.body ?? '{}')) as { title?: string; archived?: boolean }
        const found = threads.find(t => t.id === id)!
        const next = { ...found, ...(patch.title ? { title: patch.title } : {}), ...(patch.archived ? { archived: true } : {}) }
        threads = patch.archived ? threads.filter(t => t.id !== id) : threads.map(t => (t.id === id ? next : t))
        return json({ thread: next })
      }
      return json({ threads, max_open: 10 })
    }
    if (url.includes('/messages')) {
      if (method === 'DELETE') return json({ ok: true, removed: 1 })
      const lane = new URL(url, 'http://x').searchParams.get('thread_id') ?? 'main'
      return json(HISTORY[lane] ?? { messages: [], drafts: [], cards: [] })
    }
    return json({})
  }))
})

afterEach(() => {
  root.unmount()
  host.remove()
  vi.unstubAllGlobals()
})

describe('the lane strip', () => {
  it('opens on the main conversation and lists every open side thread beside it', async () => {
    await mount()
    await settle()
    const tabs = [...host.querySelectorAll('[role="tab"]')].map(t => (t.textContent ?? '').trim())
    expect(tabs[0]).toBe('Main')
    expect(tabs.join(' | ')).toContain('Quarterly numbers')
    expect(tabs.join(' | ')).toContain('Supplier audit')
    // Main is the lane in view, and its history — only its history — is on screen.
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain('Main')
    expect(host.textContent).toContain('main-only-text')
    expect(host.textContent).not.toContain('lane-seven-text')
    // And the main conversation is read with NO thread_id, exactly as before.
    expect(urls()).toContain('/api/agent-chat/agents/librarian/messages')
  })

  it('switching to a side thread reads THAT lane and shows only its messages', async () => {
    await mount()
    await settle()
    byText('Quarterly numbers1')!.click()
    await settle()
    expect(urls()).toContain('/api/agent-chat/agents/librarian/messages?thread_id=7')
    expect(host.textContent).toContain('lane-seven-text')
    expect(host.textContent).not.toContain('main-only-text')
    expect(host.textContent).not.toContain('lane-eight-text')
  })

  it('sends into the lane in view, by thread_id in the body', async () => {
    await mount()
    await settle()
    byText('Supplier audit1')!.click()
    await settle()
    const box = host.querySelector('textarea')!
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
    setter.call(box, 'check the invoices')
    box.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
    byText('Send')!.click()
    await settle()
    const post = calls.find(c => c.method === 'POST' && c.url.includes('/messages'))!
    expect(JSON.parse(post.body!)).toMatchObject({ text: 'check the invoices', thread_id: 8 })
  })

  it('"+ Side thread" opens a new lane and switches to it', async () => {
    await mount()
    await settle()
    byText('+ Side thread')!.click()
    await settle()
    const post = calls.find(c => c.method === 'POST' && c.url.endsWith('/threads'))
    expect(post).toBeDefined()
    expect(urls()).toContain('/api/agent-chat/agents/librarian/messages?thread_id=9')
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain('Side thread 3')
  })

  it('never offers a control that claims to create a bot', async () => {
    await mount()
    await settle()
    for (const b of buttons()) {
      const label = `${b.textContent ?? ''} ${b.getAttribute('aria-label') ?? ''}`
      expect(label).not.toMatch(/new bot|add bot|create (a )?bot/i)
    }
  })
})

describe('clearing and closing never reach across to the main conversation', () => {
  it('Clear inside a side thread DELETEs that lane, never the bare messages URL', async () => {
    await mount()
    await settle()
    byText('Quarterly numbers1')!.click()
    await settle()

    byText('Clear side thread')!.click()
    await settle()
    confirmButton('Clear side thread')!.click()
    await settle()

    const dels = calls.filter(c => c.method === 'DELETE')
    expect(dels).toHaveLength(1)
    expect(dels[0].url).toBe('/api/agent-chat/agents/librarian/messages?thread_id=7')
    // The URL that would have emptied the main conversation was never called.
    expect(dels.some(d => d.url === '/api/agent-chat/agents/librarian/messages')).toBe(false)
  })

  it('the dialog promises the main conversation is kept', async () => {
    await mount()
    await settle()
    byText('Quarterly numbers1')!.click()
    await settle()
    byText('Clear side thread')!.click()
    await settle()
    const dialog = document.body.textContent ?? ''
    expect(dialog).toContain('Clear the side thread "Quarterly numbers"?')
    expect(dialog).toContain('Your main conversation with Librarian is not changed.')
  })

  it('Close archives the lane and drops back to the main conversation', async () => {
    await mount()
    await settle()
    byText('Supplier audit1')!.click()
    await settle()

    byText('Close')!.click()
    await settle()
    expect(document.body.textContent).toContain('Close the side thread "Supplier audit"?')
    confirmButton('Close side thread')!.click()
    await settle()

    const patch = calls.find(c => c.method === 'PATCH')!
    expect(patch.url).toBe('/api/agent-chat/agents/librarian/threads/8')
    expect(JSON.parse(patch.body!)).toEqual({ archived: true })
    // Closing DELETEs nothing at all, and the main conversation is what we land on.
    expect(calls.filter(c => c.method === 'DELETE')).toHaveLength(0)
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain('Main')
    expect(host.textContent).toContain('main-only-text')
    expect([...host.querySelectorAll('[role="tab"]')].map(t => t.textContent).join(' ')).not.toContain('Supplier audit')
  })

  it('renames a lane in place, without touching any message', async () => {
    await mount()
    await settle()
    byText('Quarterly numbers1')!.click()
    await settle()

    byText('Rename')!.click()
    await settle()
    const box = host.querySelector('#side-thread-name') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    setter.call(box, 'Q4 numbers')
    box.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
    byText('Save')!.click()
    await settle()

    const patch = calls.find(c => c.method === 'PATCH')!
    expect(JSON.parse(patch.body!)).toEqual({ title: 'Q4 numbers' })
    expect(calls.filter(c => c.method === 'DELETE')).toHaveLength(0)
    expect([...host.querySelectorAll('[role="tab"]')].map(t => t.textContent).join(' ')).toContain('Q4 numbers')
  })
})

describe('the strip is additive', () => {
  it('a server that cannot list threads still shows the conversation', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      calls.push({ url, method, body: null })
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } })
      if (url === '/api/agent-chat/agents') return json({ agents: [BOT], demo: false, providers: { demo: true }, default_provider: null })
      if (url.includes('/threads')) return new Response('nope', { status: 500 })
      if (url.includes('/messages')) return json(HISTORY.main)
      return json({})
    }))
    await mount()
    await settle()
    expect(host.textContent).toContain('main-only-text')
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain('Main')
  })
})
