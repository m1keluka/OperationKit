/**
 * Settings → Integrations → "Connect an MCP server" (Sprint 7.8, obj 900620).
 *
 *   GET    /api/mcp-servers/oauth/client-metadata  CIMD client document (public; an auth server fetches it)
 *   GET    /api/mcp-servers/oauth/callback         OAuth redirect target (public; CSRF-bound by signed state)
 *   GET    /api/mcp-servers?workspace=<slug>       servers of ONE workspace (members of it, or admin)
 *   GET    /api/mcp-servers/catalog                catalog connectors that publish a remote MCP URL
 *   POST   /api/mcp-servers/detect                 { url } → how the server wants to authenticate   (admin)
 *   POST   /api/mcp-servers                        connect                                           (admin)
 *   PATCH  /api/mcp-servers/:id                    rename, enable/disable, per-tool toggles, new key (admin)
 *   POST   /api/mcp-servers/:id/test               initialize + tools/list                           (admin)
 *   POST   /api/mcp-servers/:id/oauth/start        → { redirect_url }                                (admin)
 *   DELETE /api/mcp-servers/:id                    disconnect + delete local tokens                  (admin)
 *
 * No response ever contains a credential (McpServerSummary has no value
 * field). Agent API keys and card session tokens are refused by requireAdmin
 * and, for the whole prefix, by the agent-key guard (off the agent surface).
 */
import { Router } from 'express'
import type { Request, Response } from 'express'
import type { McpCatalogEntry, McpDetectResponse, McpErrorKind, McpServerCreateRequest, McpServerSummary } from '@operationkit/shared'
import { requireAuth, requireAdmin, type AuthRequest } from '../middleware/auth.js'
import { userHasWorkspace } from '../middleware/workspace.js'
import { listConnectors } from '../connectors/registry.js'
import { appBaseUrl } from '../connectors/dcr-routes.js'
import { detectAuth } from '../mcp-servers/auth-detect.js'
import {
  completeOAuth,
  createServer,
  deleteServer,
  getServerRow,
  listServerRows,
  mcpClientMetadataDocument,
  mcpOAuthRedirectUri,
  McpServerInputError,
  startOAuth,
  testServer,
  toSummary,
  updateServer,
  mcpFetch,
} from '../services/workspace-mcp-servers.js'

import { getDb } from '../db/index.js'
import { forgetMcpBuild } from '../services/integration-builder.js'

const router = Router()

// ── Public (must stay BEFORE requireAuth) ───────────────────────────────────

router.get('/oauth/client-metadata', (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'public, max-age=300')
  res.json(mcpClientMetadataDocument())
})

function backToSettings(params: Record<string, string>): string {
  return `${appBaseUrl()}/settings/connectors?${new URLSearchParams(params).toString()}`
}

router.get('/oauth/callback', async (req: Request, res: Response) => {
  const code = typeof req.query.code === 'string' ? req.query.code : ''
  const state = typeof req.query.state === 'string' ? req.query.state : ''
  const oauthError = typeof req.query.error === 'string' ? req.query.error.slice(0, 100) : ''
  if (oauthError) return res.redirect(backToSettings({ mcp_oauth: 'error', mcp_error: oauthError }))
  if (!code || !state) return res.redirect(backToSettings({ mcp_oauth: 'error', mcp_error: 'missing_code' }))
  const done = await completeOAuth(state, code)
  if (!done.ok) {
    return res.redirect(backToSettings({ mcp_oauth: 'error', mcp_error: done.error.slice(0, 200), ...(done.serverId ? { mcp_server: String(done.serverId) } : {}) }))
  }
  // Fill in server info + tools straight away so the list shows them on return.
  await testServer(done.serverId).catch(() => null)
  return res.redirect(backToSettings({ mcp_oauth: 'connected', mcp_server: String(done.serverId) }))
})

router.use(requireAuth)

// ── Reads ────────────────────────────────────────────────────────────────────

function canSeeWorkspace(req: AuthRequest, workspace: string): boolean {
  if (!req.user) return false
  if (req.user.role === 'admin' && !req.agentKey && !req.sessionFile) return true
  return userHasWorkspace(req.user.id, workspace)
}

router.get('/', (req: AuthRequest, res: Response) => {
  const workspace = typeof req.query.workspace === 'string' ? req.query.workspace.trim() : ''
  if (!workspace) return res.status(400).json({ error: 'workspace is required' })
  if (!canSeeWorkspace(req, workspace)) return res.status(403).json({ error: `No access to workspace '${workspace}'` })
  res.json(listServerRows(workspace).map(toSummary))
})

router.get('/catalog', async (_req: AuthRequest, res: Response) => {
  const defs = await listConnectors()
  const out: McpCatalogEntry[] = defs
    .filter(d => typeof d.mcp_url === 'string' && d.mcp_url.length > 0)
    .map(d => ({ id: d.id, name: d.name, description: d.description, mcp_url: d.mcp_server_url ?? d.mcp_url! }))
  res.json(out)
})

// ── Admin-only mutations ─────────────────────────────────────────────────────

/**
 * POST /detect body → what the client sees. Exported so the Integrations bot
 * (obj 900682, routes/integrations-builder.ts) detects through the SAME code
 * path instead of a second copy.
 */
export async function detectResponse(rawUrl: unknown, rawTransport: unknown): Promise<McpDetectResponse> {
  const url = typeof rawUrl === 'string' ? rawUrl : ''
  const transport = rawTransport === 'sse' || rawTransport === 'streamable_http' ? rawTransport : 'auto'
  const out = await detectAuth({ url, transport, fetchImpl: mcpFetch() })
  if (!out.ok) return { ok: false, kind: out.kind, error: out.error }
  if (out.data.auth === 'none') {
    return {
      ok: true,
      auth: 'none',
      server_name: out.data.probe.server_name,
      server_version: out.data.probe.server_version,
      tool_count: out.data.probe.tools.length,
    }
  }
  if (out.data.auth === 'oauth') {
    return {
      ok: true,
      auth: 'oauth',
      registration: out.data.registration,
      issuer: out.data.issuer,
      scopes_supported: out.data.scopes_supported.slice(0, 50),
      redirect_uri: mcpOAuthRedirectUri(),
    }
  }
  return { ok: true, auth: 'api_key', reason: out.data.reason }
}

router.post('/detect', requireAdmin, async (req: AuthRequest, res: Response) => {
  res.json(await detectResponse(req.body?.url, req.body?.transport))
})

function errorBody(err: unknown): { status: number; body: { error: string } } {
  if (err instanceof McpServerInputError) return { status: 400, body: { error: err.message } }
  const msg = (err as Error)?.message ?? String(err)
  if (/UNIQUE constraint/.test(msg)) return { status: 409, body: { error: 'A server with that name already exists in this workspace.' } }
  console.warn('[mcp-servers] request failed:', msg.slice(0, 200))
  return { status: 500, body: { error: 'Something went wrong saving the MCP server.' } }
}

function sendError(res: Response, err: unknown): Response {
  const e = errorBody(err)
  return res.status(e.status).json(e.body)
}

export type ConnectOutcome =
  | { status: 201; body: { server: McpServerSummary; test: { ok: boolean; kind?: McpErrorKind; error?: string } | null } }
  | { status: number; body: { error: string; kind?: McpErrorKind } }

/**
 * POST / — connect a server, then test it (OAuth servers wait for sign-in).
 * Exported so the Integrations bot (obj 900682) connects through the SAME
 * path: same SSRF guard, same server-side OAuth re-detect, same secrets-store
 * credential handling. `b.api_key` is write-only and never echoed.
 */
export async function connectMcpServer(b: Partial<McpServerCreateRequest>, actorUserId: number | null): Promise<ConnectOutcome> {
  try {
    let detected = null
    if (b.auth_type === 'oauth') {
      // Re-detect server-side: the OAuth endpoints come from the server's own
      // metadata, never from the browser.
      const d = await detectAuth({ url: String(b.url ?? ''), transport: b.transport ?? 'auto', fetchImpl: mcpFetch() })
      if (!d.ok) return { status: 400, body: { error: d.error, kind: d.kind } }
      if (d.data.auth !== 'oauth') return { status: 400, body: { error: 'This server does not offer OAuth. Use the API key option.' } }
      detected = d.data
    }
    const row = createServer(
      {
        workspace: String(b.workspace ?? ''),
        name: String(b.name ?? ''),
        url: String(b.url ?? ''),
        transport: b.transport,
        auth_type: b.auth_type as McpServerCreateRequest['auth_type'],
        auth_header_name: b.auth_header_name,
        api_key: b.api_key,
        oauth_client_id: b.oauth_client_id,
        oauth_client_secret: b.oauth_client_secret,
        oauth_scope: b.oauth_scope,
        catalog_id: b.catalog_id,
        detected,
      },
      actorUserId,
    )
    if (row.auth_type === 'oauth') return { status: 201, body: { server: toSummary(row), test: null } }
    const test = await testServer(row.id)
    return {
      status: 201,
      body: {
        server: toSummary(test?.row ?? row),
        test: test ? (test.ok ? { ok: true } : { ok: false, kind: test.kind, error: test.error }) : null,
      },
    }
  } catch (err) {
    return errorBody(err)
  }
}

router.post('/', requireAdmin, async (req: AuthRequest, res: Response) => {
  const out = await connectMcpServer((req.body ?? {}) as Partial<McpServerCreateRequest>, req.user!.id)
  return res.status(out.status).json(out.body)
})

function idParam(req: Request): number | null {
  const id = Number(req.params.id)
  return Number.isInteger(id) && id > 0 ? id : null
}

router.patch('/:id', requireAdmin, (req: AuthRequest, res: Response) => {
  const id = idParam(req)
  if (!id || !getServerRow(id)) return res.status(404).json({ error: 'No such MCP server.' })
  try {
    const b = req.body ?? {}
    const row = updateServer(
      id,
      {
        name: typeof b.name === 'string' ? b.name : undefined,
        enabled: typeof b.enabled === 'boolean' ? b.enabled : undefined,
        disabled_tools: Array.isArray(b.disabled_tools) ? b.disabled_tools : undefined,
        api_key: typeof b.api_key === 'string' ? b.api_key : undefined,
      },
      req.user!.id,
    )
    return res.json(toSummary(row))
  } catch (err) {
    return sendError(res, err)
  }
})

router.post('/:id/test', requireAdmin, async (req: AuthRequest, res: Response) => {
  const id = idParam(req)
  const out = id ? await testServer(id) : null
  if (!out) return res.status(404).json({ error: 'No such MCP server.' })
  return res.json(out.ok ? { ok: true, server: toSummary(out.row) } : { ok: false, kind: out.kind, error: out.error, server: toSummary(out.row) })
})

router.post('/:id/oauth/start', requireAdmin, async (req: AuthRequest, res: Response) => {
  const id = idParam(req)
  if (!id || !getServerRow(id)) return res.status(404).json({ error: 'No such MCP server.' })
  const out = await startOAuth(id, req.user!.id)
  if (!out.ok) return res.status(400).json({ error: out.error })
  return res.json({ redirect_url: out.redirectUrl })
})

router.delete('/:id', requireAdmin, (req: AuthRequest, res: Response) => {
  const id = idParam(req)
  if (!id || !deleteServer(id, req.user!.id)) return res.status(404).json({ error: 'No such MCP server.' })
  forgetMcpBuild(getDb(), id) // obj 900682: drop the Integrations-bot build record too
  return res.json({ ok: true })
})

export default router
