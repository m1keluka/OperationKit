/**
 * session-file-access — lets a CARD SESSION reach its own workspace's
 * knowledge-base files with the objective-scoped token the server already
 * mints for it (`CC_SESSION_TOKEN`). obj 900204.
 *
 * ## The bug
 *
 * With `SESSION_ISOLATION=docker` a session runs in a sibling container whose
 * ONLY binds are its own worktree (`/workspace`) and its own HOME
 * (`/home/jailuser`) — see services/session-jail.ts. The vault is NOT one of
 * them, and it never will be: adding a third bind means a compose change, a
 * rebuild, and a host path the session would have to guess. Yet the spawn
 * prompt told every session "Knowledge base is at ~/second-brain/" and
 * "write a decision doc to ~/second-brain/workspaces/<ws>/decisions/". Both
 * paths are absent inside the jail, so cards could not find files that plainly
 * exist in the KB (the Connections.csv report that opened this card) and
 * MANDATORY vault capture silently failed on every jailed run.
 *
 * ## The fix
 *
 * Nothing new serves bytes. The control plane ALREADY exposes two
 * permission-checked, workspace-scoped file surfaces, and a jailed session can
 * already reach the control plane over its loopback forwarder
 * (`http://localhost:3002`, obj 900113):
 *
 *   - `/api/files`  — read-only search / stat / download of NON-markdown files
 *                     (csv, pdf, pptx, xlsx, images). Policy in
 *                     services/file-access.ts: root allowlist, denylist,
 *                     realpath-after-resolve so `..` and escaping symlinks are
 *                     rejected.
 *   - `/api/docs`   — the markdown knowledge base: tree / file / search, and
 *                     PUT /file so vault capture works from a jail.
 *
 * Both were gated on `requireAuth`, which a session has no credential for. This
 * middleware adds the missing credential path and NOTHING else: present a valid
 * `X-CC-Session-Token`, get the authenticated identity of that card, scoped to
 * that card's ONE workspace.
 *
 * ## Why this is not a privilege hole
 *
 *  - The workspace is read from the OBJECTIVE ROW at request time, never from
 *    the request and never from the (possibly stale) token claim. A session
 *    cannot name another workspace; `?workspace=` is rejected unless it equals
 *    its own.
 *  - The principal is DE-ESCALATED to `role: 'user'` even when the acting user
 *    is an admin. Both routers branch on `role === 'admin'` to mean "every root
 *    on the box"; a card must never inherit that. `requireAdmin` is additionally
 *    hard-denied for this principal.
 *  - SYSTEM roots (service configs, logs, crontabs, `.env*`) are stripped from
 *    the scope. They are not workspace knowledge and a card has no business in
 *    them.
 *  - The token is HMAC'd under a key derived from JWT_SECRET under its own
 *    label and cannot be replayed as a login JWT. Whenever it is minted the
 *    spawn env drops JWT_SECRET (`stripServerSigningSecrets`), so a session
 *    cannot forge a token for a workspace it was not given.
 *  - Membership: when the card has an acting user, that user must actually be a
 *    member of the objective's workspace (admins pass). Workspace membership is
 *    the cross-USER guard; the objective row is the cross-WORKSPACE guard.
 *
 * Mounted BEFORE `requireAuth` on each router, and a no-op when no session
 * token is present — so every existing cookie / API-key caller is unchanged.
 */
import type { NextFunction, Response } from 'express'
import type { User } from '@operationkit/shared'
import { getDb } from '../db/index.js'
import { SESSION_KB_ACCESS_FLAG, sessionKbAccessEnabled, sessionTokenFromHeaders, verifySessionToken } from '../lib/session-trust.js'

export { SESSION_KB_ACCESS_FLAG, sessionKbAccessEnabled }
import { userHasWorkspace } from './workspace.js'
import { requireAuth, type AuthRequest } from './auth.js'

export interface SessionFilePrincipal {
  objectiveId: number
  /** The ONE workspace this request may touch. From the objective row. */
  workspace: string
}

declare module 'express-serve-static-core' {
  interface Request {
    /** Set only when the caller authenticated with a card's CC_SESSION_TOKEN. */
    sessionFile?: SessionFilePrincipal
  }
}

/** The single workspace a session-token caller is confined to, or null for everyone else. */
export function sessionFileWorkspace(req: AuthRequest): string | null {
  return req.sessionFile?.workspace ?? null
}

const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/i

/**
 * Express middleware. No token → `next()` untouched. Token present → it must be
 * valid and authorised, otherwise the request is refused here (we never fall
 * through to `requireAuth` with a bad session token, which would otherwise read
 * as a plain 401 "Authentication required" and hide the real reason).
 */
export function sessionFileAuth(req: AuthRequest, res: Response, next: NextFunction): void {
  const token = sessionTokenFromHeaders(req.headers as Record<string, string | string[] | undefined>)
  if (!token) {
    next()
    return
  }
  if (!sessionKbAccessEnabled()) {
    res.status(403).json({ error: 'Session knowledge-base access is disabled on this install', code: 'session_kb_disabled' })
    return
  }
  const claims = verifySessionToken(token)
  if (!claims) {
    res.status(401).json({ error: 'Invalid or expired session token', code: 'bad_session_token' })
    return
  }

  let objective: { id: number; workspace: string | null } | undefined
  let user: User | undefined
  try {
    const db = getDb()
    objective = db.prepare('SELECT id, workspace FROM objectives WHERE id = ?').get(claims.objectiveId) as
      | { id: number; workspace: string | null }
      | undefined
    if (claims.actingUserId != null) {
      user = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(claims.actingUserId) as User | undefined
    }
  } catch {
    res.status(503).json({ error: 'Session token could not be resolved', code: 'session_lookup_failed' })
    return
  }

  if (!objective) {
    res.status(401).json({ error: 'Session token references an objective that no longer exists', code: 'bad_session_token' })
    return
  }

  // The LIVE row, never the claim: a card moved between workspaces must follow
  // the move, and a token minted before the move must not keep the old scope.
  const workspace = (objective.workspace || '').trim()
  if (!workspace || !SLUG.test(workspace)) {
    res.status(403).json({ error: 'This card has no workspace, so it has no knowledge-base scope', code: 'no_workspace' })
    return
  }

  // Cross-USER guard. A card with no acting user is still a server-minted card;
  // its scope is the objective's workspace and that is authority enough.
  if (user && user.role !== 'admin' && !userHasWorkspace(user.id, workspace)) {
    res.status(403).json({ error: `No access to workspace '${workspace}'`, code: 'workspace_forbidden' })
    return
  }

  req.sessionFile = { objectiveId: objective.id, workspace }
  // De-escalated principal: never 'admin', whoever the acting user is.
  req.user = {
    id: user?.id ?? 0,
    username: user ? `session:${objective.id}:${user.username}` : `session:${objective.id}`,
    role: 'member',
  } as User
  req.authVia = 'session_token'
  next()
}

/**
 * The auth gate both file routers mount: `sessionFileAuth`, then `requireAuth`
 * ONLY for callers it did not authenticate.
 *
 * Mounting the two as separate `router.use()` layers does not work:
 * `requireAuth` re-reads the credential from the cookie / `Authorization`
 * header, finds neither, and 401s the session caller the previous layer just
 * accepted. Composing them keeps `requireAuth` itself untouched — no global
 * "skip auth when this property is set" hole — while making the precedence
 * explicit in one place.
 */
export function sessionOrRequireAuth(req: AuthRequest, res: Response, next: NextFunction): void {
  sessionFileAuth(req, res, () => {
    if (req.sessionFile) {
      next()
      return
    }
    void requireAuth(req, res, next)
  })
}
