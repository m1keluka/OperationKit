/**
 * Single front door for every `/api/internal/*` route (obj 900027).
 *
 * ## Why this exists
 *
 * Before this middleware, each internal route carried its own ad-hoc
 * `if (!isLocalhost(req)) 403` check, and `isLocalhost` trusted
 * `X-Forwarded-For`. A remote client could therefore send
 * `X-Forwarded-For: 127.0.0.1` and reach `/api/internal/pr-health`,
 * `/api/internal/objectives` and `/api/internal/reviews/:id/criteria`
 * unauthenticated (verified live from outside the host — all three returned
 * 200). `lib/is-localhost.ts` now makes the origin check non-spoofable; this
 * middleware makes it impossible for a NEW internal route to ship without any
 * gate at all, by enforcing one centrally ahead of the routers.
 *
 * ## The policy
 *
 * A request reaches an internal router only if it is credentialled OR genuinely
 * on-box:
 *
 *  - **`X-Internal-Secret`** matching `INTERNAL_API_SECRET` — the explicit
 *    shared secret. Works from anywhere, including through the proxy.
 *  - **`Authorization: Bearer <OBJECTIVES_API_TOKEN>`** — the narrowly scoped
 *    cross-host objective-create token (obj 702304). The create route still
 *    re-validates it; the gate only lets it past so cross-host callers on the
 *    example2-ops droplet keep working.
 *  - **A genuine local socket** with no forwarding headers (`isLocalhost`).
 *    This is what first-party on-box callers use today — cron, the state
 *    poller, in-container sessions running `curl localhost:3002`, the shell
 *    scripts under `scripts/`. None of them send a secret, and there are ~60
 *    such call sites across prompts, docs and shell scripts, so making the
 *    secret unconditionally mandatory would break the platform on deploy.
 *
 * ## Ratchet
 *
 * `INTERNAL_API_REQUIRE_SECRET=1` drops the bare-localhost allowance so
 * `X-Internal-Secret` (or the objectives token) is required from EVERY caller,
 * local included. It is off by default precisely because of those ~60 call
 * sites; the in-repo server-side callers have been updated to send the secret
 * (see `lib/internal-api-headers.ts`), so the flag can be switched on once the
 * prompt/doc/script call sites follow.
 *
 * Per-route `isLocalhost` checks are deliberately left in place behind this —
 * defense in depth, and several routes need a finer-grained rule than the gate.
 */
import type { NextFunction, Request, Response } from 'express'
import { isLocalhost } from '../lib/is-localhost.js'
import { hasValidInternalSecret } from './internal-secret.js'
import { hasValidObjectivesToken } from './objectives-token.js'

/** True when bare-localhost is no longer sufficient and a credential is required. */
export function internalApiRequiresSecret(): boolean {
  return process.env.INTERNAL_API_REQUIRE_SECRET === '1'
}

/** True when the request carries a credential valid for the internal surface. */
export function hasInternalApiCredential(req: Request): boolean {
  return hasValidInternalSecret(req) || hasValidObjectivesToken(req)
}

/**
 * Express middleware. Mount ONCE at `/api/internal`, ahead of every internal
 * router, so a route added later is gated by construction.
 */
export function internalApiGate(req: Request, res: Response, next: NextFunction): void {
  if (hasInternalApiCredential(req)) {
    next()
    return
  }
  if (!internalApiRequiresSecret() && isLocalhost(req)) {
    next()
    return
  }
  res.status(403).json({
    error: 'Internal API: local origin or X-Internal-Secret required',
  })
}
