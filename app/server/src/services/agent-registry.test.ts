/**
 * Runtime replacement for the compile-time exhaustiveness check that the closed
 * `AgentContext` union used to provide: every seeded slug must resolve BOTH a
 * workdir and a prompt-file name, and unknown slugs must degrade to the same
 * values the deleted AGENT_MAP / WORKDIR_MAP fallbacks produced.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TMP_DB = path.join(os.tmpdir(), `cc-agent-registry-${process.pid}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const {
  listAgents,
  listAssignableAgents,
  getAgent,
  agentExists,
  resolveAgentWorkdir,
  resolveAgentPromptFile,
  agentLabel,
  createAgent,
  updateAgent,
  archiveAgent,
  invalidateAgentsCache,
} = await import('./agent-registry.js')
const { PROJECTS_DIR, AI_WORKSPACE_DIR, HOME_DIR } = await import('../config.js')

beforeAll(() => { initDb() })
afterAll(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP_DB + suffix) } catch { /* ignore */ }
  }
})

describe('agent registry', () => {
  it('seeds a non-empty roster on a fresh DB', () => {
    const agents = listAgents()
    expect(agents.length).toBeGreaterThan(0)
    expect(agents.map(a => a.slug)).toContain('cto')
    expect(agents.map(a => a.slug)).toContain('general')
  })

  it('every seeded slug resolves BOTH a workdir and a prompt-file name', () => {
    for (const a of listAgents()) {
      const workdir = resolveAgentWorkdir(a.slug)
      expect(workdir, `workdir for ${a.slug}`).toBeTruthy()
      expect([PROJECTS_DIR, AI_WORKSPACE_DIR, HOME_DIR, a.workdir_path]).toContain(workdir)
      expect(resolveAgentPromptFile(a.slug), `prompt file for ${a.slug}`).toBeTruthy()
      expect(agentLabel(a.slug)).toBeTruthy()
    }
  })

  it('maps workdir_kind onto the host constants', () => {
    expect(resolveAgentWorkdir('cto')).toBe(PROJECTS_DIR)
    expect(resolveAgentWorkdir('general')).toBe(HOME_DIR)
    expect(resolveAgentWorkdir('cmo')).toBe(AI_WORKSPACE_DIR)
  })

  it('an unknown slug degrades exactly like the deleted WORKDIR_MAP/AGENT_MAP fallbacks', () => {
    expect(agentExists('no-such-persona')).toBe(false)
    expect(getAgent('no-such-persona')).toBeUndefined()
    // WORKDIR_MAP[ctx] || HOME_DIR
    expect(resolveAgentWorkdir('no-such-persona')).toBe(HOME_DIR)
    expect(resolveAgentWorkdir(null)).toBe(HOME_DIR)
    // never "You are the undefined agent"
    expect(resolveAgentPromptFile('no-such-persona')).toBe('no-such-persona')
    expect(agentLabel('no-such-persona')).toBe('no-such-persona')
  })

  it('prompt_file overrides the identity mapping when set', () => {
    createAgent({ slug: 'tst-aliased', label: 'Aliased', prompt_file: 'some-other-file' })
    expect(resolveAgentPromptFile('tst-aliased')).toBe('some-other-file')
  })

  it('CRUD round-trips and invalidates the cache', () => {
    const created = createAgent({
      slug: 'tst-analyst', label: 'Analyst', kind: 'routing-only',
      workdir_kind: 'custom', workdir_path: '/tmp/analyst', mono: 'AN', sort_order: 42,
    })
    expect(created.slug).toBe('tst-analyst')
    expect(resolveAgentWorkdir('tst-analyst')).toBe('/tmp/analyst')

    const updated = updateAgent('tst-analyst', { label: 'Senior Analyst', assignable: false })
    expect(updated?.label).toBe('Senior Analyst')
    expect(updated?.assignable).toBe(false)
    expect(listAssignableAgents().map(a => a.slug)).not.toContain('tst-analyst')

    expect(archiveAgent('tst-analyst')).toEqual({ ok: true })
    expect(listAgents().map(a => a.slug)).not.toContain('tst-analyst')
    expect(listAgents({ includeArchived: true }).map(a => a.slug)).toContain('tst-analyst')
    expect(archiveAgent('nope')).toEqual({ ok: false, reason: 'not_found' })
  })

  it('refuses to archive a persona that still owns non-terminal work', () => {
    createAgent({ slug: 'tst-busy', label: 'Busy' })
    invalidateAgentsCache()
    getDb().prepare("INSERT INTO objectives (title, agent_context, status) VALUES ('live card', 'tst-busy', 'working')").run()
    const result = archiveAgent('tst-busy')
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/active objective/)
  })
})
