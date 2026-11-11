import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { applyInstallSlugs, BUILT_IN_BOTS, botForAgentSlug, listBots, parseInstallSlugMap, resolveBot } from './bot-registry.js'

function settingsDb(rows: Record<string, string> = {}): Database.Database {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)')
  for (const [k, v] of Object.entries(rows)) db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(k, v)
  return db
}

// Trial bots roster (obj 900371): General gets a second chat-agent slug
// on its existing identity; CFO and CTO are new identities. The chat-agent
// slugs are namespaced so they never collide with the session-worker executive
// roster's bare 'cfo' / 'cto' slugs. The built-in ones are the generic example
// files' placeholders; an install's real slugs are DATA (obj 900430).
describe('bot-registry: trial bots (obj 900371)', () => {
  it('resolves CFO by id, name and alias', () => {
    for (const raw of ['Grok: CFO', 'CFO', 'grok-cfo', 'cfo']) {
      const r = resolveBot(raw)
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.bot.id).toBe('Grok: CFO')
    }
  })

  it('resolves CTO by id, name and alias', () => {
    for (const raw of ['Grok: CTO', 'CTO', 'grok-cto', 'cto']) {
      const r = resolveBot(raw)
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.bot.id).toBe('Grok: CTO')
    }
  })

  it('maps the example files\' placeholder chat-agent slugs to their owning bot', () => {
    expect(botForAgentSlug('your-org-cfo')?.id).toBe('Grok: CFO')
    expect(botForAgentSlug('your-org-cto')?.id).toBe('Grok: CTO')
    expect(botForAgentSlug('your-org-general')?.id).toBe('Grok: General')
  })

  it('still maps the pre-existing general chat-agent slug (unchanged)', () => {
    expect(botForAgentSlug('general')?.id).toBe('Grok: General')
  })
})

describe('bot-registry: install-local chat slugs (obj 900430)', () => {
  const MAP = JSON.stringify({
    'General': ['acme-co-general'],
    CFO: ['acme-co-cfo'],
    'Grok: CTO': ['acme-co-cto'],
  })

  it('an install that configured nothing does not recognise another org\'s slugs', () => {
    const db = settingsDb()
    expect(botForAgentSlug('acme-co-cfo', db)).toBeNull()
    expect(listBots(db)).toEqual(BUILT_IN_BOTS)
  })

  it('settings.bot_agent_slugs adds the install\'s own slugs to the right bots', () => {
    const db = settingsDb({ bot_agent_slugs: MAP })
    expect(botForAgentSlug('acme-co-general', db)?.id).toBe('Grok: General')
    expect(botForAgentSlug('acme-co-cfo', db)?.id).toBe('Grok: CFO')
    expect(botForAgentSlug('acme-co-cto', db)?.id).toBe('Grok: CTO')
    // additive: every built-in slug still routes exactly as before
    for (const b of BUILT_IN_BOTS) for (const s of b.agent_slugs) expect(botForAgentSlug(s, db)?.id).toBe(b.id)
    const cfo = listBots(db).find(b => b.id === 'Grok: CFO')
    expect(cfo?.agent_slugs).toEqual(['your-org-cfo', 'acme-co-cfo'])
    // ids, names and aliases are untouched
    expect(listBots(db).map(b => [b.id, b.name, b.aliases])).toEqual(BUILT_IN_BOTS.map(b => [b.id, b.name, b.aliases]))
  })

  it('the short aliases cos / cfo / cto (stable on every build) are valid map keys', () => {
    const db = settingsDb({ bot_agent_slugs: JSON.stringify({ cos: ['acme-co-cos'], cfo: ['acme-co-cfo'], cto: ['acme-co-cto'] }) })
    expect(botForAgentSlug('acme-co-cos', db)?.id).toBe('Grok: General')
    expect(botForAgentSlug('acme-co-cos', db)?.agent_slugs).toContain('acme-co-cos')
    expect(botForAgentSlug('acme-co-cfo', db)?.id).toBe('Grok: CFO')
    expect(botForAgentSlug('acme-co-cto', db)?.id).toBe('Grok: CTO')
  })

  it('never moves a slug another bot already owns, and skips unknown bots', () => {
    const db = settingsDb({ bot_agent_slugs: JSON.stringify({ CFO: ['operation-kit', 'your-org-cto'], 'No Such Bot': ['x-bot'] }) })
    expect(botForAgentSlug('operation-kit', db)?.id).toBe('Operation Kit')
    expect(botForAgentSlug('your-org-cto', db)?.id).toBe('Grok: CTO')
    expect(botForAgentSlug('x-bot', db)).toBeNull()
  })

  it('a malformed setting is ignored rather than breaking the registry', () => {
    for (const bad of ['not json', '[1,2]', '"str"', '42']) {
      const db = settingsDb({ bot_agent_slugs: bad })
      expect(listBots(db)).toEqual(BUILT_IN_BOTS)
    }
    expect(parseInstallSlugMap('{"CFO": ["ok-slug", "Bad Slug", "../x", 7, "ok-slug"]}')).toEqual({ CFO: ['ok-slug'] })
  })

  it('applies on top of a settings.bot_registry override too', () => {
    const db = settingsDb({
      bot_registry: JSON.stringify([{ id: 'Grok: CFO', name: 'CFO', aliases: [], agent_slugs: [] }]),
      bot_agent_slugs: JSON.stringify({ CFO: ['acme-co-cfo'] }),
    })
    expect(botForAgentSlug('acme-co-cfo', db)?.id).toBe('Grok: CFO')
  })

  it('applyInstallSlugs does not mutate its input', () => {
    const before = JSON.stringify(BUILT_IN_BOTS)
    applyInstallSlugs(BUILT_IN_BOTS, { CFO: ['acme-co-cfo'] })
    expect(JSON.stringify(BUILT_IN_BOTS)).toBe(before)
  })
})
