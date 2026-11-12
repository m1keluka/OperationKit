// @vitest-environment jsdom
//
// obj 900511 (Sprint 7.7) — the optional shared third-party OAuth app panel.
// It must render only for eligible connectors, start collapsed and OFF with
// every field empty (no built-in issuer/client id), say plainly that it is an
// optional dependency on a third party, and only let an admin change it.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import type { ConnectorSharedApp, ConnectorSummary } from '@operationkit/shared'
import { SharedOAuthAppPanel, sharedAppStateLabel } from './SharedOAuthAppPanel'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false

const OFF: ConnectorSharedApp = {
  enabled: false,
  configured: false,
  issuer: null,
  client_id: null,
  redirect_uri: null,
  provider_label: null,
  install_callback_uri: 'https://client-a.example.com/api/user/connector-oauth/slack/callback',
  own_app_configured: false,
}

function slack(shared_app: ConnectorSharedApp | null = OFF): ConnectorSummary {
  return {
    id: 'slack',
    name: 'Slack',
    description: 'Lets agents read and post Slack messages.',
    products: [],
    connect: { kind: 'oauth', button_label: 'Add to Slack' },
    available: false,
    unavailable_reason: 'Slack is not set up on this server yet.',
    can_check: false,
    status: { state: 'not_connected', account: null, details: [], connected_at: null, checked_at: null, error: null },
    access: { agents: null, workspaces: null },
    auth_path: 'oauth_guided',
    oauth_setup: null,
    setup_guide: 'docs/connectors/guides/slack.md',
    shared_app,
  }
}

describe('SharedOAuthAppPanel', () => {
  let container: HTMLDivElement | null = null
  let root: Root | null = null
  afterEach(() => {
    if (root) flushSync(() => root!.unmount())
    container?.remove()
    root = null
    container = null
  })
  function mount(el: React.ReactElement) {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    flushSync(() => root!.render(el))
    return container
  }

  it('renders nothing for a connector that may not use a shared app', () => {
    const c = mount(<SharedOAuthAppPanel connector={slack(null)} isAdmin />)
    expect(c.innerHTML).toBe('')
  })

  it('starts collapsed, labelled Optional and Off', () => {
    const c = mount(<SharedOAuthAppPanel connector={slack()} isAdmin />)
    expect(c.textContent).toContain('Optional')
    expect(c.textContent).toContain('Off')
    expect(c.querySelector('form')).toBeNull()
    expect(c.querySelector('button')!.getAttribute('aria-expanded')).toBe('false')
  })

  it('opened: says it is a third-party dependency, every field empty, toggle unchecked', () => {
    const c = mount(<SharedOAuthAppPanel connector={slack()} isAdmin onSave={vi.fn()} defaultOpen />)
    expect(c.textContent).toContain('depend on that third party, not on Operation Kit')
    expect(c.textContent).toContain('Your install works without this')
    const inputs = Array.from(c.querySelectorAll('input[type="text"]')) as HTMLInputElement[]
    expect(inputs).toHaveLength(4)
    for (const i of inputs) expect(i.value).toBe('')
    expect((c.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(false)
    expect(c.textContent).toContain(OFF.install_callback_uri)
    // Save stays disabled until the admin supplies their own issuer/client/redirect.
    const save = Array.from(c.querySelectorAll('button')).find(b => b.textContent === 'Save') as HTMLButtonElement
    expect(save.disabled).toBe(true)
  })

  it('non-admins see it read-only with no Save button', () => {
    const c = mount(<SharedOAuthAppPanel connector={slack()} isAdmin={false} onSave={vi.fn()} defaultOpen />)
    expect(c.textContent).toContain('Only an admin can change this.')
    expect(Array.from(c.querySelectorAll('button')).some(b => b.textContent === 'Save')).toBe(false)
    for (const i of Array.from(c.querySelectorAll('input'))) expect((i as HTMLInputElement).disabled).toBe(true)
  })

  it('state label: own app wins even when switched on', () => {
    expect(sharedAppStateLabel(OFF).text).toBe('Off')
    expect(sharedAppStateLabel({ ...OFF, enabled: true }).text).toBe('On')
    expect(sharedAppStateLabel({ ...OFF, enabled: true, own_app_configured: true }).text).toContain('your own app wins')
  })
})
