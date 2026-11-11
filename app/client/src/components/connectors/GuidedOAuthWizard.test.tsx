// @vitest-environment jsdom
//
// obj 900506 — the guided-OAuth wizard renders the install's own pre-filled
// redirect URI, the exact scopes to add, and numbered steps, and does so only
// for `auth_path: 'oauth_guided'` connectors with an `oauth_setup`.
import { describe, it, expect, afterEach } from 'vitest'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import type { ConnectorSummary } from '@operationkit/shared'
import { GuidedOAuthWizard } from './GuidedOAuthWizard'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false

function slack(): ConnectorSummary {
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
    oauth_setup: {
      redirect_uri: 'https://ai.example.com/api/user/connector-oauth/slack/callback',
      scopes: ['channels:read', 'channels:history', 'chat:write', 'users:read'],
    },
    setup_guide: 'docs/connectors/guides/slack.md',
  }
}

describe('GuidedOAuthWizard', () => {
  let container: HTMLDivElement | null = null
  let root: Root | null = null

  afterEach(() => {
    if (root) flushSync(() => root!.unmount())
    container?.remove()
    root = null
    container = null
  })

  it('shows the install-local redirect URI, scopes, and numbered steps for a guided-OAuth connector', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    flushSync(() => {
      root!.render(<GuidedOAuthWizard connector={slack()} open onClose={() => {}} />)
    })

    // Modal renders into a portal appended to document.body, not `container`.
    const text = document.body.textContent ?? ''
    expect(text).toContain('Connect Slack')
    expect(text).toContain('https://ai.example.com/api/user/connector-oauth/slack/callback')
    expect(text).toContain('channels:read')
    expect(text).toContain('chat:write')
    expect(text).toContain('docs/connectors/guides/slack.md')

    const steps = document.querySelectorAll('[role="dialog"] ol li')
    expect(steps.length).toBeGreaterThanOrEqual(3)
    expect(steps.length).toBeLessThanOrEqual(5)
  })

  it('renders nothing visible when closed', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    flushSync(() => {
      root!.render(<GuidedOAuthWizard connector={slack()} open={false} onClose={() => {}} />)
    })

    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })
})
