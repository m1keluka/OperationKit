/**
 * Route tests for GET /api/agents/board-layer and GET /api/agents/layer-file
 * (obj 712124).
 *
 * Real sqlite via initDb() (so `projects` / `objectives` / `agents` are the
 * actual schema, and objective_count is a real GROUP BY), plus:
 *   - a TEMP ~/ai-workspace tree, so on-disk existence is exercised for real
 *     without depending on the operator's live workspace, and
 *   - a STUB layer-graph generator behind LAYER_GRAPH_SCRIPT, the same seam
 *     services/skill-graph.test.ts uses — the route consumes the real
 *     skill-graph service, only its generator is stubbed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

const STAMP = `${process.pid}-${Date.now()}`
const TMP_DB = path.join(os.tmpdir(), `cc-boardlayer-test-${STAMP}.db`)
const TMP_WS = path.join(os.tmpdir(), `cc-boardlayer-ws-${STAMP}`)

// ── a minimal ~/ai-workspace ──────────────────────────────────────────────
// Present: agents/cto.md, skills/devops/SKILL.md, tools/github/TOOL.md,
//          workspaces/example/agent-profiles/cto.md
// Absent (deliberately): agents/acquisition-sites.md  -> persona orphan
//                        skills/ghost-skill/SKILL.md  -> dangling skill edge
//                        overlay for acquisition-sites -> overlay_exists:false
function write(rel: string, body: string): void {
  const abs = path.join(TMP_WS, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, body)
}

write('agents/cto.md', '# CTO persona\n')
write('skills/devops/SKILL.md', '# devops\n')
write('tools/github/TOOL.md', '# github tool\n')
write('workspaces/example/agent-profiles/cto.md', '# example cto overlay\n')
write('skills/registry.json', JSON.stringify({ skills: { devops: { description: 'Ship code' } } }))
write('tools/registry.json', JSON.stringify({ tools: { github: { description: 'GitHub API' } } }))

const STUB_GRAPH = {
  source: 'frontmatter-layer-graph',
  generated_at: '2026-09-21T00:00:00Z',
  counts: {
    agents: 2, skills: 1, skills_top_level: 1, subskills: 0,
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
    },
  },
  tools: { github: { skills: ['devops'] } },
  orphans: { tools: [], skills: [] },
}
// The stub reads the payload from a sibling .json file rather than inlining it:
// JSON literals are not Python literals (`null`/`true` would be a NameError).
const STUB_JSON = path.join(TMP_WS, 'stub-layer-graph.json')
fs.writeFileSync(STUB_JSON, JSON.stringify(STUB_GRAPH))
const STUB_SCRIPT = path.join(TMP_WS, 'stub-layer-graph.py')
fs.writeFileSync(STUB_SCRIPT, `import sys\nsys.stdout.write(open(${JSON.stringify(STUB_JSON)}).read())\n`)

process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-boardlayer'
process.env.AI_WORKSPACE_DIR = TMP_WS
process.env.LAYER_GRAPH_SCRIPT = STUB_SCRIPT

const { initDb, getDb } = await import('../db/index.js')
const { default: agentsRouter } = await import('./agents.js')
const { invalidateAgentsCache } = await import('../services/agent-registry.js')
const { clearSkillGraphCache } = await import('../services/skill-graph.js')

let server: http.Server
let baseUrl: string
let cookie: string

function token(): string {
  return jwt.sign({ id: 1, username: 'tester', role: 'admin' }, process.env.JWT_SECRET as string, { expiresIn: '1h' })
}

async function get(url: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${url}`, { headers: { cookie } })
  return { status: res.status, body: await res.json().catch(() => null) }
}

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  // Two registry agents; `acquisition-sites` has no persona file on the fake disk.
  db.prepare(`INSERT OR REPLACE INTO agents (slug, label, kind, assignable, workdir_kind, sort_order)
              VALUES (?, ?, 'executive', 1, 'workspace', ?)`).run('cto', 'CTO', 1)
  db.prepare(`INSERT OR REPLACE INTO agents (slug, label, kind, assignable, workdir_kind, sort_order)
              VALUES (?, ?, 'executive', 1, 'workspace', ?)`).run('acquisition-sites', 'Acquisition Sites', 2)
  invalidateAgentsCache()

  db.prepare("INSERT INTO projects (id, workspace, name) VALUES (16, 'example', 'Acquisition Sites')").run()
  db.prepare("INSERT INTO projects (id, workspace, name) VALUES (14, 'example', 'Platform')").run()
  const ins = db.prepare(
    "INSERT INTO objectives (title, workspace, agent_context, project_id) VALUES (?, 'example', ?, ?)",
  )
  for (let i = 0; i < 3; i++) ins.run(`cto obj ${i}`, 'cto', 16)
  ins.run('acq obj', 'acquisition-sites', 16)
  // Noise that must NOT be counted into project 16.
  ins.run('other project', 'cto', 14)

  clearSkillGraphCache()

  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/agents', agentsRouter)
  await new Promise<void>(resolve => { server = app.listen(0, () => resolve()) })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('server has no address')
  baseUrl = `http://127.0.0.1:${addr.port}`
  cookie = `token=${token()}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  try { getDb().close() } catch { /* already closed */ }
  for (const suffix of ['', '-wal', '-shm']) {
    const f = `${TMP_DB}${suffix}`
    if (fs.existsSync(f)) fs.unlinkSync(f)
  }
  fs.rmSync(TMP_WS, { recursive: true, force: true })
})

describe('GET /api/agents/board-layer', () => {
  it('requires auth', async () => {
    const res = await fetch(`${baseUrl}/api/agents/board-layer?project_id=16`)
    expect(res.status).toBe(401)
  })

  it('returns the documented shape for a project scope', async () => {
    const { status, body } = await get('/api/agents/board-layer?project_id=16')
    expect(status).toBe(200)
    expect(Object.keys(body).sort()).toEqual(['agents', 'orphans', 'scope', 'skills', 'tools'])
    expect(body.scope).toEqual({ project_id: 16, project_name: 'Acquisition Sites', workspace: 'example' })
    expect(Object.keys(body.orphans).sort())
      .toEqual(['agents_without_persona', 'skills_declared_missing', 'tools_declared_missing'])
    expect(Object.keys(body.agents[0]).sort()).toEqual([
      'assignable', 'kind', 'label', 'missing_skills', 'objective_count',
      'overlay_exists', 'overlay_file', 'persona_exists', 'persona_file',
      'skills_always', 'skills_available', 'slug',
    ])
    expect(Object.keys(body.skills[0]).sort()).toEqual([
      'description', 'exists', 'file', 'parent', 'slug', 'subskills',
      'tools', 'used_by_always', 'used_by_available',
    ])
    expect(Object.keys(body.tools[0]).sort())
      .toEqual(['description', 'exists', 'file', 'slug', 'used_by_skills'])
  })

  it('lists both board agents with objective_count from the objectives table', async () => {
    const { body } = await get('/api/agents/board-layer?project_id=16')
    const bySlug = Object.fromEntries(body.agents.map((a: any) => [a.slug, a]))
    expect(Object.keys(bySlug).sort()).toEqual(['acquisition-sites', 'cto'])
    // 3 on project 16; the 4th cto objective lives on project 14 and must not count.
    expect(bySlug.cto.objective_count).toBe(3)
    expect(bySlug.cto.label).toBe('CTO')
    expect(bySlug['acquisition-sites'].objective_count).toBe(1)
  })

  it('reports a missing overlay and a missing persona without 500ing', async () => {
    const { status, body } = await get('/api/agents/board-layer?project_id=16')
    expect(status).toBe(200)
    const bySlug = Object.fromEntries(body.agents.map((a: any) => [a.slug, a]))
    expect(bySlug.cto.overlay_exists).toBe(true)
    expect(bySlug.cto.persona_exists).toBe(true)
    expect(bySlug['acquisition-sites'].overlay_exists).toBe(false)
    expect(bySlug['acquisition-sites'].overlay_file)
      .toBe(path.join(TMP_WS, 'workspaces/example/agent-profiles/acquisition-sites.md'))
    expect(bySlug['acquisition-sites'].persona_exists).toBe(false)
    expect(bySlug['acquisition-sites'].persona_file).toBeNull()
    expect(body.orphans.agents_without_persona).toEqual(['acquisition-sites'])
  })

  it('keeps the dangling declared skill edge with exists:false and in orphans', async () => {
    const { body } = await get('/api/agents/board-layer?project_id=16')
    const ghost = body.skills.find((s: any) => s.slug === 'ghost-skill')
    expect(ghost).toBeDefined()
    expect(ghost.exists).toBe(false)
    expect(ghost.file).toBeNull()
    expect(ghost.used_by_always).toEqual(['cto'])
    expect(body.orphans.skills_declared_missing).toEqual(['ghost-skill'])
  })

  it('workspace scope with no project_id unions in the registry roster', async () => {
    const { status, body } = await get('/api/agents/board-layer?workspace=example')
    expect(status).toBe(200)
    expect(body.scope).toEqual({ project_id: null, project_name: null, workspace: 'example' })
    const slugs = body.agents.map((a: any) => a.slug)
    expect(slugs).toEqual(Array.from(slugs).sort())
    expect(slugs).toContain('cto')
    expect(slugs).toContain('acquisition-sites')
    // Seeded registry rows with zero objectives are present at workspace scope.
    expect(slugs).toContain('cfo')
    expect(body.agents.find((a: any) => a.slug === 'cfo').objective_count).toBe(0)
    // 4 cto objectives in the workspace across both projects.
    expect(body.agents.find((a: any) => a.slug === 'cto').objective_count).toBe(4)
  })

  it('400s with neither project_id nor workspace, 404s on an unknown project', async () => {
    expect((await get('/api/agents/board-layer')).status).toBe(400)
    expect((await get('/api/agents/board-layer?project_id=abc')).status).toBe(400)
    expect((await get('/api/agents/board-layer?project_id=999999')).status).toBe(404)
  })
})

describe('GET /api/agents/layer-file', () => {
  it('serves an agent persona, a skill and a tool from the three roots', async () => {
    const agent = await get('/api/agents/layer-file?kind=agent&slug=cto')
    expect(agent.status).toBe(200)
    expect(agent.body).toMatchObject({
      path: path.join(TMP_WS, 'agents/cto.md'),
      kind: 'agent', slug: 'cto', content: '# CTO persona\n', exists: true,
    })
    expect(agent.body.bytes).toBe(14)

    const skill = await get('/api/agents/layer-file?kind=skill&slug=devops')
    expect(skill.status).toBe(200)
    expect(skill.body.content).toBe('# devops\n')

    // tools/ is NOT in any workspace doc_read_roots; this route reaches it anyway.
    const tool = await get('/api/agents/layer-file?kind=tool&slug=github')
    expect(tool.status).toBe(200)
    expect(tool.body.path).toBe(path.join(TMP_WS, 'tools/github/TOOL.md'))
    expect(tool.body.content).toBe('# github tool\n')

    const overlay = await get('/api/agents/layer-file?kind=overlay&slug=cto&workspace=example')
    expect(overlay.status).toBe(200)
    expect(overlay.body.content).toBe('# example cto overlay\n')
  })

  it('reports a missing file as exists:false rather than 500ing', async () => {
    const { status, body } = await get('/api/agents/layer-file?kind=overlay&slug=acquisition-sites&workspace=example')
    expect(status).toBe(200)
    expect(body.exists).toBe(false)
    expect(body.content).toBe('')
    expect(body.bytes).toBe(0)
  })

  it('rejects a .. traversal slug with 400 and does not serve the file', async () => {
    const res = await get(`/api/agents/layer-file?kind=agent&slug=${encodeURIComponent('../../../../etc/passwd')}`)
    expect(res.status).toBe(400)
    expect(JSON.stringify(res.body)).not.toContain('root:')
    expect(res.body.error).toMatch(/traverse/)
    const asSkill = await get(`/api/agents/layer-file?kind=skill&slug=${encodeURIComponent('../../../../etc')}`)
    expect(asSkill.status).toBe(400)
    // and the file is genuinely not reachable by any encoding of it
    expect((await get(`/api/agents/layer-file?kind=skill&slug=${encodeURIComponent('devops/../../../etc')}`)).status).toBe(400)
  })

  it('rejects an absolute path slug with 400', async () => {
    const res = await get(`/api/agents/layer-file?kind=agent&slug=${encodeURIComponent('/etc/passwd')}`)
    expect(res.status).toBe(400)
    expect(JSON.stringify(res.body)).not.toContain('root:')
    const asTool = await get(`/api/agents/layer-file?kind=tool&slug=${encodeURIComponent('/etc')}`)
    expect(asTool.status).toBe(400)
  })

  it('rejects an unknown kind', async () => {
    expect((await get('/api/agents/layer-file?kind=passwd&slug=cto')).status).toBe(400)
  })
})
