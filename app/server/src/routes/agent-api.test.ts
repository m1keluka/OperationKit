import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'http'
import express from 'express'
import agentApiRouter from './agent-api.js'
import { AGENT_OPENAPI } from '../api/agent-openapi.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

let server: http.Server
let baseUrl: string

beforeAll(async () => {
  const app = express()
  app.use('/api', agentApiRouter)
  await new Promise<void>(resolve => {
    server = app.listen(0, '127.0.0.1', () => resolve())
  })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no address')
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
})

const AGENT_PATHS = [
  '/api/health',
  '/api/agent',
  '/api/openapi.json',
  '/api/auth/token',
  '/api/auth/api-key',
  '/api/auth/me',
  '/api/auth/agent-keys',
  '/api/auth/agent-keys/{id}',
  '/api/workspaces',
  '/api/models',
  '/api/objectives',
  '/api/objectives/search',
  '/api/objectives/strategies',
  '/api/objectives/{id}',
  '/api/objectives/{id}/status',
  '/api/objectives/{id}/message',
  '/api/objectives/{id}/output',
  '/api/objectives/{id}/timeline',
  '/api/objectives/{id}/stop',
  '/api/objectives/{id}/progress',
  '/api/objectives/{id}/artifacts',
  '/api/objectives/{id}/artifacts/file',
  '/api/briefing/briefing',
  '/api/docs/search',
  '/api/docs/file',
  '/api/files/search',
  '/api/files/stat',
  '/api/files/download',
  '/api/secrets-broker/list',
  '/api/secrets-broker/http',
  // Control layer + MCP (obj 714091/714092, reconciled obj 714100)
  '/api/agent/changes',
  '/api/agent/attention',
  '/api/mcp',
]

describe('GET /api/agent', () => {
  it('describes how to auth without requiring a token', async () => {
    const res = await fetch(`${baseUrl}/api/agent`)
    expect(res.status).toBe(200)
    const body = await res.json() as { name: string; spec: string; auth: { obtain: string } }
    expect(body.name).toMatch(/Command Center/)
    expect(body.spec).toBe('/api/openapi.json')
    expect(body.auth.obtain).toMatch(/API key|api-key/)
  })
})

describe('GET /api/openapi.json', () => {
  it('serves OpenAPI 3.1 covering the agent PM surface', async () => {
    const res = await fetch(`${baseUrl}/api/openapi.json`)
    expect(res.status).toBe(200)
    const spec = await res.json() as { openapi: string; paths: Record<string, unknown> }
    expect(spec.openapi).toBe('3.1.0')
    for (const p of AGENT_PATHS) {
      expect(spec.paths, `missing ${p}`).toHaveProperty(p)
    }
    expect(spec.paths).not.toHaveProperty('/api/admin')
    expect(spec.paths).not.toHaveProperty('/api/internal/deploy')
    expect(spec.paths).not.toHaveProperty('/api/secrets')
  })

  // obj 900293: owner_bot must be discoverable from the served spec, not just
  // a component nobody references — create, update AND every read response.
  it('exposes owner_bot on objective create/update requests and read/write responses', async () => {
    const spec = await (await fetch(`${baseUrl}/api/openapi.json`)).json() as Loose
    const schemas = spec.components.schemas
    const ref = (o: Loose) => String(o?.content?.['application/json']?.schema?.$ref ?? o?.content?.['application/json']?.schema?.items?.$ref ?? '')
    const list = spec.paths['/api/objectives']
    const one = spec.paths['/api/objectives/{id}']
    // Requests: POST and PUT both carry owner_bot.
    expect(ref(list.post.requestBody)).toBe('#/components/schemas/CreateObjectiveRequest')
    expect(ref(one.put.requestBody)).toBe('#/components/schemas/CreateObjectiveRequest')
    const req = schemas.CreateObjectiveRequest.properties.owner_bot
    expect(req.type).toEqual(['string', 'null'])
    expect(req.maxLength).toBe(64)
    expect(req.description).toMatch(/set to your own exact Grok bot name/i)
    expect(req.description).toMatch(/General/)
    expect(schemas.CreateObjectiveRequest.required).not.toContain('owner_bot')
    // Responses: list GET, POST 201, GET /:id and PUT 200 all resolve to Objective, which has owner_bot.
    expect(ref(list.get.responses['200'])).toBe('#/components/schemas/Objective')
    expect(ref(list.post.responses['201'])).toBe('#/components/schemas/Objective')
    expect(ref(one.get.responses['200'])).toBe('#/components/schemas/Objective')
    expect(ref(one.put.responses['200'])).toBe('#/components/schemas/Objective')
    const res = schemas.Objective.properties.owner_bot
    expect(res.type).toEqual(['string', 'null'])
    expect(res.description).toMatch(/null = unowned/)
    expect(res.description).toMatch(/General/)
  })

  it('matches the in-process spec object', async () => {
    const res = await fetch(`${baseUrl}/api/openapi.json`)
    expect(await res.json()).toEqual(AGENT_OPENAPI)
  })
})
