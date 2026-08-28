import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'http'
import express from 'express'
import agentApiRouter from './agent-api.js'
import { AGENT_OPENAPI } from '../api/agent-openapi.js'

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
  '/api/jarvis/briefing',
  '/api/docs/search',
  '/api/docs/file',
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

  it('matches the in-process spec object', async () => {
    const res = await fetch(`${baseUrl}/api/openapi.json`)
    expect(await res.json()).toEqual(AGENT_OPENAPI)
  })
})
