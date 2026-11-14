import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { WorkspaceAccessSection } from './WorkspaceAccessSection'
import type { BotWorkspaceAccessInfo, BotWorkspaceAccessResponse } from './types'

/* obj 900797 — Workspace access on the bot's settings panel. A global bot's
   list of workspaces it may use: an admin sees the current list, grants one
   from a picker of the rest and revokes one per row; the three states (not
   restricted yet / N workspaces / none) read differently; a revoke that
   switched High Agency off says so; non-admins see it read-only. Wording is
   Workspace, never Organization. */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const OPTIONS = [{ slug: 'ops', name: 'Ops' }, { slug: 'sales', name: 'Sales' }, { slug: 'finance', name: 'Finance' }]

function accessWith(mode: 'restricted' | 'unrestricted', workspaces: string[]): BotWorkspaceAccessInfo {
  return {
    slug: 'acme-cto', mode, configured: true, workspaces,
    grants: workspaces.map(w => ({ workspace: w, granted_by: 'jordan', granted_at: '2026-11-13 18:00:00' })),
    updated_by: mode === 'unrestricted' ? 'migration' : 'jordan', updated_at: '2026-11-13 18:00:00',
  }
}

let host: HTMLDivElement
let root: Root
let requests: { url: string; method: string; body: Record<string, unknown> | null }[] = []
let current: BotWorkspaceAccessInfo
let haSwitchedOff = false
let failNext: string | null = null
let asMember = false

function payload(extra: Partial<BotWorkspaceAccessResponse> = {}): BotWorkspaceAccessResponse {
  // A member gets no workspace_options (the server only sends the picker to admins).
  return { access: current, ...(asMember ? {} : { workspace_options: OPTIONS }), ...extra }
}

beforeEach(() => {
  requests = []
  haSwitchedOff = false
  failNext = null
  asMember = false
  current = accessWith('restricted', ['ops'])
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null
    const method = init?.method ?? 'GET'
    requests.push({ url, method, body })
    if (failNext && method !== 'GET') {
      const error = failNext
      failNext = null
      return new Response(JSON.stringify({ error }), { status: 403, headers: { 'content-type': 'application/json' } })
    }
    if (method === 'POST') current = accessWith('restricted', [...current.workspaces, body.workspace].sort())
    if (method === 'DELETE') current = accessWith('restricted', current.workspaces.filter(w => !url.endsWith(`/${w}`)))
    if (method === 'PUT') current = accessWith('restricted', body.workspaces)
    const extra = method === 'DELETE' || method === 'PUT' ? { high_agency_switched_off: haSwitchedOff } : {}
    return new Response(JSON.stringify(payload(extra)), { status: method === 'POST' ? 201 : 200, headers: { 'content-type': 'application/json' } })
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

async function render(isAdmin: boolean, onChanged?: () => void) {
  await act(async () => {
    root.render(<WorkspaceAccessSection agent={{ slug: 'acme-cto', name: 'CTO' }} isAdmin={isAdmin} onChanged={onChanged} />)
  })
}

const button = (t: string) => [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === t || b.getAttribute('aria-label') === t)
const picker = () => {
  const l = [...host.querySelectorAll('label')].find(x => x.textContent?.trim() === 'Grant a workspace')
  return l ? host.querySelector<HTMLSelectElement>(`#${l.htmlFor}`) : null
}
const rows = () => [...host.querySelectorAll('ul[aria-label] li')].map(li => li.querySelector('span span')?.textContent)
async function click(el: Element) {
  await act(async () => { (el as HTMLElement).click() })
}
async function choose(el: HTMLSelectElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

describe('WorkspaceAccessSection', () => {
  it('loads the bot\'s list and shows what it may use, with the rest in the grant picker', async () => {
    await render(true)
    expect(requests[0]).toMatchObject({ method: 'GET', url: '/api/agent-chat/agents/acme-cto/workspaces' })
    expect(host.textContent).toContain('Workspace access')
    expect(host.textContent).toContain('1 workspace')
    expect(rows()).toEqual(['Ops (ops)'])
    expect(host.textContent).toContain('Granted by jordan')
    expect([...picker()!.options].map(o => o.value)).toEqual(['sales', 'finance'])
    expect(host.textContent).not.toMatch(/organi[sz]ation/i)
  })

  it('grant POSTs the chosen workspace and shows it in the list', async () => {
    const changed = vi.fn()
    await render(true, changed)
    await choose(picker()!, 'finance')
    await click(button('Grant access')!)
    const post = requests.find(r => r.method === 'POST')!
    expect(post).toMatchObject({ url: '/api/agent-chat/agents/acme-cto/workspaces', body: { workspace: 'finance' } })
    expect(rows()).toEqual(['Finance (finance)', 'Ops (ops)'])
    expect(host.textContent).toContain('Granted finance.')
    expect(host.textContent).toContain('2 workspaces')
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('revoke DELETEs that workspace; revoking the last one says the bot now has none', async () => {
    await render(true)
    await click(button('Revoke ops')!)
    expect(requests.find(r => r.method === 'DELETE')?.url).toBe('/api/agent-chat/agents/acme-cto/workspaces/ops')
    expect(rows()).toEqual([])
    expect(host.textContent).toContain('Revoked ops.')
    expect(host.textContent).toContain('No workspaces')
    expect(host.textContent).toContain("can't read or write any board")
  })

  it('says so when a revoke switched High Agency off', async () => {
    haSwitchedOff = true
    await render(true)
    await click(button('Revoke ops')!)
    expect(host.textContent).toContain('Revoked ops. High Agency was switched off because it woke in ops.')
  })

  it('flags a bot that is not restricted yet, and granting restricts it', async () => {
    current = accessWith('unrestricted', [])
    await render(true)
    expect(host.textContent).toContain('Not restricted')
    expect(host.textContent).toContain('can still work in any workspace the person chatting with it can see')
    expect(host.textContent).not.toContain('Changed by migration')
    await choose(picker()!, 'sales')
    await click(button('Grant and restrict')!)
    expect(requests.find(r => r.method === 'POST')?.body).toEqual({ workspace: 'sales' })
    expect(host.textContent).toContain('Granted sales. CTO is now restricted to the workspaces listed here.')
  })

  it('an unrestricted bot can be locked out of every workspace in one click', async () => {
    current = accessWith('unrestricted', [])
    await render(true)
    await click(button('Restrict to no workspace')!)
    expect(requests.find(r => r.method === 'PUT')).toMatchObject({ url: '/api/agent-chat/agents/acme-cto/workspaces', body: { workspaces: [] } })
    expect(host.textContent).toContain('CTO now has no workspace.')
  })

  it('shows the server\'s refusal', async () => {
    failNext = 'Only an admin signed in to Command Center can change a bot\'s settings'
    await render(true)
    await click(button('Grant access')!)
    expect(host.textContent).toContain('Only an admin signed in')
    expect(rows()).toEqual(['Ops (ops)'])
  })

  it('is read-only for a non-admin: the list, no picker and no revoke', async () => {
    asMember = true
    await render(false)
    expect(rows()).toEqual(['ops'])
    expect(picker()).toBeNull()
    expect(button('Revoke ops')).toBeUndefined()
    expect(host.textContent).toContain('Only an admin can change which workspaces a bot may use.')
  })
})
