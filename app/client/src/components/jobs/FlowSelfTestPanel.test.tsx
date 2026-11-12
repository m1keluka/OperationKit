import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { act } from 'react'
import type { FlowPublishState, FlowSelfTest } from '../../../../shared/flow/api'
import { FlowSelfTestPanel } from './FlowSelfTestPanel'

/**
 * obj 900641 (card B5) — the self-test + publish panel shows the ENGINE's
 * verdict (failing asserts, "would send" steps) and only lets the owner publish
 * a green version after ticking exactly its send/spend nodes. The server makes
 * every decision; this checks the panel sends the right request.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function selfTest(status: 'passed' | 'failed'): FlowSelfTest {
  return {
    id: 41, flow_id: 12, version: 3, mode: 'dry', status, requested_by: 'agent:900', created_at: '2026-11-12T08:00:00Z',
    ended_at: '2026-11-12T08:00:01Z', run_ids: [77],
    result: {
      passed: status === 'passed',
      uncovered_nodes: [],
      failing_asserts: status === 'failed' ? [{ fixture: 'default', run_id: 77, expr: 'steps.notify.output.ok == true', why: 'summary posted' }] : [],
      failures: status === 'failed' ? [{ code: 'goal_not_met', fixture: 'default', message: 'fixture "default": end condition not met' }] : [],
      fixtures: [{
        name: 'default', run_id: 77, status: 'succeeded', goal_met: status === 'passed' ? 1 : 0, goal: null, error: null, spent_usd: 0,
        simulated: [{ node_id: 'notify', iteration: 0, effect: 'send', simulated: 'would_send', input_preview: '{"channel":"#bookings","text":"Triaged 1 bookings."}' }],
      }],
    },
  }
}

const state = (st: FlowSelfTest | null): FlowPublishState => ({
  version: 3, nodes_requiring_approval: ['notify'], nodes_missing_mocks: [], self_test: st, approvals: null,
})

let root: Root
let host: HTMLDivElement
const fetchMock = vi.fn()

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  root.unmount()
  host.remove()
  vi.unstubAllGlobals()
})

function render(publish: FlowPublishState) {
  flushSync(() => {
    root.render(<FlowSelfTestPanel flowId={12} publish={publish} publishedVersion={null} flowsEnabled onChanged={() => {}} onOpenRun={() => {}} />)
  })
}
const publishButton = () => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Publish v3')) as HTMLButtonElement

describe('FlowSelfTestPanel', () => {
  it('a red self-test shows the failing assert and the would-send step, and publish stays disabled', () => {
    render(state(selfTest('failed')))
    expect(host.textContent).toContain('steps.notify.output.ok == true')
    expect(host.textContent).toContain('summary posted')
    const would = host.querySelector('[data-testid="would-step"]')!
    expect(would.textContent).toContain('would send')
    expect(would.textContent).toContain('Triaged 1 bookings.')
    expect(publishButton().disabled).toBe(true)
    expect(host.textContent).toContain('The latest self-test of this version failed.')
  })

  it('green: publish needs the send node ticked, then posts exactly that approval', async () => {
    render(state(selfTest('passed')))
    expect(publishButton().disabled).toBe(true)
    const box = host.querySelector('input[type="checkbox"]') as HTMLInputElement
    await act(async () => { box.click() })
    expect(publishButton().disabled).toBe(false)
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, approvals: { version: 3, nodes: ['notify'], by: 'user:1', at: 'x' } }), { status: 200 }))
    await act(async () => { publishButton().click() })
    expect(fetchMock).toHaveBeenCalledWith('/api/flows/12/publish', expect.objectContaining({ method: 'POST', credentials: 'include' }))
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ version: 3, approve: ['notify'] })
    expect(host.textContent).toContain('you approved notify')
  })

  it('a server refusal (e.g. not a cookie owner) is shown, not hidden', async () => {
    render(state(selfTest('passed')))
    await act(async () => { (host.querySelector('input[type="checkbox"]') as HTMLInputElement).click() })
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Publishing a workflow needs an owner/admin signed in to the web app', code: 'publish_requires_owner' }), { status: 403 }))
    await act(async () => { publishButton().click() })
    expect(host.textContent).toContain('needs an owner/admin signed in')
  })

  it('Dry run posts a dry self-test of the shown version', async () => {
    render(state(null))
    expect(host.textContent).toContain('No self-test of this version yet.')
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, self_test: selfTest('passed') }), { status: 200 }))
    const dry = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Dry run'))!
    await act(async () => { dry.click() })
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ version: 3, mode: 'dry' })
    expect(fetchMock.mock.calls[0][0]).toBe('/api/flows/12/test')
  })
})
