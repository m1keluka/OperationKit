// Admin-only surface for the Loops tracker (personal / holdco threads-with-people).
//
// Gating: requireAuth + requireAdmin. Mike is the only admin, so a non-admin member
// of ANY workspace — including a member of personal itself — receives 403 on every
// endpoint. Mirrors the granola-content route's gating (Mike-only vault data) with
// the existing RBAC primitives; no new auth scheme.
//
// Data lives entirely in second-brain markdown (see services/loops.ts). This route
// NEVER touches the granola_processed_meetings / granola_action_items tables nor the
// granola-content drafts/hooks files — loops are a separate stream.
import { Router } from 'express'
import { requireAuth, requireAdmin, type AuthRequest } from '../middleware/auth.js'
import {
  listLoops,
  createLoop,
  patchLoopBody,
  patchLoopStatus,
  patchLoopMeta,
  archiveLoop,
  LOOPS_WORKSPACE,
} from '../services/loops.js'

const router = Router()
// Admin-only for the entire surface.
router.use(requireAuth, requireAdmin)

// GET /api/loops — all loops (client filters by status / tag / party).
router.get('/', (_req: AuthRequest, res) => {
  res.json({ workspace: LOOPS_WORKSPACE, loops: listLoops() })
})

// POST /api/loops — manual "New loop" (title required; People/party OPTIONAL). New
// loops enter the `queued` lane, created today. project/due optional.
router.post('/', (req: AuthRequest, res) => {
  const { party, title, project, due, tags, party_type } = (req.body || {}) as {
    party?: string
    title?: string
    project?: string
    due?: string
    tags?: string[]
    party_type?: string
  }
  const result = createLoop({
    party: party || '',
    title: title || '',
    project: typeof project === 'string' ? project : '',
    due: typeof due === 'string' ? due : '',
    tags: Array.isArray(tags) ? tags : [],
    party_type: typeof party_type === 'string' ? party_type : '',
  })
  if (!result.ok) {
    res.status(400).json({ error: result.error })
    return
  }
  res.status(201).json({ ok: true, loop: result.loop })
})

// PATCH /api/loops/:slug/body — edit the markdown notes, preserving frontmatter.
router.patch('/:slug/body', (req: AuthRequest, res) => {
  const { body } = (req.body || {}) as { body?: string }
  if (typeof body !== 'string') {
    res.status(400).json({ error: 'body (string) required' })
    return
  }
  const result = patchLoopBody(req.params.slug as string, body)
  if (!result.ok) {
    res.status(result.error === 'loop not found' ? 404 : 400).json({ error: result.error })
    return
  }
  res.json({ ok: true, loop: result.loop })
})

// PATCH /api/loops/:slug/status — move across lanes queued|working|done (done stamps done-date).
router.patch('/:slug/status', (req: AuthRequest, res) => {
  const { status } = (req.body || {}) as { status?: string }
  if (!status) {
    res.status(400).json({ error: 'status required' })
    return
  }
  const result = patchLoopStatus(req.params.slug as string, status)
  if (!result.ok) {
    res.status(result.error === 'loop not found' ? 404 : 400).json({ error: result.error })
    return
  }
  res.json({ ok: true, loop: result.loop })
})

// PATCH /api/loops/:slug/meta — change project / due / People(party) / party_type
// and/or replace the tag set.
router.patch('/:slug/meta', (req: AuthRequest, res) => {
  const { project, due, party, party_type, tags } = (req.body || {}) as {
    project?: string
    due?: string
    party?: string
    party_type?: string
    tags?: string[]
  }
  const result = patchLoopMeta(req.params.slug as string, { project, due, party, party_type, tags })
  if (!result.ok) {
    res.status(result.error === 'loop not found' ? 404 : 400).json({ error: result.error })
    return
  }
  res.json({ ok: true, loop: result.loop })
})

// DELETE /api/loops/:slug — "remove" a loop (reversible: moved to loops-archive/).
router.delete('/:slug', (req: AuthRequest, res) => {
  const result = archiveLoop(req.params.slug as string)
  if (!result.ok) {
    res.status(result.error === 'loop not found' ? 404 : 400).json({ error: result.error })
    return
  }
  res.json({ ok: true })
})

// POST /api/loops/:slug/approve — approve a pending (review-queue) loop onto the
// active board (moves it to `queued`). Clean semantics over PATCH /status; works
// from any lane but the intended source is `pending`.
router.post('/:slug/approve', (req: AuthRequest, res) => {
  const result = patchLoopStatus(req.params.slug as string, 'queued')
  if (!result.ok) {
    res.status(result.error === 'loop not found' ? 404 : 400).json({ error: result.error })
    return
  }
  res.json({ ok: true, loop: result.loop })
})

// POST /api/loops/:slug/deny — deny a pending loop. Delegates to the existing
// archive path (reversible move to loops-archive/), so Deny === archive.
router.post('/:slug/deny', (req: AuthRequest, res) => {
  const result = archiveLoop(req.params.slug as string)
  if (!result.ok) {
    res.status(result.error === 'loop not found' ? 404 : 400).json({ error: result.error })
    return
  }
  res.json({ ok: true })
})

// POST /api/loops/bulk — checkbox/bulk management. action 'status' moves each slug to
// `status`; action 'archive' archives each. Returns a per-slug result list.
router.post('/bulk', (req: AuthRequest, res) => {
  const { slugs, action, status } = (req.body || {}) as {
    slugs?: string[]
    action?: 'status' | 'archive'
    status?: string
  }
  if (!Array.isArray(slugs) || slugs.length === 0) {
    res.status(400).json({ error: 'slugs (non-empty array) required' })
    return
  }
  if (action !== 'status' && action !== 'archive') {
    res.status(400).json({ error: "action must be 'status' or 'archive'" })
    return
  }
  if (action === 'status' && !status) {
    res.status(400).json({ error: "status required for action 'status'" })
    return
  }
  const results = slugs.map(slug => {
    const r = action === 'archive' ? archiveLoop(String(slug)) : patchLoopStatus(String(slug), status as string)
    return { slug: String(slug), ok: r.ok, error: r.ok ? undefined : r.error }
  })
  res.json({ ok: results.every(r => r.ok), results })
})

export default router
