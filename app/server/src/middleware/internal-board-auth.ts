/**
 * Authenticated principal + hard workspace/user authorization for INTERNAL
 * BOARD READS (obj 900321, constraints C6 and C17).
 *
 * ## The hole this closes
 *
 * `middleware/internal-api-gate.ts` admits a request to `/api/internal/*` when
 * it is credentialled (`X-Internal-Secret` / `OBJECTIVES_API_TOKEN`) **or**
 * merely on-box (`isLocalhost`). That origin check is genuinely non-spoofable —
 * but `INTERNAL_TRUSTED_PEER_CIDRS` deliberately extends "on-box" to the
 * `ok-jails` docker subnet so a sandboxed card session can reach the control
 * plane (obj 900113). The consequence, reproduced first-hand from inside a jail
 * with no credential at all:
 *
 *     GET /api/internal/objectives?fields=minimal&include_terminal=0
 *       → 200, every row on the board, spanning every workspace
 *     GET /api/internal/objectives/<another workspace's card>
 *       → 200, the full row including description / acceptance_criteria /
 *         last_session_summary / ai_review_findings
 *
 * The same jail correctly answers **403** to that workspace's KB file, to
 * `/etc/passwd` and to a `../` traversal. The wall exists and is well built
 * (`services/file-access.ts`, `routes/docs.ts`); the board surface simply never
 * consulted it, because origin was the whole policy and the jail has loopback.
 *
 * `SECURITY.md` meanwhile documented `X-Internal-Secret` as required *even from
 * localhost* — a guarantee the code did not provide (C17).
 *
 * ## The policy
 *
 * Every internal board READ now resolves a PRINCIPAL and authorizes the rows it
 * is about to hand back. Four principals, in precedence order:
 *
 *  1. **`session`** — a valid `X-CC-Session-Token` (`ccs_…`), the per-card HMAC
 *     the server already mints at spawn (`lib/session-trust.ts`). Confined to
 *     ONE workspace, and authorized by TWO independent checks:
 *       - **workspace**: the LIVE `objectives.workspace` row of the card the
 *         token names — never the token claim, so a card that moved workspaces
 *         follows the move and a stale token does not keep the old scope;
 *       - **user**: when the token carries an acting user, that user must still
 *         exist AND still be a member of that workspace (admins pass). Removing
 *         the membership row revokes a RUNNING session's board access on its
 *         very next read — the revocation gap C7 describes for env-baked grants
 *         does not apply here, because this is re-checked per request.
 *     A token that is absent-but-claimed, malformed, expired, forged, points at
 *     a deleted card, or whose user lost the workspace → **fails closed**, with
 *     no fallback to localhost trust. Presenting a bad credential must never be
 *     better than presenting none.
 *
 *  2. **`server`** — `X-Internal-Secret` or the scoped `OBJECTIVES_API_TOKEN`.
 *     This is the EXPLICIT least-privilege compatibility path the genuinely
 *     server-to-server callers use (health probes, the state poller, cron,
 *     `scripts/*`, the dev-feedback bridge). Board-wide by design and recorded
 *     as such in the resolution reason, so "which callers are board-wide" is an
 *     answerable question instead of "anything on loopback".
 *
 *  3. **`local-operator`** — a genuine loopback / docker-gateway peer with no
 *     credential. The ~60 first-party on-box call sites that predate the secret
 *     (prompts, docs, shell scripts). Board-wide, and the ONLY principal the
 *     ratchet below can withdraw.
 *
 *  4. **denied** — anything else, including a peer on a sandbox CIDR with no
 *     session token. This is the C6 fix: a jail peer is on-box for *reachability*
 *     and is NOT on-box for *authority*. It must present the token it already
 *     has in its environment.
 *
 * ## Ratchet
 *
 * `CC_INTERNAL_BOARD_REQUIRE_PRINCIPAL=1`, or settings row
 * `internal_board_require_principal = '1'`, withdraws principal 3, so every
 * board read must carry a session token or the internal secret. Off by default
 * because of those first-party call sites; nothing about the C6 fix depends on
 * it — principal 4 is denied either way.
 *
 * ## Deliberately out of scope
 *
 * Reads only. Internal board WRITES (`/objectives/:id/status`, `/message`,
 * `/progress`, `/fanout`, bulk create) keep their existing gates: changing them
 * is a larger blast radius and belongs with the phase-B lifecycle work. The
 * alert surface (`GET /api/alerts` has no workspace column at all) is likewise a
 * separate change.
 */
import type { Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { getDb } from '../db/index.js'
import { isLocalhost, isTrustedPeerAddress, socketRemoteAddress, trustedPeerCidrs } from '../lib/is-localhost.js'
import { hasInternalApiCredential } from './internal-api-gate.js'
import { sessionTokenFromHeaders, verifySessionToken } from '../lib/session-trust.js'
import { userHasWorkspace } from './workspace.js'
import { isValidWorkspaceSlug } from '../lib/kb-workspace-scope.js'

export type BoardPrincipalKind = 'session' | 'server' | 'local-operator'

export interface BoardPrincipal {
  kind: BoardPrincipalKind
  /** Why this principal was granted — for logs and for the X-Board-Principal header. */
  reason: string
  /** The ONE workspace a `session` principal may see. `null` = board-wide. */
  workspace: string | null
  /** The card a `session` principal is bound to. */
  objectiveId: number | null
  actingUserId: number | null
}

export interface BoardDenial {
  status: 401 | 403 | 503
  code: string
  error: string
}

export type BoardAuthResult = { ok: true; principal: BoardPrincipal } | { ok: false; denial: BoardDenial }

export const BOARD_PRINCIPAL_REQUIRED_FLAG = 'internal_board_require_principal'

/** True when a bare on-box caller is no longer authority enough for a board read. */
export function boardPrincipalRequired(db?: Database.Database, env: NodeJS.ProcessEnv = process.env): boolean {
  const override = (env.CC_INTERNAL_BOARD_REQUIRE_PRINCIPAL || '').trim()
  if (override === '1') return true
  if (override === '0') return false
  try {
    const row = (db ?? getDb())
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(BOARD_PRINCIPAL_REQUIRED_FLAG) as { value: string } | undefined
    return row?.value === '1'
  } catch {
    return false
  }
}

/**
 * Is this peer a SANDBOX peer — reachable-but-not-authoritative?
 *
 * Loopback and the docker bridge gateway are first-party on-box callers. The
 * extra CIDRs in `INTERNAL_TRUSTED_PEER_CIDRS` are the per-session sandbox
 * network and nothing else (see `lib/is-localhost.ts`), so a peer that is
 * trusted ONLY because of that list is a session and must authenticate as one.
 */
export function isSandboxPeer(req: Request, env: NodeJS.ProcessEnv = process.env): boolean {
  const addr = socketRemoteAddress(req)
  if (!addr) return false
  if (addr === '::1') return false
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(addr)) return false
  if (/^172\.\d{1,3}\.0\.1$/.test(addr)) return false
  // Trusted at all? Then it is trusted only via the sandbox CIDR list.
  return isTrustedPeerAddress(addr, env) && trustedPeerCidrs(env).length > 0
}

/**
 * Resolve the principal for an internal board read. Never throws.
 *
 * Pure w.r.t. the response: it returns a denial rather than writing one, so the
 * route can decide the shape (and so it is unit-testable without express).
 */
export function resolveBoardPrincipal(
  req: Request,
  db?: Database.Database,
  env: NodeJS.ProcessEnv = process.env,
): BoardAuthResult {
  const token = sessionTokenFromHeaders(req.headers as Record<string, string | string[] | undefined>)

  // 1. A session token, when present, is BINDING. No fallback to origin trust.
  if (token) {
    const claims = verifySessionToken(token)
    if (!claims) {
      return { ok: false, denial: { status: 401, code: 'bad_session_token', error: 'Invalid or expired session token' } }
    }
    let objective: { id: number; workspace: string | null } | undefined
    let user: { id: number; role: string } | undefined
    try {
      const d = db ?? getDb()
      objective = d.prepare('SELECT id, workspace FROM objectives WHERE id = ?').get(claims.objectiveId) as
        | { id: number; workspace: string | null }
        | undefined
      if (claims.actingUserId != null) {
        user = d.prepare('SELECT id, role FROM users WHERE id = ?').get(claims.actingUserId) as
          | { id: number; role: string }
          | undefined
      }
    } catch {
      return { ok: false, denial: { status: 503, code: 'session_lookup_failed', error: 'Session token could not be resolved' } }
    }
    if (!objective) {
      return {
        ok: false,
        denial: { status: 401, code: 'bad_session_token', error: 'Session token references an objective that no longer exists' },
      }
    }
    const workspace = (objective.workspace || '').trim()
    if (!isValidWorkspaceSlug(workspace)) {
      return { ok: false, denial: { status: 403, code: 'no_workspace', error: 'This card has no workspace, so it has no board scope' } }
    }
    // A token that NAMES an acting user must still resolve to a live user.
    // A deleted user is a revoked principal, not an anonymous one.
    if (claims.actingUserId != null && !user) {
      return { ok: false, denial: { status: 403, code: 'user_revoked', error: 'The acting user for this session no longer exists' } }
    }
    if (user && user.role !== 'admin' && !userHasWorkspace(user.id, workspace)) {
      return { ok: false, denial: { status: 403, code: 'workspace_forbidden', error: `No access to workspace '${workspace}'` } }
    }
    return {
      ok: true,
      principal: {
        kind: 'session',
        reason: 'session-token',
        workspace,
        objectiveId: objective.id,
        actingUserId: user?.id ?? null,
      },
    }
  }

  // 2. Explicit server-to-server credential: board-wide, least-privilege by
  //    being the ONLY unscoped path a non-loopback caller has.
  if (hasInternalApiCredential(req)) {
    return { ok: true, principal: { kind: 'server', reason: 'internal-credential', workspace: null, objectiveId: null, actingUserId: null } }
  }

  // 3./4. Origin. A sandbox peer is reachable but not authoritative.
  if (isSandboxPeer(req, env)) {
    return {
      ok: false,
      denial: {
        status: 403,
        code: 'session_token_required',
        error: 'Internal board reads from a sandboxed session require X-CC-Session-Token (CC_SESSION_TOKEN)',
      },
    }
  }
  if (isLocalhost(req)) {
    if (boardPrincipalRequired(db, env)) {
      return {
        ok: false,
        denial: {
          status: 403,
          code: 'principal_required',
          error: 'Internal board reads require X-CC-Session-Token or X-Internal-Secret on this install',
        },
      }
    }
    return { ok: true, principal: { kind: 'local-operator', reason: 'on-box-origin', workspace: null, objectiveId: null, actingUserId: null } }
  }
  return { ok: false, denial: { status: 403, code: 'not_authorized', error: 'Internal API: local origin or X-Internal-Secret required' } }
}

/** May this principal see a row belonging to `workspace`? */
export function principalMaySeeWorkspace(principal: BoardPrincipal, workspace: string | null | undefined): boolean {
  if (principal.workspace === null) return true
  return (workspace || '').trim() === principal.workspace
}

/**
 * Route helper: resolve, write the denial if there is one, and stamp the
 * principal on the response so an operator can see which principal answered.
 * Returns the principal, or null when the response has already been sent.
 */
export function requireBoardPrincipal(req: Request, res: Response, db?: Database.Database): BoardPrincipal | null {
  const result = resolveBoardPrincipal(req, db)
  if (!result.ok) {
    res.status(result.denial.status).json({ error: result.denial.error, code: result.denial.code })
    return null
  }
  res.set('X-Board-Principal', result.principal.kind)
  if (result.principal.workspace) res.set('X-Board-Workspace', result.principal.workspace)
  return result.principal
}

/**
 * Enforce a `session` principal's workspace on a list query's filters.
 *
 * A session may not widen its scope, and asking for a DIFFERENT workspace is a
 * loud 403 rather than a silent rewrite — a caller that believes it is reading
 * `example` must not receive `operationkit` rows under an HTTP 200.
 */
export function applyPrincipalWorkspaceFilter(
  principal: BoardPrincipal,
  requested: unknown,
): { workspace: string } | { denied: BoardDenial } | null {
  if (principal.workspace === null) return null
  const asked = typeof requested === 'string' ? requested.trim() : ''
  if (asked && asked !== 'all' && asked !== principal.workspace) {
    return {
      denied: {
        status: 403,
        code: 'workspace_forbidden',
        error: `This session is scoped to workspace '${principal.workspace}' and cannot read '${asked}'`,
      },
    }
  }
  return { workspace: principal.workspace }
}
