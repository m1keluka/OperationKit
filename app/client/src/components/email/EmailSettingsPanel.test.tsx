// @vitest-environment jsdom
//
// obj 900497 — Settings → Email panel + onboarding checklist. The load-bearing
// checks: the stored credential is never rendered (only "saved"), the panel
// says plainly when email is not set up, a test send reports its outcome, and
// the checklist shows branding → email → coding account in that order.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { EmailSettingsPanel } from './EmailSettingsPanel'
import { SetupChecklist } from '../setup/SetupChecklist'
import { invalidateWorkspacesCache } from '../../hooks/useWorkspaces'
import type { EmailSetup, SetupStatus } from '../../lib/email'

async function flush() {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve()
    await new Promise(r => setTimeout(r, 0))
    flushSync(() => {})
  }
}

function setup(over: Partial<EmailSetup> = {}): EmailSetup {
  return {
    provider: null, from_name: '', from_address: '', reply_to: '', app_url: '',
    smtp: { host: '', port: 587, security: 'starttls', username: '' },
    last_test: null, configured: false, problems: ['Pick an email provider'],
    has_credential: { smtp: false, resend: false, postmark: false },
    credential_keys: { smtp: 'CC_EMAIL_SMTP_PASSWORD', resend: 'CC_EMAIL_RESEND_API_KEY', postmark: 'CC_EMAIL_POSTMARK_SERVER_TOKEN' },
    ...over,
  }
}

const DNS = { domain: 'acme.test', provider: 'resend', where_to_get: 'Resend → Domains.', steps: ['Add the domain.'], records: [{ purpose: 'DKIM', type: 'TXT', host: 'resend._domainkey.acme.test', value: 'p=… (copy from Resend)', note: 'n' }], check: { domain: 'acme.test', spf: null, dmarc: 'v=DMARC1; p=none', error: null } }

let root: Root
let host: HTMLDivElement
let calls: Array<{ url: string; method: string; body: unknown }>

function mockFetch(routes: Record<string, (body: unknown) => { status?: number; json: unknown }>) {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ url, method, body })
    const key = Object.keys(routes).find(k => `${method} ${url}`.startsWith(k))
    const r = key ? routes[key](body) : { status: 404, json: { error: 'nope' } }
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { 'Content-Type': 'application/json' } })
  }))
}

function render(node: React.ReactNode) {
  flushSync(() => root.render(<MemoryRouter>{node}</MemoryRouter>))
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  flushSync(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

describe('EmailSettingsPanel', () => {
  it('says plainly that email is not set up', async () => {
    mockFetch({ 'GET /api/admin/email': () => ({ json: setup() }) })
    render(<EmailSettingsPanel />)
    await flush()
    expect(host.textContent).toContain('Email is not set up yet')
    expect(host.textContent).toContain('Not set up')
    expect(host.textContent).toContain('Have your coding agent set up email')
  })

  it('never renders a stored credential and saves a pasted one write-only', async () => {
    const configured = setup({ provider: 'resend', from_name: 'Acme', from_address: 'no-reply@acme.test', app_url: 'https://ops.acme.test', configured: true, problems: [], has_credential: { smtp: false, resend: true, postmark: false } })
    mockFetch({
      'GET /api/admin/email/dns': () => ({ json: DNS }),
      'GET /api/admin/email': () => ({ json: configured }),
      'PUT /api/admin/email': () => ({ json: configured }),
    })
    render(<EmailSettingsPanel />)
    await flush()
    const cred = host.querySelector<HTMLInputElement>('#email-credential')!
    expect(cred.type).toBe('password')
    expect(cred.value).toBe('')
    expect(cred.placeholder).toContain('saved')
    expect(host.textContent).toContain('CC_EMAIL_RESEND_API_KEY')
    await new Promise(r => setTimeout(r, 500)) // DNS help is debounced
    await flush()
    expect(host.textContent).toContain('Records for acme.test')
    expect(host.textContent).toContain('DMARC: v=DMARC1; p=none')
  })

  it('sends a test email and shows the result', async () => {
    const configured = setup({ provider: 'smtp', from_address: 'no-reply@acme.test', app_url: 'https://ops.acme.test', configured: true, problems: [], smtp: { host: 'smtp.acme.test', port: 587, security: 'starttls', username: '' } })
    mockFetch({
      'GET /api/admin/email/dns': () => ({ json: { ...DNS, provider: 'smtp' } }),
      'GET /api/admin/email': () => ({ json: configured }),
      'POST /api/admin/email/test': () => ({ json: { ok: true, ...configured, last_test: { ok: true, at: new Date().toISOString(), to_domain: 'acme.test', error: null } } }),
    })
    render(<EmailSettingsPanel />)
    await flush()
    const to = host.querySelector<HTMLInputElement>('input[aria-label="Send test to"]')!
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(to, 'owner@acme.test')
    to.dispatchEvent(new Event('input', { bubbles: true }))
    await flush()
    const btn = [...host.querySelectorAll('button')].find(b => b.textContent?.includes('Send test email'))!
    expect(btn.disabled).toBe(false)
    btn.click()
    await flush()
    expect(calls.find(c => c.method === 'POST')?.body).toEqual({ to: 'owner@acme.test' })
    expect(host.textContent).toContain('Test email sent to owner@acme.test')
    expect(host.textContent).toContain('Working')
  })
})

describe('SetupChecklist', () => {
  it('lists branding → email → coding account, ticks done steps and links each panel', async () => {
    const status: SetupStatus = {
      complete: false,
      steps: [
        { id: 'branding', title: 'Branding', done: true },
        { id: 'email', title: 'Transactional email', done: false, configured: true },
        { id: 'models', title: 'Add one coding subscription account', done: false },
      ],
    }
    mockFetch({ 'GET /api/admin/setup-status': () => ({ json: status }) })
    render(<SetupChecklist />)
    await flush()
    const items = [...host.querySelectorAll('li[data-step]')]
    expect(items.map(li => li.getAttribute('data-step'))).toEqual(['branding', 'email', 'models', 'knowledge_base'])
    expect(items.map(li => li.getAttribute('data-done'))).toEqual(['1', '0', '0', '0'])
    expect(host.textContent).toContain('1 of 4 done')
    expect(host.textContent).toContain('send a test')
    const hrefs = [...host.querySelectorAll('a')].map(a => a.getAttribute('href'))
    expect(hrefs).toEqual(expect.arrayContaining(['/settings/branding', '/settings/email', '/settings/models', '/knowledge/setup']))
    expect(host.textContent).toContain('Copy prompt')
  })

  it('step 4 "Set up your knowledge base" ticks once a visible workspace has a finished setup run (obj 900556)', async () => {
    invalidateWorkspacesCache()
    mockFetch({
      'GET /api/admin/setup-status': () => ({ json: { complete: true, steps: [{ id: 'branding', title: 'Branding', done: true }, { id: 'email', title: 'Email', done: true }, { id: 'models', title: 'Models', done: true }] } }),
      'GET /api/workspaces': () => ({ json: [{ slug: 'acme', name: 'Acme' }, { slug: 'beta', name: 'Beta' }] }),
      'GET /api/kb-setup/status?workspace=acme': () => ({ json: { step_done: false } }),
      'GET /api/kb-setup/status?workspace=beta': () => ({ json: { step_done: true } }),
    })
    render(<SetupChecklist />)
    await flush()
    await flush()
    const kb = host.querySelector('li[data-step="knowledge_base"]')!
    expect(kb.textContent).toContain('Set up your knowledge base')
    expect(kb.getAttribute('data-done')).toBe('1')
    expect(host.textContent).toContain('4 of 4 done')
    invalidateWorkspacesCache()
  })

  it('accepts link overrides (for the settings reorg) and never invents a branding route', async () => {
    mockFetch({ 'GET /api/admin/setup-status': () => ({ json: { complete: false, steps: [{ id: 'branding', title: 'Branding', done: false }, { id: 'email', title: 'Email', done: false }, { id: 'models', title: 'Models', done: false }] } }) })
    render(<SetupChecklist links={{ email: '/settings/email', models: '/settings/models' }} />)
    await flush()
    const hrefs = [...host.querySelectorAll('a')].map(a => a.getAttribute('href'))
    expect(hrefs).toEqual(['/settings/email', '/settings/models', '/knowledge/setup'])
    expect(host.textContent).toContain('OK_BRAND_NAME')
    expect(host.textContent).toContain('Keep default')
  })
})
