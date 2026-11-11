/**
 * Who may open a websocket? (obj 719935, obj 900108)
 *
 * Its own module, not part of `ws/index.ts`, for two reasons: the rule is the
 * whole security decision for the live board and the admin shell, and
 * `ws/index.ts` pulls in node-pty, so testing the rule there would mean
 * standing up a terminal.
 */
import type { IncomingHttpHeaders } from 'http'
import { parse as parseCookie } from 'cookie'
import { verifyToken } from '../middleware/auth.js'
import { cfAccessIdentifies } from '../lib/cf-access-identity.js'
import type { User } from '@operationkit/shared'

/**
 * The user this upgrade may act as, or null to refuse it.
 *
 * A one-time-setup-password session gets no live board and no shell. A person
 * Cloudflare Access verified is NOT that: they never typed the setup password,
 * so a `pwc` cookie left over from one is not a reason to refuse them — but
 * only when THIS upgrade still carries a valid Access assertion for them.
 * Without Access configured nothing changes: `cfAccessIdentifies` is false and
 * the flagged session is refused exactly as before.
 */
export async function authorizeUpgrade(headers: IncomingHttpHeaders): Promise<User | null> {
  const cookies = parseCookie(headers.cookie || '')
  const user = verifyToken(cookies.token || '')
  if (!user) return null
  if (user.must_change_password && !user.via_cf_access && !(await cfAccessIdentifies(headers, user.id))) {
    return null
  }
  const { via_cf_access: _cfaClaim, ...plain } = user
  return plain
}
