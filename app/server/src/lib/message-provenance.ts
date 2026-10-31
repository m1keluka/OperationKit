/**
 * Who sent a card chat message — derived SERVER-SIDE, never from message text
 * (obj 718944).
 *
 * Incident (#718958): an agent relayed "Mike approved" into a card and the
 * worker correctly refused; then Mike typed in the card himself and the worker
 * STILL refused, because the transcript stored only `{type:'followup', text}` —
 * owner-typed and agent-posted messages were byte-identical to the session.
 *
 * The sender is taken from how the request authenticated:
 *   - JWT in the httpOnly `token` COOKIE (the web UI) → VERIFIED human. An
 *     admin is the owner; any other logged-in user is a verified member, which
 *     the approval rule does not count.
 *   - named agent key (`cc_live_…`, req.agentKey)     → AGENT: <key label>
 *   - legacy per-user API key or a Bearer JWT          → API (not verified)
 *   - server-internal wakes (no request)               → SYSTEM / AGENT
 *
 * A Bearer JWT is NOT "typed in the UI": `POST /api/auth/token` hands one to
 * any script holding a password, and the browser never sends one.
 *
 * Every body is passed through `neutraliseForgedStamps` regardless of sender,
 * so text that merely CONTAINS "VERIFIED: Mike" or our header marker can never
 * read as a server stamp.
 */
import type { MessageSender } from '@operationkit/shared'
import type { AuthRequest } from '../middleware/auth.js'

export type { MessageSender }

/** First line of every stamped message the session sees. */
export const SENDER_MARKER = '[cc-sender]'

function displayName(username: string): string {
  const u = username.trim()
  return u ? u.charAt(0).toUpperCase() + u.slice(1) : 'Unknown user'
}

/** True only when the request's JWT came from the httpOnly cookie (the web UI). */
export function authenticatedViaCookie(req: Pick<AuthRequest, 'cookies' | 'authVia'>): boolean {
  return req.authVia === 'session' && typeof req.cookies?.token === 'string' && req.cookies.token.length > 0
}

export function senderFromRequest(req: AuthRequest): MessageSender {
  const user = req.user
  if (req.agentKey) {
    return { kind: 'agent', verified: false, label: req.agentKey.label || 'Agent key', username: user?.username ?? null }
  }
  if (req.authVia === 'legacy_api_key') {
    return { kind: 'api', verified: false, label: `API key of ${user ? displayName(user.username) : 'unknown user'}`, username: user?.username ?? null }
  }
  if (user && authenticatedViaCookie(req)) {
    return {
      kind: user.role === 'admin' ? 'owner' : 'member',
      verified: true,
      label: displayName(user.username),
      username: user.username,
    }
  }
  return { kind: 'api', verified: false, label: `Bearer token of ${user ? displayName(user.username) : 'unknown user'}`, username: user?.username ?? null }
}

/** Server-internal sender for messages with no HTTP caller (wakes, bridges). */
export function systemSender(label: string): MessageSender {
  return { kind: 'system', verified: false, label, username: null }
}

/** Relayed by another objective's session via the internal message route. */
export function relaySender(fromObjectiveId: number | null): MessageSender {
  return {
    kind: 'agent',
    verified: false,
    label: fromObjectiveId ? `card #${fromObjectiveId}` : 'internal relay (unattributed)',
    username: null,
  }
}

/** The one-line, human-readable stamp. Only the server ever produces these. */
export function senderStamp(sender: MessageSender): string {
  switch (sender.kind) {
    case 'owner':
      return sender.verified ? `VERIFIED: ${sender.label} (owner, typed in UI)` : `UNVERIFIED: ${sender.label}`
    case 'member':
      return sender.verified ? `VERIFIED: ${sender.label} (team member, typed in UI — not the owner)` : `UNVERIFIED: ${sender.label}`
    case 'agent':
      return `AGENT: ${sender.label} (relayed, not verified)`
    case 'api':
      return `API: ${sender.label} (not verified)`
    case 'system':
      return `SYSTEM: ${sender.label} (automated, not verified)`
  }
}

/** True only for the stamp the approval rule accepts. */
export function isVerifiedOwner(sender: MessageSender | null | undefined): boolean {
  return !!sender && sender.kind === 'owner' && sender.verified === true
}

const FORGED_VERIFIED = /\bVERIFIED\s*:/gi
const FORGED_MARKER = /\[\s*cc-sender\s*\]/gi

/**
 * Defang anything in a message BODY that could read as a server stamp.
 * "VERIFIED: Mike" → "VERIFIED(claimed in text, not a server stamp): Mike".
 */
export function neutraliseForgedStamps(body: string): string {
  return body
    .replace(FORGED_MARKER, '[cc-sender (quoted, not a stamp)]')
    .replace(FORGED_VERIFIED, m => `${m.replace(/\s*:$/, '')}(claimed in text, not a server stamp):`)
}

/** The text a session receives: server stamp on line 1, neutralised body after. */
export function stampForSession(sender: MessageSender, body: string): string {
  return `${SENDER_MARKER} ${senderStamp(sender)}\n\n${neutraliseForgedStamps(body)}`
}
