import type { BoardLayerPayload, LayerFile, LayerFileKind } from '../lib/board-layer'

/**
 * Typed fixture for the Agents tab (obj 712126).
 *
 * Modelled on the real OperationKit layer for CC project 16 (Acquisition
 * Sites): one project agent with a workspace overlay, one shared executive
 * agent, and — deliberately — a DANGLING declared edge in each direction:
 *   · `acq-sites` declares the skill `acq-brand-kit`, which has no file on disk
 *     (skills_declared_missing)
 *   · the skill `acq-site-builder` declares the tool `acq-deploy`, whose file
 *     is absent (tools_declared_missing)
 *   · `legacy-scout` has no persona file at all (agents_without_persona)
 * so the tab's defect rendering is exercised rather than assumed.
 *
 * W6 (obj 712124) owns the server for this contract; this fixture lets the
 * component and its tests run with no server at all.
 */
export const AGENTS_FIXTURE: BoardLayerPayload = {
  scope: { project_id: 16, project_name: 'Acquisition Sites', workspace: 'example' },
  agents: [
    {
      slug: 'acq-sites',
      label: 'Acquisition Sites',
      kind: 'project',
      assignable: true,
      objective_count: 129,
      persona_file: '/home/operator/ai-workspace/agents/acq-sites.md',
      persona_exists: true,
      overlay_file: '/home/operator/ai-workspace/workspaces/example/agent-profiles/acq-sites.md',
      overlay_exists: true,
      skills_always: ['acq-site-builder', 'acq-brand-kit'],
      skills_available: ['acq-copy-review'],
      missing_skills: ['acq-brand-kit'],
    },
    {
      slug: 'cto',
      label: 'CTO',
      kind: 'executive',
      assignable: true,
      objective_count: 4,
      persona_file: '/home/operator/ai-workspace/agents/cto.md',
      persona_exists: true,
      overlay_file: '/home/operator/ai-workspace/workspaces/example/agent-profiles/cto.md',
      overlay_exists: true,
      skills_always: ['acq-copy-review'],
      skills_available: [],
      missing_skills: [],
    },
    {
      slug: 'legacy-scout',
      label: 'Legacy Scout',
      kind: 'routing-only',
      assignable: false,
      objective_count: 0,
      persona_file: '/home/operator/ai-workspace/agents/legacy-scout.md',
      persona_exists: false,
      overlay_file: null,
      overlay_exists: false,
      skills_always: [],
      skills_available: [],
      missing_skills: [],
    },
  ],
  skills: [
    {
      slug: 'acq-site-builder',
      description: 'Scaffold and ship an acquisition microsite.',
      file: '/home/operator/ai-workspace/skills/acq-site-builder/SKILL.md',
      exists: true,
      tools: ['acq-deploy', 'acq-lighthouse'],
      used_by_always: ['acq-sites'],
      used_by_available: [],
      parent: null,
      subskills: [],
    },
    {
      slug: 'acq-copy-review',
      description: 'Brand-voice pass over site copy.',
      file: '/home/operator/ai-workspace/skills/acq-copy-review/SKILL.md',
      exists: true,
      tools: ['acq-lighthouse'],
      used_by_always: ['cto'],
      used_by_available: ['acq-sites'],
      parent: null,
      subskills: [],
    },
    {
      // Declared by acq-sites, registered, but the SKILL.md is not on disk.
      slug: 'acq-brand-kit',
      description: null,
      file: '/home/operator/ai-workspace/skills/acq-brand-kit/SKILL.md',
      exists: false,
      tools: [],
      used_by_always: ['acq-sites'],
      used_by_available: [],
      parent: null,
      subskills: [],
    },
  ],
  tools: [
    {
      slug: 'acq-lighthouse',
      description: 'Lighthouse audit runner.',
      file: '/home/operator/ai-workspace/tools/acq-lighthouse.md',
      exists: true,
      used_by_skills: ['acq-site-builder', 'acq-copy-review'],
    },
    {
      // Declared by acq-site-builder; the tool doc is missing.
      slug: 'acq-deploy',
      description: null,
      file: '/home/operator/ai-workspace/tools/acq-deploy.md',
      exists: false,
      used_by_skills: ['acq-site-builder'],
    },
  ],
  orphans: {
    agents_without_persona: ['legacy-scout'],
    skills_declared_missing: ['acq-brand-kit'],
    tools_declared_missing: ['acq-deploy'],
  },
}

/** The same layer scoped to the whole workspace — a different agent set, so a
 *  scope switch is observable in a test without guessing at the server. */
export const AGENTS_FIXTURE_ALL: BoardLayerPayload = {
  ...AGENTS_FIXTURE,
  scope: { project_id: null, project_name: null, workspace: 'example' },
  agents: [
    ...AGENTS_FIXTURE.agents,
    {
      slug: 'cmo',
      label: 'CMO',
      kind: 'executive',
      assignable: true,
      objective_count: 11,
      persona_file: '/home/operator/ai-workspace/agents/cmo.md',
      persona_exists: true,
      overlay_file: null,
      overlay_exists: false,
      skills_always: ['acq-copy-review'],
      skills_available: [],
      missing_skills: [],
    },
  ],
}

const FILE_BODIES: Record<string, string> = {
  'agent:acq-sites': '# Agent: Acquisition Sites\n\nYou own the acquisition microsite estate.',
  'overlay:acq-sites': '# example overlay — acq-sites\n\nBrand rules, repo setup, deploy target.',
  'agent:cto': '# Agent: CTO\n\nYou are Mike’s Chief Technology Officer.',
  'overlay:cto': '# example overlay — cto\n\nExample-specific priorities.',
  'skill:acq-site-builder': '# Skill: acq-site-builder\n\nScaffold, build, ship.',
  'skill:acq-copy-review': '# Skill: acq-copy-review\n\nBrand-voice pass.',
  'tool:acq-lighthouse': '# Tool: acq-lighthouse\n\nRuns a Lighthouse audit.',
}

const FILE_PATHS: Record<string, string> = {
  'agent:acq-sites': '/home/operator/ai-workspace/agents/acq-sites.md',
  'overlay:acq-sites': '/home/operator/ai-workspace/workspaces/example/agent-profiles/acq-sites.md',
  'agent:cto': '/home/operator/ai-workspace/agents/cto.md',
  'overlay:cto': '/home/operator/ai-workspace/workspaces/example/agent-profiles/cto.md',
  'skill:acq-site-builder': '/home/operator/ai-workspace/skills/acq-site-builder/SKILL.md',
  'skill:acq-copy-review': '/home/operator/ai-workspace/skills/acq-copy-review/SKILL.md',
  'skill:acq-brand-kit': '/home/operator/ai-workspace/skills/acq-brand-kit/SKILL.md',
  'tool:acq-lighthouse': '/home/operator/ai-workspace/tools/acq-lighthouse.md',
  'tool:acq-deploy': '/home/operator/ai-workspace/tools/acq-deploy.md',
  'agent:legacy-scout': '/home/operator/ai-workspace/agents/legacy-scout.md',
}

/** Stand-in for GET /api/agents/layer-file. */
export function fixtureLoadFile(kind: LayerFileKind, slug: string): Promise<LayerFile> {
  const key = `${kind}:${slug}`
  const content = FILE_BODIES[key]
  return Promise.resolve({
    path: FILE_PATHS[key] ?? '',
    kind,
    slug,
    content: content ?? '',
    bytes: content ? content.length : 0,
    exists: content !== undefined,
  })
}
