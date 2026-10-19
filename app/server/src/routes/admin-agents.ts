import { Router } from 'express'
import { requireAuth, requireAdmin, type AuthRequest } from '../middleware/auth.js'
import type { AgentKind, AgentWorkdirKind } from '@operationkit/shared'
import {
  agentExists,
  archiveAgent,
  createAgent,
  getAgent,
  listAgents,
  updateAgent,
} from '../services/agent-registry.js'

const router = Router()
router.use(requireAuth, requireAdmin)

const KINDS: AgentKind[] = ['executive', 'routing-only']
const WORKDIRS: AgentWorkdirKind[] = ['projects', 'workspace', 'home', 'custom']

function parseKind(v: unknown): AgentKind | undefined {
  return typeof v === 'string' && (KINDS as string[]).includes(v) ? (v as AgentKind) : undefined
}
function parseWorkdirKind(v: unknown): AgentWorkdirKind | undefined {
  return typeof v === 'string' && (WORKDIRS as string[]).includes(v) ? (v as AgentWorkdirKind) : undefined
}
function optString(v: unknown): string | null | undefined {
  if (v === undefined) return undefined
  if (v === null) return null
  return typeof v === 'string' ? v : undefined
}

// GET /api/admin/agents-registry — full list including archived (admin view).
// Mounted off the /agents path used by admin-ops.ts, which lists persona FILES.
router.get('/', (_req: AuthRequest, res) => {
  res.json(listAgents({ includeArchived: true }))
})

// POST /api/admin/agents-registry — add a persona to the roster
router.post('/', (req: AuthRequest, res) => {
  const body = req.body as Record<string, unknown>
  const slug = typeof body.slug === 'string' ? body.slug.trim() : ''
  const label = typeof body.label === 'string' ? body.label.trim() : ''
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(slug)) {
    res.status(400).json({ error: 'slug must be 2-41 chars: lowercase alnum + hyphens' })
    return
  }
  if (!label) {
    res.status(400).json({ error: 'label required' })
    return
  }
  if (agentExists(slug)) {
    res.status(409).json({ error: `Agent '${slug}' already exists` })
    return
  }
  const workdir_kind = parseWorkdirKind(body.workdir_kind) ?? 'workspace'
  if (workdir_kind === 'custom' && typeof body.workdir_path !== 'string') {
    res.status(400).json({ error: "workdir_path is required when workdir_kind is 'custom'" })
    return
  }
  res.status(201).json(createAgent({
    slug,
    label,
    kind: parseKind(body.kind) ?? 'executive',
    assignable: body.assignable === undefined ? true : !!body.assignable,
    prompt_file: optString(body.prompt_file) ?? null,
    workdir_kind,
    workdir_path: optString(body.workdir_path) ?? null,
    mono: optString(body.mono) ?? null,
    badge_hex: optString(body.badge_hex) ?? null,
    badge_tw: optString(body.badge_tw) ?? null,
    sort_order: typeof body.sort_order === 'number' ? body.sort_order : 0,
  }))
})

// PATCH /api/admin/agents-registry/:slug — edit a persona
router.patch('/:slug', (req: AuthRequest, res) => {
  const slug = String(req.params.slug)
  if (!getAgent(slug)) {
    res.status(404).json({ error: `Agent '${slug}' not found` })
    return
  }
  const body = req.body as Record<string, unknown>
  const updated = updateAgent(slug, {
    label: typeof body.label === 'string' && body.label.trim() ? body.label.trim() : undefined,
    kind: parseKind(body.kind),
    assignable: body.assignable === undefined ? undefined : !!body.assignable,
    prompt_file: optString(body.prompt_file),
    workdir_kind: parseWorkdirKind(body.workdir_kind),
    workdir_path: optString(body.workdir_path),
    mono: optString(body.mono),
    badge_hex: optString(body.badge_hex),
    badge_tw: optString(body.badge_tw),
    sort_order: typeof body.sort_order === 'number' ? body.sort_order : undefined,
    archived: body.archived === undefined ? undefined : !!body.archived,
  })
  res.json(updated)
})

// DELETE /api/admin/agents-registry/:slug — archive, never hard-delete: existing
// board cards keep pointing at the slug and must not be orphaned.
router.delete('/:slug', (req: AuthRequest, res) => {
  const slug = String(req.params.slug)
  const result = archiveAgent(slug)
  if (!result.ok) {
    res.status(result.reason === 'not_found' ? 404 : 409).json({ error: result.reason })
    return
  }
  res.json({ ok: true, archived: slug })
})

export default router
