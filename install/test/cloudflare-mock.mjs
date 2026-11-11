// Minimal in-memory stand-in for the Cloudflare v4 API endpoints install/cloudflare.sh
// calls. Used only by install/test/cloudflare-mock-test.sh. Records every request.
import http from 'node:http'
import { randomUUID } from 'node:crypto'

const TOKEN = process.env.MOCK_CF_TOKEN || 'mock-token'
const state = {
  zones: [{ id: 'zone1', name: 'example-capital.com', account: { id: 'acct1' } }],
  tunnels: [], dns: [], apps: [], policies: {}, idps: [], svc: [], rulesets: [],
  org: process.env.MOCK_NO_ORG ? null : { auth_domain: 'example-capital.cloudflareaccess.com' },
  configs: {}, calls: [],
}
const ok = (res, result) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ success: true, errors: [], result })) }
const bad = (res, code, message) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify({ success: false, errors: [{ code, message }] })) }
const err = (res, status, code, message) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ success: false, errors: [{ code, message }] })) }

// Cloudflare refuses an Access app whose destination already belongs to a
// different application on the same hostname (obj 900069). Reproducing it here
// is the point: without the skip in install/cloudflare.sh the step dies.
const takenDestination = (json, selfId) => {
  const want = new Set((json.destinations || []).map(d => d.uri))
  for (const a of state.apps) {
    if (a.id === selfId) continue
    for (const d of a.destinations || []) if (want.has(d.uri)) return d.uri
  }
  return null
}

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
    if (p === '/accounts/acct1/access/organizations') {
      // A token without the Access "Organizations" permission (obj 720210).
      if (process.env.MOCK_NO_ORG_SCOPE) { res.writeHead(403, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] })) }
      return state.org ? ok(res, state.org) : bad(res, 404, 'zero trust not enabled')
    }
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
      // Cloudflare generates the AUD tag on create and keeps it across updates.
      if (m === 'POST') {
        const taken = takenDestination(json, null)
        if (taken) return err(res, 409, 12132, `The destination ${taken} belongs to another application`)
        const a = { id: randomUUID(), aud: randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''), ...json }; state.apps.push(a); return ok(res, a)
      }
      const i = state.apps.findIndex(a => a.id === appId)
      if (m === 'GET') return i >= 0 ? ok(res, state.apps[i]) : bad(res, 404, 'no such app')
      if (m === 'PUT') {
        const taken = takenDestination(json, appId)
        if (taken) return err(res, 409, 12132, `The destination ${taken} belongs to another application`)
        state.apps[i] = { id: appId, aud: state.apps[i].aud, ...json }; return ok(res, state.apps[i])
      }
      if (m === 'DELETE') { state.apps.splice(i, 1); delete state.policies[appId]; return ok(res, {}) }
    }
    // ── Rulesets (Configuration Rules; obj 900259) ──────────────────────────
    // Enough of the Ruleset Engine for install/cloudflare.sh's api-bic step:
    // the zone's http_config_settings phase entry point, plus the per-rule
    // add / update / delete endpoints it uses so unrelated rules are never
    // rewritten. Two failure modes are reproducible on demand, because the
    // script promises a different, actionable message for each.
    if (p.startsWith('/zones/zone1/rulesets')) {
      if (process.env.MOCK_NO_CONFIG_RULES_PERM) return err(res, 403, 10000, 'Authentication error')
      const phase = (ph) => state.rulesets.find(r => r.phase === ph)
      if ((mm = p.match(/^\/zones\/zone1\/rulesets\/phases\/([^/]+)\/entrypoint$/))) {
        const existing = phase(mm[1])
        if (m === 'GET') return existing ? ok(res, existing) : err(res, 404, 1001, 'could not find a ruleset: ruleset not found')
        // Some accounts refuse the entry-point PUT; install/cloudflare.sh then
        // falls back to an explicit "create a zone ruleset" POST.
        if (m === 'PUT' && process.env.MOCK_NO_PUT_ENTRYPOINT && !existing) return err(res, 400, 10021, 'cannot create ruleset through this endpoint')
        if (m === 'PUT') {
          const rs = existing || { id: randomUUID(), phase: mm[1], kind: 'zone', rules: [] }
          rs.name = json.name || rs.name
          rs.rules = (json.rules || []).map(r => ({ id: randomUUID(), version: '1', ...r }))
          if (!existing) state.rulesets.push(rs)
          return ok(res, rs)
        }
      }
      if (p === '/zones/zone1/rulesets' && m === 'POST') {
        const rs = { id: randomUUID(), phase: json.phase, kind: json.kind, name: json.name,
                     rules: (json.rules || []).map(r => ({ id: randomUUID(), version: '1', ...r })) }
        state.rulesets.push(rs); return ok(res, rs)
      }
      if ((mm = p.match(/^\/zones\/zone1\/rulesets\/([^/]+)\/rules(?:\/([^/]+))?$/))) {
        const rs = state.rulesets.find(r => r.id === mm[1])
        if (!rs) return bad(res, 404, 'no such ruleset')
        if (m === 'POST') {
          if (process.env.MOCK_CONFIG_RULES_PLAN_LIMIT) return err(res, 400, 20062, 'rules quota exceeded: your plan does not allow more rules')
          rs.rules.push({ id: randomUUID(), version: '1', ...json }); return ok(res, rs)
        }
        const i = rs.rules.findIndex(r => r.id === mm[2])
        if (i < 0) return bad(res, 404, 'no such rule')
        if (m === 'PATCH') { rs.rules[i] = { ...rs.rules[i], ...json }; return ok(res, rs) }
        if (m === 'DELETE') { rs.rules.splice(i, 1); return ok(res, rs) }
      }
    }
    bad(res, 404, `mock: unhandled ${m} ${p}`)
  })
}).listen(Number(process.env.PORT || 8788), '127.0.0.1', () => console.log('mock cloudflare listening'))
