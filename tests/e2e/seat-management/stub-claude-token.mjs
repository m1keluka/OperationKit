#!/usr/bin/env node
// Stub of Claude's OAuth token endpoint for the seat-management E2E (obj 720330).
// The scratch server is pointed here with CC_CLAUDE_OAUTH_TOKEN_URL, which the
// server honours ONLY on a scratch instance and ONLY for a loopback URL
// (claude-oauth-login.ts claudeTokenUrl).
//
//   POST /v1/oauth/token  {grant_type, code, code_verifier, state, client_id, ...}
//     code "bad-code"     → 400 invalid_grant (Claude rejects the code)
//     code "expired-…"    → a token the fake `claude` probe reports as expired
//     anything else       → 200 { access_token: "sk-ant-oat01-e2e-<n>-…", expires_in }
//   GET /__calls          → how many exchanges happened, and whether each carried a verifier
import http from 'node:http'

const port = Number(process.env.STUB_PORT || 4555)
const calls = []
http.createServer((req, res) => {
  const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
  if (req.method === 'GET' && req.url === '/__calls') return send(200, { count: calls.length, calls })
  if (req.method !== 'POST' || req.url !== '/v1/oauth/token') return send(404, { error: 'not_found' })
  let raw = ''
  req.on('data', d => { raw += d })
  req.on('end', () => {
    let body = {}
    try { body = JSON.parse(raw) } catch { return send(400, { error: 'invalid_request' }) }
    const ok = body.grant_type === 'authorization_code' && typeof body.code_verifier === 'string' && body.code_verifier.length >= 43 && typeof body.state === 'string'
    calls.push({ at: new Date().toISOString(), code: String(body.code).slice(0, 12), hasVerifier: typeof body.code_verifier === 'string', ok })
    if (!ok) return send(400, { error: 'invalid_request', error_description: 'missing PKCE verifier or state' })
    if (body.code === 'bad-code') return send(400, { error: 'invalid_grant', error_description: 'Invalid authorization code' })
    const n = calls.length
    const prefix = String(body.code).startsWith('expired-') ? 'sk-ant-oat01-e2e-expired' : 'sk-ant-oat01-e2e'
    send(200, { access_token: `${prefix}-${n}-${'x'.repeat(40)}${String(1000 + n)}`, token_type: 'bearer', expires_in: 31536000, scope: 'user:inference' })
  })
}).listen(port, '127.0.0.1', () => console.log(`[stub-claude-token] listening on http://127.0.0.1:${port}`))
