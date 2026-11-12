// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { CodingAgentSetup, buildSetupPrompt, CODING_AGENTS } from './CodingAgentSetup'

const ORIGIN = 'https://cc.example.com'

describe('buildSetupPrompt (obj 900681)', () => {
  it('Claude Code: one claude mcp add over Streamable HTTP, key from the env', () => {
    const p = buildSetupPrompt('claude-code', ORIGIN, 'Acme Ops')
    expect(p).toContain(`claude mcp add --transport http --scope user command-center ${ORIGIN}/api/mcp`)
    expect(p).toContain('Authorization: Bearer $CC_AGENT_KEY')
  })

  it('Cursor and Codex get their own config formats', () => {
    expect(buildSetupPrompt('cursor', ORIGIN, 'Acme Ops')).toContain('"Authorization": "Bearer ${env:CC_AGENT_KEY}"')
    const codex = buildSetupPrompt('codex', ORIGIN, 'Acme Ops')
    expect(codex).toContain('[mcp_servers.command-center]')
    expect(codex).toContain('bearer_token_env_var = "CC_AGENT_KEY"')
    expect(buildSetupPrompt('other', ORIGIN, 'Acme Ops')).toContain('mcp-remote')
  })

  it('every variant verifies with whoami, points at the key page, and never carries a key value', () => {
    for (const { key } of CODING_AGENTS) {
      const p = buildSetupPrompt(key, ORIGIN, 'Acme Ops')
      expect(p).toContain('my Acme Ops (')
      expect(p).toContain('"whoami"')
      expect(p).toContain(`${ORIGIN}/settings/api-mcp`)
      expect(p).toContain('Never ask me to paste the key into chat')
      expect(p).not.toMatch(/cc_live_[A-Za-z0-9]/)
    }
  })
})

describe('<CodingAgentSetup />', () => {
  let root: Root
  let container: HTMLDivElement
  afterEach(() => {
    flushSync(() => root.unmount())
    container.remove()
  })

  it('switches the prompt when another agent is picked', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    flushSync(() => root.render(<CodingAgentSetup />))
    const prompt = () => container.querySelector('[data-testid="coding-agent-prompt"]')?.textContent ?? ''
    expect(prompt()).toContain('claude mcp add')
    const cursorTab = Array.from(container.querySelectorAll('[role="tab"]')).find(t => t.textContent === 'Cursor') as HTMLElement
    flushSync(() => cursorTab.click())
    expect(prompt()).toContain('~/.cursor/mcp.json')
    expect(prompt()).not.toContain('claude mcp add')
  })
})
