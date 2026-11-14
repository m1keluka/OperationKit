/**
 * browser-policy.ts — what the card browser (Playwright MCP / Chromium) is
 * allowed to reach, and whether it runs sandboxed.
 *
 * WHY THIS EXISTS (obj 900024). The card browser used to be launched with
 * `--no-sandbox` and no origin policy at all, inside the same container that
 * holds the secrets store, the seat logins and the app database. A single
 * renderer compromise from a hostile page — and a bundled Chromium is always
 * some weeks behind Chrome stable's security releases — therefore started with
 * no OS sandbox and unrestricted egress, including to the cloud metadata
 * endpoint (169.254.169.254) and to every service on the private network.
 *
 * Two controls, resolved here and enforced in two different places:
 *
 *   1. SANDBOX (OS-level). `sandbox: true` means the Chromium setuid/userns
 *      sandbox stays ON — the launcher simply does not pass `--no-sandbox`.
 *      Enforced by session-reviewer-prompt.ts when it writes the MCP config.
 *
 *   2. EGRESS POLICY (network-level). `allowedOrigins` / `blockedOrigins` are
 *      handed to Playwright MCP *and* to our own loopback egress guard
 *      (services/browser-egress-proxy.ts), which Chromium is pointed at with
 *      `--proxy-server`.
 *
 *      The belt-and-braces is deliberate, not redundant. Playwright's own help
 *      text for `--allowed-origins` says, verbatim: "*does not* serve as a
 *      security boundary and *does not* affect redirects." It is implemented by
 *      route interception inside the page. The proxy is the actual boundary:
 *      Chromium cannot open a TCP socket for http/https without going through
 *      it, and it re-checks every CONNECT — including the ones a redirect
 *      produces, which is exactly the case Playwright's flag misses.
 *
 * FAIL-CLOSED, NEVER FAIL-QUIET. Nothing here silently relaxes. Every widening
 * is an explicit opt-in that the resolver reports back in `warnings`, so the
 * caller can log it and install/verify.sh can fail on it.
 */

/** Cloud instance-metadata endpoints. Always blocked; see `allowMetadata`. */
export const METADATA_HOSTS = [
  '169.254.169.254',        // AWS / Azure / DigitalOcean / OpenStack IMDS
  'metadata.google.internal',
  'metadata.goog',
  'fd00:ec2::254',          // AWS IMDS over IPv6
  '100.100.100.200',        // Alibaba Cloud
] as const

/** The origins every install allows unless it explicitly turns loopback off. */
export const LOOPBACK_ORIGINS = [
  'http://localhost:*',
  'https://localhost:*',
  'http://127.0.0.1:*',
  'https://127.0.0.1:*',
  'http://[::1]:*',
  'https://[::1]:*',
] as const

export interface BrowserPolicy {
  /** Keep the Chromium OS sandbox on (do NOT pass --no-sandbox). */
  sandbox: boolean
  /** Run Chromium behind the loopback egress guard. */
  egressGuard: boolean
  /** Origin patterns the browser may request. Never empty. */
  allowedOrigins: string[]
  /** Origin patterns refused before the allowlist is consulted. */
  blockedOrigins: string[]
  /** Allow RFC1918 / CGNAT / link-local destinations (default: no). */
  allowPrivateNetwork: boolean
  /** Allow cloud instance metadata (default: no; separate from the above). */
  allowMetadata: boolean
  /** Allow loopback destinations — needed for local preview servers. */
  allowLoopback: boolean
  /** Human-readable notes about every control this config widened. */
  warnings: string[]
}

function truthy(v: string | undefined, dflt: boolean): boolean {
  if (v === undefined || v.trim() === '') return dflt
  return /^(1|on|yes|true)$/i.test(v.trim())
}

/** Split a `;`-separated (or `,`-separated) origin list, dropping blanks. */
export function parseOriginList(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/**
 * Normalise one origin pattern to `{ scheme, host, port }`.
 * Accepted forms: `example.com`, `*.example.com`, `https://example.com`,
 * `https://example.com:8443`, `http://localhost:*`, `http://[::1]:*`, `*`.
 * Returns null for input we refuse to guess at — an unparseable entry is
 * dropped (and reported) rather than silently widened to "everything".
 */
export function parseOriginPattern(
  pattern: string,
): { scheme: string | null; host: string; port: string | null } | null {
  let p = pattern.trim()
  if (!p) return null
  if (p === '*') return { scheme: null, host: '*', port: null }

  let scheme: string | null = null
  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(p)
  if (schemeMatch) {
    scheme = schemeMatch[1].toLowerCase()
    p = p.slice(schemeMatch[0].length)
  }
  // Strip anything after the authority — a path in an origin entry is a
  // mistake, and honouring half of it would be worse than ignoring it.
  p = p.split('/')[0]
  if (!p) return null

  let host: string
  let port: string | null = null
  if (p.startsWith('[')) {
    const close = p.indexOf(']')
    if (close < 0) return null
    host = p.slice(0, close + 1).toLowerCase()
    const rest = p.slice(close + 1)
    if (rest.startsWith(':')) port = rest.slice(1)
    else if (rest.length > 0) return null
  } else {
    const idx = p.lastIndexOf(':')
    if (idx > 0) {
      host = p.slice(0, idx).toLowerCase()
      port = p.slice(idx + 1)
    } else {
      host = p.toLowerCase()
    }
  }
  if (!host) return null
  if (port !== null && port !== '*' && !/^\d{1,5}$/.test(port)) return null
  return { scheme, host, port: port === '' ? null : port }
}

function hostMatches(patternHost: string, host: string): boolean {
  if (patternHost === '*') return true
  const h = host.toLowerCase()
  if (patternHost.startsWith('*.')) {
    const suffix = patternHost.slice(1) // ".example.com"
    return h.endsWith(suffix) && h.length > suffix.length
  }
  return patternHost === h
}

/** Does `target` match any pattern in `patterns`? */
export function originMatches(
  patterns: string[],
  target: { scheme: string; host: string; port: number },
): boolean {
  const host = target.host.toLowerCase().replace(/^\[|\]$/g, '')
  for (const raw of patterns) {
    const pat = parseOriginPattern(raw)
    if (!pat) continue
    if (pat.scheme && pat.scheme !== target.scheme) continue
    if (!hostMatches(pat.host.replace(/^\[|\]$/g, ''), host)) continue
    if (pat.port && pat.port !== '*' && Number(pat.port) !== target.port) continue
    return true
  }
  return false
}

/**
 * Resolve the policy from the process env.
 *
 * Env (set by install/docker-compose.yml from client.conf):
 *   CARD_BROWSER_SANDBOX               on (default) | off
 *   CARD_BROWSER_EGRESS_GUARD          on (default) | off
 *   CARD_BROWSER_ALLOWED_ORIGINS       `;`-separated extra origins
 *   CARD_BROWSER_BLOCKED_ORIGINS       `;`-separated extra blocks
 *   CARD_BROWSER_ALLOW_LOOPBACK        on (default) | off
 *   CARD_BROWSER_ALLOW_PRIVATE_NETWORK off (default) | on
 *   CARD_BROWSER_ALLOW_METADATA        off (default) | on
 * The install's own domain is picked up from OK_DOMAIN / CORS_ORIGINS so a
 * stock install needs no browser configuration at all.
 */
export function resolveBrowserPolicy(env: NodeJS.ProcessEnv = process.env): BrowserPolicy {
  const warnings: string[] = []

  const sandbox = truthy(env.CARD_BROWSER_SANDBOX, true)
  if (!sandbox) {
    warnings.push(
      'CARD_BROWSER_SANDBOX=off — the Chromium OS sandbox is DISABLED. A renderer ' +
      'compromise runs with the full privileges of the session user.',
    )
  }

  const egressGuard = truthy(env.CARD_BROWSER_EGRESS_GUARD, true)
  if (!egressGuard) {
    warnings.push(
      'CARD_BROWSER_EGRESS_GUARD=off — the card browser has unrestricted network ' +
      'egress. Origin policy is then advisory only (Playwright does not enforce it).',
    )
  }

  const allowLoopback = truthy(env.CARD_BROWSER_ALLOW_LOOPBACK, true)
  const allowPrivateNetwork = truthy(env.CARD_BROWSER_ALLOW_PRIVATE_NETWORK, false)
  if (allowPrivateNetwork) {
    warnings.push(
      'CARD_BROWSER_ALLOW_PRIVATE_NETWORK=on — the card browser may reach RFC1918 / ' +
      'link-local addresses on this network.',
    )
  }
  const allowMetadata = truthy(env.CARD_BROWSER_ALLOW_METADATA, false)
  if (allowMetadata) {
    warnings.push(
      'CARD_BROWSER_ALLOW_METADATA=on — the card browser may reach the cloud ' +
      "instance-metadata endpoint. This hands any hostile page the host's cloud " +
      'credentials. Turn this off.',
    )
  }

  const allowed: string[] = []
  if (allowLoopback) allowed.push(...LOOPBACK_ORIGINS)

  // The install's own site, so "review the card I just shipped" keeps working.
  for (const d of parseOriginList(env.OK_DOMAIN)) {
    if (d && d !== 'localhost') allowed.push(`https://${d}`, `http://${d}`)
  }
  for (const o of parseOriginList(env.CORS_ORIGINS)) allowed.push(o)

  const extra = parseOriginList(env.CARD_BROWSER_ALLOWED_ORIGINS)
  for (const e of extra) {
    if (parseOriginPattern(e)) allowed.push(e)
    else warnings.push(`CARD_BROWSER_ALLOWED_ORIGINS: ignoring unparseable entry ${JSON.stringify(e)}`)
  }
  if (extra.some((e) => e.trim() === '*')) {
    warnings.push(
      'CARD_BROWSER_ALLOWED_ORIGINS contains "*" — the origin allowlist is ' +
      'effectively disabled. Only the private-network and metadata blocks remain.',
    )
  }

  const blocked = parseOriginList(env.CARD_BROWSER_BLOCKED_ORIGINS).filter((b) => {
    if (parseOriginPattern(b)) return true
    warnings.push(`CARD_BROWSER_BLOCKED_ORIGINS: ignoring unparseable entry ${JSON.stringify(b)}`)
    return false
  })
  if (!allowMetadata) blocked.push(...METADATA_HOSTS)

  return {
    sandbox,
    egressGuard,
    allowedOrigins: dedupe(allowed),
    blockedOrigins: dedupe(blocked),
    allowPrivateNetwork,
    allowMetadata,
    allowLoopback,
    warnings,
  }
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs.map((x) => x.trim()).filter(Boolean))]
}

// ── IP classification ────────────────────────────────────────────────────────

function ipv4Parts(ip: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip)
  if (!m) return null
  const parts = m.slice(1, 5).map(Number)
  return parts.every((n) => n >= 0 && n <= 255) ? parts : null
}

/** True for a cloud metadata / link-local address, in either family. */
export function isMetadataAddress(ip: string): boolean {
  const bare = ip.toLowerCase().replace(/^\[|\]$/g, '')
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(bare)
  const v4 = ipv4Parts(mapped ? mapped[1] : bare)
  if (v4) {
    // The whole link-local /16 — IMDS lives at 169.254.169.254 but the rest of
    // 169.254/16 is equally not something a card browser should be reaching.
    if (v4[0] === 169 && v4[1] === 254) return true
    if (bare === '100.100.100.200') return true
    return false
  }
  if (bare.startsWith('fe80:')) return true
  if (bare.startsWith('fd00:ec2:')) return true
  return false
}

/** True for loopback in either family. */
export function isLoopbackAddress(ip: string): boolean {
  const bare = ip.toLowerCase().replace(/^\[|\]$/g, '')
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(bare)
  const v4 = ipv4Parts(mapped ? mapped[1] : bare)
  if (v4) return v4[0] === 127
  return bare === '::1' || bare === '0:0:0:0:0:0:0:1'
}

/**
 * True for an address on a private / non-routable network: RFC1918, CGNAT,
 * link-local, unique-local v6, and v4-mapped forms of all of those.
 * Loopback is reported separately (it has its own, narrower allowance).
 */
export function isPrivateAddress(ip: string): boolean {
  const bare = ip.toLowerCase().replace(/^\[|\]$/g, '')
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(bare)
  const v4 = ipv4Parts(mapped ? mapped[1] : bare)
  if (v4) {
    const [a, b] = v4
    if (a === 10) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true   // CGNAT
    if (a === 169 && b === 254) return true             // link-local
    if (a === 0) return true
    if (a >= 224) return true                           // multicast / reserved
    return false
  }
  if (bare === '::') return true
  if (bare.startsWith('fe80:')) return true
  if (/^f[cd][0-9a-f]{2}:/.test(bare)) return true      // fc00::/7 unique-local
  return false
}

export type EgressDecision =
  | { allow: true }
  | { allow: false; reason: string }

/**
 * The one decision function both the proxy and the tests use.
 * Order matters and is part of the contract:
 *   1. metadata  — always refused unless allowMetadata (no allowlist override)
 *   2. blocklist — evaluated before the allowlist, like Playwright's own
 *   3. allowlist — a target that matches nothing is refused
 *   4. address class — refuse loopback/private destinations the policy did not
 *      opt into, INCLUDING when an allowlisted name resolves to one (the DNS
 *      rebinding case). A literal loopback/private host that is itself on the
 *      allowlist is what `allowLoopback` / `allowPrivateNetwork` permit.
 */
export function decideEgress(
  policy: BrowserPolicy,
  target: { scheme: string; host: string; port: number },
  resolvedIps: string[],
): EgressDecision {
  const host = target.host.toLowerCase().replace(/^\[|\]$/g, '')

  if (!policy.allowMetadata) {
    if (METADATA_HOSTS.some((m) => m.toLowerCase() === host)) {
      return { allow: false, reason: `cloud instance metadata host (${host}) is blocked` }
    }
    for (const ip of resolvedIps) {
      if (isMetadataAddress(ip)) {
        return { allow: false, reason: `${host} resolves to metadata/link-local address ${ip}` }
      }
    }
  }

  if (originMatches(policy.blockedOrigins, target)) {
    return { allow: false, reason: `${target.scheme}://${host}:${target.port} is on the block list` }
  }

  if (!originMatches(policy.allowedOrigins, target)) {
    return {
      allow: false,
      reason:
        `${target.scheme}://${host}:${target.port} is not in the card browser's allowed origins. ` +
        'Add it to BROWSER_ALLOWED_ORIGINS in client.conf if this install needs it.',
    }
  }

  const hostIsAddressLiteral = ipv4Parts(host) !== null || host.includes(':')
  const hostIsLocalName = host === 'localhost' || host.endsWith('.localhost')

  for (const ip of resolvedIps) {
    if (isLoopbackAddress(ip)) {
      if (!policy.allowLoopback) {
        return { allow: false, reason: `loopback destination ${ip} is blocked (BROWSER_ALLOW_LOOPBACK=off)` }
      }
      // Only a request that ASKED for loopback may reach it. A public name that
      // resolves to 127.0.0.1 is a rebinding attempt, not a preview server.
      if (!hostIsAddressLiteral && !hostIsLocalName) {
        return { allow: false, reason: `${host} resolves to loopback ${ip} (DNS rebinding refused)` }
      }
      continue
    }
    if (isPrivateAddress(ip) && !policy.allowPrivateNetwork) {
      return {
        allow: false,
        reason:
          `${host} resolves to private address ${ip}; the card browser may not reach the ` +
          'private network (BROWSER_ALLOW_PRIVATE_NETWORK=off)',
      }
    }
  }

  return { allow: true }
}
