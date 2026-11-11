/**
 * Cloudflare Access single sign-on (obj 720332).
 *
 * A client install sits behind Cloudflare Access: nobody reaches the app until
 * Cloudflare has checked their email. Cloudflare then adds a signed JWT to every
 * request in the `Cf-Access-Jwt-Assertion` header. When that token verifies, the
 * app trusts the email in it and skips its own sign-in page.
 *
 * The header is trusted ONLY after the signature verifies against the team's
 * public keys, and the audience (the Access app's AUD tag), issuer and expiry
 * all check out. The app port is bound to 127.0.0.1 behind the tunnel, but that
 * is not relied on: a forged or replayed-elsewhere header is just rejected.
 *
 * Off unless BOTH env vars are set (install/cloudflare.sh writes them):
 *   OK_CF_ACCESS_TEAM  team domain, e.g. `acme.cloudflareaccess.com` (or `acme`)
 *   OK_CF_ACCESS_AUD   the Access application's AUD tag
 */
import crypto, { type KeyObject } from 'crypto'
import jwt from 'jsonwebtoken'

export const CF_ACCESS_HEADER = 'cf-access-jwt-assertion'
export const CF_ACCESS_LOGOUT_PATH = '/cdn-cgi/access/logout'

/** Keys are re-fetched after this long even if every kid still resolves. */
const KEY_TTL_MS = 60 * 60 * 1000
/** An unknown kid (key rotation) may force a refetch at most this often. */
const MIN_REFETCH_MS = 30 * 1000
const FETCH_TIMEOUT_MS = 5000
/** Tolerated clock difference between Cloudflare and this server. */
const CLOCK_TOLERANCE_SEC = 30

export interface CfAccessConfig {
  teamDomain: string
  issuer: string
  aud: string
  certsUrl: string
}

const TEAM_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

/** Null when the feature is off (either env var unset) or the team value is malformed. */
export function cfAccessConfig(env: NodeJS.ProcessEnv = process.env): CfAccessConfig | null {
  const rawTeam = (env.OK_CF_ACCESS_TEAM || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/\/+$/, '')
  const aud = (env.OK_CF_ACCESS_AUD || '').trim()
  if (!rawTeam || !aud) return null
  const team = rawTeam.endsWith('.cloudflareaccess.com') ? rawTeam.slice(0, -'.cloudflareaccess.com'.length) : rawTeam
  if (!TEAM_RE.test(team)) return null
  const teamDomain = `${team}.cloudflareaccess.com`
  return {
    teamDomain,
    issuer: `https://${teamDomain}`,
    aud,
    certsUrl: `https://${teamDomain}/cdn-cgi/access/certs`,
  }
}

export type CfAccessResult =
  | { ok: true; email: string }
  | { ok: false; reason: 'malformed' | 'unknown_key' | 'bad_signature' | 'expired' | 'wrong_audience' | 'wrong_issuer' | 'no_email' | 'certs_unavailable' }

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

interface Jwk { kid?: string; kty?: string; alg?: string; use?: string; n?: string; e?: string }

export class CfAccessVerifier {
  private keys = new Map<string, KeyObject>()
  private fetchedAt = 0
  private inflight: Promise<void> | null = null

  constructor(
    readonly config: CfAccessConfig,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
    private readonly now: () => number = Date.now,
  ) {}

  /** Number of cached signing keys (for tests / diagnostics). */
  get keyCount(): number { return this.keys.size }

  async verify(token: string | undefined | null): Promise<CfAccessResult> {
    if (!token || typeof token !== 'string') return { ok: false, reason: 'malformed' }
    const decoded = jwt.decode(token, { complete: true })
    if (!decoded || typeof decoded.payload === 'string') return { ok: false, reason: 'malformed' }
    // RS256 only — never `none`, never an HMAC alg that could treat a public key as a secret.
    if (decoded.header.alg !== 'RS256' || !decoded.header.kid) return { ok: false, reason: 'malformed' }

    let key: KeyObject | undefined
    try {
      key = await this.keyFor(decoded.header.kid)
    } catch {
      return { ok: false, reason: 'certs_unavailable' }
    }
    if (!key) return { ok: false, reason: 'unknown_key' }

    let payload: jwt.JwtPayload
    try {
      payload = jwt.verify(token, key, {
        algorithms: ['RS256'],
        audience: this.config.aud,
        issuer: this.config.issuer,
        clockTolerance: CLOCK_TOLERANCE_SEC,
        clockTimestamp: Math.floor(this.now() / 1000),
      }) as jwt.JwtPayload
    } catch (err) {
      const msg = (err as Error).message || ''
      if ((err as Error).name === 'TokenExpiredError') return { ok: false, reason: 'expired' }
      if (msg.includes('audience')) return { ok: false, reason: 'wrong_audience' }
      if (msg.includes('issuer')) return { ok: false, reason: 'wrong_issuer' }
      if (msg.includes('not active')) return { ok: false, reason: 'expired' }
      return { ok: false, reason: 'bad_signature' }
    }
    // Cloudflare tokens always carry exp; refuse one that does not.
    if (typeof payload.exp !== 'number') return { ok: false, reason: 'expired' }
    // Service tokens (verify robot, agent passes) carry common_name, not email.
    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : ''
    if (!email || !email.includes('@')) return { ok: false, reason: 'no_email' }
    return { ok: true, email }
  }

  private async keyFor(kid: string): Promise<KeyObject | undefined> {
    const age = this.now() - this.fetchedAt
    if (this.fetchedAt === 0 || age > KEY_TTL_MS) {
      await this.refresh()
    } else if (!this.keys.has(kid) && age > MIN_REFETCH_MS) {
      // Unknown kid: Cloudflare rotated its keys. Refetch, but rate-limited so
      // a stream of garbage kids cannot turn into a stream of outbound calls.
      await this.refresh()
    }
    return this.keys.get(kid)
  }

  private refresh(): Promise<void> {
    if (!this.inflight) {
      this.inflight = this.load().finally(() => { this.inflight = null })
    }
    return this.inflight
  }

  private async load(): Promise<void> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
    let body: unknown
    try {
      const res = await this.fetchImpl(this.config.certsUrl, { signal: ctrl.signal })
      if (!res.ok) throw new Error(`certs HTTP ${res.status}`)
      body = await res.json()
    } catch (err) {
      // Keep serving the previous keys if we have any; only a cold cache fails.
      this.fetchedAt = this.keys.size ? this.now() - KEY_TTL_MS + MIN_REFETCH_MS : 0
      if (this.keys.size) return
      throw err
    } finally {
      clearTimeout(timer)
    }
    const next = new Map<string, KeyObject>()
    const list = (body as { keys?: Jwk[] } | null)?.keys
    for (const jwk of Array.isArray(list) ? list : []) {
      if (!jwk || jwk.kty !== 'RSA' || !jwk.kid || !jwk.n || !jwk.e) continue
      try {
        next.set(jwk.kid, crypto.createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' }))
      } catch { /* skip an unreadable key */ }
    }
    if (next.size === 0) {
      if (this.keys.size) { this.fetchedAt = this.now() - KEY_TTL_MS + MIN_REFETCH_MS; return }
      throw new Error('certs response had no usable RSA keys')
    }
    this.keys = next
    this.fetchedAt = this.now()
  }
}

let cached: { key: string; verifier: CfAccessVerifier } | null = null

/** Process-wide verifier for the current env, or null when the feature is off. */
export function getCfAccessVerifier(env: NodeJS.ProcessEnv = process.env): CfAccessVerifier | null {
  const cfg = cfAccessConfig(env)
  if (!cfg) return null
  const key = `${cfg.teamDomain}|${cfg.aud}`
  if (!cached || cached.key !== key) cached = { key, verifier: new CfAccessVerifier(cfg) }
  return cached.verifier
}

/** Test hook: inject a verifier (or clear with null). */
export function setCfAccessVerifierForTests(v: CfAccessVerifier | null): void {
  cached = v ? { key: `${v.config.teamDomain}|${v.config.aud}`, verifier: v } : null
}
