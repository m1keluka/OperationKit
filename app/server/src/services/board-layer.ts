/**
 * Board layer — the per-project view of the agent -> skill -> tool graph.
 *
 * Powers the Agents tab. This service is a PROJECTION, not a second graph:
 * every agent->skill and skill->tool edge comes from
 * `services/skill-graph.ts` (the okit-validated frontmatter layer graph served
 * by GET /api/admin/skill-graph). Nothing here re-parses frontmatter and
 * nothing shells out to okit per request. What this module adds on top:
 *
 *   1. SCOPE — which agents are actually in use, derived from the board:
 *      `objectives.agent_context` grouped by `project_id` (or by workspace).
 *      There is no agent column on `projects`; usage is an objectives fact.
 *   2. REGISTRY METADATA — label / kind / assignable / prompt_file from the
 *      sqlite `agents` table (services/agent-registry.ts).
 *   3. ON-DISK REALITY — a real fs.existsSync for every declared node, so a
 *      dangling edge (a skill an agent declares but which has no SKILL.md) is
 *      SHOWN with exists:false and listed in `orphans`, never silently dropped.
 *      Surfacing those breaks is the whole point of the tab.
 *
 * Path resolution mirrors what a real session gets: the per-workspace overlay
 * at workspaces/<ws>/agent-profiles/<slug>.md is OPTIONAL and checked with
 * fs.existsSync exactly as services/prompt-builder.ts does.
 */
import fs from 'fs'
import path from 'path'
import { getDb } from '../db/index.js'
import { AI_WORKSPACE_DIR, AGENTS_DIR, SKILLS_DIR } from '../config.js'
import { listAgents } from './agent-registry.js'
import { getSkillGraph, type SkillGraph } from './skill-graph.js'

/** The three ~/ai-workspace roots this feature is allowed to read from. Every
 *  resolved path — for the board payload AND for layer-file — must still live
 *  under one of these AFTER realpath. */
export const TOOLS_DIR = `${AI_WORKSPACE_DIR}/tools`
export const LAYER_ROOTS = [AGENTS_DIR, SKILLS_DIR, TOOLS_DIR] as const
export const WORKSPACES_DIR = `${AI_WORKSPACE_DIR}/workspaces`

export type LayerKind = 'agent' | 'skill' | 'tool' | 'overlay'

export interface BoardLayerAgent {
  slug: string
  label: string
  kind: string
  assignable: boolean
  /** Objectives on this project (or in this workspace) with agent_context = slug. */
  objective_count: number
  /** Absolute path to the persona file, or null when it is missing on disk. */
  persona_file: string | null
  persona_exists: boolean
  /** Absolute path the workspace overlay WOULD live at (it is optional). */
  overlay_file: string | null
  overlay_exists: boolean
  skills_always: string[]
  skills_available: string[]
  /** Declared skills with no SKILL.md on disk. */
  missing_skills: string[]
}

export interface BoardLayerSkill {
  slug: string
  description: string
  file: string | null
  exists: boolean
  tools: string[]
  used_by_always: string[]
  used_by_available: string[]
  parent: string | null
  subskills: string[]
}

export interface BoardLayerTool {
  slug: string
  description: string
  file: string | null
  exists: boolean
  used_by_skills: string[]
}

export interface BoardLayer {
  scope: { project_id: number | null; project_name: string | null; workspace: string }
  agents: BoardLayerAgent[]
  skills: BoardLayerSkill[]
  tools: BoardLayerTool[]
  orphans: {
    agents_without_persona: string[]
    skills_declared_missing: string[]
    tools_declared_missing: string[]
  }
}

export function personaPath(slug: string, promptFile?: string | null): string {
  // The registry may pin a persona file explicitly; a relative value is taken
  // as relative to ~/ai-workspace (the convention prompt_file rows use).
  if (promptFile) {
    return path.isAbsolute(promptFile) ? promptFile : path.join(AI_WORKSPACE_DIR, promptFile)
  }
  return path.join(AGENTS_DIR, `${slug}.md`)
}

/** `skills/<slug>/SKILL.md`, where slug may be the compound `parent/child`
 *  sub-skill address that skill-graph.ts emits. */
export function skillPath(slug: string): string {
  return path.join(SKILLS_DIR, ...slug.split('/'), 'SKILL.md')
}

export function toolPath(slug: string): string {
  return path.join(TOOLS_DIR, ...slug.split('/'), 'TOOL.md')
}

export function overlayPath(workspace: string, slug: string): string {
  return path.join(WORKSPACES_DIR, workspace, 'agent-profiles', `${slug}.md`)
}

/** Tool descriptions live in tools/registry.json (`{tools: {slug: {description}}}`).
 *  Missing/unparseable registry costs a description, never an edge. */
export function readToolDescriptions(registryPath = `${TOOLS_DIR}/registry.json`): Record<string, string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath, 'utf-8')) as {
      tools?: Record<string, { description?: unknown }>
    }
    const out: Record<string, string> = {}
    for (const [slug, row] of Object.entries(parsed?.tools ?? {})) {
      if (typeof row?.description === 'string') out[slug] = row.description
    }
    return out
  } catch {
    return {}
  }
}

interface ScopeRow { agent_context: string; n: number }

/** Objective counts per agent_context for the requested scope. */
export function agentUsage(projectId: number | null, workspace: string): Map<string, number> {
  const rows = (projectId === null
    ? getDb()
      .prepare('SELECT agent_context, COUNT(*) AS n FROM objectives WHERE workspace = ? GROUP BY agent_context')
      .all(workspace)
    : getDb()
      .prepare('SELECT agent_context, COUNT(*) AS n FROM objectives WHERE project_id = ? GROUP BY agent_context')
      .all(projectId)) as ScopeRow[]
  return new Map(rows.filter(r => !!r.agent_context).map(r => [r.agent_context, r.n]))
}

/** Rewrite of `objectives.agent_context` values into the in-scope agent set.
 *  Workspace scope additionally includes every non-archived registry agent, so
 *  the workspace-level view is the full roster rather than only what happens to
 *  have objectives today. Project scope is strictly what the board uses. */
export function scopedAgentSlugs(
  usage: Map<string, number>,
  projectId: number | null,
  registrySlugs: string[],
): string[] {
  const slugs = new Set(usage.keys())
  if (projectId === null) for (const s of registrySlugs) slugs.add(s)
  return Array.from(slugs).sort()
}

/** The subset of an `agents` registry row this projection needs. */
export interface RegistryRow {
  slug: string
  label: string
  kind: string
  assignable: boolean
  prompt_file?: string | null
}

export interface BuildOpts {
  projectId: number | null
  workspace: string
  projectName: string | null
  graph: SkillGraph
  usage: Map<string, number>
  /** Non-archived rows from the sqlite `agents` table. Passed in (rather than
   *  read here) so the projection stays a pure function over its inputs. */
  registry: RegistryRow[]
  toolDescriptions: Record<string, string>
  /** Test seam. Defaults to the real filesystem check. */
  exists?: (p: string) => boolean
}

export function buildBoardLayer(opts: BuildOpts): BoardLayer {
  const exists = opts.exists ?? ((p: string) => fs.existsSync(p))
  const registry = new Map(opts.registry.map(r => [r.slug, r]))
  const slugs = scopedAgentSlugs(opts.usage, opts.projectId, Array.from(registry.keys()))

  const agents: BoardLayerAgent[] = []
  const agentsWithoutPersona: string[] = []
  // slug -> {always: Set<agent>, available: Set<agent>} for the in-scope agents only.
  const skillUse = new Map<string, { always: Set<string>; available: Set<string> }>()

  for (const slug of slugs) {
    const row = registry.get(slug)
    const node = opts.graph.agents[slug]
    const always = node?.always ?? []
    const available = node?.available ?? []

    for (const [mode, list] of [['always', always], ['available', available]] as const) {
      for (const s of list) {
        if (!skillUse.has(s)) skillUse.set(s, { always: new Set(), available: new Set() })
        skillUse.get(s)![mode].add(slug)
      }
    }

    const persona = personaPath(slug, row?.prompt_file)
    const personaExists = exists(persona)
    if (!personaExists) agentsWithoutPersona.push(slug)
    const overlay = opts.workspace ? overlayPath(opts.workspace, slug) : null

    agents.push({
      slug,
      // An agent_context with no registry row is still real board data — show it
      // rather than dropping the objectives it owns.
      label: row?.label ?? slug,
      kind: row?.kind ?? 'unknown',
      assignable: row?.assignable ?? false,
      objective_count: opts.usage.get(slug) ?? 0,
      persona_file: personaExists ? persona : null,
      persona_exists: personaExists,
      overlay_file: overlay,
      overlay_exists: overlay ? exists(overlay) : false,
      skills_always: always,
      skills_available: available,
      missing_skills: [...always, ...available].filter(s => !exists(skillPath(s))),
    })
  }

  // ── Skills reachable from the in-scope agents ──────────────────────────
  const skills: BoardLayerSkill[] = []
  const skillsMissing: string[] = []
  // tool -> skills (in scope) that declare it
  const toolUse = new Map<string, Set<string>>()

  for (const slug of Array.from(skillUse.keys()).sort()) {
    const node = opts.graph.skills[slug]
    const file = skillPath(slug)
    const fileExists = exists(file)
    // A declared-but-absent skill has no graph node at all. Keep the edge
    // visible with exists:false instead of dropping it.
    if (!fileExists) skillsMissing.push(slug)
    const tools = node?.tools ?? []
    for (const t of tools) {
      if (!toolUse.has(t)) toolUse.set(t, new Set())
      toolUse.get(t)!.add(slug)
    }
    const use = skillUse.get(slug)!
    skills.push({
      slug,
      description: node?.description ?? '',
      file: fileExists ? file : null,
      exists: fileExists,
      tools,
      used_by_always: Array.from(use.always).sort(),
      used_by_available: Array.from(use.available).sort(),
      parent: node?.parent ?? null,
      subskills: node?.subskills ?? [],
    })
  }

  // ── Tools reachable from those skills ──────────────────────────────────
  const tools: BoardLayerTool[] = []
  const toolsMissing: string[] = []
  for (const slug of Array.from(toolUse.keys()).sort()) {
    const file = toolPath(slug)
    const fileExists = exists(file)
    if (!fileExists) toolsMissing.push(slug)
    tools.push({
      slug,
      description: opts.toolDescriptions[slug] ?? '',
      file: fileExists ? file : null,
      exists: fileExists,
      used_by_skills: Array.from(toolUse.get(slug)!).sort(),
    })
  }

  return {
    scope: { project_id: opts.projectId, project_name: opts.projectName, workspace: opts.workspace },
    agents,
    skills,
    tools,
    orphans: {
      agents_without_persona: agentsWithoutPersona.sort(),
      skills_declared_missing: skillsMissing.sort(),
      tools_declared_missing: toolsMissing.sort(),
    },
  }
}

export interface ProjectRow { id: number; workspace: string; name: string }

export function getProject(id: number): ProjectRow | undefined {
  return getDb().prepare('SELECT id, workspace, name FROM projects WHERE id = ?').get(id) as ProjectRow | undefined
}

export interface ResolveScope { projectId: number | null; workspace: string | null }

/** Assemble the full payload for a request. */
export async function loadBoardLayer(scope: ResolveScope): Promise<BoardLayer> {
  let workspace = scope.workspace ?? ''
  let projectName: string | null = null
  if (scope.projectId !== null) {
    const project = getProject(scope.projectId)
    if (!project) throw Object.assign(new Error(`project ${scope.projectId} not found`), { status: 404 })
    // The project's own workspace wins — a mismatched ?workspace= would produce
    // overlay paths a session would never actually read.
    workspace = project.workspace
    projectName = project.name
  }
  const graph = await getSkillGraph()
  return buildBoardLayer({
    projectId: scope.projectId,
    workspace,
    projectName,
    graph,
    usage: agentUsage(scope.projectId, workspace),
    registry: listAgents(),
    toolDescriptions: readToolDescriptions(),
  })
}

// ── layer-file resolution ────────────────────────────────────────────────

export class LayerPathError extends Error {
  status = 400
}

/**
 * Resolve a (kind, slug) address to an absolute file under one of the three
 * ~/ai-workspace roots (or the workspaces/ overlay tree).
 *
 * Defence is in depth and deliberately boring:
 *   1. Syntactic reject — no '..' segment, no absolute path, no NUL, no
 *      backslash, each segment must match a conservative slug charset.
 *   2. Structural reject — kind decides the root; nothing else is reachable.
 *   3. CONTAINMENT ASSERT — after path.resolve (and fs.realpathSync when the
 *      file exists, so a symlink out of the tree is caught too) the result must
 *      still be inside the allowed root. This is the check that holds even if
 *      (1) and (2) are ever weakened.
 */
const SEGMENT = /^[A-Za-z0-9._-]+$/

export function assertSafeSlug(slug: string): string[] {
  if (typeof slug !== 'string' || slug.trim() === '') throw new LayerPathError('slug is required')
  if (slug.includes('\0')) throw new LayerPathError('slug contains an illegal character')
  if (slug.includes('\\')) throw new LayerPathError('slug contains an illegal character')
  if (path.isAbsolute(slug) || slug.startsWith('/') || /^[A-Za-z]:/.test(slug)) {
    throw new LayerPathError('slug must not be an absolute path')
  }
  const segments = slug.split('/')
  // Traversal is checked BEFORE the arity check so '../../etc/passwd' reports
  // the reason it was actually rejected.
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') throw new LayerPathError('slug must not traverse directories')
    if (!SEGMENT.test(seg)) throw new LayerPathError(`illegal slug segment: ${seg}`)
  }
  if (segments.length > 2) throw new LayerPathError('slug may have at most one sub-skill segment')
  return segments
}

export function assertUnderRoot(resolved: string, root: string): string {
  // realpath only when it exists; a not-yet-existing file still gets the
  // lexical containment check (we report exists:false for it).
  let real = resolved
  try { real = fs.realpathSync(resolved) } catch { /* not on disk yet */ }
  const realRoot = (() => { try { return fs.realpathSync(root) } catch { return root } })()
  const inside = (p: string, r: string) => p === r || p.startsWith(r.endsWith(path.sep) ? r : r + path.sep)
  if (!inside(path.resolve(resolved), path.resolve(root)) || !inside(real, realRoot)) {
    throw new LayerPathError('resolved path escapes the allowed ai-workspace root')
  }
  return real
}

export interface LayerFileAddress { kind: LayerKind; slug: string; workspace?: string | null }

export function resolveLayerFile(addr: LayerFileAddress): { path: string; root: string } {
  const segments = assertSafeSlug(addr.slug)
  switch (addr.kind) {
    case 'agent': {
      if (segments.length !== 1) throw new LayerPathError('agent slug has no sub-segments')
      const p = path.join(AGENTS_DIR, `${segments[0]}.md`)
      assertUnderRoot(p, AGENTS_DIR)
      return { path: p, root: AGENTS_DIR }
    }
    case 'skill': {
      const p = path.join(SKILLS_DIR, ...segments, 'SKILL.md')
      assertUnderRoot(p, SKILLS_DIR)
      return { path: p, root: SKILLS_DIR }
    }
    case 'tool': {
      const p = path.join(TOOLS_DIR, ...segments, 'TOOL.md')
      assertUnderRoot(p, TOOLS_DIR)
      return { path: p, root: TOOLS_DIR }
    }
    case 'overlay': {
      if (segments.length !== 1) throw new LayerPathError('overlay slug has no sub-segments')
      const ws = addr.workspace ?? ''
      const wsSegments = assertSafeSlug(ws)
      if (wsSegments.length !== 1) throw new LayerPathError('workspace must be a single slug')
      const root = path.join(WORKSPACES_DIR, wsSegments[0], 'agent-profiles')
      const p = path.join(root, `${segments[0]}.md`)
      assertUnderRoot(p, WORKSPACES_DIR)
      return { path: p, root }
    }
    default:
      throw new LayerPathError('kind must be one of agent, skill, tool, overlay')
  }
}

const MAX_LAYER_FILE_BYTES = 2 * 1024 * 1024

export interface LayerFile {
  path: string
  kind: LayerKind
  slug: string
  content: string
  bytes: number
  exists: boolean
}

export function readLayerFile(addr: LayerFileAddress): LayerFile {
  const { path: abs } = resolveLayerFile(addr)
  if (!fs.existsSync(abs)) {
    return { path: abs, kind: addr.kind, slug: addr.slug, content: '', bytes: 0, exists: false }
  }
  const stat = fs.statSync(abs)
  if (!stat.isFile()) throw new LayerPathError('resolved path is not a regular file')
  if (stat.size > MAX_LAYER_FILE_BYTES) {
    throw Object.assign(new Error('layer file is too large to serve'), { status: 413 })
  }
  const content = fs.readFileSync(abs, 'utf-8')
  return { path: abs, kind: addr.kind, slug: addr.slug, content, bytes: stat.size, exists: true }
}
