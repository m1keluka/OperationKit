import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'http'
import express from 'express'
import { CONTENT_SECURITY_POLICY, DESIGN_FRAME_CSP, securityHeaders } from './security-headers.js'

let server!: http.Server
let baseUrl!: string

beforeAll(async () => {
  const app = express()
  app.disable('x-powered-by')
  app.use(securityHeaders)
  app.get('/ping', (_req, res) => { res.json({ ok: true }) })
  app.get('/api/objectives/:id/design-frame', (_req, res) => { res.send('<html></html>') })
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

describe('securityHeaders', () => {
  it('sets the baseline headers and hides X-Powered-By', async () => {
    const res = await fetch(`${baseUrl}/ping`)
    expect(res.status).toBe(200)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin')
    expect(res.headers.get('permissions-policy')).toBe('camera=(), microphone=(), geolocation=()')
    expect(res.headers.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY)
    expect(res.headers.get('x-powered-by')).toBeNull()
    expect(CONTENT_SECURITY_POLICY).toContain("script-src 'self'")
    expect(CONTENT_SECURITY_POLICY).toContain("frame-src 'self' https:")
    expect(CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'")
  })

  it('relaxes CSP and omits X-Frame-Options on the design-frame proxy', async () => {
    const res = await fetch(`${baseUrl}/api/objectives/12/design-frame`)
    expect(res.status).toBe(200)
    expect(res.headers.get('x-frame-options')).toBeNull()
    expect(res.headers.get('content-security-policy')).toBe(DESIGN_FRAME_CSP)
    expect(DESIGN_FRAME_CSP).toContain("style-src 'unsafe-inline' https:")
    expect(DESIGN_FRAME_CSP).toContain("script-src 'unsafe-inline'")
    expect(DESIGN_FRAME_CSP).not.toContain("script-src 'unsafe-inline' https:")
    expect(DESIGN_FRAME_CSP).toContain("base-uri https: 'self'")
    expect(DESIGN_FRAME_CSP).toContain("frame-ancestors 'self'")
  })
})
