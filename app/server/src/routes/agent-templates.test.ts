/**
 * Route + service tests for agent templates (obj 719986): gallery, install a
 * starter, import (upload + path, with the path allowlist), export, the
 * worker-prompt hook, the internal script surface and the installer switch.
 * Real sqlite + a temp ai-workspace; nothing touches the operator's files.
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
const TMP_DB = path.join(os.tmpdir(), `cc-agenttpl-test-${STAMP}.db`)
const TMP_WS = path.join(os.tmpdir(), `cc-agenttpl-ws-${STAMP}`)
const OUTSIDE = path.join(os.tmpdir(), `cc-agenttpl-outside-${STAMP}`)
fs.mkdirSync(path.join(TMP_WS, 'agents'), { recursive: true })
fs.mkdirSync(path.join(TMP_WS, 'agent-imports'), { recursive: true })
fs.mkdirSync(OUTSIDE, { recursive: true })
fs.writeFileSync(path.join(TMP_WS, 'agents', 'cto.md'), '---\nskills: [x]\n---\n# CTO persona\nShip carefully.\n')

process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-agenttpl'
process.env.AI_WORKSPACE_DIR = TMP_WS
delete process.env.AGENT_FILES_DIR
delete process.env.AGENT_TEMPLATES_DIR
delete process.env.INTERNAL_API_SECRET

const { initDb, getDb } = await import('../db/index.js')
const { agentTemplatesRouter, internalAgentTemplatesRouter } = await import('./agent-templates.js')
const { invalidateAgentsCache, getAgent } = await import('../services/agent-registry.js')
const { installStarterTemplatesFromEnv } = await import('../services/agent-templates.js')
const { readAgentInstructions } = await import('../services/prompt-builder-workdir.js')
const { getInternalApiSecret } = await import('../middleware/internal-secret.js')

let server: http.Server
let baseUrl: string
let cookie: string

const UPLOAD = `name: Sample helper
slug: sample-helper
description: Answers questions about the sample company.
colour: pink
version: 1.0.0
author: Example Consulting
tools: [search, read_file]
knowledge_folders: [clients/example-co]
system_prompt: |
  You help the Example Co team.
`

async function call(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any; text: string; headers: Headers }> {
  const res = await fetch(`${baseUrl}${url}`, {
    method,
    headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let parsed: any = null
  try { parsed = JSON.parse(text) } catch { /* yaml */ }
  return { status: res.status, body: parsed, text, headers: res.headers }
}

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  invalidateAgentsCache()
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/agent-templates', agentTemplatesRouter)
  app.use('/api/internal/agent-templates', internalAgentTemplatesRouter)
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()) })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no address')
  baseUrl = `http://127.0.0.1:${addr.port}`
  cookie = `token=${jwt.sign({ id: 1, username: 'tester', role: 'admin' }, process.env.JWT_SECRET as string, { expiresIn: '1h' })}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  try { getDb().close() } catch { /* closed */ }
  for (const s of ['', '-wal', '-shm']) if (fs.existsSync(`${TMP_DB}${s}`)) fs.unlinkSync(`${TMP_DB}${s}`)
  fs.rmSync(TMP_WS, { recursive: true, force: true })
  fs.rmSync(OUTSIDE, { recursive: true, force: true })
})

describe('admin gallery', () => {
  it('requires an admin', async () => {
    const member = `token=${jwt.sign({ id: 2, username: 'm', role: 'member' }, process.env.JWT_SECRET as string)}`
    const r = await call('GET', '/api/agent-templates', undefined, { cookie: member })
    expect(r.status).toBe(403)
  })

  it('lists the three starters as available, not installed', async () => {
    const r = await call('GET', '/api/agent-templates')
    expect(r.status).toBe(200)
    const slugs = r.body.templates.map((t: any) => t.slug).sort()
    expect(slugs).toEqual(['knowledge-librarian', 'operator', 'personal-assistant'])
    expect(r.body.templates.every((t: any) => t.source === 'starter' && !t.installed)).toBe(true)
    expect(r.body.problems).toEqual([])
  })
})

describe('install a starter template', () => {
  it('writes the file, registers the agent and adds a switched-off routine', async () => {
    const r = await call('POST', '/api/agent-templates/templates/personal-assistant/install', {})
    expect(r.status).toBe(201)
    expect(r.body.action).toBe('created')
    expect(fs.existsSync(path.join(TMP_WS, 'agents', 'personal-assistant', 'agent.yaml'))).toBe(true)
    const reg = getAgent('personal-assistant')
    expect(reg).toMatchObject({ label: 'Personal assistant', mono: 'PA', badge_tw: 'bg-agent-coo' })
    const routine = getDb().prepare("SELECT * FROM routines WHERE name = 'agent:personal-assistant:Morning briefing'").get() as any
    expect(routine.enabled).toBe(0)
    expect(routine.cron_expr).toBe('30 7 * * 1-5')
    expect(JSON.parse(routine.objective_template).agent_context).toBe('personal-assistant')

    const g = await call('GET', '/api/agent-templates')
    const t = g.body.templates.find((x: any) => x.slug === 'personal-assistant')
    expect(t).toMatchObject({ installed: true, installed_version: '1.0.0', update_available: false })
    expect(g.body.installed.find((x: any) => x.slug === 'personal-assistant')).toMatchObject({ origin: 'template', has_file: true, author: 'Operation Kit' })
  })

  it('refuses a second install without overwrite, allows it with overwrite', async () => {
    const again = await call('POST', '/api/agent-templates/templates/personal-assistant/install', {})
    expect(again.status).toBe(409)
    const replace = await call('POST', '/api/agent-templates/templates/personal-assistant/install', { overwrite: true })
    expect(replace.status).toBe(201)
    expect(replace.body.action).toBe('updated')
  })

  it('the worker prompt now comes from the agent file', () => {
    const s = readAgentInstructions('personal-assistant')
    expect(s).toContain('# Personal assistant')
    expect(s).toContain('drafts only')
    expect(s).toContain('- personal/todos')
  })

  it('404s an unknown template', async () => {
    expect((await call('POST', '/api/agent-templates/templates/nope/install', {})).status).toBe(404)
  })
})

describe('import', () => {
  it('validates without installing', async () => {
    const r = await call('POST', '/api/agent-templates/validate', { content: 'slug: x\n', filename: 'x.yaml' })
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(false)
    expect(r.body.errors.map((e: any) => e.field)).toEqual(expect.arrayContaining(['name', 'slug', 'system_prompt']))
    expect(getAgent('x')).toBeUndefined()
  })

  it('an invalid upload changes nothing and returns field errors', async () => {
    const r = await call('POST', '/api/agent-templates/import', { content: 'name: Broken\nslug: broken-one\n', filename: 'broken.yaml' })
    expect(r.status).toBe(400)
    expect(r.body.errors[0]).toMatchObject({ field: 'system_prompt' })
    expect(getAgent('broken-one')).toBeUndefined()
    expect(fs.existsSync(path.join(TMP_WS, 'agents', 'broken-one'))).toBe(false)
  })

  it('imports an uploaded file', async () => {
    const r = await call('POST', '/api/agent-templates/import', { content: UPLOAD, filename: 'sample-helper.agent.yaml' })
    expect(r.status).toBe(201)
    expect(getAgent('sample-helper')).toMatchObject({ label: 'Sample helper', badge_tw: 'bg-agent-cmo' })
  })

  it('refuses to overwrite an existing non-file agent without consent', async () => {
    const r = await call('POST', '/api/agent-templates/import', { content: UPLOAD.replace('slug: sample-helper', 'slug: cto'), filename: 'cto.yaml' })
    expect(r.status).toBe(409)
  })

  it('imports by path only from the allowed folders', async () => {
    const inside = path.join(TMP_WS, 'agent-imports', 'path-helper', 'agent.yaml')
    fs.mkdirSync(path.dirname(inside), { recursive: true })
    fs.writeFileSync(inside, UPLOAD.replace('slug: sample-helper', 'slug: path-helper'))
    const ok = await call('POST', '/api/agent-templates/import', { path: path.dirname(inside) })
    expect(ok.status).toBe(201)
    expect(ok.body.slug).toBe('path-helper')

    const outside = path.join(OUTSIDE, 'agent.yaml')
    fs.writeFileSync(outside, UPLOAD.replace('slug: sample-helper', 'slug: outside-helper'))
    const denied = await call('POST', '/api/agent-templates/import', { path: outside })
    expect(denied.status).toBe(403)
    const traversal = await call('POST', '/api/agent-templates/import', { path: path.join(TMP_WS, 'agent-imports', '..', '..', path.basename(OUTSIDE), 'agent.yaml') })
    expect(traversal.status).toBe(403)
    expect(getAgent('outside-helper')).toBeUndefined()
  })
})

describe('export', () => {
  it('exports a file-backed agent as a downloadable file that re-imports', async () => {
    const r = await call('GET', '/api/agent-templates/agents/sample-helper/export')
    expect(r.status).toBe(200)
    expect(r.headers.get('content-disposition')).toContain('sample-helper.agent.yaml')
    expect(r.text).toContain('slug: sample-helper')
    expect(r.text).toContain('author: Example Consulting')
    const v = await call('POST', '/api/agent-templates/validate', { content: r.text, filename: 'sample-helper.agent.yaml' })
    expect(v.body.ok).toBe(true)
  })

  it('converts an older registry-only agent (persona .md) into an agent file', async () => {
    const r = await call('GET', '/api/agent-templates/agents/cto/export?format=json')
    expect(r.status).toBe(200)
    expect(r.body.def).toMatchObject({ slug: 'cto', name: 'CTO', colour: 'blue', version: '1.0.0' })
    expect(r.body.def.system_prompt).toBe('# CTO persona\nShip carefully.')
  })

  it('404s an unknown agent', async () => {
    expect((await call('GET', '/api/agent-templates/agents/ghost/export')).status).toBe(404)
  })
})

describe('internal (script) surface', () => {
  it('requires the internal secret', async () => {
    const r = await call('GET', '/api/internal/agent-templates')
    expect(r.status).toBe(401)
  })

  it('install-starters installs the rest and skips what is there', async () => {
    const h = { 'x-internal-secret': getInternalApiSecret() }
    const r = await call('POST', '/api/internal/agent-templates/install-starters', { templates: 'all' }, h)
    expect(r.status).toBe(200)
    const by = Object.fromEntries(r.body.results.map((x: any) => [x.slug, x.status]))
    expect(by).toEqual({ 'knowledge-librarian': 'created', operator: 'created', 'personal-assistant': 'already-installed' })
  })
})

describe('installer switch (STARTER_AGENT_TEMPLATES)', () => {
  it('is a no-op when unset, and never overwrites', () => {
    expect(installStarterTemplatesFromEnv({})).toEqual([])
    expect(installStarterTemplatesFromEnv({ STARTER_AGENT_TEMPLATES: 'all' })).toEqual([])
  })
})
