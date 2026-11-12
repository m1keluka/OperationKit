/**
 * URL + SSRF guard for workspace MCP servers (Sprint 7.8, obj 900620).
 *
 * A workspace admin pastes an arbitrary URL and this server then makes HTTP
 * requests to it (and to whatever OAuth endpoints it advertises). Without a
 * guard that is a textbook SSRF: point it at the cloud metadata service, the
 * Docker gateway or a sibling container and the server fetches it for you.
 *
 * Two layers, both required:
 *   1. `validateMcpUrl` — syntax: https only (plain http only for loopback
 *      when local-dev mode is on), no credentials in the URL, no IP literal or
 *      hostname that is obviously internal (metadata hosts, private ranges).
 *   2. `assertPublicAddress` — the RESOLVED address. A public-looking hostname
 *      can resolve to 10.0.0.5, so every connection re-checks the IP it is
 *      about to dial (see safe-fetch.ts, which plugs this into `lookup` so a
 *      DNS-rebinding answer is checked at connect time, not just at save time).
 *
 * Local dev: `http://localhost`, `127.0.0.1` and `[::1]` are allowed ONLY when
 * `CC_MCP_ALLOW_LOCALHOST=1` or NODE_ENV is `development`/`test`. Production
 * installs never reach loopback through this path.
 */
import net from 'node:net'

export type UrlCheck = { ok: true; url: URL } | { ok: false; error: string }

/** Hostnames that are always internal, whatever they resolve to. */
const BLOCKED_HOSTNAMES = new Set([
  'metadata.google.internal',
  'metadata.goog',
  'metadata',
  'instance-data',
  'instance-data.ec2.internal',
  'host.docker.internal',
  'gateway.docker.internal',
  'kubernetes.default',
  'kubernetes.default.svc',
])

const LOOPBACK_NAMES = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback'])

/** Is loopback (http or https) allowed? Off in production. */
export function localDevAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CC_MCP_ALLOW_LOCALHOST === '1') return true
  if (env.CC_MCP_ALLOW_LOCALHOST === '0') return false
  return env.NODE_ENV === 'development' || env.NODE_ENV === 'test'
}

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, oct) => (acc << 8) + Number(oct), 0) >>> 0
}

function inV4Cidr(ip: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask)
}

/** IPv4 ranges that are never a legitimate remote MCP server. */
const BLOCKED_V4: Array<[string, number, string]> = [
  ['0.0.0.0', 8, 'unspecified'],
  ['10.0.0.0', 8, 'private'],
  ['100.64.0.0', 10, 'carrier-grade NAT'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local / cloud metadata'],
  ['172.16.0.0', 12, 'private'],
  ['192.0.0.0', 24, 'IETF protocol assignments'],
  ['192.0.2.0', 24, 'documentation'],
  ['192.88.99.0', 24, '6to4 relay'],
  ['192.168.0.0', 16, 'private'],
  ['198.18.0.0', 15, 'benchmarking'],
  ['198.51.100.0', 24, 'documentation'],
  ['203.0.113.0', 24, 'documentation'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved'],
]

/** Expand an IPv6 address to 8 groups of 16-bit numbers. Returns null if unparseable. */
function expandV6(ip: string): number[] | null {
  let addr = ip.toLowerCase()
  const zone = addr.indexOf('%')
  if (zone >= 0) addr = addr.slice(0, zone)
  // Embedded IPv4 tail (::ffff:1.2.3.4) → two hex groups.
  const v4Tail = addr.match(/(\d+\.\d+\.\d+\.\d+)$/)
  if (v4Tail) {
    if (net.isIPv4(v4Tail[1]) === false) return null
    const n = ipv4ToInt(v4Tail[1])
    addr = addr.slice(0, -v4Tail[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`
  }
  const halves = addr.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - head.length - tail.length
  if (halves.length === 1 && head.length !== 8) return null
  if (missing < 0) return null
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail]
  const out = groups.map(g => parseInt(g, 16))
  if (out.length !== 8 || out.some(n => Number.isNaN(n) || n < 0 || n > 0xffff)) return null
  return out
}

/**
 * Why an IP literal must not be dialled, or null if it is a public address.
 * Covers IPv4, IPv6 and IPv4-mapped/compatible IPv6 (::ffff:169.254.169.254
 * is the metadata endpoint in disguise).
 */
export function blockedAddressReason(ip: string): string | null {
  if (net.isIPv4(ip)) {
    for (const [base, bits, why] of BLOCKED_V4) if (inV4Cidr(ip, base, bits)) return why
    return null
  }
  if (!net.isIPv6(ip)) return 'not an IP address'
  const g = expandV6(ip)
  if (!g) return 'unparseable IPv6 address'
  const isZeroPrefix = (n: number) => g.slice(0, n).every(x => x === 0)
  if (g.every(x => x === 0)) return 'unspecified'
  if (isZeroPrefix(7) && g[7] === 1) return 'loopback'
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): judge the v4.
  if ((isZeroPrefix(5) && g[5] === 0xffff) || (isZeroPrefix(6) && (g[6] !== 0 || g[7] > 1))) {
    const v4 = `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`
    return blockedAddressReason(v4)
  }
  // NAT64 well-known prefix 64:ff9b::/96 embeds an IPv4 too.
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(x => x === 0)) {
    const v4 = `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`
    return blockedAddressReason(v4)
  }
  if ((g[0] & 0xfe00) === 0xfc00) return 'unique-local (private)'
  if ((g[0] & 0xffc0) === 0xfe80) return 'link-local'
  if ((g[0] & 0xffc0) === 0xfec0) return 'site-local (deprecated private)'
  if ((g[0] & 0xff00) === 0xff00) return 'multicast'
  if (g[0] === 0x2001 && g[1] === 0x0db8) return 'documentation'
  // fd00:ec2::254 (AWS IMDS over IPv6) is covered by the fc00::/7 rule above.
  return null
}

export function isLoopbackAddress(ip: string): boolean {
  if (net.isIPv4(ip)) return inV4Cidr(ip, '127.0.0.0', 8)
  const g = net.isIPv6(ip) ? expandV6(ip) : null
  if (!g) return false
  if (g.slice(0, 7).every(x => x === 0) && g[7] === 1) return true
  if (g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff) return (g[6] >> 8) === 127
  return false
}

/**
 * The connect-time check: may this resolved address be dialled? Loopback is
 * the one exception, and only in local-dev mode.
 */
export function checkResolvedAddress(ip: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (isLoopbackAddress(ip) && localDevAllowed(env)) return null
  const why = blockedAddressReason(ip)
  return why ? `${ip} is a ${why} address; MCP servers must be on the public internet.` : null
}

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

/**
 * Syntax-level validation of a pasted MCP server URL (or an OAuth endpoint it
 * advertises). Does NOT resolve DNS — safe-fetch does that at connect time.
 *
 * `allowHttp` (obj 900671): a bot's web_fetch tool reads ordinary public web
 * pages, and many are still plain http. Every other rule still applies (no
 * credentials, no internal host names, no private or metadata addresses), and
 * safe-fetch still checks the resolved address at connect time.
 */
export function validateMcpUrl(
  raw: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: { allowHttp?: boolean } = {},
): UrlCheck {
  const input = (raw ?? '').trim()
  if (!input) return { ok: false, error: 'Enter the server URL.' }
  if (input.length > 2048) return { ok: false, error: 'That URL is too long.' }
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return { ok: false, error: 'That is not a valid URL. It should look like https://example.com/mcp' }
  }
  if (url.username || url.password) {
    return { ok: false, error: 'Do not put a username or password in the URL. Use the API key option instead.' }
  }
  const host = stripBrackets(url.hostname.toLowerCase()).replace(/\.$/, '')
  if (!host) return { ok: false, error: 'The URL has no host name.' }
  const loopbackHost = LOOPBACK_NAMES.has(host) || host.endsWith('.localhost') || (net.isIP(host) > 0 && isLoopbackAddress(host))
  const devLoopback = loopbackHost && localDevAllowed(env)

  if (url.protocol !== 'https:') {
    if (url.protocol === 'http:' && devLoopback) return { ok: true, url }
    if (url.protocol === 'http:' && !opts.allowHttp) {
      return { ok: false, error: 'The URL must start with https://. Plain http is only allowed for localhost in local development.' }
    }
    if (url.protocol !== 'http:') {
      return { ok: false, error: `Unsupported URL scheme "${url.protocol.replace(/:$/, '')}". Use https://.` }
    }
  }
  if (loopbackHost) {
    return devLoopback ? { ok: true, url } : { ok: false, error: 'localhost is not reachable from this server. Use the server\'s public https URL.' }
  }
  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith('.internal') || host.endsWith('.local')) {
    return { ok: false, error: `${host} is an internal host name; MCP servers must be on the public internet.` }
  }
  if (net.isIP(host)) {
    const why = blockedAddressReason(host)
    if (why) return { ok: false, error: `${host} is a ${why} address; MCP servers must be on the public internet.` }
  } else if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) {
    // Decimal / hex integer hosts (http://2852039166/) are an SSRF bypass classic.
    return { ok: false, error: 'Numeric host names are not allowed.' }
  } else if (!host.includes('.')) {
    return { ok: false, error: `${host} is not a public host name.` }
  }
  return { ok: true, url }
}
