import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { BotSettingsPanel } from './BotSettingsPanel'
import type { AgentsResponse, ChatAgentInfo } from './types'

/* obj 900671 — each bot's page has an editable default model, per-bot tool
   assignment and an "All tools" option. Saving PUTs exactly what the admin
   picked; a non-admin sees the same settings read-only. */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const CATALOG: NonNullable<AgentsResponse['tool_catalog']> = [
  { name: 'web_search', label: 'Web search', description: 'Search the public web.', group: 'web' },
  { name: 'web_fetch', label: 'Read web pages', description: 'Open one public page.', group: 'web' },
  { name: 'list_objectives', label: 'List cards', description: 'List board cards.', group: 'board' },
  { name: 'create_objective', label: 'File board cards', description: 'File a card.', group: 'board' },
]

const META = {
  tool_catalog: CATALOG,
  model_suggestions: { claude: ['claude-opus-5-5', 'claude-sonnet-5'] },
  default_models: { claude: 'claude-sonnet-5' },
  web: { available: true, backends: ['firecrawl'] },
  providers: { claude: true, anthropic: false, openai: false, xai: true, 'openai-compatible': false, demo: true },
} as AgentsResponse

const CTO: ChatAgentInfo = {
  slug: 'acme-cto', name: 'CTO', description: '', avatar: 'CT', colour: 'blue', knowledge_folders: [],
  tools: ['list_objectives', 'create_objective'], model: null, provider: null, version: null, author: null, source: 'file',
  answered_by: { id: 'claude', model: 'claude-sonnet-5' },
  all_tools: false, effective_tools: ['list_objectives', 'create_objective', 'board_briefing'],
  file_defaults: { provider: null, model: null, tools: ['list_objectives', 'create_objective'] },
  config: null,
}

const HIGH_AGENCY_OFF = {
  high_agency: {
    slug: 'acme-cto', enabled: false, times_per_day: 1, first_hour: 9, workspace: null, allow_cards: true, allow_workflows: true,
    run_as_user_id: null, routine_id: null, updated_by: null, updated_at: null, wake_times: ['09:00'], cron: '0 9 * * *',
    next_wake_at: null, routine: null, last_wake: null,
  },
  cadences: [1, 2, 3, 4, 6],
  max_cards_per_wake: 3,
}

let host: HTMLDivElement
let root: Root
let requests: { url: string; method: string; body: unknown }[] = []
let onSaved: ReturnType<typeof vi.fn>

beforeEach(() => {
  requests = []
  onSaved = vi.fn()
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    // The High Agency section (obj 900748) loads its own setting; it has its own
    // test file, so its calls are answered here and kept out of `requests`.
    if (url.includes('/high-agency')) return new Response(JSON.stringify(HIGH_AGENCY_OFF), { status: 200, headers: { 'content-type': 'application/json' } })
    const body = init?.body ? JSON.parse(String(init.body)) : null
    requests.push({ url, method: init?.method ?? 'GET', body })
    const agent = { ...CTO, model: body?.model ?? null, all_tools: !!body?.all_tools, config: init?.method === 'DELETE' ? null : { ...body, updated_by: 'jordan', updated_at: '' } }
    return new Response(JSON.stringify({ agent }), { status: 200, headers: { 'content-type': 'application/json' } })
  }))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

function render(agent: ChatAgentInfo, isAdmin: boolean, meta: AgentsResponse = META) {
  act(() => {
    root.render(<BotSettingsPanel agent={agent} meta={meta} isAdmin={isAdmin} onSaved={onSaved} onClose={() => {}} />)
  })
}

const box = (label: string) => host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
const allTools = () => [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(i => i.closest('label')?.textContent?.includes('All tools'))!
const button = (t: string) => [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === t)!

function setInput(el: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
}

async function click(el: Element) {
  await act(async () => { (el as HTMLElement).click() })
}

describe('BotSettingsPanel', () => {
  it('shows the editable default model, the tool list grouped by kind, and an All tools option', () => {
    render(CTO, true)
    const model = host.querySelector<HTMLInputElement>('#bot-model-acme-cto')!
    expect(model.disabled).toBe(false)
    expect(model.placeholder).toBe('claude-sonnet-5 (default)')
    expect([...host.querySelectorAll('datalist option')].map(o => o.getAttribute('value'))).toEqual(['claude-opus-5-5', 'claude-sonnet-5'])
    expect(host.textContent).toContain('Answers now with Claude · claude-sonnet-5')
    expect(host.textContent).toContain('All tools')
    expect(host.textContent).toContain('Web')
    expect(box('Web search').checked).toBe(false)
    expect(box('List cards').checked).toBe(true)
  })

  it('saves a new default model and web tools for this bot', async () => {
    render(CTO, true)
    act(() => setInput(host.querySelector<HTMLInputElement>('#bot-model-acme-cto')!, 'claude-opus-5-5'))
    await click(box('Web search'))
    await click(box('Read web pages'))
    await click(button('Save'))
    expect(requests).toHaveLength(1)
    expect(requests[0].method).toBe('PUT')
    expect(requests[0].url).toBe('/api/agent-chat/agents/acme-cto/config')
    expect(requests[0].body).toEqual({
      provider: null,
      model: 'claude-opus-5-5',
      all_tools: false,
      tools: ['list_objectives', 'create_objective', 'web_search', 'web_fetch'],
    })
    expect(onSaved).toHaveBeenCalledTimes(1)
    expect(host.textContent).toContain('Saved.')
  })

  it('"All tools" ticks and locks every tool, and saves all_tools: true', async () => {
    render(CTO, true)
    await click(allTools())
    expect(box('Web search').checked).toBe(true)
    expect(box('Web search').disabled).toBe(true)
    await click(button('Save'))
    expect(requests[0].body).toMatchObject({ all_tools: true })
  })

  it('an unchanged tool list is sent as null so the agent file stays in charge', async () => {
    render(CTO, true)
    await click(button('Save'))
    expect(requests[0].body).toMatchObject({ tools: null, model: null, provider: null })
  })

  it('switching All tools off for a bot whose file says `tools: [all]` sends an explicit list', async () => {
    render({ ...CTO, tools: ['all'], all_tools: true, file_defaults: { provider: null, model: null, tools: ['all'] } }, true)
    expect(allTools().checked).toBe(true)
    await click(allTools())
    await click(box('Web search'))
    await click(button('Save'))
    expect(requests[0].body).toMatchObject({ all_tools: false, tools: ['web_search'] })
  })

  it('Reset to file deletes the override', async () => {
    render({ ...CTO, model: 'claude-opus-5-5', config: { provider: null, model: 'claude-opus-5-5', tools: null, all_tools: false, updated_by: 'jordan', updated_at: '' } }, true)
    expect(host.querySelector<HTMLInputElement>('#bot-model-acme-cto')!.value).toBe('claude-opus-5-5')
    await click(button('Reset to file'))
    expect(requests[0]).toMatchObject({ method: 'DELETE', url: '/api/agent-chat/agents/acme-cto/config' })
    expect(host.querySelector<HTMLInputElement>('#bot-model-acme-cto')!.value).toBe('')
  })

  it('warns when web search is picked but no search key is set up', async () => {
    render(CTO, true, { ...META, web: { available: false, backends: [] } })
    expect(host.textContent).not.toContain('Web search is not set up')
    await click(box('Web search'))
    expect(host.textContent).toContain('Web search is not set up on this install yet')
  })

  it('is read-only for a non-admin and shows what the bot can use', () => {
    render({ ...CTO, effective_tools: ['web_search', 'list_objectives'] }, false)
    expect(host.textContent).toContain('Only an admin can change')
    expect(host.querySelector<HTMLInputElement>('#bot-model-acme-cto')!.disabled).toBe(true)
    expect(box('Web search').checked).toBe(true)
    expect(box('File board cards').checked).toBe(false)
    expect([...host.querySelectorAll('button')].some(b => b.textContent?.trim() === 'Save')).toBe(false)
  })
})

/* obj 900749 — "Use secrets by name" is explicit opt-in: "All tools" never
   implies it, so it stays tickable (and unticked) with "All tools" on, and a
   tick is saved alongside all_tools. */
describe('explicit-only secret tool', () => {
  const META_SECRETS = {
    ...META,
    tool_catalog: [...CATALOG, { name: 'secrets', label: 'Use secrets by name', description: 'Server adds the key.', group: 'secrets', explicit_only: true }],
  } as AgentsResponse

  it('is not implied by "All tools" and can be ticked on its own', async () => {
    render({ ...CTO, all_tools: true }, true, META_SECRETS)
    expect(allTools().checked).toBe(true)
    expect(box('Web search').disabled).toBe(true)
    const secrets = box('Use secrets by name')
    expect(secrets.checked).toBe(false)
    expect(secrets.disabled).toBe(false)
    expect(host.textContent).toContain('Secrets')
    await click(secrets)
    await click(button('Save'))
    const put = requests.find(r => r.method === 'PUT')!
    expect(put.body).toMatchObject({ all_tools: true })
    expect((put.body as { tools: string[] }).tools).toContain('secrets')
  })
})

// obj 900745 — Operator missed the ghost "Done" (plain text on the dark panel) and
// closed the panel with the header Settings toggle. Done is a real button now.
describe('BotSettingsPanel Done button (obj 900745)', () => {
  it('is a visible, bordered button (not ghost text) that closes the panel', async () => {
    const onClose = vi.fn()
    act(() => {
      root.render(<BotSettingsPanel agent={CTO} meta={META} isAdmin={false} onSaved={onSaved} onClose={onClose} />)
    })
    const done = button('Done')
    expect(done).toBeTruthy()
    expect(done.getAttribute('aria-label')).toBe('Done: close settings for CTO')
    // Secondary variant + stronger hairline and fill — never the transparent ghost.
    expect(done.className).toContain('!border-line-strong')
    expect(done.className).toContain('!bg-surface-2')
    expect(done.className).not.toContain('bg-transparent')
    expect(done.className).not.toContain('border-transparent')
    await click(done)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
