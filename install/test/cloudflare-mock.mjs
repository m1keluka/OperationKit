// Minimal in-memory stand-in for the Cloudflare v4 API endpoints install/cloudflare.sh
// calls. Used only by install/test/cloudflare-mock-test.sh. Records every request.
import http from 'node:http'
import { randomUUID } from 'node:crypto'

const TOKEN = process.env.MOCK_CF_TOKEN || 'mock-token'
const state = {
  zones: [{ id: 'zone1', name: 'example-capital.com', account: { id: 'acct1' } }],
  tunnels: [], dns: [], apps: [], policies: {}, idps: [], svc: [],
  org: process.env.MOCK_NO_ORG ? null : { auth_domain: 'example-capital.cloudflareaccess.com' },
  configs: {}, calls: [],
}
const ok = (res, result) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ success: true, errors: [], result })) }
const bad = (res, code, message) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify({ success: false, errors: [{ code, message }] })) }

http.createServer((req, res) => {
  let body = ''
  req.on('data', c => { body += c })
  req.on('end', () => {
    const url = new URL(req.url, 'http://x')
    const p = url.pathname.replace(/^\/client\/v4/, '')
    const m = req.method
    if (p === '/__state') return ok(res, state)
    state.calls.push(`${m} ${p}`)
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return bad(res, 401, 'bad token')
    const json = body ? JSON.parse(body) : {}
    let mm
    if (m === 'GET' && p === '/zones') return ok(res, state.zones.filter(z => z.name === url.searchParams.get('name')))
    if ((mm = p.match(/^\/accounts\/acct1\/cfd_tunnel$/))) {
      if (m === 'GET') return ok(res, state.tunnels.filter(t => t.name === url.searchParams.get('name') && !t.deleted))
      const t = { id: randomUUID(), name: json.name, connections: [] }; state.tunnels.push(t); return ok(res, t)
    }
    if ((mm = p.match(/^\/accounts\/acct1\/cfd_tunnel\/([^/]+)(\/.*)?$/))) {
      const t = state.tunnels.find(x => x.id === mm[1] && !x.deleted); if (!t) return bad(res, 404, 'no tunnel')
      if (mm[2] === '/configurations' && m === 'PUT') { state.configs[t.id] = json.config; return ok(res, {}) }
      if (mm[2] === '/token') return ok(res, `mock-tunnel-token-${t.id}`)
      if (mm[2] === '/connections' && m === 'DELETE') return ok(res, {})
      if (!mm[2] && m === 'GET') return ok(res, t)
      if (!mm[2] && m === 'DELETE') { t.deleted = true; return ok(res, t) }
    }
    if ((mm = p.match(/^\/zones\/zone1\/dns_records(?:\/([^/]+))?$/))) {
      if (m === 'GET') return ok(res, state.dns.filter(r => r.name === url.searchParams.get('name')))
      if (m === 'POST') { const r = { id: randomUUID(), ...json }; state.dns.push(r); return ok(res, r) }
      const i = state.dns.findIndex(r => r.id === mm[1]); if (i < 0) return bad(res, 404, 'no record')
      if (m === 'PUT') { state.dns[i] = { id: mm[1], ...json }; return ok(res, state.dns[i]) }
      if (m === 'DELETE') { state.dns.splice(i, 1); return ok(res, {}) }
    }
    if (p === '/accounts/acct1/access/organizations') return state.org ? ok(res, state.org) : bad(res, 404, 'zero trust not enabled')
    if (p === '/accounts/acct1/access/identity_providers') {
      if (m === 'GET') return ok(res, state.idps)
      const i = { id: randomUUID(), ...json }; state.idps.push(i); return ok(res, i)
    }
    if ((mm = p.match(/^\/accounts\/acct1\/access\/service_tokens(?:\/([^/]+))?$/))) {
      if (m === 'GET') return ok(res, state.svc)
      if (m === 'POST') { const s = { id: randomUUID(), name: json.name, client_id: 'cid.access', client_secret: 'mock-svc-secret' }; state.svc.push(s); return ok(res, s) }
      if (m === 'DELETE') { state.svc = state.svc.filter(s => s.id !== mm[1]); return ok(res, {}) }
    }
    if ((mm = p.match(/^\/accounts\/acct1\/access\/apps(?:\/([^/]+))?(\/policies)?(?:\/([^/]+))?$/))) {
      const [, appId, pol, polId] = mm
      if (pol) {
        const list = (state.policies[appId] ||= [])
        if (m === 'GET') return ok(res, list)
        if (m === 'POST') { const x = { id: randomUUID(), ...json }; list.push(x); return ok(res, x) }
        if (m === 'PUT') { const i = list.findIndex(x => x.id === polId); list[i] = { id: polId, ...json }; return ok(res, list[i]) }
        if (m === 'DELETE') { state.policies[appId] = list.filter(x => x.id !== polId); return ok(res, {}) }
      }
      if (m === 'GET' && !appId) return ok(res, state.apps)
      if (m === 'POST') { const a = { id: randomUUID(), ...json }; state.apps.push(a); return ok(res, a) }
      const i = state.apps.findIndex(a => a.id === appId)
      if (m === 'PUT') { state.apps[i] = { id: appId, ...json }; return ok(res, state.apps[i]) }
      if (m === 'DELETE') { state.apps.splice(i, 1); delete state.policies[appId]; return ok(res, {}) }
    }
    bad(res, 404, `mock: unhandled ${m} ${p}`)
  })
}).listen(Number(process.env.PORT || 8788), '127.0.0.1', () => console.log('mock cloudflare listening'))
