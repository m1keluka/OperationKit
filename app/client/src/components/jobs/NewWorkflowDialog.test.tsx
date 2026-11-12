import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { NewWorkflowDialog, parseAsserts } from './NewWorkflowDialog'

/**
 * obj 900642 (card B6) — "New workflow" posts a GOAL (not JSON) to POST /api/flows
 * and shows the builder card it filed. The server builds the brief and enforces
 * the workspace; this checks the dialog sends the right request and keeps what
 * the user typed while the board re-renders.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

const q = <T extends Element>(sel: string) => document.body.querySelector(sel) as T | null

/** React tracks the value through its own setter; set it the way a keystroke would. */
function type(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
}

function render(props: Partial<Parameters<typeof NewWorkflowDialog>[0]> = {}) {
  act(() => {
    root.render(
      <NewWorkflowDialog open onClose={() => {}} workspaces={['acme', 'beta']} defaultWorkspace="beta" {...props} />,
    )
  })
}

describe('NewWorkflowDialog', () => {
  it('parses one end-condition assert per non-empty line', () => {
    expect(parseAsserts('  \n')).toBeUndefined()
    expect(parseAsserts('a == 1\n\n  len(b) > 0 ')).toEqual({ assert: [{ expr: 'a == 1' }, { expr: 'len(b) > 0' }] })
  })

  it('posts the goal, name, workspace, end condition and builder budget, then shows the builder card', async () => {
    fetchMock.mockResolvedValue({
      status: 201,
      json: async () => ({
        flow_id: 9, slug: 'triage', workspace: 'beta', objective_id: 321,
        builder: { objective_id: 321, status: 'queue', max_iterations: 4, queue_hold: null },
      }),
    })
    const onCreated = vi.fn()
    render({ onCreated })
    const submit = q<HTMLButtonElement>('button[type="submit"]')!
    expect(submit.disabled).toBe(true) // no goal yet
    expect(q<HTMLSelectElement>('select')!.value).toBe('beta')

    act(() => {
      type(q<HTMLTextAreaElement>('textarea')!, 'Triage yesterday\'s bookings into the CRM')
      type(q<HTMLInputElement>('input[maxlength="120"]')!, 'Booking triage')
      type(document.body.querySelectorAll('textarea')[1] as HTMLTextAreaElement, 'steps.check.output.ok == true')
      type(q<HTMLInputElement>('input[type="number"]')!, '4')
    })
    await act(async () => { q<HTMLButtonElement>('button[type="submit"]')!.click() })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/flows')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({
      workspace: 'beta',
      goal: "Triage yesterday's bookings into the CRM",
      name: 'Booking triage',
      end_condition: { assert: [{ expr: 'steps.check.output.ok == true' }] },
      builder: { max_iterations: 4 },
    })
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ flow_id: 9, objective_id: 321 }))
    expect(q('[data-testid="new-workflow-created"]')?.textContent).toContain('triage')
    expect(document.body.textContent).toContain('Open builder card #321')
  })

  it('shows the server error and stays on the form', async () => {
    fetchMock.mockResolvedValue({ status: 403, json: async () => ({ error: "No access to workspace 'beta'" }) })
    render()
    act(() => type(q<HTMLTextAreaElement>('textarea')!, 'goal'))
    await act(async () => { q<HTMLButtonElement>('button[type="submit"]')!.click() })
    expect(document.body.textContent).toContain("No access to workspace 'beta'")
    expect(q('[data-testid="new-workflow-created"]')).toBeNull()
  })

  it('keeps what the user typed when the parent re-renders with a fresh workspaces array', () => {
    render()
    act(() => type(q<HTMLTextAreaElement>('textarea')!, 'half-written goal'))
    render({ workspaces: ['acme', 'beta'] }) // new array identity, as the live board does every few seconds
    expect(q<HTMLTextAreaElement>('textarea')!.value).toBe('half-written goal')
  })
})
