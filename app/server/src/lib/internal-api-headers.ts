/**
 * Headers for server-side calls the Node process makes BACK into its own
 * `/api/internal/*` surface over loopback (obj 900027).
 *
 * These callers already satisfy the localhost half of `internalApiGate`, but
 * they also send `X-Internal-Secret` so the stricter
 * `INTERNAL_API_REQUIRE_SECRET=1` mode can be switched on without breaking
 * them. Use this helper for any new in-process call to `/api/internal/*`.
 */
import { getInternalApiSecret } from '../middleware/internal-secret.js'

export function internalApiHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { 'X-Internal-Secret': getInternalApiSecret(), ...extra }
}
