/**
 * CSRF state for the DCR/CIMD authorization-code round-trip (Sprint 7.3, obj
 * 900507). Mirrors services/user-google-connections.ts's `signState` /
 * `verifyState`: the consent round-trip leaves our origin, so the callback
 * cannot trust a cookie. A short-lived JWT signed with JWT_SECRET binds the
 * flow to the user AND connector that started it, and carries the PKCE code
 * verifier so the callback (routes/user-dcr.ts) never has to persist it
 * server-side between the redirect out and the redirect back.
 */
import jwt from 'jsonwebtoken'
import { getJwtSecret } from '../middleware/auth.js'

interface DcrStatePayload {
  uid: number
  connector: string
  verifier: string
}

export function signDcrState(userId: number, connectorId: string, codeVerifier: string): string {
  return jwt.sign(
    { uid: userId, connector: connectorId, verifier: codeVerifier } satisfies DcrStatePayload,
    getJwtSecret(),
    { expiresIn: '15m' },
  )
}

/** Verify a callback `state`. Returns the payload, or null if forged/expired/mismatched. */
export function verifyDcrState(state: string, expectedConnectorId: string): DcrStatePayload | null {
  try {
    const decoded = jwt.verify(state, getJwtSecret()) as DcrStatePayload
    if (typeof decoded.uid !== 'number' || typeof decoded.verifier !== 'string') return null
    if (decoded.connector !== expectedConnectorId) return null
    return decoded
  } catch {
    return null
  }
}
