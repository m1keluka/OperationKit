// Fake Claude OAuth token endpoint for install/test/claude-oauth-mock-test.sh.
// POST /v1/oauth/token → reply chosen by the code:
//   "good"      → a fake subscription token, BUT only when the PKCE verifier
//                 matches the challenge registered with POST /__expect (the way
//                 the real endpoint binds a code to its link); else 400
//   "apikey"    → an API key (must be refused)
//   "ratelimit" → 429 JSON      "boom" → 500 JSON
//   "html"      → 403 with a web page (a proxy / bot check, not Claude)
//   anything else → 400 invalid_grant
// POST /__expect {challenge} → set the expected PKCE challenge ("" = don't check)
// GET /__last → the last token request body;  GET /__count → token requests so far.
import http from 'node:http'
import crypto from 'node:crypto'
let last = null
let count = 0
let expect = ''
const b64url = b => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
http.createServer((req, res) => {
  const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)) }
  if (req.method === 'GET' && req.url === '/__last') return json(200, last)
  if (req.method === 'GET' && req.url === '/__count') return json(200, count)
  let body = ''
  req.on('data', d => { body += d })
  req.on('end', () => {
    if (req.url === '/__expect') { expect = JSON.parse(body).challenge || ''; return json(200, { ok: true }) }
    count += 1
    try { last = JSON.parse(body) } catch { last = { unparsable: body } }
    const pkceOk = !expect || b64url(crypto.createHash('sha256').update(String(last.code_verifier)).digest()) === expect
    if (last.code === 'good' && pkceOk) return json(200, { access_token: 'sk-ant-oat01-fake-mock-token-0000', expires_in: 31536000 })
    if (last.code === 'apikey') return json(200, { access_token: 'sk-ant-api03-fake-metered-key' })
    if (last.code === 'ratelimit') return json(429, { error: { type: 'rate_limit_error', message: 'Rate limited' } })
    if (last.code === 'boom') return json(500, { error: 'server_error' })
    if (last.code === 'html') { res.writeHead(403, { 'Content-Type': 'text/html' }); res.end('<html><head><title>Attention Required</title></head><body>blocked</body></html>'); return }
    return json(400, { error: 'invalid_grant', error_description: pkceOk ? 'Invalid authorization code' : 'Invalid code verifier' })
  })
}).listen(Number(process.env.PORT), '127.0.0.1')
