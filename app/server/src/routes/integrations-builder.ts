/**
 * Integrations: "New Integration → Make my own" and the Integrations bot (obj 900682).
 *
 *   POST /api/integrations/builder                      {workspace, target?, docs?} → builder card, started   (admin, signed in)
 *   GET  /api/integrations/builds?workspace=            what Integrations bots built in ONE workspace     (members of it, or admin)
 *
 * Builder routes — ONLY the builder card's own session (its CC_SESSION_TOKEN) or a signed-in admin:
 *   POST /api/integrations/builder/:id/detect           {url, transport?}  — same code as POST /api/mcp-servers/detect (#900620)
 *   POST /api/integrations/builder/:id/mcp-server       {name, url, auth_type, api_key_secret?, …} — same code as POST /api/mcp-servers
 *   POST /api/integrations/builder/:id/tool             {name, description, base_url, secrets[], body, dry_run?} — okit new tool (http-api)
 *
 * The bot never handles a key value: `api_key_secret` is a secret NAME that the
 * server resolves from the card's workspace scope (where the in-chat secret form
 * writes it) and hands to the 900620 connect path, which stores it under its own
 * server-only prefix. No response carries a value. A session token is confined
 * to its own card, that card's live workspace, and only cards that were created
 * by "Make my own" (`integration_builder_cards`). This prefix is off the
 * agent-key surface (agent-key-guard default-deny).
 */
import { Router, type NextFunction, type Response } from 'express'
import type {
  IntegrationBuilderCreateRequest,
  IntegrationBuilderCreateResponse,
  McpServerCreateRequest,
  McpServerSummary,
} from '@operationkit/shared'
import { getDb } from '../db/index.js'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import { userHasWorkspace } from '../middleware/workspace.js'
import { SESSION_SECRET_ACCESS_FLAG, readSettingFlag, sessionTokenFromHeaders, verifySessionToken } from '../lib/session-trust.js'
import { listConnectors } from '../connectors/registry.js'
import { listServerRows, workspaceExists } from '../services/workspace-mcp-servers.js'
import { getSecretValue, isServerOnlySecretKey } from '../services/secrets-store.js'
import { SECRET_NAME_RE } from '../services/secret-requests.js'
import {
  BUILDER_DOCS_MAX, BUILDER_TARGET_MAX, createIntegrationBuilderCard, getBuilderCard, listBuilds, recordBuild,
  type BriefCatalogEntry, type BuilderCardRow,
} from '../services/integration-builder.js'
import { connectMcpServer, detectResponse } from './mcp-servers.js'
import { parseSlug, runOkit } from './internal-operationkit.js'
import { startCreatedObjective } from './objectives-create-start.js'
import { logActivity } from './feed.js'
import { broadcast } from '../ws/index.js'

const router = Router()

const WS_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/i
const TOOL_DESCRIPTION_MIN = 10
const TOOL_DESCRIPTION_MAX = 300
const TOOL_BODY_MAX = 50_000
const MAX_TOOL_SECRETS = 5

interface BuilderRequest extends AuthRequest {
  builder?: { card: BuilderCardRow; actorUserId: number | null; via: 'session' | 'admin' }
}

// ── "Make my own" ───────────────────────────────────────────────────────────

/** Catalog entries that already have a guided setup (#900499) — the bot sends people there first. */
async function catalogForBrief(): Promise<BriefCatalogEntry[]> {
  try {
    return (await listConnectors()).map(d => ({
      id: d.id,
      name: d.name,
      mcp: typeof d.mcp_url === 'string' && d.mcp_url.length > 0,
      setup_guide: d.setup_guide ?? null,
    }))
  } catch {
    return []
  }
}

router.post('/builder', requireAuth, async (req: AuthRequest, res: Response) => {
  // A card session token or an agent key never reaches here as an admin (requireAuth
  // gives neither), but say so plainly: only a signed-in admin starts a bot.
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Only an admin can start the Integrations bot.' })
  const b = (req.body ?? {}) as Partial<IntegrationBuilderCreateRequest>
  const workspace = typeof b.workspace === 'string' ? b.workspace.trim() : ''
  if (!workspace || !WS_SLUG.test(workspace) || !workspaceExists(workspace)) {
    return res.status(400).json({ error: 'Pick a workspace for the integration.' })
  }
  if (b.target !== undefined && typeof b.target !== 'string') return res.status(400).json({ error: 'target must be text' })
  if (b.docs !== undefined && typeof b.docs !== 'string') return res.status(400).json({ error: 'docs must be text' })
  if ((b.target ?? '').length > BUILDER_TARGET_MAX) return res.status(400).json({ error: `Keep "what to connect" under ${BUILDER_TARGET_MAX} characters.` })
  if ((b.docs ?? '').length > BUILDER_DOCS_MAX) {
    return res.status(400).json({ error: `Docs are over ${BUILDER_DOCS_MAX} characters — paste a link instead, the bot will read it.` })
  }

  const db = getDb()
  const secretFormEnabled = readSettingFlag(SESSION_SECRET_ACCESS_FLAG)
  const { objectiveId } = createIntegrationBuilderCard(db, {
    workspace,
    target: b.target ?? null,
    docs: b.docs ?? null,
    createdByUserId: req.user.id,
    catalog: await catalogForBrief(),
    connectedMcp: listServerRows(workspace).map(r => ({ name: r.name, slug: r.slug, status: r.status })),
    secretFormEnabled,
  })
  try {
    logActivity({
      project: 'integrations', workspace, objective_id: objectiveId, event_type: 'decision',
      title: `Integrations bot started: card #${objectiveId}`,
      detail: (b.target ?? '').slice(0, 200),
      metadata: { kind: 'integration_builder_created', actor: req.user.username },
    })
  } catch { /* activity is best-effort */ }

  const start = await startCreatedObjective(db, objectiveId)
  const startBlock = (start.body.start ?? {}) as { started?: boolean; detail?: string }
  if (!startBlock.started) {
    const obj = db.prepare('SELECT * FROM objectives WHERE id = ?').get(objectiveId)
    if (obj) broadcast({ type: 'objective_updated', payload: obj as never })
  }
  const body: IntegrationBuilderCreateResponse = {
    ok: true,
    objective_id: objectiveId,
    workspace,
    started: !!startBlock.started,
    start_detail: startBlock.started ? null : startBlock.detail ?? null,
    secret_form_enabled: secretFormEnabled,
  }
  return res.status(201).json(body)
})

router.get('/builds', requireAuth, (req: AuthRequest, res: Response) => {
  const workspace = typeof req.query.workspace === 'string' ? req.query.workspace.trim() : ''
  if (!workspace) return res.status(400).json({ error: 'workspace is required' })
  if (req.user!.role !== 'admin' && !userHasWorkspace(req.user!.id, workspace)) {
    return res.status(403).json({ error: `No access to workspace '${workspace}'` })
  }
  return res.json(listBuilds(getDb(), workspace))
})

// ── builder-only routes ─────────────────────────────────────────────────────

const CLOSED = new Set(['done', 'cancelled'])

/** The builder card's own session, or a signed-in admin. Nobody else, no other card. */
function builderOnly(req: BuilderRequest, res: Response, next: NextFunction): void {
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id <= 0) {
    res.status(404).json({ error: 'No such builder card.' })
    return
  }
  const db = getDb()
  const card = getBuilderCard(db, id)
  const live = db.prepare('SELECT id, workspace, status FROM objectives WHERE id = ?').get(id) as
    | { id: number; workspace: string | null; status: string }
    | undefined
  const check = (via: 'session' | 'admin', actorUserId: number | null): void => {
    if (!card || !live) {
      res.status(404).json({ error: 'No such builder card.' })
      return
    }
    // The card's LIVE workspace must still be the one the bot was started for.
    if ((live.workspace ?? '') !== card.workspace) {
      res.status(403).json({ error: 'This card moved to another workspace; start a new Integrations bot there.' })
      return
    }
    if (CLOSED.has(live.status)) {
      res.status(409).json({ error: `Card #${id} is ${live.status}; start a new Integrations bot.` })
      return
    }
    req.builder = { card, actorUserId, via }
    next()
  }

  const token = sessionTokenFromHeaders(req.headers as Record<string, string | string[] | undefined>)
  if (token) {
    const claims = verifySessionToken(token)
    if (!claims) {
      res.status(401).json({ error: 'Invalid or expired session token' })
      return
    }
    if (claims.objectiveId !== id) {
      res.status(403).json({ error: 'A session token only works for its own card.' })
      return
    }
    // Act as the admin who started the bot (audit trail), never as the session.
    check('session', card?.created_by_user_id ?? null)
    return
  }
  void requireAuth(req, res, () => {
    if (req.user?.role !== 'admin') {
      res.status(403).json({ error: 'Only the builder card\'s session or an admin may do this.' })
      return
    }
    check('admin', req.user.id)
  })
}

router.post('/builder/:id/detect', builderOnly, async (req: BuilderRequest, res: Response) => {
  return res.json(await detectResponse(req.body?.url, req.body?.transport))
})

router.post('/builder/:id/mcp-server', builderOnly, async (req: BuilderRequest, res: Response) => {
  const { card, actorUserId } = req.builder!
  const b = (req.body ?? {}) as Partial<McpServerCreateRequest> & { api_key_secret?: unknown }
  if (b.api_key !== undefined || b.oauth_client_secret !== undefined) {
    return res.status(400).json({
      error: 'Never send a key value. Ask for it with the in-chat secret form, then pass its NAME as api_key_secret.',
    })
  }
  if (b.workspace !== undefined && b.workspace !== card.workspace) {
    return res.status(403).json({ error: `This bot only connects servers in '${card.workspace}'.` })
  }
  const authType = b.auth_type
  if (authType !== 'none' && authType !== 'api_key' && authType !== 'oauth') {
    return res.status(400).json({ error: 'auth_type must be none, api_key or oauth' })
  }
  let apiKey: string | undefined
  let secretNames: string[] = []
  if (authType === 'api_key') {
    const name = typeof b.api_key_secret === 'string' ? b.api_key_secret.trim() : ''
    if (!SECRET_NAME_RE.test(name)) {
      return res.status(400).json({ error: 'api_key_secret must be the UPPER_SNAKE_CASE name of a workspace secret.' })
    }
    if (isServerOnlySecretKey(name)) return res.status(403).json({ error: `${name} is a server-only secret and cannot be used here.` })
    // Workspace scope only — exactly where the in-chat form (scope "workspace") writes.
    const value = getSecretValue({ scopeType: 'workspace', workspace: card.workspace }, name, actorUserId, 'server')
    if (!value) {
      return res.status(409).json({
        error: `No secret named ${name} in workspace '${card.workspace}' yet. Ask for it with the in-chat secret form, then retry.`,
        code: 'secret_missing',
        secret: name,
      })
    }
    apiKey = value
    secretNames = [name]
  }
  const out = await connectMcpServer(
    {
      workspace: card.workspace,
      name: typeof b.name === 'string' ? b.name : '',
      url: typeof b.url === 'string' ? b.url : '',
      transport: b.transport,
      auth_type: authType,
      auth_header_name: typeof b.auth_header_name === 'string' ? b.auth_header_name : undefined,
      api_key: apiKey,
      oauth_client_id: typeof b.oauth_client_id === 'string' ? b.oauth_client_id : undefined,
      oauth_scope: typeof b.oauth_scope === 'string' ? b.oauth_scope : undefined,
      catalog_id: typeof b.catalog_id === 'string' ? b.catalog_id : undefined,
    },
    actorUserId,
  )
  apiKey = undefined
  if (out.status !== 201 || !('server' in out.body)) return res.status(out.status).json(out.body)
  const server = out.body.server as McpServerSummary
  const build = recordBuild(getDb(), {
    objectiveId: card.objective_id, workspace: card.workspace, kind: 'mcp_server', ref: String(server.id),
    name: server.name, description: server.server_name, secretNames,
  })
  return res.status(201).json({
    ...out.body,
    build,
    next: server.auth_type === 'oauth'
      ? 'Ask the person to press Sign in on this server in Settings → Integrations.'
      : out.body.test?.ok ? 'Connected. It is listed on Settings → Integrations.' : 'The connection test failed — see test.error.',
  })
})

interface ToolSecretInput { env?: unknown; header?: unknown; note?: unknown }

function httpsUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  try {
    const u = new URL(raw.trim())
    return u.protocol === 'https:' ? u.toString() : null
  } catch {
    return null
  }
}

/** Pure: validate the bot's tool request into okit's `{frontmatter, body}` payload. */
export function toolPayload(
  input: Record<string, unknown>,
  workspace: string,
): { ok: true; slug: string; name: string; description: string; frontmatter: Record<string, unknown>; body: string; secretNames: string[] } | { ok: false; error: string } {
  const target = parseSlug('tool', input.name)
  if (typeof target === 'string') return { ok: false, error: target }
  const description = typeof input.description === 'string' ? input.description.trim() : ''
  if (description.length < TOOL_DESCRIPTION_MIN || description.length > TOOL_DESCRIPTION_MAX) {
    return { ok: false, error: `description: one sentence, ${TOOL_DESCRIPTION_MIN}–${TOOL_DESCRIPTION_MAX} characters` }
  }
  const baseUrl = httpsUrl(input.base_url)
  if (!baseUrl) return { ok: false, error: 'base_url must be an https:// URL' }
  const docsUrl = input.docs_url === undefined || input.docs_url === null || input.docs_url === '' ? null : httpsUrl(input.docs_url)
  if (input.docs_url && !docsUrl) return { ok: false, error: 'docs_url must be an https:// URL' }
  const rawSecrets = Array.isArray(input.secrets) ? (input.secrets as ToolSecretInput[]) : []
  if (rawSecrets.length > MAX_TOOL_SECRETS) return { ok: false, error: `at most ${MAX_TOOL_SECRETS} secrets` }
  const secrets: { env: string; header: string | null; note: string | null }[] = []
  for (const s of rawSecrets) {
    const env = typeof s?.env === 'string' ? s.env.trim() : ''
    if (!SECRET_NAME_RE.test(env)) return { ok: false, error: `secrets[].env must be an UPPER_SNAKE_CASE name, got '${env.slice(0, 64)}'` }
    if (isServerOnlySecretKey(env)) return { ok: false, error: `${env} is a server-only secret` }
    const header = typeof s.header === 'string' ? s.header.trim().slice(0, 200) : null
    const note = typeof s.note === 'string' ? s.note.trim().slice(0, 300) : null
    secrets.push({ env, header, note })
  }
  const extra = typeof input.body === 'string' ? input.body : ''
  if (extra.length > TOOL_BODY_MAX) return { ok: false, error: `body is over ${TOOL_BODY_MAX} characters` }
  const title = target.leaf.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')

  const frontmatter: Record<string, unknown> = {
    name: target.leaf,
    kind: 'http-api',
    description,
    ...(secrets.length ? {
      auth_path: 'api_key',
      auth: {
        secrets: secrets.map(s => ({
          env: s.env,
          source: 'session-spawn-env',
          note: s.note || `Workspace secret ${s.env} (Settings → Secrets, workspace ${workspace}), injected into sessions in that workspace. Read $${s.env}; never print it.`,
        })),
      },
    } : {}),
  }
  const lines = [
    `# ${title}`,
    '',
    description,
    '',
    `- **Base URL:** ${baseUrl}`,
    ...(docsUrl ? [`- **API docs:** ${docsUrl}`] : []),
    `- **Workspace:** \`${workspace}\` — built by the Integrations bot (Settings → Integrations → Make my own).`,
    '',
  ]
  if (secrets.length) {
    lines.push('## Auth', '')
    for (const s of secrets) lines.push(`- \`$${s.env}\`${s.header ? ` — send as \`${s.header.replace(/`/g, "'")}\`` : ''}`)
    lines.push('', 'Use the key by name from the session env. Never print, echo or log it, and never write it into a file.', '')
  }
  if (extra.trim()) lines.push(extra.trim(), '')
  return { ok: true, slug: target.slug, name: title, description, frontmatter, body: lines.join('\n'), secretNames: secrets.map(s => s.env) }
}

router.post('/builder/:id/tool', builderOnly, async (req: BuilderRequest, res: Response) => {
  const { card } = req.builder!
  const input = (req.body ?? {}) as Record<string, unknown>
  const p = toolPayload(input, card.workspace)
  if (!p.ok) return res.status(400).json({ error: p.error })
  const dryRun = input.dry_run === true
  const args = ['new', 'tool', p.slug, '--json', '--from-json', '-']
  if (dryRun) args.push('--dry-run')
  let result: Awaited<ReturnType<typeof runOkit>>
  try {
    result = await runOkit(args, JSON.stringify({ frontmatter: p.frontmatter, body: p.body }))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return res.status(503).json({ error: `The OperationKit Tools CLI is not available on this server (${msg.slice(0, 120)}).`, code: 'okit_unavailable' })
  }
  let parsed: Record<string, unknown> = {}
  try { parsed = JSON.parse(result.stdout || '{}') as Record<string, unknown> } catch { parsed = { output: result.stdout.slice(0, 2000) } }
  if (result.code === 1) return res.status(422).json({ error: 'The Tool failed schema validation.', ...parsed })
  if (result.code !== 0) {
    return res.status(409).json({ error: (parsed.error as string) || 'okit refused (a Tool with that name may already exist — pick another name).', ...parsed })
  }
  if (dryRun) return res.json({ ok: true, dry_run: true, name: p.slug, ...parsed })
  const build = recordBuild(getDb(), {
    objectiveId: card.objective_id, workspace: card.workspace, kind: 'tool', ref: p.slug, name: p.name,
    description: p.description, secretNames: p.secretNames,
  })
  return res.status(201).json({ ok: true, name: p.slug, ...parsed, build })
})

export default router
