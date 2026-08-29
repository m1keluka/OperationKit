import { WebSocketServer, WebSocket } from 'ws'
import type { Server } from 'http'
import type { IncomingMessage } from 'http'
import type { Duplex } from 'stream'
import { parse as parseCookie } from 'cookie'
import { spawn, type IPty } from 'node-pty'
import { verifyToken } from '../middleware/auth.js'
import { getUserWorkspaces } from '../middleware/workspace.js'
import { getDb } from '../db/index.js'
import type { ServerMessage, ClientMessage, User, UserRole } from '@command-center/shared'

// Per-connection state. We snapshot workspace memberships at connect time —
// see Phase 5 audit note. If admin grants a new workspace mid-session the
// client reconnects (or reloads) to pick it up.
interface ConnectedClient {
  ws: WebSocket
  userId: number
  role: UserRole
  workspaces: Set<string>
  // The workspace this socket is currently viewing, set via `set_view_scope`.
  // Used only for ADMIN view-scoping: when set and !== 'all', admin broadcasts
  // are filtered to this workspace (view-leak fix, obj 1001). Members are
  // unaffected — their visibility is always membership+ownership based.
  viewedWorkspace?: string
}

const clients = new Set<ConnectedClient>()

/**
 * Extract the connect-time view scope from a `/ws?workspace=<ws>` upgrade URL
 * (view-leak fix, obj 700082). Returns the workspace to scope this socket to, or
 * undefined to see everything ('all', missing, or malformed → back-compat).
 */
export function parseConnectScope(url: string | undefined): string | undefined {
  try {
    const qs = (url || '').split('?')[1]
    const wsParam = qs ? new URLSearchParams(qs).get('workspace') : null
    if (wsParam && wsParam !== 'all') return wsParam
  } catch {
    // Malformed query string — leave unscoped.
  }
  return undefined
}

let mainWss: WebSocketServer
let shellWss: WebSocketServer

export function initWebSocket(server: Server): void {
  mainWss = new WebSocketServer({ noServer: true })
  shellWss = new WebSocketServer({ noServer: true })

  // Route upgrade requests by path
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const cookies = parseCookie(req.headers.cookie || '')
    const user = verifyToken(cookies.token || '')

    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }

    // The URL may carry a query string (e.g. `/ws?workspace=example2`), so route on
    // the pathname only — `req.url === '/ws'` would miss a scoped connection.
    const path = (req.url || '').split('?')[0]

    if (path === '/ws/shell') {
      if (user.role !== 'admin') {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
        socket.destroy()
        return
      }
      shellWss.handleUpgrade(req, socket, head, (ws) => {
        shellWss.emit('connection', ws, req)
      })
    } else if (path === '/ws') {
      // Stash the verified user on the request so the connection handler
      // can attach a per-socket scope without re-verifying the cookie.
      ;(req as IncomingMessage & { _user?: User })._user = user
      mainWss.handleUpgrade(req, socket, head, (ws) => {
        mainWss.emit('connection', ws, req)
      })
    } else {
      socket.destroy()
    }
  })

  // Main WS: kanban state broadcasts only
  mainWss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const user = (req as IncomingMessage & { _user?: User })._user
    if (!user) {
      ws.close(1008, 'Missing user context')
      return
    }
    const memberships = getUserWorkspaces(user.id).map(w => w.workspace)
    // Scope the socket at CONNECT time from the `?workspace=` query param. This
    // closes the view-leak race (obj 700082): without it, `viewedWorkspace` is
    // unset until the client's first `set_view_scope` message is processed, and
    // during that window an admin viewing a single workspace receives EVERY
    // workspace's broadcasts (admin-sees-all). Reconnects (every backend deploy
    // drops the socket ~5s) reopened that window repeatedly, leaking other orgs'
    // objectives onto a single-org board "at random". Setting it here means the
    // socket is already scoped the instant it joins the broadcast set, before
    // any message can be delivered. `set_view_scope` still handles live switches.
    const client: ConnectedClient = {
      ws,
      userId: user.id,
      role: user.role,
      workspaces: new Set(memberships),
      viewedWorkspace: parseConnectScope(req.url),
    }
    clients.add(client)

    // Inbound control messages. Currently only `set_view_scope`, which records
    // the workspace this socket is viewing so admin broadcasts can be scoped.
    ws.on('message', (raw) => {
      try {
        const parsed = JSON.parse(raw.toString()) as ClientMessage
        if (parsed && parsed.type === 'set_view_scope') {
          client.viewedWorkspace =
            typeof parsed.workspace === 'string' ? parsed.workspace : undefined
        }
      } catch {
        // Non-JSON / unknown messages are ignored on the kanban socket.
      }
    })

    ws.on('close', () => {
      clients.delete(client)
    })
  })

  // Shell WS: direct bash terminal
  shellWss.on('connection', (ws: WebSocket) => {
    let pty: IPty
    try {
      pty = spawn('bash', [], {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        env: { ...process.env as Record<string, string>, HOME: '/home/operator', USER: 'operator', TERM: 'xterm-256color' },
        cwd: '/home/operator',
      })
    } catch (err) {
      ws.send(`\r\nFailed to spawn shell: ${err}\r\n`)
      ws.close()
      return
    }

    pty.onData((data: string) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data)
      }
    })

    pty.onExit(() => {
      if (ws.readyState === WebSocket.OPEN) ws.close()
    })

    ws.on('message', (raw) => {
      const msg = raw.toString()
      try {
        const parsed = JSON.parse(msg)
        if (parsed.type === 'resize') {
          pty.resize(parsed.cols, parsed.rows)
          return
        }
      } catch {
        // Not JSON = terminal input
      }
      pty.write(msg)
    })

    ws.on('close', () => { pty.kill() })
  })
}

// Lazy DB handle — only resolved when we need a row lookup.
function lookupObjective(id: number) {
  try {
    return getDb()
      .prepare('SELECT workspace, created_by, assigned_user_id FROM objectives WHERE id = ?')
      .get(id) as { workspace: string; created_by: number | null; assigned_user_id: number | null } | undefined
  } catch {
    return undefined
  }
}

/**
 * Resolve the target workspace of a broadcast for ADMIN view-scoping (obj 1001).
 * Returns undefined when the message isn't workspace-bound (terminal/alerts) or
 * the workspace can't be determined (e.g. objective already deleted) — such
 * messages are always delivered so we never silently drop ops signals.
 */
function resolveMessageWorkspace(message: ServerMessage): string | undefined {
  switch (message.type) {
    case 'objective_updated': return message.payload.workspace
    case 'objective_deleted': return message.payload.workspace
    case 'activity':          return message.payload.workspace
    case 'state_change':
    case 'session_intel_ready':
    case 'session_stuck':     return lookupObjective(message.payload.objective_id)?.workspace
    default:                  return undefined
  }
}

/**
 * Per-message visibility check (Phase 5).
 * Admins see everything, EXCEPT when this socket has set a specific viewed
 * workspace (`set_view_scope`) — then admin broadcasts are scoped to that
 * workspace (view-leak fix, obj 1001). Members see only messages tied to a
 * workspace they belong to, and (for objective-linked payloads) only when they
 * created the objective or it was assigned to them — mirroring `GET /api/objectives`.
 *
 * Mutates no state; safe to call sync.
 */
function shouldDeliver(message: ServerMessage, client: ConnectedClient): boolean {
  if (client.role === 'admin') {
    // View-scoping: only filter when the admin is viewing a single workspace.
    // 'all' (or unset) keeps the historical see-everything behavior (back-compat).
    if (client.viewedWorkspace && client.viewedWorkspace !== 'all') {
      const mw = resolveMessageWorkspace(message)
      if (mw !== undefined && mw !== client.viewedWorkspace) return false
    }
    return true
  }

  const memberOwnsRow = (row: { created_by: number | null; assigned_user_id: number | null }) =>
    row.created_by === client.userId || row.assigned_user_id === client.userId

  switch (message.type) {
    case 'objective_updated': {
      const o = message.payload
      if (!client.workspaces.has(o.workspace)) return false
      return memberOwnsRow({ created_by: o.created_by ?? null, assigned_user_id: o.assigned_user_id ?? null })
    }
    case 'objective_deleted': {
      // Payload is just { id }. Objective is already gone from the DB, so we
      // can't recheck ownership. Suppress for non-admins — members get their
      // own list-refresh via REST when needed.
      return false
    }
    case 'state_change':
    case 'session_intel_ready':
    case 'session_stuck': {
      const obj = lookupObjective(message.payload.objective_id)
      if (!obj) return false
      if (!client.workspaces.has(obj.workspace)) return false
      return memberOwnsRow(obj)
    }
    case 'activity': {
      const e = message.payload
      if (e.workspace && !client.workspaces.has(e.workspace)) return false
      if (e.objective_id) {
        const obj = lookupObjective(e.objective_id)
        // Objective row may be missing if deleted; deny for members in that case.
        if (!obj) return false
        return memberOwnsRow(obj)
      }
      return true
    }
    case 'terminal_output': {
      // Terminal output is only sent in response to a client subscribing to a
      // specific session — we deliver per-socket elsewhere. Treat any broadcast
      // here as admin-only since members shouldn't see raw stdout streams.
      return false
    }
    case 'error':
      return true
    default:
      // Pre-existing types broadcast outside the ServerMessage union (alerts,
      // alert_acked). Restrict to admins by default — these are ops signals.
      return false
  }
}

export function broadcast(message: ServerMessage): void {
  const serialized = JSON.stringify(message)
  for (const client of clients) {
    if (client.ws.readyState !== WebSocket.OPEN) continue
    if (!shouldDeliver(message, client)) continue
    client.ws.send(serialized)
  }
}
