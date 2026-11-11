import { describe, expect, it } from 'vitest'
import fs from 'fs'
import { fileURLToPath } from 'url'
import Database from 'better-sqlite3'
import { parseAgentFile } from '../agent-file.js'
import { botForAgentSlug } from './bot-registry.js'
import { installSlugState, localizeAgentFileText, parseLocalizeOptions, updateInstallSlugs } from './install-slugs.js'

const ROSTER_DIR = fileURLToPath(new URL('../../../../../docs/bots/trial-roster/', import.meta.url))
// [file, bot, the install's slug]
const ROSTER: Array<[string, string, string]> = [
  ['cos', 'Grok: General', 'acme-co-general'],
  ['cfo', 'Grok: CFO', 'acme-co-cfo'],
  ['cto', 'Grok: CTO', 'acme-co-cto'],
]

function settingsDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)')
  return db
}

describe('parseLocalizeOptions', () => {
  it('needs a slug and a folder; the display name defaults to the folder name', () => {
    expect(parseLocalizeOptions({ slug: 'acme-cfo', knowledge_folder: 'workspaces/acme/' })).toEqual({
      ok: true,
      options: { slug: 'acme-cfo', knowledge_folder: 'workspaces/acme', display_name: 'acme' },
    })
    expect(parseLocalizeOptions({ slug: 'acme-cfo', knowledge_folder: 'workspaces/acme', display_name: 'Acme Co' })).toMatchObject({
      ok: true,
      options: { display_name: 'Acme Co' },
    })
  })

  it('refuses bad input rather than coercing it', () => {
    for (const bad of [
      null,
      'acme-cfo',
      { knowledge_folder: 'workspaces/acme' },
      { slug: 'acme-cfo' },
      { slug: 'Acme CFO', knowledge_folder: 'workspaces/acme' },
      { slug: 'your-org-cfo', knowledge_folder: 'workspaces/acme' },
      { slug: 'acme-cfo', knowledge_folder: 'workspaces/your-org' },
      { slug: 'acme-cfo', knowledge_folder: '../secrets' },
      { slug: 'acme-cfo', knowledge_folder: '/etc' },
      { slug: 'acme-cfo', knowledge_folder: 'workspaces/../x' },
      { slug: 'acme-cfo', knowledge_folder: 'workspaces/acme', display_name: 'line\nbreak' },
      { slug: 'acme-cfo', knowledge_folder: 'workspaces/acme', display_name: '' },
    ]) {
      expect(parseLocalizeOptions(bad).ok, JSON.stringify(bad)).toBe(false)
    }
  })
})

describe('localizeAgentFileText', () => {
  const opts = { slug: 'acme-cfo', knowledge_folder: 'clients/acme-finance', display_name: 'Acme' }

  it('replaces the folder, the name and the whole slug line', () => {
    const r = localizeAgentFileText('name: CFO (Your Org trial)\nslug: anything-here\nknowledge_folders:\n  - workspaces/your-org\n', opts)
    expect(r).toEqual({ ok: true, text: 'name: CFO (Acme trial)\nslug: acme-cfo\nknowledge_folders:\n  - clients/acme-finance\n' })
  })

  it('refuses a file that would keep a placeholder, or has no slug line', () => {
    expect(localizeAgentFileText('slug: x-y\nsystem_prompt: the your-org team\n', opts).ok).toBe(false)
    expect(localizeAgentFileText('name: x\n', opts).ok).toBe(false)
  })
})

describe('the shipped trial-roster example files', () => {
  it('are generic: placeholder folder, and a slug that is not an org\'s', () => {
    for (const [file] of ROSTER) {
      const text = fs.readFileSync(`${ROSTER_DIR}${file}.agent.yaml`, 'utf8')
      const parsed = parseAgentFile(text, { filename: `${file}.agent.yaml` })
      expect(parsed.ok, JSON.stringify(parsed)).toBe(true)
      if (!parsed.ok) continue
      expect(parsed.agent.slug.startsWith('your-org-')).toBe(true)
      expect(parsed.agent.knowledge_folders).toEqual(['workspaces/your-org'])
    }
  })

  it('localize to a valid file at the install slug, owned by the right bot, scoped to the install folder only', () => {
    const db = settingsDb()
    for (const [file, bot, slug] of ROSTER) {
      const w = updateInstallSlugs(db, { bot, add: slug })
      expect(w.ok, JSON.stringify(w)).toBe(true)
      const original = fs.readFileSync(`${ROSTER_DIR}${file}.agent.yaml`, 'utf8')
      const r = localizeAgentFileText(original, { slug, knowledge_folder: 'workspaces/acme-co', display_name: 'Acme Co' })
      expect(r.ok, JSON.stringify(r)).toBe(true)
      if (!r.ok) continue
      const parsed = parseAgentFile(r.text, { filename: `${file}.agent.yaml` })
      expect(parsed.ok, JSON.stringify(parsed)).toBe(true)
      if (!parsed.ok) continue
      expect(parsed.warnings).toEqual([])
      expect(parsed.agent.slug).toBe(slug)
      expect(parsed.agent.knowledge_folders).toEqual(['workspaces/acme-co'])
      expect(parsed.agent.name).toContain('Acme Co')
      expect(botForAgentSlug(parsed.agent.slug, db)?.id).toBe(bot)
      // localize is text-only: tools, model and provider are the template's
      const before = parseAgentFile(original, { filename: `${file}.agent.yaml` })
      expect(before.ok).toBe(true)
      if (before.ok) {
        expect(parsed.agent.tools).toEqual(before.agent.tools)
        expect(parsed.agent.model).toEqual(before.agent.model)
        expect(parsed.agent.provider).toEqual(before.agent.provider)
      }
    }
  })
})

describe('updateInstallSlugs', () => {
  it('adds and removes under the canonical bot id, touching only its own settings row', () => {
    const db = settingsDb()
    db.prepare("INSERT INTO settings (key, value) VALUES ('unrelated', 'keep')").run()
    expect(updateInstallSlugs(db, { bot: 'cfo', add: 'acme-cfo' }).ok).toBe(true)
    expect(updateInstallSlugs(db, { bot: 'Grok: CFO', add: 'acme-cfo' }).ok).toBe(true) // idempotent
    expect(updateInstallSlugs(db, { bot: 'CFO', add: 'acme-finance' }).ok).toBe(true)
    // every spelling of one bot merges into ONE entry, under the latest key typed
    expect(installSlugState(db).configured).toEqual({ CFO: ['acme-cfo', 'acme-finance'] })
    const r = updateInstallSlugs(db, { bot: 'cfo', remove: 'acme-finance' })
    expect(r.ok && r.state.configured).toEqual({ cfo: ['acme-cfo'] })
    expect(r.ok && r.state.bots.find(b => b.id === 'Grok: CFO')?.agent_slugs).toEqual(['your-org-cfo', 'acme-cfo'])
    expect(updateInstallSlugs(db, { bot: 'CFO', remove: 'acme-cfo' }).ok).toBe(true)
    expect(installSlugState(db).configured).toEqual({})
    expect(db.prepare("SELECT value FROM settings WHERE key = 'unrelated'").get()).toEqual({ value: 'keep' })
  })

  it('two bots sharing an id are told apart by the key the operator typed', () => {
    // The public build's name-scrub can give two built-ins the same id; the
    // map must still route to the bot the alias names, not the first id match.
    const db = settingsDb()
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('bot_registry', JSON.stringify([
      { id: 'Grok: Twin', name: 'Twin', aliases: ['first-twin'], agent_slugs: [] },
      { id: 'Grok: Twin', name: 'Twin', aliases: ['second-twin'], agent_slugs: [] },
    ]))
    expect(updateInstallSlugs(db, { bot: 'second-twin', add: 'acme-second' }).ok).toBe(true)
    const bots = installSlugState(db).bots
    expect(bots[0].agent_slugs).toEqual([])
    expect(bots[1].agent_slugs).toEqual(['acme-second'])
    expect(updateInstallSlugs(db, { bot: 'first-twin', add: 'acme-second' })).toMatchObject({ ok: false, status: 409 })
  })

  it('refuses unknown bots, bad slugs, stealing a slug, and removing a built-in', () => {
    const db = settingsDb()
    const bad = [
      [{ bot: 'Nobody', add: 'acme-cfo' }, 400],
      [{ bot: 'CFO' }, 400],
      [{ bot: 'CFO', add: 'a', remove: 'b' }, 400],
      [{ bot: 'CFO', add: 'Bad Slug' }, 400],
      [{ bot: 'CFO', add: 'your-org-cto' }, 409],
      [{ bot: 'CFO', add: 'operation-kit' }, 409],
      [{ bot: 'CFO', remove: 'your-org-cfo' }, 404],
    ] as const
    for (const [change, status] of bad) {
      const r = updateInstallSlugs(db, change as never)
      expect(r.ok, JSON.stringify(change)).toBe(false)
      if (!r.ok) expect(r.status, JSON.stringify(change)).toBe(status)
    }
    expect(db.prepare("SELECT value FROM settings WHERE key = 'bot_agent_slugs'").get()).toBeUndefined()
  })
})
