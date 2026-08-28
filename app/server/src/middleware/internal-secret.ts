/**
 * Internal-route shared-secret gate (audit B5 / threat T6).
 *
 * Several localhost-only internal routes (routines CRUD, deploy/restart,
 * test-credential plaintext fetch) historically trusted network origin alone
 * (127.0.0.1 / ::1 / 172.x.0.1). That meant ANY in-container session able to
 * `curl localhost` could create routines, restart/redeploy the server, and read
 * decrypted test credentials with no token. This adds a required shared secret
 * (`X-Internal-Secret` header, constant-time compared against env
 * `INTERNAL_API_SECRET`) on top of — not instead of — the localhost check.
 *
 * Mirrors the existing `checkServiceAuth` pattern in routes/internal.ts
 * (MENTOR_SERVICE_TOKEN bridge), but exposed as a reusable middleware so the
 * three surfaces share one implementation.
 */
import crypto from 'crypto'
import type { Request, Response } from 'express'

// Non-production fallback so local dev / the Vitest suite / first-party callers
// all agree on a value without requiring Doppler. This is NOT a production
// secret: assertInternalApiSecret() fails boot if INTERNAL_API_SECRET is unset
// in production, so this constant can never be the live value there.
const DEV_FALLBACK = 'dev-internal-secret-not-for-production'

/**
 * Resolve the internal API shared secret. In production this comes only from
 * `INTERNAL_API_SECRET` (enforced at boot by assertInternalApiSecret). In
 * non-production we fall back to a fixed dev value so callers and the gate stay
 * in sync without external secret config.
 */
export function getInternalApiSecret(): string {
  const fromEnv = process.env.INTERNAL_API_SECRET
  if (fromEnv && fromEnv.length > 0) return fromEnv
  return DEV_FALLBACK
}

/**
 * Fail boot if the secret is missing in production. Internal routes are
 * unauthenticated without it, so an unset secret in production is a hard error
 * rather than a silent downgrade. Call once at startup.
 */
export function assertInternalApiSecret(): void {
  if (process.env.NODE_ENV === 'production' && !process.env.INTERNAL_API_SECRET) {
    throw new Error(
      'INTERNAL_API_SECRET is required in production: internal localhost routes ' +
        '(routines, deploy/restart, test-credentials fetch) would otherwise be unauthenticated.'
    )
  }
}

/** Constant-time string compare; false (not throw) on length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) return false
  return crypto.timingSafeEqual(ab, bb)
}

/**
 * True when the request carries the correct `X-Internal-Secret` header
 * (header lookup is case-insensitive; comparison is constant-time).
 */
export function hasValidInternalSecret(req: Request): boolean {
  const provided = req.header('x-internal-secret')
  if (!provided) return false
  return safeEqual(provided, getInternalApiSecret())
}

/**
 * Require the shared secret on an internal route. Writes a 401 and returns
 * false when the header is missing/invalid; returns true when the request may
 * proceed. Callers keep their own localhost (network-origin) check as
 * defense-in-depth — the secret is now required IN ADDITION to localhost.
 */
export function requireInternalSecret(req: Request, res: Response): boolean {
  if (!hasValidInternalSecret(req)) {
    res.status(401).json({ error: 'Invalid or missing internal API secret' })
    return false
  }
  return true
}
