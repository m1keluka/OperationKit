/**
 * board-layer unit tests (obj 712124).
 *
 * These cover the two halves that do NOT need a database or the real
 * ~/ai-workspace: the pure projection (`buildBoardLayer`) and the path
 * resolver / traversal guard used by GET /api/agents/layer-file.
 *
 * The route-level tests (real sqlite + HTTP) live in
 * routes/agents-board-layer.test.ts.
 */
import { describe, it, expect } from 'vitest'
import path from 'path'
import {
  buildBoardLayer,
  scopedAgentSlugs,
  skillPath,
  resolveLayerFile,
  assertSafeSlug,
  LayerPathError,
  TOOLS_DIR,
  WORKSPACES_DIR,
  type BuildOpts,
} from './board-layer.js'
import { AGENTS_DIR, SKILLS_DIR } from '../config.js'
import type { SkillGraph } from './skill-graph.js'

function graph(): SkillGraph {
  return {
    source: 'frontmatter-layer-graph',
    generated_at: '2026-09-21T00:00:00Z',
    counts: {
      agents: 2, skills: 2, skills_top_level: 2, subskills: 0,
      tools: 1, agent_skill_edges: 3, skill_tool_edges: 1,
    },
    agents: {
      cto: { always: ['devops', 'ghost-skill'], available: [] },
      'acquisition-sites': { always: [], available: ['devops'] },
    },
    skills: {
      devops: {
        depth: 1, parent: null, subskills: [], tools: ['github'],
        agents_always: ['cto'], agents_available: ['acquisition-sites'],
        description: 'Ship code',
      },
      // NOTE: `ghost-skill` deliberately has NO graph node and no SKILL.md —
      // it is the dangling declared edge the tab exists to surface.
    },
    tools: { github: { skills: ['devops'] } },
    orphans: { tools: [], skills: [] },
  }
}

/** Only these paths "exist" on the fake disk. */
const PRESENT = new Set([
  path.join(AGENTS_DIR, 'cto.md'),
  skillPath('devops'),
  path.join(TOOLS_DIR, 'github', 'TOOL.md'),
  path.join(WORKSPACES_DIR, 'example', 'agent-profiles', 'cto.md'),
])

function opts(over: Partial<BuildOpts> = {}): BuildOpts {
  return {
    projectId: 16,
    workspace: 'example',
    projectName: 'Acquisition Sites',
    graph: graph(),
    usage: new Map([['cto', 140], ['acquisition-sites', 1]]),
    registry: [
      { slug: 'cto', label: 'CTO', kind: 'executive', assignable: true, prompt_file: null },
      { slug: 'acquisition-sites', label: 'Acquisition Sites', kind: 'executive', assignable: true, prompt_file: null },
      { slug: 'cmo', label: 'CMO', kind: 'executive', assignable: true, prompt_file: null },
    ],
    toolDescriptions: { github: 'GitHub API' },
    exists: (p: string) => PRESENT.has(p),
    ...over,
  }
}

describe('scopedAgentSlugs', () => {
  it('project scope is exactly the agent_contexts the board uses', () => {
    expect(scopedAgentSlugs(new Map([['cto', 3]]), 16, ['cto', 'cmo'])).toEqual(['cto'])
  })

  it('workspace scope unions in the whole registry roster', () => {
    expect(scopedAgentSlugs(new Map([['cto', 3]]), null, ['cto', 'cmo'])).toEqual(['cmo', 'cto'])
  })
})

describe('buildBoardLayer', () => {
  it('scopes agents to the project and carries objective_count from the board', () => {
    const out = buildBoardLayer(opts())
    expect(out.scope).toEqual({ project_id: 16, project_name: 'Acquisition Sites', workspace: 'example' })
    expect(out.agents.map(a => a.slug).sort()).toEqual(['acquisition-sites', 'cto'])
    expect(out.agents.find(a => a.slug === 'cto')!.objective_count).toBe(140)
    expect(out.agents.find(a => a.slug === 'acquisition-sites')!.objective_count).toBe(1)
    // cmo is in the registry but has no objectives on this project.
    expect(out.agents.map(a => a.slug)).not.toContain('cmo')
  })

  it('an agent with no workspace overlay reports overlay_exists:false and does not throw', () => {
    const out = buildBoardLayer(opts())
    const acq = out.agents.find(a => a.slug === 'acquisition-sites')!
    expect(acq.overlay_file).toBe(path.join(WORKSPACES_DIR, 'example', 'agent-profiles', 'acquisition-sites.md'))
    expect(acq.overlay_exists).toBe(false)
    const cto = out.agents.find(a => a.slug === 'cto')!
    expect(cto.overlay_exists).toBe(true)
  })

  it('an agent with no persona file gets persona_file:null and lands in orphans', () => {
    const out = buildBoardLayer(opts())
    const acq = out.agents.find(a => a.slug === 'acquisition-sites')!
    expect(acq.persona_exists).toBe(false)
    expect(acq.persona_file).toBeNull()
    expect(out.orphans.agents_without_persona).toEqual(['acquisition-sites'])
    expect(out.agents.find(a => a.slug === 'cto')!.persona_file).toBe(path.join(AGENTS_DIR, 'cto.md'))
  })

  it('keeps a dangling declared skill edge visible with exists:false and lists it in orphans', () => {
    const out = buildBoardLayer(opts())
    const ghost = out.skills.find(s => s.slug === 'ghost-skill')
    expect(ghost, 'the dangling edge must not be silently dropped').toBeDefined()
    expect(ghost!.exists).toBe(false)
    expect(ghost!.file).toBeNull()
    expect(ghost!.used_by_always).toEqual(['cto'])
    expect(out.orphans.skills_declared_missing).toEqual(['ghost-skill'])
    expect(out.agents.find(a => a.slug === 'cto')!.missing_skills).toEqual(['ghost-skill'])
  })

  it('only reports skills and tools reachable from the in-scope agents', () => {
    const out = buildBoardLayer(opts({
      usage: new Map([['acquisition-sites', 1]]),
      projectId: 99,
    }))
    expect(out.skills.map(s => s.slug)).toEqual(['devops'])
    expect(out.skills[0].used_by_available).toEqual(['acquisition-sites'])
    expect(out.skills[0].used_by_always).toEqual([])
    expect(out.tools.map(t => t.slug)).toEqual(['github'])
    expect(out.tools[0].used_by_skills).toEqual(['devops'])
    expect(out.tools[0].description).toBe('GitHub API')
    expect(out.tools[0].exists).toBe(true)
  })

  it('surfaces a declared tool with no TOOL.md instead of dropping it', () => {
    const g = graph()
    g.skills.devops.tools = ['github', 'phantom-tool']
    const out = buildBoardLayer(opts({ graph: g }))
    const phantom = out.tools.find(t => t.slug === 'phantom-tool')!
    expect(phantom.exists).toBe(false)
    expect(phantom.file).toBeNull()
    expect(out.orphans.tools_declared_missing).toEqual(['phantom-tool'])
  })

  it('an agent_context with no registry row still appears (board data wins)', () => {
    const out = buildBoardLayer(opts({ usage: new Map([['not-in-registry', 4]]) }))
    const row = out.agents.find(a => a.slug === 'not-in-registry')!
    expect(row.label).toBe('not-in-registry')
    expect(row.objective_count).toBe(4)
    expect(row.skills_always).toEqual([])
  })
})

describe('layer-file path safety', () => {
  it('rejects a relative ../ traversal slug', () => {
    expect(() => resolveLayerFile({ kind: 'agent', slug: '../../etc/passwd' })).toThrow(LayerPathError)
    expect(() => resolveLayerFile({ kind: 'skill', slug: '../../../etc/passwd' })).toThrow(LayerPathError)
    expect(() => resolveLayerFile({ kind: 'tool', slug: '..' })).toThrow(LayerPathError)
  })

  it('rejects an absolute path slug', () => {
    expect(() => resolveLayerFile({ kind: 'agent', slug: '/etc/passwd' })).toThrow(LayerPathError)
    expect(() => resolveLayerFile({ kind: 'skill', slug: '/etc/shadow' })).toThrow(LayerPathError)
  })

  it('rejects encoded/odd separators and empty slugs', () => {
    for (const bad of ['', '   ', 'a\\..\\b', 'foo\0bar', 'a/b/c', 'foo/../bar']) {
      expect(() => assertSafeSlug(bad), bad).toThrow(LayerPathError)
    }
  })

  it('resolves the legitimate addresses under the three ai-workspace roots', () => {
    expect(resolveLayerFile({ kind: 'agent', slug: 'cto' }).path)
      .toBe(path.join(AGENTS_DIR, 'cto.md'))
    expect(resolveLayerFile({ kind: 'skill', slug: 'devops' }).path)
      .toBe(path.join(SKILLS_DIR, 'devops', 'SKILL.md'))
    // Compound parent/child sub-skill address that skill-graph.ts emits.
    expect(resolveLayerFile({ kind: 'skill', slug: 'marketing/pre-call-hammer' }).path)
      .toBe(path.join(SKILLS_DIR, 'marketing', 'pre-call-hammer', 'SKILL.md'))
    expect(resolveLayerFile({ kind: 'tool', slug: 'github' }).path)
      .toBe(path.join(TOOLS_DIR, 'github', 'TOOL.md'))
    expect(resolveLayerFile({ kind: 'overlay', slug: 'cto', workspace: 'example' }).path)
      .toBe(path.join(WORKSPACES_DIR, 'example', 'agent-profiles', 'cto.md'))
  })

  it('rejects a traversing workspace on an overlay address', () => {
    expect(() => resolveLayerFile({ kind: 'overlay', slug: 'cto', workspace: '../../etc' }))
      .toThrow(LayerPathError)
    expect(() => resolveLayerFile({ kind: 'overlay', slug: 'cto', workspace: '' }))
      .toThrow(LayerPathError)
  })
})
