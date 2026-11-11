/**
 * Skill graph — the agent -> skill -> tool layer graph, served to the admin UI.
 *
 * SOURCE OF TRUTH (obj 707012): the okit-validated **frontmatter layer graph**.
 * Edges are read from the `skills:` key on `agents/<name>.md` and the `tools:`
 * key on every `SKILL.md`, by shelling out to
 * `~/ai-workspace/scripts/generate-layer-graph.py --json` — the same collection
 * pass that renders `docs/operationkit-layer-graph.md` and the same discovery
 * `okit validate` enforces. The server therefore holds no second copy of the
 * graph logic and cannot drift from the validator (the pattern
 * `routes/internal-operationkit.ts` already uses for `okit`).
 *
 * What this deliberately does NOT serve, and why:
 *   - `skills/registry.json`'s top-level `graph` block, and the per-skill
 *     `tier` / `depends_on` / `depended_by` fields. Those were a SECOND,
 *     hand-maintained description of the same graph: stale (11 agents vs the
 *     real 19), unvalidated, and carrying dangling targets. They were deleted
 *     under obj 707012 rather than migrated, because the frontmatter layer
 *     declares no skill->skill dependency and no tier — inventing those edges
 *     here would recreate the drift. Consumers get declared edges or nothing.
 *   - `handoffs_to`. Not present in agent frontmatter; dropped, not faked.
 *
 * registry.json is still read, for the RETAINED per-skill operational stats
 * (`description`, `usage_count`, `failure_count`, `needs_improvement`) that the
 * dream cycle writes back. Those are facts ABOUT a node, not edges between
 * nodes, so they stay on the registry side of the line.
 */
import { execFile } from 'child_process'
import fs from 'fs'
import path from 'path'
import { AI_WORKSPACE_DIR, SKILLS_REGISTRY } from '../config.js'

const SCRIPT_TIMEOUT_MS = 20_000
const MAX_BUFFER = 8 * 1024 * 1024
/** The graph only changes when a .md frontmatter changes; a short TTL keeps the
 *  tab snappy without ever serving a stale-by-minutes picture. */
const CACHE_TTL_MS = 30_000

export interface SkillGraphAgent {
  always: string[]
  available: string[]
}

export interface SkillGraphSkill {
  /** 1 = top-level skill, 2 = sub-skill addressed by the compound `parent/child` slug. */
  depth: number
  parent: string | null
  subskills: string[]
  /** Tools this skill declares (`tools:` frontmatter) — the skill -> tool edges. */
  tools: string[]
  /** Reverse agent -> skill edges, split by load mode. */
  agents_always: string[]
  agents_available: string[]
  /** Retained registry.json stats (not graph edges). Absent if the skill has no row. */
  description?: string
  usage_count?: number
  failure_count?: number
  needs_improvement?: boolean
}

export interface SkillGraph {
  source: 'frontmatter-layer-graph'
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
  agents: Record<string, SkillGraphAgent>
  skills: Record<string, SkillGraphSkill>
  tools: Record<string, { skills: string[] }>
  orphans: { tools: string[]; skills: string[] }
}

export function layerGraphScript(): string {
  return process.env.LAYER_GRAPH_SCRIPT
    || path.join(AI_WORKSPACE_DIR, 'scripts', 'generate-layer-graph.py')
}

/**
 * Reject a payload the tab cannot render, BEFORE it is cached and served.
 *
 * Valid JSON of the wrong shape is the dangerous case: `mergeRegistryStats` only
 * touches `.skills`, so a payload missing `tools` sails through the service and
 * then throws inside the React render (`Object.keys(data.tools)`), turning a
 * deliberate 503 EmptyState into a blank tab with a console stack. Checking the
 * three node maps plus the `source` marker keeps the failure server-side and
 * legible.
 */
export function layerGraphShapeError(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'payload is not an object'
  const graph = value as Record<string, unknown>
  if (graph.source !== 'frontmatter-layer-graph') {
    return `expected source "frontmatter-layer-graph", got ${JSON.stringify(graph.source)}`
  }
  for (const key of ['agents', 'skills', 'tools', 'counts'] as const) {
    const node = graph[key]
    if (!node || typeof node !== 'object' || Array.isArray(node)) return `"${key}" is not an object`
  }
  return null
}

/** Run the generator in --json mode. Rejects with a readable message; the route
 *  turns that into a 503 so the tab can say "graph unavailable" rather than
 *  silently rendering an empty graph. */
export function runLayerGraph(): Promise<SkillGraph> {
  return new Promise((resolve, reject) => {
    const script = layerGraphScript()
    if (!fs.existsSync(script)) {
      reject(new Error(`layer-graph generator not found at ${script}`))
      return
    }
    execFile(
      'python3',
      [script, '--json'],
      { timeout: SCRIPT_TIMEOUT_MS, maxBuffer: MAX_BUFFER, env: { ...process.env, AI_WORKSPACE: AI_WORKSPACE_DIR } },
      (err, stdout, stderr) => {
        // Any non-zero exit, timeout or kill is a failure, EVEN when stdout parses.
        // A generator that dies partway can still have flushed syntactically valid
        // JSON, and accepting it would cache a truncated graph for the whole TTL
        // and serve it as truth. Fail closed; the route turns this into a 503.
        if (err) {
          reject(new Error(`layer-graph generator failed: ${(stderr || err.message).slice(0, 500)}`))
          return
        }
        let parsed: unknown
        try {
          parsed = JSON.parse(stdout)
        } catch {
          reject(new Error(`layer-graph generator did not return JSON: ${(stderr || stdout).slice(0, 500)}`))
          return
        }
        const shapeError = layerGraphShapeError(parsed)
        if (shapeError) {
          reject(new Error(`layer-graph generator returned an unusable graph: ${shapeError}`))
          return
        }
        resolve(parsed as SkillGraph)
      },
    )
  })
}

/** Per-skill stats retained in registry.json after the graph block was deleted. */
type RegistryStats = Record<string, {
  description?: unknown
  usage_count?: unknown
  failure_count?: unknown
  needs_improvement?: unknown
}>

export function readRegistryStats(registryPath = SKILLS_REGISTRY): RegistryStats {
  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath, 'utf-8')) as { skills?: RegistryStats }
    return parsed && typeof parsed.skills === 'object' && parsed.skills ? parsed.skills : {}
  } catch {
    // A missing/unparseable registry costs the tab its usage counters, not its
    // graph — the edges come from frontmatter and are unaffected.
    return {}
  }
}

/**
 * Attach the retained registry stats to their graph nodes.
 *
 * Node membership is decided ENTIRELY by the layer graph: a registry row with
 * no frontmatter node is ignored rather than resurrected as a phantom skill.
 */
export function mergeRegistryStats(graph: SkillGraph, stats: RegistryStats): SkillGraph {
  const skills: Record<string, SkillGraphSkill> = {}
  for (const [slug, node] of Object.entries(graph.skills)) {
    const row = stats[slug]
    skills[slug] = {
      ...node,
      ...(typeof row?.description === 'string' ? { description: row.description } : {}),
      ...(typeof row?.usage_count === 'number' ? { usage_count: row.usage_count } : {}),
      ...(typeof row?.failure_count === 'number' ? { failure_count: row.failure_count } : {}),
      ...(typeof row?.needs_improvement === 'boolean' ? { needs_improvement: row.needs_improvement } : {}),
    }
  }
  return { ...graph, skills }
}

let cache: { at: number; value: SkillGraph } | null = null

/** The full payload `GET /api/admin/skill-graph` serves. */
export async function getSkillGraph(force = false): Promise<SkillGraph> {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value
  const merged = mergeRegistryStats(await runLayerGraph(), readRegistryStats())
  cache = { at: Date.now(), value: merged }
  return merged
}

/** Test seam — drops the memoized graph. */
export function clearSkillGraphCache(): void {
  cache = null
}
