// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { AgentWebhooksSection } from './AgentWebhooksSection'

async function flush() {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve()
    await new Promise(r => setTimeout(r, 0))
    flushSync(() => {})
    await Promise.resolve()
  }
}

const { apiMock } = vi.hoisted(() => ({
  apiMock: { get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() },
}))

vi.mock('../../lib/api', () => ({
  api: apiMock,
  ApiError: class ApiError extends Error {
    constructor(public status: number, public body: unknown, message: string) {
      super(message)
    }
  },
}))

vi.mock('../ui', async () => {
  const actual = await vi.importActual<typeof import('../ui')>('../ui')
  return { ...actual, useConfirm: () => ({ confirm: vi.fn(async () => true), confirmDialog: null }) }
})

const KEY = (id: number, label: string) => ({
  id, label, last4: 'AbCd', scopes: ['board:read'], workspaces: null,
  created_at: '2026-10-01 10:00:00', last_used_at: null, revoked_at: null,
})
const HOOK = {
  key_id: 7, url: 'https://bot.example.com/hook', header_name: 'Authorization', header_prefix: 'Bearer ',
  events: ['pr_opened', 'entered_review', 'done'], enabled: true, has_secret: true,
  secret_name: 'CC_AGENT_WEBHOOK_KEY_7', created_at: '2026-10-28 01:00:00', updated_at: '2026-10-28 01:00:00',
}
const DELIVERY = {
  id: 1, event_id: 'cc_evt_9_k7', event: 'entered_review', objective_id: 4242, status: 'failed', attempts: 5,
  last_status_code: 503, last_error: 'HTTP 503', next_attempt_at: null, created_at: '2026-10-28 01:05:00', delivered_at: null,
}

function button(container: HTMLElement, text: string): HTMLButtonElement {
  const b = Array.from(container.querySelectorAll('button')).find(x => x.textContent?.trim() === text)
  if (!b) throw new Error(`no button "${text}"`)
  return b as HTMLButtonElement
}

function setInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('AgentWebhooksSection', () => {
  let root: Root
  let container: HTMLDivElement

  beforeEach(() => {
    apiMock.get.mockReset().mockImplementation(async (p: string) => {
      if (p === '/auth/agent-keys') return { keys: [KEY(7, 'Grok: Example'), KEY(8, 'Grok: Inbox'), { ...KEY(9, 'Old'), revoked_at: '2026-10-02' }] }
      if (p === '/auth/agent-keys/7/webhook') return { webhook: HOOK }
      if (p === '/auth/agent-keys/8/webhook') return { webhook: null }
      if (p.startsWith('/auth/agent-keys/7/webhook/deliveries')) return { deliveries: [DELIVERY] }
      throw new Error(`unexpected GET ${p}`)
    })
    apiMock.post.mockReset()
    apiMock.put.mockReset()
    apiMock.del.mockReset().mockResolvedValue({ ok: true })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    flushSync(() => root.unmount())
    container.remove()
  })

  it('lists active keys only, with webhook state', async () => {
    flushSync(() => root.render(<AgentWebhooksSection />))
    await flush()
    const text = container.textContent ?? ''
    expect(text).toContain('Grok: Example')
    expect(text).toContain('https://bot.example.com/hook')
    expect(text).toContain('Grok: Inbox')
    expect(text).toContain('no webhook')
    expect(text).not.toContain('Old')
  })

  it('new webhook: default events preselected, sender key required, PUT carries it once and the field clears', async () => {
    apiMock.put.mockResolvedValue({ webhook: { ...HOOK, key_id: 8 } })
    flushSync(() => root.render(<AgentWebhooksSection />))
    await flush()
    button(container, 'Add webhook').click()
    await flush()
    const checked = Array.from(container.querySelectorAll('fieldset input[type=checkbox]'))
      .filter(i => (i as HTMLInputElement).checked)
      .map(i => i.closest('label')!.querySelector('.font-mono')!.textContent)
    expect(checked).toEqual(['pr_opened', 'ai_review', 'entered_review', 'needs_secret', 'failed', 'stalled', 'done'])

    setInput(container.querySelector('#wh-8-url') as HTMLInputElement, 'https://grok.example.com/cc')
    expect(button(container, 'Save webhook').disabled).toBe(true) // no sender key yet
    const secret = container.querySelector('#wh-8-secret') as HTMLInputElement
    expect(secret.type).toBe('password')
    setInput(secret, 'super-secret-sender')
    await flush()
    button(container, 'Save webhook').click()
    await flush()
    expect(apiMock.put).toHaveBeenCalledWith('/auth/agent-keys/8/webhook', {
      url: 'https://grok.example.com/cc',
      header_name: 'Authorization',
      header_prefix: 'Bearer ',
      events: ['pr_opened', 'ai_review', 'entered_review', 'needs_secret', 'failed', 'stalled', 'done'],
      enabled: true,
      secret: 'super-secret-sender',
    })
    expect((container.querySelector('#wh-8-secret') as HTMLInputElement).value).toBe('')
    expect(container.textContent).toMatch(/will not be shown again/)
  })

  it('existing webhook: blank sender key keeps the stored one, shows delivery log, sends a test event', async () => {
    apiMock.put.mockResolvedValue({ webhook: HOOK })
    apiMock.post.mockResolvedValue({ delivered: true, status_code: 200, error: null, event_id: 'cc_test_x' })
    flushSync(() => root.render(<AgentWebhooksSection />))
    await flush()
    button(container, 'Edit webhook').click()
    await flush()
    expect(container.textContent).toContain('HTTP 503')
    expect(container.textContent).toContain('#4242')
    expect(container.textContent).toContain('5 tries')

    button(container, 'Save webhook').click()
    await flush()
    expect(apiMock.put.mock.calls[0][1]).not.toHaveProperty('secret')

    button(container, 'Send test event').click()
    await flush()
    expect(apiMock.post).toHaveBeenCalledWith('/auth/agent-keys/7/webhook/test')
    expect(container.textContent).toMatch(/Delivered — receiver answered 200/)
  })

  // obj 900270: the needs_agent option is on every key (no label pilot) and saves.
  const eventBox = (c: HTMLElement, name: string) => {
    const label = Array.from(c.querySelectorAll('fieldset label')).find(l => l.querySelector('.font-mono')?.textContent === name)
    if (!label) throw new Error(`no event option "${name}"`)
    return label.querySelector('input[type=checkbox]') as HTMLInputElement
  }

  it('needs_agent is offered on a non-pilot key (the shared connection) and saves', async () => {
    apiMock.get.mockImplementation(async (p: string) => {
      if (p === '/auth/agent-keys') return { keys: [KEY(11, 'OpKit')] }
      if (p === '/auth/agent-keys/11/webhook') return { webhook: null }
      throw new Error(`unexpected GET ${p}`)
    })
    apiMock.put.mockResolvedValue({ webhook: { ...HOOK, key_id: 11, events: ['needs_agent'] } })
    flushSync(() => root.render(<AgentWebhooksSection />))
    await flush()
    button(container, 'Add webhook').click()
    await flush()
    const needs = eventBox(container, 'needs_agent')
    expect(needs.checked).toBe(false) // new webhooks still start on the default set
    // Shared connection: needs_agent only.
    for (const e of ['pr_opened', 'ai_review', 'entered_review', 'needs_secret', 'failed', 'stalled', 'done']) eventBox(container, e).click()
    needs.click()
    await flush()
    setInput(container.querySelector('#wh-11-url') as HTMLInputElement, 'https://cos.example.com/card-wake')
    setInput(container.querySelector('#wh-11-secret') as HTMLInputElement, 'shared-sender-key-123')
    await flush()
    button(container, 'Save webhook').click()
    await flush()
    expect(apiMock.put).toHaveBeenCalledWith('/auth/agent-keys/11/webhook', expect.objectContaining({ events: ['needs_agent'] }))
    expect(container.textContent).toMatch(/Saved\./)
  })

  it('adding needs_agent to an existing webhook keeps its other events', async () => {
    apiMock.put.mockResolvedValue({ webhook: { ...HOOK, events: ['pr_opened', 'entered_review', 'done', 'needs_agent'] } })
    flushSync(() => root.render(<AgentWebhooksSection />))
    await flush()
    button(container, 'Edit webhook').click()
    await flush()
    eventBox(container, 'needs_agent').click()
    await flush()
    button(container, 'Save webhook').click()
    await flush()
    expect(apiMock.put.mock.calls[0][1].events).toEqual(['pr_opened', 'entered_review', 'done', 'needs_agent'])
  })

  it('remove deletes the webhook', async () => {
    flushSync(() => root.render(<AgentWebhooksSection />))
    await flush()
    button(container, 'Edit webhook').click()
    await flush()
    button(container, 'Remove').click()
    await flush()
    expect(apiMock.del).toHaveBeenCalledWith('/auth/agent-keys/7/webhook')
    expect(container.textContent).toContain('no webhook')
  })
})
