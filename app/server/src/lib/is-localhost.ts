import type { Request } from 'express'

/**
 * Internal-API origin check.
 *
 * Trusts:
 *  - 127.0.0.1 / ::1 — process-local loopback
 *  - 172.x.0.1 — Docker host gateway (default bridge and compose networks).
 *    Sessions inside the command-center container hit the Node server via this
 *    gateway, not 127.0.0.1, so loopback-only would lock them out of
 *    POST /api/internal/deploy and sibling localhost-gated routes.
 *
 * Copies of this helper in routes/ previously lived in internal.ts (canonical
 * export), test-credentials.ts, and reviews.ts. Those now import this module.
 */
export function isLocalhost(req: Request): boolean {
  const ip = req.ip || req.socket.remoteAddress || ''
  const raw = ip.replace('::ffff:', '')
  return raw === '127.0.0.1' || ip === '::1' || /^172\.\d+\.0\.1$/.test(raw)
}
