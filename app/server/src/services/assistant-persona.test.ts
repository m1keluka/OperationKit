/**
 * Phase 4 (obj 709956) — the mentor/assistant subsystem must resolve its persona
 * from the agent registry, and a blank-slate install (five generic executives,
 * no `assistant` row, no ASSISTANT_AGENT_SLUG) must degrade rather than crash.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TMP_DB = path.join(os.tmpdir(), `cc-assistant-persona-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
delete process.env.ASSISTANT_AGENT_SLUG

const { initDb, getDb } = await import('../db/index.js')
const { resolveAssistantPersona, assistantAgentSlug, agentManualPath } = await import('./assistant-persona.js')
const { invalidateAgentsCache, listAgents } = await import('./agent-registry.js')
const { AGENTS_DIR } = await import('../config.js')
const { DEFAULT_AGENT_SEED } = await import('../db/schema/agents.js')

beforeAll(() => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
})

afterEach(() => {
  delete process.env.ASSISTANT_AGENT_SLUG
  invalidateAgentsCache()
})

afterAll(() => {
  try { getDb().close() } catch {}
  for (const suffix of ['', '-wal', '-shm']) {
    const f = `${TMP_DB}${suffix}`
    if (fs.existsSync(f)) fs.unlinkSync(f)
  }
})

describe('the tracked default seed is a blank slate', () => {
  it('ships only the five generic executives — no `assistant`, no private persona', () => {
    const slugs = DEFAULT_AGENT_SEED.map(r => r.slug).sort()
    expect(slugs).toEqual(['cfo', 'cmo', 'coo', 'cto', 'general'])
    expect(slugs).not.toContain('assistant')
  })

  it('the tracked example seed file matches the built-in defaults', () => {
    const here = path.dirname(new URL(import.meta.url).pathname)
    const file = path.resolve(here, '..', '..', 'seed.agents.example.json')
    const rows = JSON.parse(fs.readFileSync(file, 'utf-8')) as { slug: string }[]
    expect(rows.map(r => r.slug).sort()).toEqual(['cfo', 'cmo', 'coo', 'cto', 'general'])
  })
})

describe('resolveAssistantPersona — registry-driven, degrades gracefully', () => {
  it('a fresh blank-slate DB has no assistant row and resolution returns null', () => {
    expect(listAgents().map(a => a.slug)).not.toContain('assistant')
    expect(assistantAgentSlug()).toBeNull()
    expect(resolveAssistantPersona()).toBeNull()
  })

  it('an ASSISTANT_AGENT_SLUG naming a slug that is not registered still returns null', () => {
    process.env.ASSISTANT_AGENT_SLUG = 'no-such-persona'
    expect(resolveAssistantPersona()).toBeNull()
  })

  it('resolves a registered persona and derives its manual path from AGENTS_DIR', () => {
    getDb()
      .prepare("INSERT OR IGNORE INTO agents (slug, label, kind, assignable, workdir_kind) VALUES ('ops-assistant', 'Ops Assistant', 'routing-only', 1, 'workspace')")
      .run()
    invalidateAgentsCache()
    process.env.ASSISTANT_AGENT_SLUG = 'ops-assistant'
    const persona = resolveAssistantPersona()
    expect(persona).not.toBeNull()
    expect(persona!.slug).toBe('ops-assistant')
    expect(persona!.label).toBe('Ops Assistant')
    expect(persona!.manualPath).toBe(`${AGENTS_DIR}/ops-assistant.md`)
  })

  it('honours an explicit absolute prompt_file and ignores archived rows', () => {
    const db = getDb()
    db.prepare("INSERT OR IGNORE INTO agents (slug, label, prompt_file, workdir_kind) VALUES ('abs-persona', 'Abs', '/srv/personas/abs.md', 'workspace')").run()
    invalidateAgentsCache()
    process.env.ASSISTANT_AGENT_SLUG = 'abs-persona'
    expect(resolveAssistantPersona()!.manualPath).toBe('/srv/personas/abs.md')

    db.prepare("UPDATE agents SET archived = 1 WHERE slug = 'abs-persona'").run()
    invalidateAgentsCache()
    expect(resolveAssistantPersona()).toBeNull()
  })

  it('agentManualPath adds the .md suffix for a bare name and passes absolutes through', () => {
    expect(agentManualPath('foo')).toBe(`${AGENTS_DIR}/foo.md`)
    expect(agentManualPath('foo.md')).toBe(`${AGENTS_DIR}/foo.md`)
    expect(agentManualPath('/abs/foo.md')).toBe('/abs/foo.md')
    expect(agentManualPath(null)).toBeNull()
    expect(agentManualPath('  ')).toBeNull()
  })
})

describe('mentor paths on a blank-slate DB do not crash', () => {
  it('no assistant_configs row is seeded when no persona slug is configured', () => {
    // initDb() ran in beforeAll with ASSISTANT_AGENT_SLUG unset.
    const db = getDb()
    db.prepare("INSERT OR IGNORE INTO users (username, password_hash, role) VALUES ('operator', '', 'admin')").run()
    initDb() // re-run: the opt-in owner seed must stay a no-op
    const n = (db.prepare('SELECT COUNT(*) AS n FROM assistant_configs').get() as { n: number }).n
    expect(n).toBe(0)
  })

  it('the generic create-on-read config still works with no persona registered', async () => {
    const { resolveAssistantConfig } = await import('./assistant-config.js')
    const row = getDb().prepare("SELECT id FROM users WHERE username = 'operator'").get() as { id: number }
    const cfg = resolveAssistantConfig(row.id, 'default')
    expect(cfg).not.toBeNull()
    expect(cfg!.persona.displayName).toBe('Assistant')
    expect(cfg!.persona.manualSource).toBeNull()
  })
})
