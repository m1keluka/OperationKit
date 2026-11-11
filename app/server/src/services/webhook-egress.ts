/**
 * Outbound webhook egress guard (obj 900270, covers card #900244).
 *
 * Save-time URL validation (validateWebhookUrl) only sees the hostname the owner
 * typed. A public-looking name can still resolve to 127.0.0.1, 10.x, the cloud
 * metadata address, or flip to one of those between our check and the connect
 * (DNS rebinding / TOCTOU). So at SEND time, for every delivery and every test
 * event:
 *
 *   1. resolve the hostname ourselves (all A/AAAA answers),
 *   2. refuse if ANY answer is non-public (loopback, private, link-local, CGNAT,
 *      metadata, multicast, reserved, IPv4-mapped / NAT64 / 6to4 IPv6 …) —
 *      a mixed public+private answer is refused, never "pick the public one",
 *   3. connect to the exact address we checked (a pinned `lookup`, so the socket
 *      layer never re-resolves), with TLS SNI + certificate checks still bound to
 *      the original hostname,
 *   4. re-check the connected socket's remote address,
 *   5. never follow a redirect (node:https has no redirect logic; a 3xx is just a
 *      non-2xx failure).
 *
 * Fails closed: an address we cannot parse is treated as blocked.
 */
import dns from 'dns'
import https from 'https'
import net from 'net'

// ── Address policy ───────────────────────────────────────────────────────────

// Two lists on purpose: node's BlockList matches IPv4 addresses against IPv6
// rules via their mapped form, so a ::ffff:0:0/96 rule in a shared list would
// block every IPv4 address (8.8.8.8 included).
const BLOCKED_V4 = new net.BlockList()
const BLOCKED_V6 = new net.BlockList()
for (const [addr, prefix] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // RFC 1918
  ['100.64.0.0', 10], // CGNAT (also Alibaba metadata 100.100.100.200)
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (AWS/GCP/Azure metadata 169.254.169.254)
  ['172.16.0.0', 12], // RFC 1918
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // RFC 1918
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + 255.255.255.255 broadcast
] as const) BLOCKED_V4.addSubnet(addr, prefix, 'ipv4')
for (const [addr, prefix] of [
  ['::', 96], // unspecified, loopback ::1, deprecated IPv4-compatible ::a.b.c.d
  ['::ffff:0:0', 96], // IPv4-mapped — refused outright, whatever v4 it embeds
  ['::ffff:0:0:0', 96], // IPv4-translated (SIIT) — embeds an IPv4
  ['64:ff9b::', 96], // NAT64 well-known prefix (embeds an IPv4)
  ['64:ff9b:1::', 48], // local-use NAT64
  ['100::', 64], // discard-only
  ['2001::', 23], // IETF protocol assignments (incl. Teredo 2001::/32)
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4 (embeds an IPv4)
  ['fc00::', 7], // unique local (incl. AWS IPv6 metadata fd00:ec2::254)
  ['fe80::', 10], // link-local
  ['fec0::', 10], // deprecated site-local
  ['ff00::', 8], // multicast
  ['3fff::', 20], // documentation (RFC 9637)
  ['5f00::', 16], // SRv6 SIDs (RFC 9602)
] as const) BLOCKED_V6.addSubnet(addr, prefix, 'ipv6')

/** True when `ip` must never receive a webhook. Unparseable → true (fail closed). */
export function isBlockedAddress(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, '').replace(/%.*$/, '').toLowerCase()
  const family = net.isIP(bare)
  if (family === 4) return BLOCKED_V4.check(bare, 'ipv4')
  if (family === 6) {
    if (BLOCKED_V6.check(bare, 'ipv6')) return true
    // Belt and braces for the dotted mapped form (::ffff:127.0.0.1).
    return /^::ffff:\d+\.\d+\.\d+\.\d+$/.test(bare)
  }
  return true
}

/** Names that are never public, whatever they resolve to. */
function isBlockedName(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '')
  return h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')
}

// ── DNS seam (tests) ─────────────────────────────────────────────────────────

export interface ResolvedAddress { address: string; family: number }
export type LookupAll = (hostname: string) => Promise<ResolvedAddress[]>

const systemLookup: LookupAll = host => dns.promises.lookup(host, { all: true, verbatim: true })
/** A resolver that never answers must not hold a delivery batch (or a libuv thread slot) for long. */
export const DNS_TIMEOUT_MS = 5_000
let lookupImpl: LookupAll = systemLookup
export function setWebhookDnsLookup(f: LookupAll | null): void {
  lookupImpl = f ?? systemLookup
}

// ── Resolve + validate at send time ──────────────────────────────────────────

export const NOT_PUBLIC_ERROR = 'destination refused: host did not resolve to a public address'

export type Destination =
  | { ok: true; address: string; family: 4 | 6; hostname: string; addresses: ResolvedAddress[] }
  | { ok: false; error: string }

/**
 * Resolve the webhook URL's host and decide whether we may connect. Returns the
 * single address to pin the connection to. Never throws.
 */
export async function resolveWebhookDestination(rawUrl: string): Promise<Destination> {
  let u: URL
  try {
    u = new URL(rawUrl)
  } catch {
    return { ok: false, error: 'destination refused: invalid URL' }
  }
  if (u.protocol !== 'https:') return { ok: false, error: 'destination refused: https only' }
  if (u.username || u.password) return { ok: false, error: 'destination refused: URL embeds credentials' }
  const hostname = u.hostname.replace(/^\[|\]$/g, '')
  if (!hostname || isBlockedName(hostname)) return { ok: false, error: 'destination refused: host is not public' }

  const literal = net.isIP(hostname)
  if (literal) {
    if (isBlockedAddress(hostname)) return { ok: false, error: 'destination refused: address is not public' }
    return { ok: true, address: hostname, family: literal as 4 | 6, hostname, addresses: [{ address: hostname, family: literal }] }
  }

  // One error for "did not resolve", "timed out" and "resolved to a private
  // address", so the Settings test button cannot be used to map internal names.
  const refused: Destination = { ok: false, error: NOT_PUBLIC_ERROR }
  let answers: ResolvedAddress[]
  let timer: NodeJS.Timeout | undefined
  try {
    answers = await Promise.race([
      lookupImpl(hostname),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('DNS timeout')), DNS_TIMEOUT_MS) }),
    ])
  } catch {
    return refused
  } finally {
    if (timer) clearTimeout(timer)
  }
  if (!Array.isArray(answers) || answers.length === 0) return refused
  // Any non-public answer poisons the whole set: an attacker who controls the
  // zone could otherwise mix one public record with 127.0.0.1 and win the race.
  if (answers.some(a => !a || typeof a.address !== 'string' || isBlockedAddress(a.address))) return refused
  // Pin ALL validated answers (Happy Eyeballs / multi-A fallback still works), never
  // anything we did not check.
  const addresses = answers.map(a => ({ address: a.address, family: net.isIP(a.address) === 6 ? 6 : 4 }))
  const first = addresses[0]
  return { ok: true, address: first.address, family: first.family as 4 | 6, hostname, addresses }
}

// ── Pinned transport ─────────────────────────────────────────────────────────

/**
 * A `lookup` for net/tls that ignores the hostname and returns only the address
 * we already validated, so the socket layer cannot re-resolve (rebinding).
 * Handles both the single-answer and `all: true` (autoSelectFamily) call shapes.
 */
export function pinnedLookup(address: string, family: 4 | 6, all: ResolvedAddress[] = [{ address, family }]) {
  return (_hostname: string, options: unknown, cb?: unknown): void => {
    const callback = (typeof options === 'function' ? options : cb) as (...args: unknown[]) => void
    const opts = (typeof options === 'object' && options !== null ? options : {}) as { all?: boolean }
    if (opts.all) callback(null, all.map(a => ({ address: a.address, family: a.family })))
    else callback(null, address, family)
  }
}

export interface PinnedPostInit {
  method: string
  headers: Record<string, string>
  body: string
  signal: AbortSignal
  /** Always 'manual': redirects are never followed. */
  redirect: 'manual'
  /** The validated address the connection is pinned to. */
  address: string
  family: 4 | 6
  /** Every validated answer (first = `address`); the socket may try any of them, nothing else. */
  addresses?: ResolvedAddress[]
}

/** Request options for the pinned POST — exported so tests can assert the pin. */
export function pinnedRequestOptions(rawUrl: string, init: PinnedPostInit): https.RequestOptions {
  const u = new URL(rawUrl)
  const host = u.hostname.replace(/^\[|\]$/g, '')
  return {
    protocol: 'https:',
    host,
    port: u.port ? Number(u.port) : 443,
    path: `${u.pathname}${u.search}`,
    method: init.method,
    headers: { ...init.headers, 'Content-Length': String(Buffer.byteLength(init.body, 'utf8')) },
    // SNI + certificate hostname check stay on the name the owner configured.
    servername: net.isIP(host) ? undefined : host,
    lookup: pinnedLookup(init.address, init.family, init.addresses) as unknown as https.RequestOptions['lookup'],
    agent: false, // no pooled socket that was opened for some other address
    signal: init.signal,
  }
}

/** POST over https to the pinned address. Resolves with the status; never follows redirects. */
export function pinnedHttpsPost(rawUrl: string, init: PinnedPostInit): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = https.request(pinnedRequestOptions(rawUrl, init), res => {
      res.resume() // drain; the body is never read or logged
      res.on('error', () => { /* status already captured */ })
      resolve({ status: res.statusCode ?? 0 })
    })
    req.on('socket', socket => {
      socket.once('connect', () => {
        const remote = socket.remoteAddress
        if (!remote || isBlockedAddress(remote)) {
          req.destroy(new Error('destination refused: connected to a non-public address'))
        }
      })
    })
    req.on('error', reject)
    req.end(init.body)
  })
}
