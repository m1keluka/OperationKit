import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

/* obj 900327 — the user-facing rename to "bot", and the regressions that keep it
   from costing anything.

   Two things are asserted together on purpose, because the risk of a rename is
   exactly that one of them quietly moves:

   1. TERMINOLOGY. Every string a person reads on this page says bot/conversation,
      and says them with the right meaning: a BOT is the durable identity (one
      agent file), a CONVERSATION is the message history with it. In particular
      nothing on this page offers to create either, because it creates neither —
      so no control may be called "New bot" (it would be a lie) and none may be
      called "New conversation" either (there is one per bot, implicit).
   2. NOTHING ELSE MOVED. Persisted history still renders, the /chat/:slug
      deeplink still resolves, and the /api/agent-chat/* routes are untouched. */

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 2, username: 'jordan', role: 'admin' }, loading: false }),
}))

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = false
Element.prototype.scrollTo = function scrollTo() {}

async function settle(n = 12) {
  for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0))
}

const BOT = {
  slug: 'demo-assistant', name: 'Personal assistant (demo)', description: 'Inbox and calendar, drafts only.', avatar: 'PA', colour: 'green',
  knowledge_folders: ['demo/personal-assistant'], tools: ['email', 'calendar', 'read_file', 'create_objective'], model: null, provider: null,
  version: '1.0.0', author: 'Operation Kit', source: 'demo', answered_by: { id: 'demo', model: 'scripted' },
}

/** A conversation written BEFORE the rename. Shapes are the stored ones. */
const PERSISTED = {
  messages: [
    { id: 1, role: 'user', content: 'Reply to Priya', provider: null, model: null, tool_name: null, meta: null, created_at: '2026-10-31 09:00:00' },
    { id: 2, role: 'tool', content: 'Drafted email to priya@harbor-coffee.example', provider: 'demo', model: 'scripted', tool_name: 'email_create_draft', meta: { ok: true, draft_id: 7 }, created_at: '2026-10-31 09:00:01' },
    { id: 3, role: 'tool', content: 'Created card #41: Website quote', provider: 'demo', model: 'scripted', tool_name: 'create_objective', meta: { ok: true, objective_id: 41 }, created_at: '2026-10-31 09:00:02' },
    { id: 4, role: 'assistant', content: "I've drafted a reply to **Priya**.", provider: 'demo', model: 'scripted', tool_name: null, meta: { provider_label: 'Demo (no AI account)' }, created_at: '2026-10-31 09:00:03' },
    { id: 5, role: 'error', content: 'The calendar connector timed out.', provider: 'demo', model: 'scripted', tool_name: null, meta: { ok: false }, created_at: '2026-10-31 09:00:04' },
  ],
  drafts: [{ id: 7, kind: 'email', connector: 'demo', status: 'draft', payload: { to: 'priya@harbor-coffee.example', subject: 'Re: Thursday', body: 'Friday works.' } }],
  cards: [{ id: 41, title: 'Website quote', status: 'working', summary: null, pr_url: null, updated_at: '', url: '/o/41' }],
}

let calls: { url: string; method: string }[] = []
let roster: { agents: unknown[]; demo: boolean; providers: Record<string, boolean>; default_provider: string | null } = {
  agents: [BOT], demo: true, providers: { demo: true }, default_provider: null,
}
let rosterFailure: "none" | "offline" | "hang" = "none"
let root: Root
let host: HTMLDivElement

function mount(path: string) {
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
/** Everything a person can read: visible text plus the accessible names. */
const readable = () =>
  [
    host.textContent ?? '',
    ...[...host.querySelectorAll('[aria-label]')].map(e => e.getAttribute('aria-label') ?? ''),
    ...[...host.querySelectorAll('[placeholder]')].map(e => e.getAttribute('placeholder') ?? ''),
  ].join(' | ')

beforeEach(() => {
  calls = []
  rosterFailure = "none"
  roster = { agents: [BOT], demo: true, providers: { demo: true }, default_provider: null }
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({ url, method })
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } })
    if (url === '/api/agent-chat/agents') {
      // A non-Error rejection (an offline/abort shape) is what makes the page
      // fall back to its OWN copy rather than echoing a server message.
      if (rosterFailure === 'offline') throw 'offline'
      if (rosterFailure === 'hang') return new Promise<Response>(() => {})
      return json(roster)
    }
    if (url.endsWith('/messages')) return json(method === 'DELETE' ? {} : PERSISTED)
    return json({})
  }))
})

afterEach(() => {
  root.unmount()
  host.remove()
  vi.unstubAllGlobals()
})

describe('bots terminology (obj 900327)', () => {
  it('titles the page and the list "Bots", not "Chat"/"Agents"', async () => {
    await mount('/chat')
    await settle()
    expect(host.querySelector('h1')?.textContent).toBe('Bots')
    expect(host.querySelector('nav[aria-label="Bots"]')).not.toBeNull()
    expect(host.querySelector('nav[aria-label="Agents"]')).toBeNull()
    expect(host.textContent).toContain('One ongoing conversation with each bot.')
  })

  it('calls a bot a bot everywhere a person can read, including accessible names', async () => {
    await mount('/chat/demo-assistant')
    await settle()
    const text = readable()
    expect(text).toContain('Conversation with Personal assistant (demo)')
    expect(text).toContain('All bots')
    // No stray product-level "agent" wording left on the surface. (The word may
    // still appear inside a bot's own name/description, which is data, not chrome.)
    expect(/\bagents?\b/i.test(text.replace(/Personal assistant \(demo\)/g, ''))).toBe(false)
  })

  it('offers NO control that claims to create a bot or a conversation', async () => {
    await mount('/chat/demo-assistant')
    await settle()
    const labels = buttons().map(b => `${b.textContent ?? ''} ${b.getAttribute('aria-label') ?? ''}`)
    for (const l of labels) {
      expect(l).not.toMatch(/new bot|add bot|create (a )?bot/i)
      expect(l).not.toMatch(/new (conversation|thread|chat)/i)
    }
  })

  it('names the Clear control after the conversation and promises the bot survives', async () => {
    await mount('/chat/demo-assistant')
    await settle()
    const clear = byText('Clear conversation')
    expect(clear).toBeDefined()
    expect(clear!.getAttribute('aria-label')).toBe('Clear this conversation with Personal assistant (demo) (the bot is kept)')
    clear!.click()
    await settle()
    const dialog = document.body.textContent ?? ''
    expect(dialog).toContain('Clear your conversation with Personal assistant (demo)?')
    expect(dialog).toContain('Personal assistant (demo) itself is not deleted')
    expect(dialog).not.toMatch(/delete (the )?bot/i)
  })

  it('says "No bot called …" for an unknown slug — not "no agent"', async () => {
    await mount('/chat/not-a-real-one')
    await settle()
    expect(host.textContent).toContain('No bot called "not-a-real-one"')
    expect(host.textContent).toContain('it does not create a new bot')
  })

  it('labels the loading skeleton "Loading bots"', async () => {
    rosterFailure = 'hang'
    await mount('/chat')
    await settle(2)
    expect(host.querySelector('[aria-label="Loading bots"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="Loading agents"]')).toBeNull()
  })

  it('an empty roster tells an admin what a bot actually is', async () => {
    roster = { agents: [], demo: false, providers: { demo: true }, default_provider: null }
    await mount('/chat')
    await settle()
    expect(host.textContent).toContain('No bots yet')
    expect(host.textContent).toContain('A bot is one file in the agents folder on the server')
    expect(byText('Turn on the demo bot')).toBeDefined()
  })

  it('shows a bot-worded error when the roster cannot be loaded', async () => {
    rosterFailure = 'offline'
    await mount('/chat')
    await settle()
    expect(host.textContent).toContain('Could not load bots')
  })
})

describe('nothing else moved (obj 900327 regressions)', () => {
  it('renders a conversation persisted before the rename, unchanged', async () => {
    await mount('/chat/demo-assistant')
    await settle()
    // every stored role still renders
    expect(host.textContent).toContain('Reply to Priya')                       // user
    expect(host.textContent).toContain("I've drafted a reply to")              // assistant (markdown)
    expect(host.textContent).toContain('Drafted email to priya@harbor-coffee.example') // tool line
    expect(host.textContent).toContain('The calendar connector timed out.')    // error line
    expect(host.querySelector('[role="alert"]')).not.toBeNull()
    // the draft is still a draft, still gated on the person
    const draft = host.querySelector('section[aria-label="Email draft"]')!
    expect(draft.textContent).toContain('Draft — not sent')
    expect([...draft.querySelectorAll('button')].some(b => b.textContent === 'Send')).toBe(true)
    // the board card chip is still linked and live
    const link = host.querySelector('a[href="/o/41"]')!
    expect(link.textContent).toContain('#41')
    expect(link.textContent).toContain('In progress')
    // provenance line survives
    expect(host.querySelector('[data-testid="answered-by"]')?.textContent).toContain('Answered by Demo (no AI account)')
  })

  it('keeps the /chat/:slug deeplink and the /api/agent-chat/* routes exactly as they were', async () => {
    await mount('/chat/demo-assistant')
    await settle()
    expect(calls.map(c => c.url)).toContain('/api/agent-chat/agents')
    expect(calls.map(c => c.url)).toContain('/api/agent-chat/agents/demo-assistant/messages')
    // no renamed twin was introduced
    expect(calls.some(c => /\/api\/(bot|bots|bot-chat)\b/.test(c.url))).toBe(false)
  })

  it('clearing a conversation still DELETEs only the messages collection', async () => {
    await mount('/chat/demo-assistant')
    await settle()
    byText('Clear conversation')!.click()
    await settle()
    const confirmBtn = [...document.body.querySelectorAll('button')].find(b => b.textContent === 'Clear conversation' && !host.contains(b))
    expect(confirmBtn).toBeDefined()
    confirmBtn!.click()
    await settle()
    const dels = calls.filter(c => c.method === 'DELETE')
    expect(dels).toHaveLength(1)
    expect(dels[0].url).toBe('/api/agent-chat/agents/demo-assistant/messages')
  })
})
