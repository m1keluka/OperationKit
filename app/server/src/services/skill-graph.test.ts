/**
 * skill-graph tests (obj 707012).
 *
 * Two layers, so the service's own contract stays testable without the
 * repo-external ~/ai-workspace:
 *
 *  1. Pure unit tests of `readRegistryStats` / `mergeRegistryStats` — the seam
 *     where the RETAINED registry.json stats meet the frontmatter layer graph.
 *     These pin the rule that mattered in this migration: node membership comes
 *     from the graph, never from the registry.
 *  2. A real-generator test driven through a STUB script (LAYER_GRAPH_SCRIPT),
 *     so the execFile contract is verified without depending on the workspace,
 *     plus one skipIf-guarded run against the REAL generator that asserts the
 *     shape and the counts the admin tab renders.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  readRegistryStats,
  mergeRegistryStats,
  runLayerGraph,
  layerGraphScript,
  layerGraphShapeError,
  clearSkillGraphCache,
  type SkillGraph,
} from './skill-graph.js'

const REAL_WORKSPACE = process.env.AI_WORKSPACE_DIR || process.env.AI_WORKSPACE || '/home/operator/ai-workspace'
const REAL_GENERATOR = path.join(REAL_WORKSPACE, 'scripts', 'generate-layer-graph.py')
const HAVE_GENERATOR = fs.existsSync(REAL_GENERATOR)

function graph(overrides: Partial<SkillGraph> = {}): SkillGraph {
  return {
    source: 'frontmatter-layer-graph',
    generated_at: '2026-08-19T00:00:00Z',
    counts: {
      agents: 1, skills: 1, skills_top_level: 1, subskills: 0,
      tools: 1, agent_skill_edges: 1, skill_tool_edges: 1,
    },
    agents: { cto: { always: ['devops'], available: [] } },
    skills: {
      devops: {
        depth: 1, parent: null, subskills: [], tools: ['github'],
        agents_always: ['cto'], agents_available: [],
      },
    },
    tools: { github: { skills: ['devops'] } },
    orphans: { tools: [], skills: [] },
    ...overrides,
  }
}

describe('readRegistryStats', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-skillgraph-')) })

  it('reads the skills map out of a registry', () => {
    const p = path.join(dir, 'registry.json')
    fs.writeFileSync(p, JSON.stringify({ skills: { devops: { usage_count: 4 } } }))
    expect(readRegistryStats(p)).toEqual({ devops: { usage_count: 4 } })
  })

  it('degrades to {} on a missing or unparseable registry rather than throwing', () => {
    expect(readRegistryStats(path.join(dir, 'nope.json'))).toEqual({})
    const bad = path.join(dir, 'bad.json')
    fs.writeFileSync(bad, '{ not json')
    expect(readRegistryStats(bad)).toEqual({})
  })
})

describe('mergeRegistryStats', () => {
  it('attaches the retained stats to their graph node', () => {
    const merged = mergeRegistryStats(graph(), {
      devops: {
        description: 'ship code', usage_count: 12, failure_count: 2, needs_improvement: true,
      },
    })
    expect(merged.skills.devops).toMatchObject({
      description: 'ship code', usage_count: 12, failure_count: 2, needs_improvement: true,
      tools: ['github'], agents_always: ['cto'],
    })
  })

  it('ignores a registry row with no frontmatter node — a deleted skill cannot be resurrected', () => {
    const merged = mergeRegistryStats(graph(), { 'long-gone': { usage_count: 99 } })
    expect(Object.keys(merged.skills)).toEqual(['devops'])
  })

  it('never carries tier / depends_on / depended_by through from the registry', () => {
    const merged = mergeRegistryStats(graph(), {
      devops: {
        usage_count: 1,
        // The deleted block's shape, as it would appear in a stale registry.
        tier: 'foundation', depends_on: [{ skill: 'x' }], depended_by: [{ skill: 'y' }],
      } as Record<string, unknown>,
    })
    const node = merged.skills.devops as unknown as Record<string, unknown>
    expect(node.tier).toBeUndefined()
    expect(node.depends_on).toBeUndefined()
    expect(node.depended_by).toBeUndefined()
    expect(node.usage_count).toBe(1)
  })

  it('drops a stat whose type is wrong rather than passing garbage to the UI', () => {
    const merged = mergeRegistryStats(graph(), {
      devops: { usage_count: 'lots', needs_improvement: 'yes' } as Record<string, unknown>,
    })
    expect(merged.skills.devops.usage_count).toBeUndefined()
    expect(merged.skills.devops.needs_improvement).toBeUndefined()
  })
})

describe('runLayerGraph', () => {
  beforeEach(() => clearSkillGraphCache())

  it('rejects with a readable message when the generator is absent', async () => {
    process.env.LAYER_GRAPH_SCRIPT = '/nonexistent/generate-layer-graph.py'
    await expect(runLayerGraph()).rejects.toThrow(/not found/)
    delete process.env.LAYER_GRAPH_SCRIPT
  })

  it('invokes the generator with --json and parses its stdout', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-lg-'))
    const stub = path.join(dir, 'stub.py')
    fs.writeFileSync(stub, [
      'import json, sys',
      // Proves the route passes --json; anything else is a hard failure.
      'assert sys.argv[1:] == ["--json"], sys.argv',
      'print(json.dumps({"source": "frontmatter-layer-graph", "counts": {"agents": 19},',
      '                  "agents": {}, "skills": {}, "tools": {}}))',
    ].join('\n'))
    process.env.LAYER_GRAPH_SCRIPT = stub
    expect(layerGraphScript()).toBe(stub)
    const out = await runLayerGraph()
    expect(out.source).toBe('frontmatter-layer-graph')
    expect(out.counts.agents).toBe(19)
    delete process.env.LAYER_GRAPH_SCRIPT
  })

  it('rejects when the generator emits non-JSON', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-lg-'))
    const stub = path.join(dir, 'stub.py')
    fs.writeFileSync(stub, 'print("not json")')
    process.env.LAYER_GRAPH_SCRIPT = stub
    await expect(runLayerGraph()).rejects.toThrow(/did not return JSON/)
    delete process.env.LAYER_GRAPH_SCRIPT
  })

  // A generator that dies partway can still have flushed parseable JSON. Serving
  // it would cache a truncated graph for the whole TTL and present it as truth.
  it('rejects a non-zero exit even when stdout parses as a valid graph', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-lg-'))
    const stub = path.join(dir, 'stub.py')
    fs.writeFileSync(stub, [
      'import json, sys',
      'print(json.dumps({"source": "frontmatter-layer-graph", "counts": {},',
      '                  "agents": {}, "skills": {}, "tools": {}}))',
      'sys.stderr.write("partial walk: skills/ unreadable")',
      'sys.exit(3)',
    ].join('\n'))
    process.env.LAYER_GRAPH_SCRIPT = stub
    await expect(runLayerGraph()).rejects.toThrow(/generator failed/)
    delete process.env.LAYER_GRAPH_SCRIPT
  })

  // Valid JSON of the wrong shape must fail server-side (-> 503 EmptyState),
  // not downstream inside the React render as `Object.keys(undefined)`.
  it('rejects valid JSON that is missing a node layer', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-lg-'))
    const stub = path.join(dir, 'stub.py')
    fs.writeFileSync(stub, [
      'import json',
      // `tools` omitted — exactly what layoutGraph would crash on.
      'print(json.dumps({"source": "frontmatter-layer-graph", "counts": {},',
      '                  "agents": {}, "skills": {}}))',
    ].join('\n'))
    process.env.LAYER_GRAPH_SCRIPT = stub
    await expect(runLayerGraph()).rejects.toThrow(/unusable graph.*"tools" is not an object/)
    delete process.env.LAYER_GRAPH_SCRIPT
  })
})

describe('layerGraphShapeError', () => {
  it('accepts the shape the generator really emits', () => {
    expect(layerGraphShapeError(graph())).toBeNull()
  })

  it('names the offending layer rather than failing anonymously', () => {
    expect(layerGraphShapeError({ ...graph(), tools: undefined })).toMatch(/"tools" is not an object/)
    expect(layerGraphShapeError({ ...graph(), agents: [] })).toMatch(/"agents" is not an object/)
    expect(layerGraphShapeError({ ...graph(), counts: 'nope' })).toMatch(/"counts" is not an object/)
  })

  // Guards against a DIFFERENT json-emitting script being wired to
  // LAYER_GRAPH_SCRIPT and silently accepted as the graph.
  it('rejects a payload that is not the layer graph', () => {
    expect(layerGraphShapeError({ ...graph(), source: 'skills-registry' }))
      .toMatch(/expected source "frontmatter-layer-graph"/)
    expect(layerGraphShapeError(null)).toMatch(/not an object/)
    expect(layerGraphShapeError([])).toMatch(/not an object/)
  })
})

// Reads the live workspace read-only. Skipped where it is absent (CI), so the
// suite is never coupled to ~/ai-workspace existing.
describe.skipIf(!HAVE_GENERATOR)('runLayerGraph against the real generator', () => {
  it('returns the three-layer graph the admin tab renders', async () => {
    process.env.LAYER_GRAPH_SCRIPT = REAL_GENERATOR
    const g = await runLayerGraph()
    delete process.env.LAYER_GRAPH_SCRIPT

    expect(g.source).toBe('frontmatter-layer-graph')
    // The migration's whole point: every agent file is a node, where the deleted
    // registry block only ever knew 11 of them.
    expect(g.counts.agents).toBeGreaterThanOrEqual(19)
    expect(g.counts.agents).toBe(Object.keys(g.agents).length)
    expect(g.counts.agent_skill_edges).toBeGreaterThan(100)
    expect(g.counts.skill_tool_edges).toBeGreaterThan(0)

    // No dangling edges: every declared target resolves to a real node — the
    // property `okit validate` REF-001 enforces, asserted from the consumer side.
    for (const [agent, node] of Object.entries(g.agents)) {
      for (const slug of [...node.always, ...node.available]) {
        expect(g.skills[slug], `${agent} -> ${slug}`).toBeDefined()
      }
    }
    for (const [slug, node] of Object.entries(g.skills)) {
      for (const tool of node.tools) {
        expect(g.tools[tool], `${slug} -> ${tool}`).toBeDefined()
      }
      // The dropped affordances must not reappear from anywhere.
      const raw = node as unknown as Record<string, unknown>
      expect(raw.tier).toBeUndefined()
      expect(raw.depends_on).toBeUndefined()
    }
  })
})
