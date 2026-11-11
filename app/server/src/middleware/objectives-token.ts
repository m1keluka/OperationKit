/**
 * Objectives-create bearer-token gate (obj 702304).
 *
 * `POST /api/internal/objectives` was localhost-only (network origin) so only
 * on-box callers (kitchen-loop, meeting-queue, planner sessions) could create
 * board cards. The Cattle AI thread self-improvement scanner runs on a DIFFERENT
 * host (the example2-ops droplet) and must POST proposed fix-objectives cross-host.
 *
 * Rather than widen the localhost trust boundary, we mint a SEPARATE, narrowly
 * scoped bearer token — `OBJECTIVES_API_TOKEN` — that authorizes ONLY
 * objective-create (never deploy/restart/test-credentials, which stay behind
 * `INTERNAL_API_SECRET`). A request is accepted when it carries a valid
 * `Authorization: Bearer <OBJECTIVES_API_TOKEN>` OR originates from localhost;
 * otherwise the create route returns 401. The token is optional: when
 * `OBJECTIVES_API_TOKEN` is unset the route degrades to the previous
 * localhost-only behaviour, so existing first-party callers are never broken.
 *
 * Mirrors the constant-time-compare shape of middleware/internal-secret.ts.
 */
import crypto from 'crypto'
import fs from 'fs'
import type { Request } from 'express'

/** Default file-secret location (mounted data volume). */
const DEFAULT_TOKEN_FILE = '/app/data/objectives-api-token'

/**
 * The configured objective-create token, or null when unset/blank.
 *
 * Resolves from `OBJECTIVES_API_TOKEN` first; if unset, falls back to a
 * file-based secret (Docker-secret style) at `$OBJECTIVES_API_TOKEN_FILE` or
 * `/app/data/objectives-api-token`. The file fallback exists because a NEW env
 * var only reaches the process when the doppler-run PID1 restarts (a full
 * container restart), whereas a mounted secret file is read live on each call —
 * so the token can be provisioned/rotated without a container restart. Read per
 * request (not cached) so rotation takes effect immediately.
 */
export function getObjectivesApiToken(): string | null {
  const fromEnv = process.env.OBJECTIVES_API_TOKEN
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim()
  const file = process.env.OBJECTIVES_API_TOKEN_FILE || DEFAULT_TOKEN_FILE
  try {
    const v = fs.readFileSync(file, 'utf8').trim()
    return v.length > 0 ? v : null
  } catch {
    return null
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
 * True when the request carries a valid `Authorization: Bearer <token>` matching
 * `OBJECTIVES_API_TOKEN`. Header parsing is case-insensitive on both the header
 * name and the `Bearer` scheme; the comparison is constant-time. Returns false
 * when no token is configured, so an unset env var never authorizes a caller.
 */
export function hasValidObjectivesToken(req: Request): boolean {
  const expected = getObjectivesApiToken()
  if (!expected) return false
  const header = req.header('authorization') || ''
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  if (!match) return false
  const provided = match[1].trim()
  if (!provided) return false
  return safeEqual(provided, expected)
}
