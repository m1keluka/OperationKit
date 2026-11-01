import { describe, it, expect, beforeAll } from 'vitest'
import crypto from 'crypto'
import jwt from 'jsonwebtoken'
import { CfAccessVerifier, cfAccessConfig, getCfAccessVerifier } from './cf-access.js'

const TEAM = 'acme.cloudflareaccess.com'
const AUD = 'aud-tag-0123456789abcdef'
const ISS = `https://${TEAM}`

function rsa() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  return { publicKey, privateKey }
}
let k1: ReturnType<typeof rsa>
let k2: ReturnType<typeof rsa>
let attacker: ReturnType<typeof rsa>
beforeAll(() => { k1 = rsa(); k2 = rsa(); attacker = rsa() })

function jwk(pub: crypto.KeyObject, kid: string) {
  return { ...pub.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }
}

function sign(claims: object, key: crypto.KeyObject, kid: string, opts: jwt.SignOptions = {}) {
  return jwt.sign({ email: 'Alex@Example.com', type: 'app', ...claims }, key, {
    algorithm: 'RS256', keyid: kid, audience: [AUD], issuer: ISS, expiresIn: 600, ...opts,
  })
}

/** A fake certs endpoint whose key set the test can rotate; counts fetches. */
function certsServer(initial: object[]) {
  const state = { keys: initial, calls: 0, fail: false }
  const fetchImpl = async (url: string) => {
    state.calls++
    expect(url).toBe(`https://${TEAM}/cdn-cgi/access/certs`)
    if (state.fail) return { ok: false, status: 503, json: async () => ({}) }
    return { ok: true, status: 200, json: async () => ({ keys: state.keys }) }
  }
  return { state, fetchImpl }
}

function verifier(keys: object[], now = () => Date.now()) {
  const srv = certsServer(keys)
  const cfg = cfAccessConfig({ OK_CF_ACCESS_TEAM: TEAM, OK_CF_ACCESS_AUD: AUD })!
  return { v: new CfAccessVerifier(cfg, srv.fetchImpl, now), srv }
}

describe('cfAccessConfig', () => {
  it('is off when either env var is unset', () => {
    expect(cfAccessConfig({})).toBeNull()
    expect(cfAccessConfig({ OK_CF_ACCESS_TEAM: TEAM })).toBeNull()
    expect(cfAccessConfig({ OK_CF_ACCESS_AUD: AUD })).toBeNull()
    expect(getCfAccessVerifier({})).toBeNull()
  })
  it('accepts a bare team name or the full team domain', () => {
    expect(cfAccessConfig({ OK_CF_ACCESS_TEAM: 'acme', OK_CF_ACCESS_AUD: AUD })?.issuer).toBe(ISS)
    expect(cfAccessConfig({ OK_CF_ACCESS_TEAM: `https://${TEAM}/`, OK_CF_ACCESS_AUD: AUD })?.certsUrl)
      .toBe(`https://${TEAM}/cdn-cgi/access/certs`)
  })
  it('refuses a team value that could point the key fetch somewhere else', () => {
    expect(cfAccessConfig({ OK_CF_ACCESS_TEAM: 'evil.com/x', OK_CF_ACCESS_AUD: AUD })).toBeNull()
    expect(cfAccessConfig({ OK_CF_ACCESS_TEAM: 'a.evil.com', OK_CF_ACCESS_AUD: AUD })).toBeNull()
  })
})

describe('CfAccessVerifier', () => {
  it('accepts a valid token and returns the lower-cased email', async () => {
    const { v } = verifier([jwk(k1.publicKey, 'kid-1')])
    expect(await v.verify(sign({}, k1.privateKey, 'kid-1'))).toEqual({ ok: true, email: 'alex@example.com' })
  })

  it('rejects a bad signature (right kid, wrong private key)', async () => {
    const { v } = verifier([jwk(k1.publicKey, 'kid-1')])
    expect(await v.verify(sign({}, attacker.privateKey, 'kid-1'))).toEqual({ ok: false, reason: 'bad_signature' })
  })

  it('rejects a tampered payload', async () => {
    const { v } = verifier([jwk(k1.publicKey, 'kid-1')])
    const [h, , s] = sign({}, k1.privateKey, 'kid-1').split('.')
    const forged = Buffer.from(JSON.stringify({ email: 'admin@example.com', aud: [AUD], iss: ISS, exp: 9e9 })).toString('base64url')
    expect((await v.verify(`${h}.${forged}.${s}`)).ok).toBe(false)
  })

  it('rejects the wrong AUD', async () => {
    const { v } = verifier([jwk(k1.publicKey, 'kid-1')])
    expect(await v.verify(sign({}, k1.privateKey, 'kid-1', { audience: ['some-other-app'] })))
      .toEqual({ ok: false, reason: 'wrong_audience' })
  })

  it('rejects the wrong issuer (another team)', async () => {
    const { v } = verifier([jwk(k1.publicKey, 'kid-1')])
    expect(await v.verify(sign({}, k1.privateKey, 'kid-1', { issuer: 'https://other.cloudflareaccess.com' })))
      .toEqual({ ok: false, reason: 'wrong_issuer' })
  })

  it('rejects an expired token', async () => {
    const { v } = verifier([jwk(k1.publicKey, 'kid-1')])
    const old = Math.floor(Date.now() / 1000) - 3600
    const token = jwt.sign({ email: 'a@b.co', iat: old, exp: old + 60 }, k1.privateKey, {
      algorithm: 'RS256', keyid: 'kid-1', audience: AUD, issuer: ISS,
    })
    expect(await v.verify(token)).toEqual({ ok: false, reason: 'expired' })
  })

  it('rejects a token with no exp', async () => {
    const { v } = verifier([jwk(k1.publicKey, 'kid-1')])
    const token = jwt.sign({ email: 'a@b.co' }, k1.privateKey, { algorithm: 'RS256', keyid: 'kid-1', audience: AUD, issuer: ISS })
    expect(await v.verify(token)).toEqual({ ok: false, reason: 'expired' })
  })

  it('rejects alg=none and HMAC tokens without fetching keys', async () => {
    const { v, srv } = verifier([jwk(k1.publicKey, 'kid-1')])
    const none = jwt.sign({ email: 'a@b.co', aud: AUD, iss: ISS }, '', { algorithm: 'none' as jwt.Algorithm, keyid: 'kid-1' } as jwt.SignOptions)
    const hs = jwt.sign({ email: 'a@b.co' }, 'secret', { algorithm: 'HS256', keyid: 'kid-1', audience: AUD, issuer: ISS, expiresIn: 60 })
    expect(await v.verify(none)).toEqual({ ok: false, reason: 'malformed' })
    expect(await v.verify(hs)).toEqual({ ok: false, reason: 'malformed' })
    expect(await v.verify('not-a-jwt')).toEqual({ ok: false, reason: 'malformed' })
    expect(await v.verify(undefined)).toEqual({ ok: false, reason: 'malformed' })
    expect(srv.state.calls).toBe(0)
  })

  it('rejects a service token (no email claim)', async () => {
    const { v } = verifier([jwk(k1.publicKey, 'kid-1')])
    const token = jwt.sign({ common_name: 'abc.access', type: 'app' }, k1.privateKey, {
      algorithm: 'RS256', keyid: 'kid-1', audience: [AUD], issuer: ISS, expiresIn: 60,
    })
    expect(await v.verify(token)).toEqual({ ok: false, reason: 'no_email' })
  })

  it('caches keys: many verifications, one fetch', async () => {
    const { v, srv } = verifier([jwk(k1.publicKey, 'kid-1')])
    const token = sign({}, k1.privateKey, 'kid-1')
    await Promise.all([v.verify(token), v.verify(token), v.verify(token)])
    await v.verify(token)
    expect(srv.state.calls).toBe(1)
  })

  it('refreshes on rotation: an unknown kid triggers a refetch (rate-limited)', async () => {
    let t = 1_000_000_000_000
    const { v, srv } = verifier([jwk(k1.publicKey, 'kid-1')], () => t)
    expect((await v.verify(sign({}, k1.privateKey, 'kid-1', { expiresIn: 1e9 }))).ok).toBe(true)
    srv.state.keys = [jwk(k1.publicKey, 'kid-1'), jwk(k2.publicKey, 'kid-2')]
    const rotated = sign({}, k2.privateKey, 'kid-2', { expiresIn: 1e9 })
    // Within the rate-limit window an unknown kid does not hammer the endpoint.
    expect(await v.verify(rotated)).toEqual({ ok: false, reason: 'unknown_key' })
    expect(srv.state.calls).toBe(1)
    t += 31_000
    expect((await v.verify(rotated)).ok).toBe(true)
    expect(srv.state.calls).toBe(2)
    expect(v.keyCount).toBe(2)
  })

  it('refetches after the TTL and keeps old keys if the endpoint is down', async () => {
    let t = 1_000_000_000_000
    const { v, srv } = verifier([jwk(k1.publicKey, 'kid-1')], () => t)
    const token = sign({}, k1.privateKey, 'kid-1', { expiresIn: 1e9 })
    expect((await v.verify(token)).ok).toBe(true)
    t += 61 * 60 * 1000
    srv.state.fail = true
    expect((await v.verify(token)).ok).toBe(true)
    expect(srv.state.calls).toBe(2)
  })

  it('fails closed when keys were never loaded', async () => {
    const { v, srv } = verifier([])
    srv.state.fail = true
    expect(await v.verify(sign({}, k1.privateKey, 'kid-1'))).toEqual({ ok: false, reason: 'certs_unavailable' })
  })
})
