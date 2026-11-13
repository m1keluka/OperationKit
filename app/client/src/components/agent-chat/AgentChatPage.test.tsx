import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

/* Built-in bot chat page (obj 719987; user-facing wording renamed to "bot"
   in obj 900327). createRoot idiom (no @testing-library in this client),
   fetch stubbed per URL. */

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
    { id: 1, role: 'user', content: 'Reply to Priya', provider: null, model: null, tool_name: null, meta: null, images: [{ id: 5, name: 'inbox.png', media_type: 'image/png', size: 120, url: '/api/agent-chat/attachments/5' }], created_at: '2026-10-31 09:00:00' },
    { id: 2, role: 'tool', content: 'Drafted email to priya@harbor-coffee.example', provider: 'demo', model: 'scripted', tool_name: 'email_create_draft', meta: { ok: true, draft_id: 7 }, created_at: '2026-10-31 09:00:01' },
    { id: 3, role: 'tool', content: 'Created card #41: Website quote', provider: 'demo', model: 'scripted', tool_name: 'create_objective', meta: { ok: true, objective_id: 41 }, created_at: '2026-10-31 09:00:02' },
    { id: 4, role: 'assistant', content: "I've drafted a reply to **Priya**.", provider: 'demo', model: 'scripted', tool_name: null, meta: { provider_label: 'Demo (no AI account)' }, created_at: '2026-10-31 09:00:03' },
  ],
  drafts: [{ id: 7, kind: 'email', connector: 'demo', status: 'draft', payload: { to: 'priya@harbor-coffee.example', subject: 'Re: Thursday', body: 'Friday works.' } }],
  cards: [{ id: 41, title: 'Website quote', status: 'working', summary: null, pr_url: null, updated_at: '', url: '/o/41' }],
}

let calls: { url: string; method: string; body?: Record<string, unknown> }[] = []
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
    let body: Record<string, unknown> | undefined
    try { body = init?.body ? JSON.parse(String(init.body)) : undefined } catch { body = undefined }
    calls.push({ url, method, body })
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } })
    if (url === '/api/agent-chat/agents') return json({ agents: [AGENT], demo: true, providers: { demo: true }, default_provider: null })
    if (url.endsWith('/messages') && method === 'GET') return json(THREAD)
    if (url.endsWith('/messages') && method === 'POST') return json({ messages: [], drafts: [], cards: [] })
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
  it('lists bots and shows which AI answered each reply', async () => {
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

  it('shows the board card the bot created, with its live status and a link', async () => {
    await mount('/chat/demo-assistant')
    await settle()
    const link = host.querySelector('a[href="/o/41"]')!
    expect(link.textContent).toContain('#41')
    expect(link.textContent).toContain('In progress')
  })

  it('on the bot list alone (mobile entry) the conversation pane waits for a pick', async () => {
    await mount('/chat')
    await settle()
    expect(host.textContent).toContain('Pick a bot')
    expect(host.querySelector('nav[aria-label="Bots"] button')?.textContent).toContain('Personal assistant (demo)')
  })

  // ── screenshots (obj 900157) ──
  //
  // The composer used to be a bare textarea: pasting a screenshot into it did
  // nothing at all, so the message left as text only and the agent answered
  // that it could not open screenshots.

  const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
  const pngFile = (name = 'screenshot.png') =>
    new File([Uint8Array.from(atob(PNG_B64), c => c.charCodeAt(0))], name, { type: 'image/png' })

  function paste(el: Element, files: File[]) {
    const ev = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(ev, 'clipboardData', { value: { files, types: ['Files'] } })
    el.dispatchEvent(ev)
  }

  const sent = () => calls.find(c => c.method === 'POST' && c.url.endsWith('/messages'))

  it('pasting a screenshot attaches it, previews it, and sends it with the message', async () => {
    await mount('/chat/demo-assistant')
    await settle()
    const box = host.querySelector('#agent-chat-input') as HTMLTextAreaElement
    const send = [...host.querySelectorAll('button')].find(b => b.textContent === 'Send' && b.getAttribute('type') === 'submit')!
    expect((send as HTMLButtonElement).disabled).toBe(true)

    paste(box, [pngFile()])
    await settle()

    const preview = host.querySelector('ul[aria-label="Attached images"] img') as HTMLImageElement
    expect(preview).toBeTruthy()
    expect(preview.src).toContain('data:image/png;base64,')
    // A screenshot on its own is enough to send.
    expect(([...host.querySelectorAll('button')].find(b => b.textContent === 'Send' && b.getAttribute('type') === 'submit') as HTMLButtonElement).disabled).toBe(false)

    ;([...host.querySelectorAll('button')].find(b => b.textContent === 'Send' && b.getAttribute('type') === 'submit') as HTMLButtonElement).click()
    await settle()

    const post = sent()!
    expect(post).toBeTruthy()
    const images = post.body!.images as { name: string; media_type: string; data: string }[]
    expect(images).toHaveLength(1)
    expect(images[0].media_type).toBe('image/png')
    expect(images[0].data).toBe(`data:image/png;base64,${PNG_B64}`)
    // The attachment strip is cleared once the message is away.
    expect(host.querySelector('ul[aria-label="Attached images"]')).toBeNull()
  })

  it('pasting plain text still types into the box', async () => {
    await mount('/chat/demo-assistant')
    await settle()
    const box = host.querySelector('#agent-chat-input') as HTMLTextAreaElement
    paste(box, [])
    await settle()
    expect(host.querySelector('ul[aria-label="Attached images"]')).toBeNull()
  })

  it('the attach button takes a picked file, and a non-image is refused with a reason', async () => {
    await mount('/chat/demo-assistant')
    await settle()
    const picker = host.querySelector('[data-testid="agent-chat-file-input"]') as HTMLInputElement

    Object.defineProperty(picker, 'files', { value: [new File(['nope'], 'notes.txt', { type: 'text/plain' })], configurable: true })
    picker.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('not an image')
    expect(host.querySelector('ul[aria-label="Attached images"]')).toBeNull()

    Object.defineProperty(picker, 'files', { value: [pngFile('shot.png')], configurable: true })
    picker.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()
    expect(host.querySelectorAll('ul[aria-label="Attached images"] img')).toHaveLength(1)
  })

  it('an attached image can be removed before sending', async () => {
    await mount('/chat/demo-assistant')
    await settle()
    paste(host.querySelector('#agent-chat-input')!, [pngFile('shot.png')])
    await settle()
    const remove = host.querySelector('button[aria-label="Remove shot.png"]') as HTMLButtonElement
    expect(remove).toBeTruthy()
    remove.click()
    await settle()
    expect(host.querySelector('ul[aria-label="Attached images"]')).toBeNull()
  })

  it('renders the image on a sent message, linking to its own owner-checked route', async () => {
    await mount('/chat/demo-assistant')
    await settle()
    const img = host.querySelector('img[alt="inbox.png"]') as HTMLImageElement
    expect(img).toBeTruthy()
    expect(img.getAttribute('src')).toBe('/api/agent-chat/attachments/5')
    expect(img.closest('a')?.getAttribute('href')).toBe('/api/agent-chat/attachments/5')
  })
})

// obj 900745 — the composer was rows={1} with no autosize, so a long or
// multi-line message stayed one short line. It now grows with its content up
// to 240px, then scrolls inside, and shrinks back when cleared.
describe('AgentChatPage composer autosize (obj 900745)', () => {
  const LINE_PX = 22
  let restore: PropertyDescriptor | undefined
  beforeEach(() => {
    // jsdom has no layout: model scrollHeight as one 22px line per text line.
    restore = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'scrollHeight')
    Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
      configurable: true,
      get(this: HTMLTextAreaElement) { return Math.max(1, this.value.split('\n').length) * LINE_PX },
    })
  })
  afterEach(() => {
    if (restore) Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', restore)
    else delete (HTMLTextAreaElement.prototype as unknown as Record<string, unknown>).scrollHeight
  })

  function type(box: HTMLTextAreaElement, value: string) {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, value)
    box.dispatchEvent(new Event('input', { bubbles: true }))
  }

  it('grows with multi-line input, caps at 240px and scrolls, then shrinks when cleared', async () => {
    await mount('/chat/demo-assistant')
    await settle()
    const box = host.querySelector('#agent-chat-input') as HTMLTextAreaElement
    expect(box.className).toContain('max-h-60')

    type(box, 'one\ntwo\nthree\nfour\nfive')
    await settle()
    expect(box.style.height).toBe(`${5 * LINE_PX}px`)
    expect(box.style.overflowY).toBe('hidden')

    type(box, Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n'))
    await settle()
    expect(box.style.height).toBe('240px')
    expect(box.style.overflowY).toBe('auto')

    type(box, '')
    await settle()
    expect(box.style.height).toBe(`${LINE_PX}px`)
    expect(box.style.overflowY).toBe('hidden')
  })
})
