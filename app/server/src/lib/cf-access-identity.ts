/**
 * Who is this request, according to Cloudflare Access? (obj 900108)
 *
 * `routes/auth.ts` POST /cloudflare-access turns a verified Access assertion
 * into a session cookie. That only helps a browser with NO app session yet.
 * Someone who once signed in with the one-time setup password is carrying a
 * `pwc` cookie — and a `must_change_password` row — so the app keeps asking
 * them for a password they have never had: Cloudflare is what verifies them.
 *
 * This module is the second reader of the same header, used on the rare paths
 * where the setup-password gate is about to bite (`requireAuth`, `GET /me`,
 * the websocket upgrade). It answers one question — "does a VERIFIED Access
 * identity on this request belong to this exact user?" — and answers `false`
 * whenever anything at all is off:
 *
 *   - the feature is not configured on this install (no verifier)
 *   - no `Cf-Access-Jwt-Assertion` header
 *   - the assertion fails signature / AUD / issuer / expiry (`CfAccessVerifier`)
 *   - the verified email belongs to no user, to more than one, or to someone else
 *
 * So it can only ever REMOVE a password prompt from a person Cloudflare has
 * already verified; it can never grant access to anyone, and it never creates
 * or alters a user. An install without Access configured never reaches the
 * verifier at all and behaves exactly as it did before.
 */
import type { IncomingHttpHeaders } from 'http'
import { CF_ACCESS_HEADER, getCfAccessVerifier } from './cf-access.js'
import { getDb } from '../db/index.js'

/** The raw assertion header, or undefined when it is absent. */
export function cfAccessAssertion(headers: IncomingHttpHeaders | undefined): string | undefined {
  const raw = headers?.[CF_ACCESS_HEADER]
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === 'string' && value ? value : undefined
}

/** The verified Access email on this request, or null. Null whenever the feature is off. */
export async function verifiedCfAccessEmail(headers: IncomingHttpHeaders | undefined): Promise<string | null> {
  const verifier = getCfAccessVerifier()
  if (!verifier) return null
  const assertion = cfAccessAssertion(headers)
  if (!assertion) return null
  const result = await verifier.verify(assertion)
  return result.ok ? result.email : null
}

/**
 * The single user owning this email, or null. Deliberately the same rule as the
 * sign-in route: no match and an ambiguous match both mean "nobody".
 */
export function userIdForCfAccessEmail(email: string): number | null {
  const rows = getDb()
    .prepare('SELECT id FROM users WHERE email IS NOT NULL AND lower(trim(email)) = ?')
    .all(email) as Array<{ id: number }>
  return rows.length === 1 ? rows[0].id : null
}

/**
 * True only when this request carries a verified Access identity for `userId`.
 * Any failure — feature off, missing or bad header, unknown or ambiguous email,
 * a different user's email — is false, so the caller keeps its old behaviour.
 */
export async function cfAccessIdentifies(headers: IncomingHttpHeaders | undefined, userId: number): Promise<boolean> {
  const email = await verifiedCfAccessEmail(headers)
  if (!email) return false
  return userIdForCfAccessEmail(email) === userId
}
