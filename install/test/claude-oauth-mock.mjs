// Fake Claude OAuth token endpoint for install/test/claude-oauth-mock-test.sh.
// POST /v1/oauth/token → reply chosen by the code: "good" → a fake subscription
// token, "apikey" → an API key (must be refused), anything else → 400.
// GET /__last → the last request body (so the test can check the verifier).
import http from 'node:http'
let last = null
http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/__last') {
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(last)); return
  }
  let body = ''
  req.on('data', d => { body += d })
  req.on('end', () => {
    try { last = JSON.parse(body) } catch { last = { unparsable: body } }
    const reply = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)) }
    if (last.code === 'good') return reply(200, { access_token: 'sk-ant-oat01-fake-mock-token-0000', expires_in: 31536000 })
    if (last.code === 'apikey') return reply(200, { access_token: 'sk-ant-api03-fake-metered-key' })
    return reply(400, { error: 'invalid_grant', error_description: 'Invalid authorization code' })
  })
}).listen(Number(process.env.PORT), '127.0.0.1')
