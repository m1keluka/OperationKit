import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

/* Built-in agent chat page (obj 719987). createRoot idiom (no
   @testing-library in this client), fetch stubbed per URL. */

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 2, username: 'jordan', role: 'member' }, loading: false }),
}))

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = false
Element.prototype.scrollTo = function scrollTo() {}

async function settle() {
  for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0))
}

const AGENT = {
  slug: 'demo-assistant', name: 'Personal assistant (demo)', description: 'Inbox and calendar, drafts only.', avatar: 'PA', colour: 'green',
  knowledge_folders: ['demo/personal-assistant'], tools: ['email', 'calendar', 'read_file', 'create_objective'], model: null, provider: null,
  version: '1.0.0', author: 'Operation Kit', source: 'demo', answered_by: { id: 'demo', model: 'scripted' },
}

const THREAD = {
  messages: [
    { id: 1, role: 'user', content: 'Reply to Priya', provider: null, model: null, tool_name: null, meta: null, created_at: '2026-10-31 09:00:00' },
    { id: 2, role: 'tool', content: 'Drafted email to priya@harbor-coffee.example', provider: 'demo', model: 'scripted', tool_name: 'email_create_draft', meta: { ok: true, draft_id: 7 }, created_at: '2026-10-31 09:00:01' },
    { id: 3, role: 'tool', content: 'Created card #41: Website quote', provider: 'demo', model: 'scripted', tool_name: 'create_objective', meta: { ok: true, objective_id: 41 }, created_at: '2026-10-31 09:00:02' },
    { id: 4, role: 'assistant', content: "I've drafted a reply to **Priya**.", provider: 'demo', model: 'scripted', tool_name: null, meta: { provider_label: 'Demo (no AI account)' }, created_at: '2026-10-31 09:00:03' },
  ],
  drafts: [{ id: 7, kind: 'email', connector: 'demo', status: 'draft', payload: { to: 'priya@harbor-coffee.example', subject: 'Re: Thursday', body: 'Friday works.' } }],
  cards: [{ id: 41, title: 'Website quote', status: 'working', summary: null, pr_url: null, updated_at: '', url: '/o/41' }],
}

let calls: { url: string; method: string }[] = []
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

beforeEach(() => {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({ url, method })
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } })
    if (url === '/api/agent-chat/agents') return json({ agents: [AGENT], demo: true, providers: { demo: true }, default_provider: null })
    if (url.endsWith('/messages') && method === 'GET') return json(THREAD)
    if (url === '/api/agent-chat/drafts/7/send') return json({ draft: { ...THREAD.drafts[0], status: 'sent' } })
    return json({})
  }))
})

afterEach(() => {
  root.unmount()
  host.remove()
  vi.unstubAllGlobals()
})

describe('AgentChatPage', () => {
  it('lists agents and shows which AI answered each reply', async () => {
    await mount('/chat/demo-assistant')
    await settle()
    expect(host.textContent).toContain('Personal assistant (demo)')
    expect(host.textContent).toContain('Answers with Demo (no AI account) · scripted')
    const by = host.querySelector('[data-testid="answered-by"]')
    expect(by?.textContent).toContain('Answered by Demo (no AI account)')
    expect(by?.textContent).toContain('scripted')
  })

  it('shows the draft as NOT sent until the person presses Send', async () => {
    await mount('/chat/demo-assistant')
    await settle()
    const draft = host.querySelector('section[aria-label="Email draft"]')!
    expect(draft.textContent).toContain('Draft — not sent')
    const send = [...draft.querySelectorAll('button')].find(b => b.textContent === 'Send')!
    send.click()
    await settle()
    expect(calls.some(c => c.url === '/api/agent-chat/drafts/7/send' && c.method === 'POST')).toBe(true)
    expect(host.querySelector('section[aria-label="Email draft"]')!.textContent).toContain('Sent by you')
  })

  it('shows the board card the agent created, with its live status and a link', async () => {
    await mount('/chat/demo-assistant')
    await settle()
    const link = host.querySelector('a[href="/o/41"]')!
    expect(link.textContent).toContain('#41')
    expect(link.textContent).toContain('In progress')
  })

  it('on the agent list alone (mobile entry) the conversation pane waits for a pick', async () => {
    await mount('/chat')
    await settle()
    expect(host.textContent).toContain('Pick an agent')
    expect(host.querySelector('nav[aria-label="Agents"] button')?.textContent).toContain('Personal assistant (demo)')
  })
})
