// Admin-only surface for the Granola content engine (personal / holdco content).
//
// Gating: requireAuth + requireAdmin. Mike is the only admin, so a non-admin member
// of ANY workspace — including a member of personal itself — receives 403 on every
// endpoint. This satisfies the CONTRACT's hard cross-workspace isolation requirement
// (Mike-only / holdco content) with the existing RBAC primitives; no new auth scheme.
//
// Data lives entirely in the second-brain vault markdown (see services/granola-content.ts).
// This route NEVER reads or writes the granola_processed_meetings / granola_action_items
// tables (those are the separate CC-146 meeting pipeline).
import { Router } from 'express'
import { requireAuth, requireAdmin, type AuthRequest } from '../middleware/auth.js'
import {
  listDrafts,
  patchDraftStatus,
  patchDraftBody,
  listHooks,
  listIdeas,
  scheduleInfo,
  runNow,
  addHookVideo,
  removeHookVideo,
  hookVideoObjectPath,
  GRANOLA_WORKSPACE,
} from '../services/granola-content.js'
import {
  ensureBucket,
  signUpload,
  deleteObject,
  ALLOWED_VIDEO_MIME,
  MAX_VIDEO_BYTES,
} from '../services/supabase-storage.js'

const router = Router()
// Admin-only for the entire surface.
router.use(requireAuth, requireAdmin)

// GET /api/granola-content/drafts?status=draft|ready|posted|all — the posting queue
router.get('/drafts', (req: AuthRequest, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : 'all'
  res.json({ workspace: GRANOLA_WORKSPACE, status, drafts: listDrafts(status) })
})

// PATCH /api/granola-content/drafts/:file/status — advance draft→ready→posted.
// Rewrites only the frontmatter `status:` value, re-renders, returns the draft.
router.patch('/drafts/:file/status', (req: AuthRequest, res) => {
  const { status } = (req.body || {}) as { status?: string }
  if (!status) {
    res.status(400).json({ error: 'status required' })
    return
  }
  const result = patchDraftStatus(req.params.file as string, status)
  if (!result.ok) {
    const code = result.error === 'draft not found' ? 404 : 400
    res.status(code).json({ error: result.error })
    return
  }
  res.json({ ok: true, draft: result.draft })
})

// PATCH /api/granola-content/drafts/:file/body — edit the post body in place.
// Rewrites only the body region below the frontmatter, preserving frontmatter
// byte-for-byte. Re-parses + returns the updated draft.
router.patch('/drafts/:file/body', (req: AuthRequest, res) => {
  const { body } = (req.body || {}) as { body?: string }
  if (typeof body !== 'string') {
    res.status(400).json({ error: 'body (string) required' })
    return
  }
  const result = patchDraftBody(req.params.file as string, body)
  if (!result.ok) {
    const code = result.error === 'draft not found' ? 404 : 400
    res.status(code).json({ error: result.error })
    return
  }
  res.json({ ok: true, draft: result.draft })
})

// GET /api/granola-content/hooks — short-form video hooks
router.get('/hooks', (_req: AuthRequest, res) => {
  res.json({ workspace: GRANOLA_WORKSPACE, hooks: listHooks() })
})

// POST /api/granola-content/hooks/:file/video/sign — mint a signed upload URL so the browser
// uploads the (large) video file DIRECTLY to Supabase Storage. Service key never reaches the client.
router.post('/hooks/:file/video/sign', async (req: AuthRequest, res) => {
  const { filename, contentType, size } = (req.body || {}) as {
    filename?: string
    contentType?: string
    size?: number
  }
  if (!filename || typeof filename !== 'string') {
    res.status(400).json({ error: 'filename (string) required' })
    return
  }
  if (!contentType || !ALLOWED_VIDEO_MIME.includes(contentType)) {
    res.status(400).json({ error: `contentType must be one of: ${ALLOWED_VIDEO_MIME.join(', ')}` })
    return
  }
  if (typeof size === 'number' && size > MAX_VIDEO_BYTES) {
    res.status(400).json({ error: `file too large (max ${MAX_VIDEO_BYTES} bytes)` })
    return
  }
  try {
    await ensureBucket()
    const objectPath = hookVideoObjectPath(req.params.file as string, filename)
    const signed = await signUpload(objectPath)
    res.json({ ok: true, ...signed, contentType })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'sign failed' })
  }
})

// POST /api/granola-content/hooks/:file/video — record uploaded video metadata in the hook
// doc's frontmatter (after the browser's direct upload succeeds). Returns the updated hook.
router.post('/hooks/:file/video', (req: AuthRequest, res) => {
  const { path: objectPath, url, hook_index, label, size } = (req.body || {}) as {
    path?: string
    url?: string
    hook_index?: number
    label?: string
    size?: number
  }
  if (!objectPath || !url) {
    res.status(400).json({ error: 'path and url required' })
    return
  }
  const result = addHookVideo(req.params.file as string, {
    path: objectPath,
    url,
    hook_index: typeof hook_index === 'number' ? hook_index : -1,
    label: typeof label === 'string' ? label : '',
    uploaded_at: new Date().toISOString(),
    size: typeof size === 'number' ? size : 0,
  })
  if (!result.ok) {
    res.status(result.error === 'hook doc not found' ? 404 : 400).json({ error: result.error })
    return
  }
  res.status(201).json({ ok: true, hook: result.hook })
})

// POST /api/granola-content/hooks/:file/video/delete — remove a recorded video: deletes the
// storage object then strips the frontmatter entry. (POST not DELETE so we can pass a body.)
router.post('/hooks/:file/video/delete', async (req: AuthRequest, res) => {
  const { path: objectPath } = (req.body || {}) as { path?: string }
  if (!objectPath) {
    res.status(400).json({ error: 'path required' })
    return
  }
  try {
    await deleteObject(objectPath).catch(() => false) // strip metadata even if object already gone
    const result = removeHookVideo(req.params.file as string, objectPath)
    if (!result.ok) {
      res.status(result.error === 'hook doc not found' ? 404 : 400).json({ error: result.error })
      return
    }
    res.json({ ok: true, hook: result.hook })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'delete failed' })
  }
})

// GET /api/granola-content/ideas — ideas inbox
router.get('/ideas', (_req: AuthRequest, res) => {
  res.json({ workspace: GRANOLA_WORKSPACE, ideas: listIdeas() })
})

// GET /api/granola-content/schedule — nightly routine state (exists/enabled/last run)
router.get('/schedule', (_req: AuthRequest, res) => {
  res.json(scheduleInfo())
})

// POST /api/granola-content/run — "Run now": spawn the granola-intake session
// (same routine the nightly schedule fires).
router.post('/run', async (_req: AuthRequest, res) => {
  try {
    const result = await runNow()
    res.status(result.ok ? 201 : 409).json(result)
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'run failed' })
  }
})

export default router
