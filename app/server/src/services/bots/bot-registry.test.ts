import { describe, expect, it } from 'vitest'
import { botForAgentSlug, resolveBot } from './bot-registry.js'

// Trial bots roster (obj 900371, Mike-approved): General gets a second
// chat-agent slug on its existing identity; CFO and CTO are new identities.
// The chat-agent slugs are namespaced ('your-org-*') so they never collide
// with the session-worker executive roster's bare 'cfo' / 'cto' slugs.
describe('bot-registry: trial bots (obj 900371)', () => {
  it('resolves CFO by id, name and alias', () => {
    for (const raw of ['Grok: CFO', 'CFO', 'Example CFO', 'grok-cfo', 'cfo']) {
      const r = resolveBot(raw)
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.bot.id).toBe('Grok: CFO')
    }
  })

  it('resolves CTO by id, name and alias', () => {
    for (const raw of ['Grok: CTO', 'CTO', 'Example CTO', 'grok-cto', 'cto']) {
      const r = resolveBot(raw)
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.bot.id).toBe('Grok: CTO')
    }
  })

  it('maps the new chat-agent slugs to their owning bot', () => {
    expect(botForAgentSlug('your-org-cfo')?.id).toBe('Grok: CFO')
    expect(botForAgentSlug('your-org-cto')?.id).toBe('Grok: CTO')
    expect(botForAgentSlug('your-org-general')?.id).toBe('Grok: General')
  })

  it('still maps the pre-existing general chat-agent slug (unchanged)', () => {
    expect(botForAgentSlug('general')?.id).toBe('Grok: General')
  })
})
