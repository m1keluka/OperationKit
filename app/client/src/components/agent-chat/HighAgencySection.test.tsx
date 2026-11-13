import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { HighAgencySection } from './HighAgencySection'
import { wakeTimes } from '../../../../shared/high-agency'
import type { HighAgencyInfo, HighAgencyResponse } from './types'

/* obj 900748 — High Agency on the bot's settings panel: a visible on/off and a
   "how often" picker (not a hidden cron). Off by default; saving PUTs exactly
   what the admin picked; the wake times preview follows the form; non-admins
   see it read-only. */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const OFF: HighAgencyInfo = {
  slug: 'acme-cto', enabled: false, times_per_day: 1, first_hour: 9, workspace: null, allow_cards: true, allow_workflows: true,
  run_as_user_id: null, routine_id: null, updated_by: null, updated_at: null, wake_times: wakeTimes('acme-cto', 1, 9), cron: '',
  next_wake_at: null, routine: null, last_wake: null,
}

let host: HTMLDivElement
let root: Root
let requests: { url: string; method: string; body: Record<string, unknown> | null }[] = []
let current: HighAgencyInfo

function payload(): HighAgencyResponse {
  return { high_agency: current, cadences: [1, 2, 3, 4, 6], max_cards_per_wake: 3, workspace_options: ['ops', 'sales'] }
}

beforeEach(() => {
  requests = []
  current = { ...OFF }
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null
    const method = init?.method ?? 'GET'
    requests.push({ url, method, body })
    if (method === 'PUT') {
      current = { ...current, ...body, wake_times: wakeTimes('acme-cto', body.times_per_day, body.first_hour), updated_by: 'jordan',
        routine: body.enabled ? { id: 7, enabled: true, last_run_at: null, auto_paused_at: null, auto_pause_reason: null } : current.routine }
    }
    if (method === 'POST') {
      current = { ...current, last_wake: { objective_id: 4242, status: 'queue', created_at: '2026-11-13 09:00:00' } }
      return new Response(JSON.stringify({ ...payload(), result: { ok: true, objective_id: 4242 } }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify(payload()), { status: 200, headers: { 'content-type': 'application/json' } })
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

async function render(isAdmin: boolean) {
  await act(async () => {
    root.render(<HighAgencySection agent={{ slug: 'acme-cto', name: 'CTO' }} isAdmin={isAdmin} />)
  })
}

const sw = () => host.querySelector<HTMLInputElement>('input[role="switch"]')!
const select = (label: string) => {
  const l = [...host.querySelectorAll('label')].find(x => x.textContent?.trim() === label)!
  return host.querySelector<HTMLSelectElement>(`#${l.htmlFor}`)!
}
const check = (text: string) => [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(i => i.closest('label')?.textContent?.includes(text))!
const button = (t: string) => [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === t)
async function click(el: Element) {
  await act(async () => { (el as HTMLElement).click() })
}
async function choose(el: HTMLSelectElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

describe('HighAgencySection', () => {
  it('loads the bot\'s setting and shows it Off by default, with the cadence choices', async () => {
    await render(true)
    expect(requests[0]).toMatchObject({ method: 'GET', url: '/api/agent-chat/agents/acme-cto/high-agency' })
    expect(host.textContent).toContain('High Agency')
    expect(host.textContent).toContain('Off')
    expect(host.textContent).toContain('This bot never wakes on its own.')
    expect(sw().checked).toBe(false)
    const opts = [...select('How often').options].map(o => o.textContent)
    expect(opts).toEqual(['Once a day', 'Twice a day', '3 times a day', '4 times a day', '6 times a day'])
  })

  it('switching on with a cadence PUTs exactly what was picked, and previews the wake times first', async () => {
    await render(true)
    await click(sw())
    await choose(select('How often'), '3')
    await choose(select('First wake (UTC)'), '8')
    await choose(select('Wake cards go to'), 'sales')
    await click(check('Propose repeatable workflows'))
    // The preview follows the form before Save.
    expect(host.textContent).toContain(`Wakes 3 times a day at ${wakeTimes('acme-cto', 3, 8).join(', ')} UTC.`)

    await click(button('Save High Agency')!)
    const put = requests.find(r => r.method === 'PUT')!
    expect(put.url).toBe('/api/agent-chat/agents/acme-cto/high-agency')
    expect(put.body).toEqual({ enabled: true, times_per_day: 3, first_hour: 8, workspace: 'sales', allow_cards: true, allow_workflows: false })
    expect(host.textContent).toContain('Saved. High Agency is on.')
    expect(host.textContent).toContain('On · 3 times a day')
  })

  it('Save stays disabled until something changes', async () => {
    await render(true)
    expect(button('Save High Agency')!.disabled).toBe(true)
    await choose(select('How often'), '2')
    expect(button('Save High Agency')!.disabled).toBe(false)
  })

  it('Wake now asks the server for one wake and links the card it filed', async () => {
    await render(true)
    await click(button('Wake now')!)
    expect(requests.find(r => r.method === 'POST')?.url).toBe('/api/agent-chat/agents/acme-cto/high-agency/wake')
    expect(host.textContent).toContain('Woke CTO: card #4242.')
    expect(host.querySelector('a[href="/o/4242"]')).not.toBeNull()
  })

  it('tells the admin when the wake schedule is paused, and saving resumes it', async () => {
    current = { ...OFF, enabled: true, times_per_day: 2, routine: { id: 7, enabled: false, last_run_at: null, auto_paused_at: '2026-11-12', auto_pause_reason: '5 consecutive failures' } }
    await render(true)
    expect(host.textContent).toContain('On · paused')
    expect(host.textContent).toContain('paused on the Jobs page (5 consecutive failures)')
    expect(button('Save High Agency')!.disabled).toBe(false)
  })

  it('a non-admin sees the setting read-only, with no Save or Wake now', async () => {
    current = { ...OFF, enabled: true, times_per_day: 4 }
    await render(false)
    expect(host.textContent).toContain('On · 4 times a day')
    expect(sw().disabled || sw().closest('fieldset')!.disabled).toBe(true)
    expect(button('Save High Agency')).toBeUndefined()
    expect(button('Wake now')).toBeUndefined()
    expect(host.textContent).toContain('Only an admin can change High Agency.')
  })
})
