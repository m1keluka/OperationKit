import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { act } from 'react'
import type { FlowWaitSummary } from '../../../../shared/flow/api'
import { FlowRunWaitsPanel } from './FlowRunWaitsPanel'

/**
 * obj 900645 (card B9) — the "waiting for" panel of a workflow run: an approval
 * wait shows its prompt and the exact payload the next step will send, and the
 * Approve / Reject buttons post exactly that decision. The server decides who
 * may click (cookie owner/admin); a refusal is shown, never swallowed.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const approval: FlowWaitSummary = {
  node_id: 'confirm', iteration: 0, reason: 'approval', kind: 'approval', created_at: '2026-11-12T08:00:00Z', expires_at: null,
  objective_id: null, event_name: null,
  approval: { from: 'owner', prompt: 'Send the renewal notice to cfo@example.com?' },
  next: { node_id: 'notify', kind: 'tool', effect: 'send', input: { to: 'cfo@example.com', template: 'renewal' } },
}
const agent: FlowWaitSummary = {
  node_id: 'research', iteration: 2, reason: 'agent', kind: 'event', created_at: '2026-11-12T08:00:00Z', expires_at: null,
  objective_id: 4242, objective_status: 'working', event_name: null,
}

let root: Root
let host: HTMLDivElement
const fetchMock = vi.fn()
const onChanged = vi.fn()

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  fetchMock.mockReset()
  onChanged.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  root.unmount()
  host.remove()
  vi.unstubAllGlobals()
})

function render(waits: FlowWaitSummary[]) {
  flushSync(() => { root.render(<FlowRunWaitsPanel flowId={12} runId={77} waits={waits} onChanged={onChanged} />) })
}
const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(label)) as HTMLButtonElement

describe('FlowRunWaitsPanel', () => {
  it('renders nothing when the run waits for nothing', () => {
    render([])
    expect(host.textContent).toBe('')
  })

  it('an approval shows the prompt and the exact payload; Approve posts that node and refreshes', async () => {
    render([approval])
    expect(host.textContent).toContain('Send the renewal notice to cfo@example.com?')
    const payload = host.querySelector('[data-testid="flow-wait-payload"]')!
    expect(JSON.parse(payload.textContent!)).toEqual({ to: 'cfo@example.com', template: 'renewal' })
    expect(host.textContent).toContain('notify')

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    await act(async () => { button('Approve').click() })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/flows/12/runs/77/approval')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ decision: 'approve', node_id: 'confirm', iteration: 0 })
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('Reject sends the note; a server refusal (not the owner) is shown and nothing refreshes', async () => {
    render([approval])
    const input = host.querySelector('input[aria-label="Note"]') as HTMLInputElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'not this quarter')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Approving a workflow step needs an owner/admin signed in to the web app' }), { status: 403 }))
    await act(async () => { button('Reject').click() })
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ decision: 'reject', node_id: 'confirm', iteration: 0, note: 'not this quarter' })
    expect(host.textContent).toContain('needs an owner/admin signed in to the web app')
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('an agent wait links the child card with its status; no buttons', () => {
    render([agent])
    const link = host.querySelector('a[href="/o/4242"]')!
    expect(link.textContent).toContain('Agent card #4242')
    expect(link.textContent).toContain('working')
    expect(host.textContent).toContain('research[2]')
    expect(host.querySelectorAll('button')).toHaveLength(0)
  })
})
