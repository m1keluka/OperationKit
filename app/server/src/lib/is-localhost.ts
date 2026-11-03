import type { Request } from 'express'

/**
 * Internal-API origin check — SOCKET-BASED, NOT header-based (obj 900027).
 *
 * ## The hole this closes
 *
 * `index.ts` sets `trust proxy` so `req.ip` reflects the real client behind
 * Caddy/cloudflared. Under that setting Express derives `req.ip` from the
 * `X-Forwarded-For` chain, which is entirely client-controlled. The previous
 * implementation read `req.ip` FIRST, so ANY remote client could send
 * `X-Forwarded-For: 127.0.0.1` and be treated as a first-party on-box caller —
 * reaching `/api/internal/*` (pr-health, reviews, objectives, …) with no
 * credentials at all. Verified live from outside the host: all three returned
 * 200 with the spoofed header and nothing else.
 *
 * ## The rule now
 *
 * A request is "local" only when BOTH hold:
 *
 *  1. The **TCP peer address** (`req.socket.remoteAddress` — never `req.ip`,
 *     which is forwarded-header derived whenever `trust proxy` is on) is
 *     loopback (`127.0.0.0/8`, `::1`) or the Docker bridge gateway
 *     (`172.x.0.1`). Published container ports are DNAT'd, so host-side callers
 *     reach Node from the gateway address rather than 127.0.0.1 — the gateway
 *     must stay trusted or in-container sessions lose
 *     `POST /api/internal/deploy` and its siblings.
 *  2. The request carries **no proxy-forwarding headers at all**. This half is
 *     load-bearing: Caddy and cloudflared both terminate on the host and dial
 *     `localhost:3002`, so an externally-proxied request ALSO presents a
 *     loopback/gateway peer address. What separates it from a genuine on-box
 *     caller is that every reverse proxy in front of us stamps
 *     `X-Forwarded-For`/`X-Forwarded-Proto` unconditionally (Caddy's
 *     `reverse_proxy` and cloudflared both append to, never replace, an
 *     inbound chain), while `curl`/`fetch` from inside the box send none. A
 *     remote client cannot suppress a header the proxy adds downstream of it.
 *
 * Net effect: a forwarding header can now only ever make a request LESS
 * trusted, never more. `X-Forwarded-For: 127.0.0.1` fails from a remote socket
 * AND from a loopback socket.
 *
 * Non-local callers may still reach `/api/internal/*` by presenting the
 * `X-Internal-Secret` shared secret — see `middleware/internal-api-gate.ts`.
 */

/** Proxy/forwarding headers. Presence of ANY means the request was proxied. */
export const FORWARDING_HEADERS = [
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-real-ip',
  'forwarded',
  'cf-connecting-ip',
  'cf-ray',
  'true-client-ip',
] as const

/** True when the request carries any proxy-forwarding header. */
export function hasForwardingHeaders(req: Request): boolean {
  const headers = (req.headers ?? {}) as Record<string, unknown>
  return FORWARDING_HEADERS.some((h) => {
    const v = headers[h]
    if (v == null) return false
    if (typeof v === 'string') return v.length > 0
    if (Array.isArray(v)) return v.length > 0
    return true
  })
}

/**
 * The TCP peer address, normalized. Deliberately does NOT consult `req.ip`:
 * `req.ip` is forwarded-header derived whenever `trust proxy` is on, which is
 * exactly the spoofable input this module exists to stop trusting.
 */
export function socketRemoteAddress(req: Request): string {
  const raw = req.socket?.remoteAddress || ''
  return raw.replace(/^::ffff:/, '')
}

/** Loopback or Docker-bridge-gateway peer address. */
export function isTrustedPeerAddress(addr: string): boolean {
  if (addr === '::1') return true
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(addr)) return true
  if (/^172\.\d{1,3}\.0\.1$/.test(addr)) return true
  return false
}

/**
 * True only for a genuine on-box caller: trusted peer address AND no
 * forwarding headers. See the module docblock for why both halves are needed.
 */
export function isLocalhost(req: Request): boolean {
  if (hasForwardingHeaders(req)) return false
  return isTrustedPeerAddress(socketRemoteAddress(req))
}
