/**
 * Board layer — the OperationKit agent/skill/tool graph SCOPED TO A PROJECT.
 *
 * The existing /settings/agents surface answers "what does the registry
 * contain?" (roster CRUD + the whole-workspace skill graph). This module
 * answers a different question: "for the objectives actually sitting in THIS
 * project's column of the board, which agent persona, workspace overlay, skill
 * and tool markdown files do those sessions run on, and do those files exist?"
 *
 * Contract fixed by obj 712044 and served by obj 712124 (server side):
 *   GET /api/agents/board-layer?project_id=<int>&workspace=<slug>
 *   GET /api/agents/layer-file?kind=agent|skill|tool|overlay&slug=<slug>&workspace=<ws>
 *
 * Types live here rather than in app/shared so this tab ships as a client-only
 * change and does not race the server branch on the same file.
 *
 * HONESTY RULE (inherited from SkillGraph.tsx): every edge here is a DECLARED
 * edge — an agent's `skills:` frontmatter or a skill's `tools:` frontmatter.
 * Nothing is inferred, and a declared edge whose target file is missing is
 * surfaced as a defect rather than quietly dropped.
 */
import { api } from './api'

export interface BoardLayerScope {
  project_id: number | null
  project_name: string | null
  workspace: string
}

export interface BoardLayerAgent {
  slug: string
  label: string
  kind: string
  assignable: boolean
  /** Objectives in scope routed to this agent — which agent actually does the work here. */
  objective_count: number
  persona_file: string
  persona_exists: boolean
  overlay_file: string | null
  overlay_exists: boolean
  skills_always: string[]
  skills_available: string[]
  /** Declared skills with no registry entry — a dangling agent→skill edge. */
  missing_skills: string[]
}

export interface BoardLayerSkill {
  slug: string
  description: string | null
  file: string
  exists: boolean
  tools: string[]
  used_by_always: string[]
  used_by_available: string[]
  parent: string | null
  subskills: string[]
}

export interface BoardLayerTool {
  slug: string
  description: string | null
  file: string
  exists: boolean
  used_by_skills: string[]
}

export interface BoardLayerOrphans {
  agents_without_persona: string[]
  skills_declared_missing: string[]
  tools_declared_missing: string[]
}

export interface BoardLayerPayload {
  scope: BoardLayerScope
  agents: BoardLayerAgent[]
  skills: BoardLayerSkill[]
  tools: BoardLayerTool[]
  orphans: BoardLayerOrphans
}

export type LayerFileKind = 'agent' | 'skill' | 'tool' | 'overlay'

export interface LayerFile {
  path: string
  kind: LayerFileKind
  slug: string
  content: string
  bytes: number
  exists: boolean
}

/** Total count of dangling declared edges — the headline defect number. */
export function orphanCount(o: BoardLayerOrphans | undefined | null): number {
  if (!o) return 0
  return (
    (o.agents_without_persona?.length ?? 0) +
    (o.skills_declared_missing?.length ?? 0) +
    (o.tools_declared_missing?.length ?? 0)
  )
}

export function fetchBoardLayer(
  workspace: string,
  projectId: number | null,
): Promise<BoardLayerPayload> {
  const qs = new URLSearchParams({ workspace })
  if (projectId != null) qs.set('project_id', String(projectId))
  return api.get<BoardLayerPayload>(`/agents/board-layer?${qs.toString()}`)
}

export function fetchLayerFile(
  kind: LayerFileKind,
  slug: string,
  workspace?: string,
): Promise<LayerFile> {
  const qs = new URLSearchParams({ kind, slug })
  if (workspace) qs.set('workspace', workspace)
  return api.get<LayerFile>(`/agents/layer-file?${qs.toString()}`)
}

// ── Adapter: board layer → the SkillGraph canvas payload ────────────────────

/**
 * Reshapes the project-scoped board layer into the payload the EXISTING
 * SkillGraph canvas already knows how to lay out, so this tab reuses that
 * visualisation scoped to a project instead of growing a second one.
 *
 * `needs_improvement` is reused as the canvas's alarm ring and here means
 * "declared but the file is missing on disk" — GraphCanvas takes an
 * `alarmLabel` so the legend states that rather than the registry's
 * "needs work" wording.
 */
export interface CanvasPayload {
  source: string
  generated_at: string
  counts: {
    agents: number
    skills: number
    skills_top_level: number
    subskills: number
    tools: number
    agent_skill_edges: number
    skill_tool_edges: number
  }
  agents: Record<string, { always: string[]; available: string[] }>
  skills: Record<string, {
    depth: number
    parent: string | null
    subskills: string[]
    tools: string[]
    agents_always: string[]
    agents_available: string[]
    description?: string
    needs_improvement?: boolean
  }>
  tools: Record<string, { skills: string[] }>
  orphans: { tools: string[]; skills: string[] }
}

export function toCanvasPayload(data: BoardLayerPayload): CanvasPayload {
  const agents: CanvasPayload['agents'] = {}
  let agentSkillEdges = 0
  for (const a of data.agents) {
    agents[a.slug] = { always: a.skills_always, available: a.skills_available }
    agentSkillEdges += a.skills_always.length + a.skills_available.length
  }

  const skills: CanvasPayload['skills'] = {}
  let skillToolEdges = 0
  let subskills = 0
  for (const s of data.skills) {
    if (s.parent) subskills++
    skillToolEdges += s.tools.length
    skills[s.slug] = {
      depth: s.parent ? 2 : 1,
      parent: s.parent,
      subskills: s.subskills,
      tools: s.tools,
      agents_always: s.used_by_always,
      agents_available: s.used_by_available,
      description: s.description ?? undefined,
      needs_improvement: !s.exists,
    }
  }

  const tools: CanvasPayload['tools'] = {}
  for (const t of data.tools) tools[t.slug] = { skills: t.used_by_skills }

  return {
    source: data.scope.project_name ?? data.scope.workspace,
    generated_at: '',
    counts: {
      agents: data.agents.length,
      skills: data.skills.length,
      skills_top_level: data.skills.length - subskills,
      subskills,
      tools: data.tools.length,
      agent_skill_edges: agentSkillEdges,
      skill_tool_edges: skillToolEdges,
    },
    agents,
    skills,
    tools,
    orphans: {
      skills: data.orphans?.skills_declared_missing ?? [],
      tools: data.orphans?.tools_declared_missing ?? [],
    },
  }
}
