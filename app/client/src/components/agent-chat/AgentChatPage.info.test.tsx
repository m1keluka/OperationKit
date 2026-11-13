import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'
import { howToBlocks, reachLines } from './AgentInfoPanel'
import type { ChatAgentInfo } from './types'

/* obj 900672 — the "i" panel on a bot's conversation, and the ?prompt= deep link
   the Agents page uses to hand a request to the Operation Kit Dev bot.

   What must hold:
   - the panel is closed until asked for, opens from an "i" button with the
     right ARIA wiring, and shows the bot's OWN how-to text and example prompts;
   - picking an example prompt puts it in the message box and SENDS NOTHING;
   - a bot whose file has neither field still gets a useful panel;
   - ?prompt= pre-fills the box once, sends nothing, and leaves the URL. */

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 2, username: 'jordan', role: 'member' }, loading: false }),
}))

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = false
Element.prototype.scrollTo = function scrollTo() {}

async function settle(n = 12) {
  for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0))
}

const DEV: ChatAgentInfo = {
  slug: 'operation-kit-dev', name: 'Operation Kit Dev', description: 'Helps you set up and extend Operation Kit.', avatar: 'OK', colour: 'blue',
  knowledge_folders: ['business', 'organizations'], tools: ['search', 'read_file', 'write_doc', 'create_objective', 'board_briefing'],
  model: null, provider: null, version: '1.0.0', author: 'Operation Kit', source: 'builtin', answered_by: { id: 'claude', model: null },
  how_to_use: 'Tell me what you want to set up.\n\nWhat I help with:\n- Integrations\n- Email\n- Branding',
  example_prompts: ['Learn about my business and suggest three things to automate', 'Set up email so the platform can send from my domain'],
}

/** A bot file with no info-panel fields (every bot written before obj 900672). */
const PLAIN: ChatAgentInfo = {
  slug: 'librarian', name: 'Librarian', description: 'Keeps the knowledge base tidy.', avatar: 'L', colour: 'green',
  knowledge_folders: ['team'], tools: ['search', 'read_file'], model: null, provider: null, version: null, author: null,
  source: 'file', answered_by: { id: 'claude', model: null },
}

/** A bot created with no About text (obj 900747): the server generated it. */
const FRESH: ChatAgentInfo = {
  slug: 'researcher', name: 'Researcher', description: '', avatar: 'R', colour: 'pink',
  knowledge_folders: ['market'], tools: ['search', 'web_search'], model: null, provider: null, version: null, author: null,
  source: 'file', answered_by: { id: 'claude', model: null },
  about: {
    description: 'A research assistant for the sales team.',
    how_to_use: 'Write to Researcher the way you would message a colleague.\n\n- Ask about anything in your notes in market',
    example_prompts: ['What do my notes in market say about this week?'],
    sources: { description: 'generated', how_to_use: 'generated', example_prompts: 'generated' },
    generated_by: 'rules', generated_at: null, pending: true,
  },
}

const PROMPT = 'You are a research assistant for the sales team.\n\n## Rules\n- Cite the note <b>you</b> used.'

let calls: { url: string; method: string }[] = []
let root: Root
let host: HTMLDivElement
let lastLocation = ''

function Where() {
  const loc = useLocation()
  lastLocation = `${loc.pathname}${loc.search}`
  return null
}

async function mount(path: string, strict = false) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const { AgentChatPage } = await import('./AgentChatPage')
  const tree = (
    <MemoryRouter initialEntries={[path]}>
      <Where />
      <Routes>
        <Route path="/chat" element={<AgentChatPage />} />
        <Route path="/chat/:slug" element={<AgentChatPage />} />
      </Routes>
    </MemoryRouter>
  )
  // The app runs under StrictMode, which runs every effect twice in development.
  root.render(strict ? <StrictMode>{tree}</StrictMode> : tree)
  await settle()
}

const infoButton = () => host.querySelector<HTMLButtonElement>('button[aria-controls="agent-info-panel"]')!
const panel = () => host.querySelector<HTMLElement>('#agent-info-panel')
const box = () => host.querySelector<HTMLTextAreaElement>('#agent-chat-input')!
const sends = () => calls.filter(c => c.method === 'POST' && c.url.endsWith('/messages'))

let detailReads = 0

beforeEach(() => {
  calls = []
  detailReads = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({ url, method })
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } })
    if (url === '/api/agent-chat/agents') return json({ agents: [DEV, PLAIN, FRESH], demo: false, providers: { claude: true }, default_provider: 'claude' })
    if (url === '/api/agent-chat/agents/researcher') {
      detailReads++
      // The model-written About lands on the second read.
      const about = detailReads > 1
        ? { ...FRESH.about!, description: 'Finds facts about prospects before sales calls.', example_prompts: ['Brief me on Acme before my 3pm call'], generated_by: 'model' as const, generated_at: '2026-11-13 04:00:00', pending: false }
        : FRESH.about
      return json({ agent: { ...FRESH, about, system_prompt: PROMPT, instructions: PROMPT } })
    }
    if (url === '/api/agent-chat/agents/operation-kit-dev') return json({ agent: { ...DEV, system_prompt: 'You are Operation Kit Dev.', instructions: 'You are Operation Kit Dev.' } })
    if (url.includes('/messages')) return json({ messages: [], drafts: [], cards: [] })
    if (url.endsWith('/threads')) return json({ threads: [], max_open: 3 })
    return json({})
  }))
})

afterEach(() => {
  root.unmount()
  host.remove()
  vi.unstubAllGlobals()
})

describe('bot info panel (obj 900672)', () => {
  it('is closed until the "i" button opens it, with the ARIA wiring a screen reader needs', async () => {
    await mount('/chat/operation-kit-dev')
    expect(panel()).toBeNull()
    const btn = infoButton()
    expect(btn.getAttribute('aria-expanded')).toBe('false')
    expect(btn.getAttribute('aria-label')).toMatch(/How to use Operation Kit Dev/)
    btn.click()
    await settle(4)
    expect(btn.getAttribute('aria-expanded')).toBe('true')
    expect(panel()?.getAttribute('aria-label')).toBe('About Operation Kit Dev')
  })

  it("shows the bot's own how-to text (paragraphs + bullets) and example prompts", async () => {
    await mount('/chat/operation-kit-dev')
    infoButton().click()
    await settle(4)
    const p = panel()!
    expect(p.textContent).toContain('Tell me what you want to set up.')
    expect([...p.querySelectorAll('li')].map(li => li.textContent)).toEqual(expect.arrayContaining(['Integrations', 'Email', 'Branding']))
    const prompts = [...p.querySelectorAll('ul[aria-label="Example prompts"] button')].map(b => b.textContent)
    expect(prompts).toEqual(DEV.example_prompts)
    // It says what the bot can actually reach, in plain words.
    expect(p.textContent).toContain('Reads your knowledge base folders: business, organizations')
    expect(p.textContent).toContain('Files bigger jobs as board cards')
    expect(p.textContent).not.toMatch(/email drafts/)
  })

  it('an example prompt goes into the message box and nothing is sent', async () => {
    await mount('/chat/operation-kit-dev')
    infoButton().click()
    await settle(4)
    const pick = [...panel()!.querySelectorAll<HTMLButtonElement>('ul[aria-label="Example prompts"] button')][1]
    pick.click()
    await settle(4)
    expect(box().value).toBe('Set up email so the platform can send from my domain')
    expect(panel()).toBeNull()
    expect(sends()).toEqual([])
  })

  it("an empty conversation offers the bot's own example prompts and a way into the panel", async () => {
    await mount('/chat/operation-kit-dev')
    const text = host.textContent ?? ''
    expect(text).toContain('Learn about my business and suggest three things to automate')
    const how = [...host.querySelectorAll('button')].find(b => b.textContent === 'How to use Operation Kit Dev')!
    how.click()
    await settle(4)
    expect(panel()).not.toBeNull()
  })

  it('a bot file without the new fields still gets a useful, generic panel', async () => {
    await mount('/chat/librarian')
    infoButton().click()
    await settle(4)
    const p = panel()!
    expect(p.textContent).toContain('Write to this bot the way you would message a colleague')
    expect(p.textContent).toContain('Settings → Secrets')
    expect(p.textContent).toContain('Reads your knowledge base folders: team')
    // Same "bot" terminology rule as obj 900327: no product-level "agent" wording in the chrome.
    expect(/\bagents?\b/i.test(p.textContent ?? '')).toBe(false)
  })
})

describe('read-only instructions + generated About (obj 900747)', () => {
  const instructions = () => host.querySelector<HTMLElement>('[data-testid="agent-instructions"]')

  it("shows the bot's system prompt as plain, read-only text and offers no way to edit it", async () => {
    await mount('/chat/researcher')
    infoButton().click()
    await settle(8)
    const p = panel()!
    const pre = instructions()!
    expect(pre.tagName).toBe('PRE')
    expect(pre.getAttribute('aria-readonly')).toBe('true')
    // Plain text: the markup in the prompt is shown, never rendered.
    expect(pre.textContent).toBe(PROMPT)
    expect(pre.querySelector('b')).toBeNull()
    expect(p.textContent).toContain('Read-only')
    expect(p.textContent).toContain('An admin changes them by editing the bot’s file.')
    // Nothing in the panel can change the prompt.
    expect(p.querySelector('textarea, input, [contenteditable="true"]')).toBeNull()
    expect([...p.querySelectorAll('button')].map(b => b.textContent)).not.toEqual(expect.arrayContaining([expect.stringMatching(/edit|save/i)]))
    expect(calls.filter(c => c.method !== 'GET')).toEqual([])
  })

  it('keeps How to use, example prompts and reach alongside the instructions', async () => {
    await mount('/chat/operation-kit-dev')
    infoButton().click()
    await settle(8)
    const p = panel()!
    const headings = [...p.querySelectorAll('h4')].map(h => h.textContent)
    expect(headings).toEqual(['How to use', 'Example prompts', 'What it can reach', 'Instructions'])
    expect(instructions()!.textContent).toBe('You are Operation Kit Dev.')
    expect(p.textContent).toContain('They ship with the app')
    // A file that writes all three About fields shows no "generated" note.
    expect(p.querySelector('[data-testid="about-generated-note"]')).toBeNull()
  })

  it('a new bot with no About text in its file shows the generated About at once, then the refreshed one', async () => {
    await mount('/chat/researcher')
    // The empty conversation already offers the generated prompts and summary.
    expect(host.textContent).toContain('What do my notes in market say about this week?')
    expect(host.textContent).toContain('A research assistant for the sales team.')
    infoButton().click()
    await settle(8)
    let p = panel()!
    expect(p.textContent).toContain('A research assistant for the sales team.')
    expect(p.textContent).toContain('Ask about anything in your notes in market')
    expect(p.textContent).not.toContain('Write to this bot the way you would message a colleague')
    expect(p.querySelector('[data-testid="about-generated-note"]')!.textContent).toMatch(/being written now/)
    expect(p.textContent).toContain('Searches the public web')
    // The panel re-reads while the model-written About is pending.
    await new Promise(r => setTimeout(r, 4300))
    await settle(8)
    p = panel()!
    expect(detailReads).toBe(2)
    expect(p.textContent).toContain('Finds facts about prospects before sales calls.')
    const prompts = [...p.querySelectorAll('ul[aria-label="Example prompts"] button')].map(b => b.textContent)
    expect(prompts).toEqual(['Brief me on Acme before my 3pm call'])
    expect(p.querySelector('[data-testid="about-generated-note"]')!.textContent).toMatch(/rewritten whenever the bot changes/)
  }, 10_000)
})

describe('?prompt= deep link (obj 900672)', () => {
  it('pre-fills the message box once, sends nothing, and drops the param from the URL', async () => {
    await mount(`/chat/operation-kit-dev?prompt=${encodeURIComponent('Help me create a new skill for a task we repeat.')}`)
    await settle()
    expect(box().value).toBe('Help me create a new skill for a task we repeat.')
    expect(sends()).toEqual([])
    expect(lastLocation).toBe('/chat/operation-kit-dev')
  })

  it('survives StrictMode (effects run twice) and only fills the bot it names', async () => {
    await mount(`/chat/operation-kit-dev?prompt=${encodeURIComponent('Help me create a new bot.')}`, true)
    await settle()
    expect(box().value).toBe('Help me create a new bot.')
    expect(sends()).toEqual([])
  })

  it('a bot opened without ?prompt= starts with an empty box', async () => {
    await mount('/chat/librarian')
    expect(box().value).toBe('')
  })
})

describe('info panel helpers', () => {
  it('howToBlocks splits paragraphs and bullet runs, and never produces markup', () => {
    expect(howToBlocks('One\ntwo.\n\n- a\n- b\nAfter <b>x</b>')).toEqual([
      { kind: 'p', text: 'One two.' },
      { kind: 'ul', items: ['a', 'b'] },
      { kind: 'p', text: 'After <b>x</b>' },
    ])
  })

  it('reachLines follows the tools the bot can really call (effective_tools) when the server sends them', () => {
    expect(reachLines({ ...PLAIN, tools: ['all'], effective_tools: ['email'] })).toEqual([
      'Reads your inbox and writes email drafts — nothing is sent until you press Send',
    ])
  })

  it('reachLines names only what the file lists', () => {
    expect(reachLines({ ...PLAIN, tools: [] })).toEqual([])
    expect(reachLines({ ...PLAIN, tools: ['email', 'mcp'] })).toEqual([
      'Reads your inbox and writes email drafts — nothing is sent until you press Send',
      'Uses the MCP servers connected for this workspace in Settings → Integrations',
    ])
  })
})
