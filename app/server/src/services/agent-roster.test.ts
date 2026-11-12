import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { AgentRow } from '@operationkit/shared'
// Everything DB-backed is injected below; keep the DB (and its native deps) out.
vi.mock('./agent-registry.js', () => ({ listAgents: () => [] }))
vi.mock('./starter-packs.js', () => ({ listPacks: () => [], isPackEnabled: () => false }))

import { buildAgentRoster, buildSkillRoster } from './agent-roster.js'
import { BUILTIN_DIR, loadChatAgents } from './agent-chat/agent-defs.js'
import type { StarterPack } from './starter-packs.js'

function reg(slug: string, extra: Partial<AgentRow> = {}): AgentRow {
  return {
    slug, label: slug.toUpperCase(), kind: 'executive', assignable: true, prompt_file: null,
    workdir_kind: 'workspace', workdir_path: null, mono: null, badge_hex: null, badge_tw: null,
    archived: false, sort_order: 0, ...extra,
  }
}

let root: string
let ws: string
let agentsDir: string
let skillsDir: string
let packDir: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-roster-'))
  ws = path.join(root, 'ai-workspace')
  agentsDir = path.join(ws, 'agents')
  skillsDir = path.join(ws, 'skills')
  packDir = path.join(root, 'packs', 'knowledge-import')
  fs.mkdirSync(agentsDir, { recursive: true })
  fs.mkdirSync(skillsDir, { recursive: true })
  fs.mkdirSync(path.join(packDir, 'agents'), { recursive: true })
  fs.writeFileSync(path.join(agentsDir, 'cto.md'), '# CTO\n\nRuns engineering.\n')
  fs.writeFileSync(path.join(agentsDir, 'scout.md'), '---\ndescription: Finds things\n---\n# Scout\n')
  fs.mkdirSync(path.join(agentsDir, 'helper'))
  fs.writeFileSync(path.join(agentsDir, 'helper', 'agent.md'), '---\nname: Helper\ndescription: Helps in chat\n---\nYou help.\n')
  fs.writeFileSync(path.join(packDir, 'agents', 'kb-librarian.md'), '# Agent: Librarian\n\nYou keep the knowledge base organized.\n')
})

afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

const pack = (): StarterPack[] => [{
  dir: packDir,
  manifest: { id: 'knowledge-import', name: 'Knowledge base file import', agents: [{ slug: 'kb-librarian', label: 'Librarian', prompt_file: 'agents/kb-librarian.md' }] },
}]

function roster(opts: { packOn?: boolean; registry?: AgentRow[] } = {}) {
  const env = { AGENT_FILES_DIR: agentsDir } as NodeJS.ProcessEnv
  return buildAgentRoster({
    aiWorkspaceDir: ws,
    agentsDir,
    env,
    registry: () => opts.registry ?? [reg('cto'), reg('general')],
    packs: pack,
    packEnabled: () => !!opts.packOn,
    chatAgents: () => loadChatAgents({ env, includeBuiltins: true }).agents,
  })
}

describe('buildAgentRoster (obj 900684)', () => {
  it('still lists flat persona files with registry metadata', () => {
    const cto = roster().find(a => a.id === 'persona:cto')!
    expect(cto).toMatchObject({ filename: 'cto.md', assignable: true, kind: 'executive', label: 'CTO', file_path: 'agents/cto.md', description: 'Runs engineering.' })
    const scout = roster().find(a => a.id === 'persona:scout')!
    expect(scout).toMatchObject({ assignable: false, kind: 'routing-only', description: 'Finds things' })
    expect(scout.note).toMatch(/not in the agent registry/i)
  })

  it('lists the built-in Knowledge Base Setup agent, which the old roster missed', () => {
    expect(fs.existsSync(path.join(BUILTIN_DIR, 'kb-setup'))).toBe(true)
    const kb = roster().find(a => a.slug === 'kb-setup')!
    expect(kb).toBeDefined()
    expect(kb.source).toBe('builtin')
    expect(kb.label).toBe('Knowledge Base Setup')
    expect(kb.open_href).toBe('/chat/kb-setup')
    // Lives outside the ai-workspace dir, so the definition is inline.
    expect(kb.file_path).toBeNull()
    expect(kb.definition).toContain('Knowledge Base Setup agent')
  })

  it('lists folder-format chat agents from the agents dir', () => {
    const h = roster().find(a => a.id === 'chat:helper')!
    expect(h).toMatchObject({ source: 'chat', label: 'Helper', file_path: 'agents/helper/agent.md', description: 'Helps in chat' })
  })

  it('shows registry rows that have no persona file, with the reason', () => {
    const g = roster().find(a => a.slug === 'general')!
    expect(g.source).toBe('registry')
    expect(g.note).toMatch(/no general\.md/)
  })

  it('shows a starter-pack agent when the pack is off, and says how to switch it on', () => {
    const lib = roster().find(a => a.slug === 'kb-librarian')!
    expect(lib).toMatchObject({ source: 'starter-pack', label: 'Librarian', assignable: false })
    expect(lib.pack).toEqual({ id: 'knowledge-import', name: 'Knowledge base file import', enabled: false })
    expect(lib.note).toMatch(/switched off/)
    expect(lib.definition).toContain('Librarian')
  })

  it('does not duplicate a starter-pack agent once its persona file is installed', () => {
    fs.copyFileSync(path.join(packDir, 'agents', 'kb-librarian.md'), path.join(agentsDir, 'kb-librarian.md'))
    const rows = roster({ packOn: true, registry: [reg('kb-librarian', { label: 'Librarian' })] }).filter(a => a.slug === 'kb-librarian')
    expect(rows.map(r => r.id)).toEqual(['persona:kb-librarian'])
  })

  it('gives every row a unique id', () => {
    const ids = roster().map(a => a.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('buildSkillRoster (obj 900684)', () => {
  it('lists sub-skills as their own rows addressed parent/child', () => {
    fs.mkdirSync(path.join(skillsDir, 'outreach', 'cold-email', 'refs'), { recursive: true })
    fs.writeFileSync(path.join(skillsDir, 'outreach', 'SKILL.md'), '---\nname: outreach\ndescription: Outbound\n---\n')
    fs.writeFileSync(path.join(skillsDir, 'outreach', 'cold-email', 'SKILL.md'), '---\nname: cold-email\ndescription: Cold email\n---\n')
    fs.writeFileSync(path.join(skillsDir, 'outreach', 'cold-email', 'refs', 'a.md'), 'x')
    fs.mkdirSync(path.join(skillsDir, 'outreach', 'assets'))
    fs.writeFileSync(path.join(skillsDir, 'outreach', 'assets', 'b.md'), 'y')

    const skills = buildSkillRoster({ skillsDir })
    expect(skills.map(s => s.dirname)).toEqual(['outreach', 'outreach/cold-email'])
    expect(skills[0]).toMatchObject({ parent: null, description: 'Outbound', fileCount: 2 })
    expect(skills[1]).toMatchObject({ parent: 'outreach', description: 'Cold email', fileCount: 2 })
  })

  it('returns [] when there is no skills dir', () => {
    expect(buildSkillRoster({ skillsDir: path.join(root, 'nope') })).toEqual([])
  })
})
