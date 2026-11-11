/**
 * Connectors API (obj 720115) — Settings → Connectors.
 *
 *   GET    /api/connectors              → every connector + this person's status and access rules
 *   POST   /api/connectors/:id/connect  → token connectors: { fields } → { status }
 *                                         sign-in connectors: → { redirect_url }
 *   POST   /api/connectors/:id/check    → re-test the stored connection → { status }
 *   PUT    /api/connectors/:id/access   → { agents, workspaces } (null = all) → { access }
 *   DELETE /api/connectors/:id          → disconnect → { status }
 *
 * Responses never contain a credential, only summaries (ConnectorStatus).
 * Changes need a signed-in person in the browser: API keys may read, not change.
 */
import { Router } from 'express'
import type { Response } from 'express'
import type { ConnectorSummary } from '@operationkit/shared'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import { listConnectors, getConnector } from '../connectors/registry.js'
import { getAccess, setAccess, parseAccessBody } from '../connectors/access.js'
import { NOT_CONNECTED, type ConnectorDefinition, type ConnectOutcome } from '../connectors/types.js'

const router = Router()
router.use(requireAuth)

function callerId(req: AuthRequest, res: Response): number | null {
  const id = req.user?.id
  if (typeof id !== 'number') {
    res.status(401).json({ error: 'Authentication required' })
    return null
  }
  return id
}

/** Writers must be a person signed in to the app, not a key. */
function writerId(req: AuthRequest, res: Response): number | null {
  const id = callerId(req, res)
  if (id == null) return null
  if (req.authVia && req.authVia !== 'session') {
    res.status(403).json({ error: 'Connectors can only be changed from Settings, signed in as yourself.' })
    return null
  }
  return id
}

async function summarize(def: ConnectorDefinition, userId: number): Promise<ConnectorSummary> {
  const avail = def.availability ? def.availability() : { ok: true as const }
  let status = NOT_CONNECTED
  try {
    status = await def.status({ userId })
  } catch {
    status = { ...NOT_CONNECTED, state: 'error', error: 'Could not read this connection.' }
  }
  return {
    id: def.id,
    name: def.name,
    description: def.description,
    products: def.products ?? [],
    connect: def.connect,
    available: avail.ok,
    unavailable_reason: avail.ok ? null : avail.reason,
    can_check: typeof def.check === 'function',
    status,
    access: getAccess(def.id, userId),
  }
}

async function findOr404(req: AuthRequest, res: Response): Promise<ConnectorDefinition | null> {
  const def = await getConnector(String(req.params.id))
  if (!def) res.status(404).json({ error: 'No such connector.' })
  return def ?? null
}

function sendOutcome(res: Response, out: ConnectOutcome): void {
  if (!out.ok) {
    res.status(400).json({ error: out.error })
    return
  }
  if ('redirectUrl' in out) res.json({ redirect_url: out.redirectUrl })
  else res.json({ status: out.status })
}

router.get('/', async (req: AuthRequest, res: Response) => {
  const userId = callerId(req, res)
  if (userId == null) return
  const defs = await listConnectors()
  res.json(await Promise.all(defs.map(d => summarize(d, userId))))
})

router.post('/:id/connect', async (req: AuthRequest, res: Response) => {
  const userId = writerId(req, res)
  if (userId == null) return
  const def = await findOr404(req, res)
  if (!def) return
  const avail = def.availability ? def.availability() : { ok: true as const }
  if (!avail.ok) {
    res.status(503).json({ error: avail.reason })
    return
  }
  try {
    if (def.connect.kind === 'oauth') {
      if (!def.startOAuth) throw new Error('missing startOAuth')
      sendOutcome(res, await def.startOAuth({ userId }))
      return
    }
    if (!def.connectWithFields) throw new Error('missing connectWithFields')
    const raw = (req.body?.fields ?? {}) as Record<string, unknown>
    const fields: Record<string, string> = {}
    for (const f of def.connect.fields) {
      const v = raw[f.key]
      fields[f.key] = typeof v === 'string' ? v : ''
    }
    sendOutcome(res, await def.connectWithFields({ userId }, fields))
  } catch (err) {
    console.error(`[connectors] connect ${def.id} failed:`, (err as Error).message)
    res.status(500).json({ error: 'Connecting failed. Try again in a minute.' })
  }
})

router.post('/:id/check', async (req: AuthRequest, res: Response) => {
  const userId = writerId(req, res)
  if (userId == null) return
  const def = await findOr404(req, res)
  if (!def) return
  if (!def.check) {
    res.status(400).json({ error: 'This connector has nothing to check.' })
    return
  }
  try {
    sendOutcome(res, await def.check({ userId }))
  } catch (err) {
    console.error(`[connectors] check ${def.id} failed:`, (err as Error).message)
    res.status(500).json({ error: 'Checking failed. Try again in a minute.' })
  }
})

router.put('/:id/access', async (req: AuthRequest, res: Response) => {
  const userId = writerId(req, res)
  if (userId == null) return
  const def = await findOr404(req, res)
  if (!def) return
  const parsed = parseAccessBody(req.body)
  if ('error' in parsed) {
    res.status(400).json({ error: parsed.error })
    return
  }
  res.json({ access: setAccess(def.id, userId, parsed) })
})

router.delete('/:id', async (req: AuthRequest, res: Response) => {
  const userId = writerId(req, res)
  if (userId == null) return
  const def = await findOr404(req, res)
  if (!def) return
  try {
    await def.disconnect({ userId })
    res.json({ status: await def.status({ userId }) })
  } catch (err) {
    console.error(`[connectors] disconnect ${def.id} failed:`, (err as Error).message)
    res.status(500).json({ error: 'Disconnecting failed. Try again in a minute.' })
  }
})

export default router
