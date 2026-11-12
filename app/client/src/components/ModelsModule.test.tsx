// @vitest-environment jsdom
/**
 * obj 900679 — Models settings: the default/planner are editable dropdowns and
 * "Refresh from providers" shows per-provider results, including failures.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ModelsModule } from './ModelsModule'

const { apiMock } = vi.hoisted(() => ({
  apiMock: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
}))
vi.mock('../lib/api', () => ({ api: apiMock }))

const MODELS = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5', engine: 'claude', enabled: true, is_default: true, is_planner: true, sort_order: 4, source: 'seed' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', engine: 'claude', enabled: true, is_default: false, is_planner: false, sort_order: 18, source: 'seed' },
  { id: 'gpt-5.5', label: 'GPT-5.5 (Codex)', engine: 'codex', enabled: true, is_default: false, is_planner: false, sort_order: 30, source: 'seed' },
]
const NEW_ROW = { id: 'claude-opus-6', label: 'Claude Opus 6', engine: 'claude', enabled: false, is_default: false, is_planner: false, sort_order: 90, source: 'provider' }

const REPORT = {
  trigger: 'manual',
  started_at: '2026-11-12T14:00:00.000Z',
  finished_at: '2026-11-12T14:00:02.000Z',
  providers: [
    { provider: 'anthropic', label: 'Anthropic', engine: 'claude', status: 'ok', credential: 'ANTHROPIC_API_KEY', error: null, http_status: 200, fetched: 3, added: ['claude-opus-6'], updated: [], missing: [] },
    { provider: 'openai', label: 'OpenAI', engine: 'codex', status: 'error', credential: 'OPENAI_API_KEY', error: 'api.openai.com answered 401 (credential rejected): Incorrect API key', http_status: 401, fetched: 0, added: [], updated: [], missing: [] },
    { provider: 'xai', label: 'xAI', engine: 'grok', status: 'skipped', credential: null, error: 'Not connected — add a xAI key under API key providers (or set XAI_API_KEY).', http_status: null, fetched: 0, added: [], updated: [], missing: [] },
  ],
}

let container: HTMLDivElement
let root: Root

async function render() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root.render(<ModelsModule />) })
  await act(async () => { await Promise.resolve() })
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  apiMock.get.mockImplementation(async (path: string) => {
    if (path === '/models/all') return { models: MODELS }
    if (path === '/models/refresh') return { report: null, auto_refresh_hours: 24 }
    throw new Error(`unexpected GET ${path}`)
  })
  apiMock.patch.mockReset()
  apiMock.post.mockReset()
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('ModelsModule', () => {
  it('lets the admin change the default model from a dropdown', async () => {
    apiMock.patch.mockResolvedValue({ models: MODELS.map(m => ({ ...m, is_default: m.id === 'claude-sonnet-5' })) })
    await render()
    const select = container.querySelector<HTMLSelectElement>('#models-default-select')!
    expect(select.value).toBe('claude-opus-5-5')
    await act(async () => {
      select.value = 'claude-sonnet-5'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(apiMock.patch).toHaveBeenCalledWith('/models/claude-sonnet-5', { is_default: true })
    expect(container.querySelector<HTMLSelectElement>('#models-default-select')!.value).toBe('claude-sonnet-5')
    expect(container.textContent).toContain('refreshes automatically every 24h')
  })

  it('refreshes from providers and shows new models plus clear per-provider failures', async () => {
    apiMock.post.mockResolvedValue({ report: REPORT, models: [...MODELS, NEW_ROW], auto_refresh_hours: 24 })
    await render()
    expect(container.textContent).toContain('Never refreshed')
    const btn = container.querySelector<HTMLButtonElement>('[data-testid="models-refresh"]')!
    await act(async () => { btn.click() })
    expect(apiMock.post).toHaveBeenCalledWith('/models/refresh', {}, { timeoutMs: 120_000 })

    const ant = container.querySelector('[data-testid="refresh-status-anthropic"]')!.textContent!
    expect(ant).toContain('Updated')
    expect(ant).toContain('1 new')
    const oai = container.querySelector('[data-testid="refresh-status-openai"]')!.textContent!
    expect(oai).toContain('Failed')
    expect(oai).toContain('401 (credential rejected)')
    expect(container.querySelector('[data-testid="refresh-status-xai"]')!.textContent).toContain('Not connected')

    // the discovered model is listed with a New badge
    expect(container.textContent).toContain('claude-opus-6')
    expect(container.textContent).toContain('New')
  })

  it('shows the refresh error when the request itself fails', async () => {
    apiMock.post.mockRejectedValue(new Error('Request timed out'))
    await render()
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="models-refresh"]')!.click() })
    expect(container.textContent).toContain('Request timed out')
  })
})
