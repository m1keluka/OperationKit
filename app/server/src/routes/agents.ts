import { Router } from 'express'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import { listAgents } from '../services/agent-registry.js'
import { loadBoardLayer, readLayerFile, LayerPathError, type LayerKind } from '../services/board-layer.js'

const router = Router()
router.use(requireAuth)

// GET /api/agents — the active agent registry. Drives every agent picker,
// monogram and label in the UI; replaces the old AGENT_CONTEXTS / AGENT_META
// module constants.
router.get('/', (_req: AuthRequest, res) => {
  res.json(listAgents())
})

// GET /api/agents/board-layer?project_id=16[&workspace=example]
// Read-only projection of the agent -> skill -> tool layer graph, scoped to a
// board project (or to a whole workspace when project_id is omitted). Powers
// the Agents tab. The graph edges come from services/skill-graph.ts; this route
// adds board scope (objectives.agent_context counts), registry metadata and
// on-disk existence. See services/board-layer.ts.
router.get('/board-layer', async (req: AuthRequest, res) => {
  const rawProject = req.query.project_id
  let projectId: number | null = null
  if (rawProject !== undefined && rawProject !== '') {
    projectId = Number(rawProject)
    if (!Number.isInteger(projectId) || projectId <= 0) {
      res.status(400).json({ error: 'project_id must be a positive integer' })
      return
    }
  }
  const workspace = typeof req.query.workspace === 'string' && req.query.workspace
    ? req.query.workspace
    : null
  if (projectId === null && !workspace) {
    res.status(400).json({ error: 'project_id or workspace is required' })
    return
  }
  try {
    res.json(await loadBoardLayer({ projectId, workspace }))
  } catch (err) {
    const status = (err as { status?: number }).status
    if (status === 404) {
      res.status(404).json({ error: (err as Error).message })
      return
    }
    // The layer graph generator is repo-external; when it is unavailable the
    // tab should say so rather than render an empty graph as truth.
    res.status(503).json({ error: `layer graph unavailable: ${(err as Error).message}` })
  }
})

// GET /api/agents/layer-file?kind=agent|skill|tool|overlay&slug=…[&workspace=…]
// Serves one markdown layer file. Deliberately NOT routed through the docs
// route's workspace doc_read_roots (see the PR body / ARTIFACT): this endpoint
// carries its own, narrower allowlist — the three ~/ai-workspace layer roots
// plus the workspaces/<ws>/agent-profiles overlay tree — with a containment
// assertion after path resolution.
const LAYER_KINDS: LayerKind[] = ['agent', 'skill', 'tool', 'overlay']

router.get('/layer-file', (req: AuthRequest, res) => {
  const kind = String(req.query.kind ?? '') as LayerKind
  if (!LAYER_KINDS.includes(kind)) {
    res.status(400).json({ error: `kind must be one of ${LAYER_KINDS.join(', ')}` })
    return
  }
  const slug = typeof req.query.slug === 'string' ? req.query.slug : ''
  const workspace = typeof req.query.workspace === 'string' ? req.query.workspace : null
  try {
    res.json(readLayerFile({ kind, slug, workspace }))
  } catch (err) {
    if (err instanceof LayerPathError) {
      res.status(400).json({ error: err.message })
      return
    }
    const status = (err as { status?: number }).status
    res.status(typeof status === 'number' ? status : 500).json({ error: (err as Error).message })
  }
})

export default router
