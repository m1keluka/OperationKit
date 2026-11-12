import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { CreateAgentGuide, CREATE_PROMPTS, DEV_BOT_SLUG, devBotLink } from './CreateAgentGuide'

/* obj 900672 — the Agents page's one clear way in to creating a bot, agent or
   skill. Path 1 hands off to the built-in Operation Kit Dev bot, so it is
   existence-gated on the live bot list: an install that switched built-ins off
   gets the copy-paste prompt instead of a dead link. */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = false

async function settle() {
  for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0))
}

let container: HTMLDivElement
let root: Root
let agents: Array<{ slug: string; name?: string }> = []

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/agent-chat/agents') return new Response(JSON.stringify({ agents }), { status: 200, headers: { 'content-type': 'application/json' } })
    return new Response('{}', { status: 404 })
  }))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  root.unmount()
  container.remove()
  vi.unstubAllGlobals()
})

const links = () => Object.fromEntries([...container.querySelectorAll('a')].map(a => [a.textContent, a.getAttribute('href')]))

describe('CreateAgentGuide (obj 900672)', () => {
  it('names the three things in one line each', async () => {
    agents = [{ slug: DEV_BOT_SLUG, name: 'Acme Dev' }]
    root.render(<MemoryRouter><CreateAgentGuide /></MemoryRouter>)
    await settle()
    const text = container.textContent ?? ''
    expect(text).toContain('Make a new bot, agent or skill')
    expect(text).toMatch(/Bot — someone you chat with/)
    expect(text).toMatch(/Agent — a worker that picks up board cards/)
    expect(text).toMatch(/Skill — how-to steps an agent follows/)
  })

  it('with the Dev bot installed, links open its conversation with the request typed in', async () => {
    agents = [{ slug: 'kb-setup' }, { slug: DEV_BOT_SLUG, name: 'Acme Dev' }]
    root.render(<MemoryRouter><CreateAgentGuide /></MemoryRouter>)
    await settle()
    const l = links()
    expect(l['Create a bot']).toBe(devBotLink('bot'))
    expect(l['Create an agent']).toBe(devBotLink('agent'))
    expect(l['Create a skill']).toBe(devBotLink('skill'))
    expect(new URL(`http://x${l['Create a skill']}`).searchParams.get('prompt')).toBe(CREATE_PROMPTS.skill)
    expect(l['Browse templates']).toBe('/agents?tab=templates')
    expect(l['Paste a bot file']).toBe('/agents?tab=templates&paste=1')
    // The bot's name comes from the live list (white-label), not a literal.
    expect(container.textContent).toContain('Ask Acme Dev')
  })

  it('without the Dev bot (built-ins switched off), offers the setup prompt instead of a dead link', async () => {
    agents = [{ slug: 'kb-setup' }]
    root.render(<MemoryRouter><CreateAgentGuide /></MemoryRouter>)
    await settle()
    const l = links()
    expect(l['Create a bot']).toBeUndefined()
    expect([...container.querySelectorAll('a')].some(a => (a.getAttribute('href') ?? '').startsWith('/chat/'))).toBe(false)
    expect(container.textContent).toContain('Copy setup prompt')
  })
})
