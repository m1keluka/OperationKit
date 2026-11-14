/**
 * browser-egress-proxy.ts — the card browser's only way onto the network.
 *
 * Chromium is launched with `--proxy-server=http://127.0.0.1:<port>` pointing
 * here, so every http/https destination it wants has to pass `decideEgress`
 * first. This is the control that actually holds:
 *
 *   * Playwright MCP's own `--allowed-origins` is enforced INSIDE the page by
 *     route interception, and its documentation says plainly that it "*does
 *     not* serve as a security boundary and *does not* affect redirects". We
 *     still pass it (defence in depth, and it gives the agent a clean error),
 *     but we do not rely on it.
 *   * This proxy sees the CONNECT / absolute-URI request for EVERY hop,
 *     including each hop of a redirect chain, and it sees them before a single
 *     byte of the response reaches the renderer.
 *
 * Two further properties worth stating because they are easy to get wrong:
 *
 *   DNS PINNING. The name is resolved once, here; the decision is made against
 *   the resolved addresses; and the socket is opened to THAT address, not by
 *   re-resolving the name. So a name that answers a public address on the first
 *   lookup and 169.254.169.254 on the second cannot win the race.
 *
 *   FAIL-CLOSED. Resolution failure, an unparseable request line, a policy
 *   error — all end in a refusal, never in a pass-through. The only way out of
 *   this proxy is an explicit `allow: true`.
 *
 * It binds to 127.0.0.1 only. It is an egress guard for a local browser, not a
 * proxy anyone else may use.
 */
import http from 'http'
import net from 'net'
import dns from 'dns'
import { decideEgress, type BrowserPolicy } from '../lib/browser-policy.js'

export interface EgressProxyHandle {
  port: number
  close: () => Promise<void>
  /** Every decision this proxy made, newest last. Bounded; for verify/tests. */
  readonly log: EgressLogEntry[]
}

export interface EgressLogEntry {
  at: string
  target: string
  allowed: boolean
  reason?: string
}

const LOG_CAP = 500

/** Resolve a hostname to every address, or return the literal if it is an IP. */
export async function resolveTarget(host: string): Promise<string[]> {
  const bare = host.replace(/^\[|\]$/g, '')
  if (net.isIP(bare) !== 0) return [bare]
  const addrs = await dns.promises.lookup(bare, { all: true, verbatim: true })
  return addrs.map((a) => a.address)
}

function parseAuthority(authority: string, defaultPort: number): { host: string; port: number } | null {
  let host = authority.trim()
  let port = defaultPort
  if (!host) return null
  if (host.startsWith('[')) {
    const close = host.indexOf(']')
    if (close < 0) return null
    const rest = host.slice(close + 1)
    host = host.slice(1, close)
    if (rest.startsWith(':')) {
      port = Number(rest.slice(1))
      if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
    } else if (rest.length > 0) return null
  } else {
    const idx = host.lastIndexOf(':')
    if (idx > 0) {
      const p = host.slice(idx + 1)
      if (/^\d{1,5}$/.test(p)) {
        port = Number(p)
        host = host.slice(0, idx)
      }
    }
  }
  if (!host || port <= 0 || port > 65535) return null
  return { host: host.toLowerCase(), port }
}

/**
 * Start the egress guard. Returns the bound port (0 = let the OS choose, which
 * is what callers should do: one proxy per session, no port collisions).
 */
export async function startBrowserEgressProxy(
  policy: BrowserPolicy,
  opts: { port?: number; onDecision?: (e: EgressLogEntry) => void } = {},
): Promise<EgressProxyHandle> {
  const log: EgressLogEntry[] = []
  const record = (target: string, allowed: boolean, reason?: string) => {
    const entry: EgressLogEntry = { at: new Date().toISOString(), target, allowed, reason }
    log.push(entry)
    if (log.length > LOG_CAP) log.splice(0, log.length - LOG_CAP)
    if (!allowed) {
      console.warn(`[card-browser] BLOCKED ${target}: ${reason}`)
    }
    opts.onDecision?.(entry)
  }

  /** One gate for both request shapes. Resolves, decides, pins the address. */
  const check = async (
    scheme: string,
    host: string,
    port: number,
  ): Promise<{ ok: true; ip: string } | { ok: false; reason: string }> => {
    const label = `${scheme}://${host}:${port}`
    // Decide on the NAME first, with no addresses. This catches the metadata
    // hosts, the blocklist and the allowlist, so an off-policy destination is
    // refused before we do a DNS lookup for it — the refusal does not depend
    // on name resolution working (CI runners often have none), and we do not
    // leak the attempted hostname to the resolver.
    const preflight = decideEgress(policy, { scheme, host, port }, [])
    if (!preflight.allow) {
      record(label, false, preflight.reason)
      return { ok: false, reason: preflight.reason }
    }
    let ips: string[]
    try {
      ips = await resolveTarget(host)
    } catch (err) {
      const reason = `could not resolve ${host}: ${(err as Error).message}`
      record(label, false, reason)
      return { ok: false, reason }
    }
    if (ips.length === 0) {
      const reason = `${host} resolved to no addresses`
      record(label, false, reason)
      return { ok: false, reason }
    }
    const decision = decideEgress(policy, { scheme, host, port }, ips)
    if (!decision.allow) {
      record(label, false, decision.reason)
      return { ok: false, reason: decision.reason }
    }
    record(label, true)
    // Pin: connect to the address we judged, never re-resolve.
    return { ok: true, ip: ips[0] }
  }

  const server = http.createServer()

  // Plain HTTP through a proxy arrives as an absolute-URI request line.
  server.on('request', (req, res) => {
    void (async () => {
      let url: URL
      try {
        url = new URL(req.url && /^https?:\/\//i.test(req.url) ? req.url : `http://${req.headers.host}${req.url ?? '/'}`)
      } catch {
        res.writeHead(400, { 'content-type': 'text/plain' })
        res.end('card-browser egress guard: unparseable request\n')
        return
      }
      const scheme = url.protocol.replace(':', '')
      const port = url.port ? Number(url.port) : scheme === 'https' ? 443 : 80
      const verdict = await check(scheme, url.hostname, port)
      if (!verdict.ok) {
        res.writeHead(403, { 'content-type': 'text/plain' })
        res.end(`card-browser egress guard: ${verdict.reason}\n`)
        return
      }
      const upstream = http.request(
        {
          host: verdict.ip,
          port,
          method: req.method,
          path: url.pathname + url.search,
          headers: { ...req.headers, host: url.host },
        },
        (up) => {
          res.writeHead(up.statusCode || 502, up.headers)
          up.pipe(res)
        },
      )
      upstream.on('error', (err) => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
        res.end(`card-browser egress guard: upstream error: ${err.message}\n`)
      })
      req.pipe(upstream)
    })()
  })

  // HTTPS (and anything else Chromium tunnels) arrives as CONNECT.
  server.on('connect', (req, clientSocket, head) => {
    void (async () => {
      const authority = parseAuthority(req.url ?? '', 443)
      if (!authority) {
        clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
        return
      }
      const verdict = await check('https', authority.host, authority.port)
      if (!verdict.ok) {
        // 403 on the CONNECT: Chromium surfaces this to the page as a navigation
        // failure, which is exactly what we want the agent to see.
        clientSocket.end(
          'HTTP/1.1 403 Forbidden\r\n' +
          'Content-Type: text/plain\r\n' +
          'Connection: close\r\n\r\n' +
          `card-browser egress guard: ${verdict.reason}\n`,
        )
        return
      }
      const upstream = net.connect(authority.port, verdict.ip, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head && head.length) upstream.write(head)
        upstream.pipe(clientSocket)
        clientSocket.pipe(upstream)
      })
      const bail = () => { upstream.destroy(); clientSocket.destroy() }
      upstream.on('error', bail)
      clientSocket.on('error', bail)
    })()
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port ?? 0, '127.0.0.1', () => resolve())
  })
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0

  return {
    port,
    log,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}

// ── Process-wide lifecycle ───────────────────────────────────────────────────
//
// One guard per server process, started at boot and shared by every card
// browser (they all run as `ccuser` inside this container, so 127.0.0.1 is the
// same loopback). The port is fixed rather than ephemeral so the MCP config
// writer — which is synchronous, and runs long after boot — can name it without
// awaiting anything.

/** Default loopback port for the guard. Override with CARD_BROWSER_PROXY_PORT. */
export const DEFAULT_EGRESS_PROXY_PORT = 3099

let shared: EgressProxyHandle | null = null

export function browserEgressProxyPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.CARD_BROWSER_PROXY_PORT)
  return Number.isInteger(raw) && raw > 0 && raw < 65536 ? raw : DEFAULT_EGRESS_PROXY_PORT
}

/** The running guard, or null if it was never started / failed to start. */
export function sharedBrowserEgressProxy(): EgressProxyHandle | null {
  return shared
}

/**
 * Start the shared guard. Called once from the server's boot path.
 * Returns null when the policy has the guard switched off — which is a
 * deliberate operator choice, logged by resolveBrowserPolicy's warnings.
 * A start FAILURE throws: booting with the guard silently absent would leave
 * the card browser with unrestricted egress while the config still claimed
 * otherwise, which is precisely the fail-quiet this module exists to prevent.
 */
export async function startSharedBrowserEgressProxy(
  policy: BrowserPolicy,
  env: NodeJS.ProcessEnv = process.env,
): Promise<EgressProxyHandle | null> {
  if (!policy.egressGuard) return null
  if (shared) return shared
  shared = await startBrowserEgressProxy(policy, { port: browserEgressProxyPort(env) })
  console.log(
    `[card-browser] egress guard listening on 127.0.0.1:${shared.port}; ` +
    `${policy.allowedOrigins.length} allowed origin pattern(s), ` +
    `${policy.blockedOrigins.length} blocked`,
  )
  for (const w of policy.warnings) console.warn(`[card-browser] ${w}`)
  return shared
}

/** Test/shutdown helper. */
export async function stopSharedBrowserEgressProxy(): Promise<void> {
  if (!shared) return
  await shared.close()
  shared = null
}
