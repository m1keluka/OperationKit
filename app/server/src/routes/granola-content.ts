// Content engine HTTP surface — one content owner per authenticated user.
//
// Gating (obj 710856): requireAuth + requireContentOwner. Previously this was
// `requireAdmin`, which made Mike structurally the only person who could ever use
// the engine. Access is now a row in `content_owners`; a user without one gets 403
// on every endpoint and never sees the nav item. That preserves the CONTRACT's
// hard isolation requirement — stronger, in fact, since the owner row (not the
// URL, and not the caller's role) is what resolves every filesystem path, so an
// owner cannot reach another owner's drafts even by guessing filenames.
//
// Data lives entirely in the second-brain vault markdown (see services/granola-content.ts).
// This route NEVER reads or writes the granola_processed_meetings / granola_action_items
// tables (those are the separate CC-146 meeting pipeline).
import { Router, type Response, type NextFunction } from 'express'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
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
} from '../services/granola-content.js'
import {
  getContentOwner,
  granolaConnection,
  setGranolaKey,
  clearGranolaKey,
  ensureVaultDirs,
  ensureRoutine,
  ensureFounderPackDir,
  voiceProfileReady,
  ownerPaths,
  type ContentOwner,
} from '../services/content-owners.js'
import { verifyApiKey } from '../services/granola-client.js'
import {
  ensureBucket,
  signUpload,
  deleteObject,
  ALLOWED_VIDEO_MIME,
  MAX_VIDEO_BYTES,
} from '../services/supabase-storage.js'

const router = Router()

interface OwnerRequest extends AuthRequest {
  owner?: ContentOwner
}

/**
 * Resolve the caller's content owner, or 403. Deliberately NOT role-based: being
 * a global admin does not grant someone else's content, and being a plain member
 * does not withhold your own.
 */
function requireContentOwner(req: OwnerRequest, res: Response, next: NextFunction): void {
  const owner = getContentOwner(req.user!.id)
  if (!owner) {
    res.status(403).json({ error: 'No content workspace is set up for this account' })
    return
  }
  req.owner = owner
  next()
}

router.use(requireAuth, requireContentOwner)

// ── Connection / onboarding ──────────────────────────────────────────────────

// GET /api/granola-content/me — who this owner is and whether the flywheel is
// actually turning: Granola connected? voice profile built? routine scheduled?
// The UI renders its onboarding checklist straight off this.
router.get('/me', (req: OwnerRequest, res) => {
  const owner = req.owner!
  const conn = granolaConnection(owner)
  res.json({
    workspace: owner.vault_workspace,
    founder: owner.founder_slug,
    display_name: owner.display_name,
    granola: conn,
    voice_profile_ready: voiceProfileReady(owner),
    voice_profile_path: ownerPaths(owner).voicePatternsFile,
    schedule: scheduleInfo(owner),
  })
})

// POST /api/granola-content/connection — paste a Granola API key.
//
// The key is VERIFIED against Granola before it is stored: an unverified key would
// fail silently every night inside a spawned session, where nobody sees it. On
// success we also provision everything the nightly run needs — vault stream dirs,
// the founder pack dir, and the owner's routine (enabled at this point, since a
// credential now exists).
router.post('/connection', async (req: OwnerRequest, res) => {
  const owner = req.owner!
  const { api_key: apiKey } = (req.body || {}) as { api_key?: string }
  if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
    res.status(400).json({ error: 'api_key (string) required' })
    return
  }
  const key = apiKey.trim()
  const check = await verifyApiKey(key)
  if (!check.ok) {
    res.status(400).json({ error: `Granola rejected that key: ${check.error}` })
    return
  }
  setGranolaKey(owner, key)
  const created = ensureVaultDirs(owner)
  ensureFounderPackDir(owner)
  const routine = ensureRoutine(owner, true)
  res.status(201).json({
    ok: true,
    account: check.account,
    provisioned: created,
    schedule: {
      exists: true,
      enabled: routine.enabled === 1,
      cron_expr: routine.cron_expr,
      last_run_at: routine.last_run_at,
      workspace: owner.vault_workspace,
      routine: owner.routine_name,
    },
  })
})

// DELETE /api/granola-content/connection — disconnect Granola. Leaves the vault
// streams and every existing draft intact; this only revokes the credential.
router.delete('/connection', (req: OwnerRequest, res) => {
  const removed = clearGranolaKey(req.owner!)
  res.json({ ok: true, removed })
})

// ── Posting queue ────────────────────────────────────────────────────────────

// GET /api/granola-content/drafts?status=draft|ready|posted|all — the posting queue
router.get('/drafts', (req: OwnerRequest, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : 'all'
  res.json({ workspace: req.owner!.vault_workspace, status, drafts: listDrafts(req.owner!, status) })
})

// PATCH /api/granola-content/drafts/:file/status — advance draft→ready→posted.
// Rewrites only the frontmatter `status:` value, re-renders, returns the draft.
router.patch('/drafts/:file/status', (req: OwnerRequest, res) => {
  const { status } = (req.body || {}) as { status?: string }
  if (!status) {
    res.status(400).json({ error: 'status required' })
    return
  }
  const result = patchDraftStatus(req.owner!, req.params.file as string, status)
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
router.patch('/drafts/:file/body', (req: OwnerRequest, res) => {
  const { body } = (req.body || {}) as { body?: string }
  if (typeof body !== 'string') {
    res.status(400).json({ error: 'body (string) required' })
    return
  }
  const result = patchDraftBody(req.owner!, req.params.file as string, body)
  if (!result.ok) {
    const code = result.error === 'draft not found' ? 404 : 400
    res.status(code).json({ error: result.error })
    return
  }
  res.json({ ok: true, draft: result.draft })
})

// ── Hooks / short-form ───────────────────────────────────────────────────────

// GET /api/granola-content/hooks — short-form video hooks
router.get('/hooks', (req: OwnerRequest, res) => {
  res.json({ workspace: req.owner!.vault_workspace, hooks: listHooks(req.owner!) })
})

// POST /api/granola-content/hooks/:file/video/sign — mint a signed upload URL so the browser
// uploads the (large) video file DIRECTLY to Supabase Storage. Service key never reaches the client.
router.post('/hooks/:file/video/sign', async (req: OwnerRequest, res) => {
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
    const objectPath = hookVideoObjectPath(req.owner!, req.params.file as string, filename)
    const signed = await signUpload(objectPath)
    res.json({ ok: true, ...signed, contentType })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'sign failed' })
  }
})

// POST /api/granola-content/hooks/:file/video — record uploaded video metadata in the hook
// doc's frontmatter (after the browser's direct upload succeeds). Returns the updated hook.
router.post('/hooks/:file/video', (req: OwnerRequest, res) => {
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
  const result = addHookVideo(req.owner!, req.params.file as string, {
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
router.post('/hooks/:file/video/delete', async (req: OwnerRequest, res) => {
  const { path: objectPath } = (req.body || {}) as { path?: string }
  if (!objectPath) {
    res.status(400).json({ error: 'path required' })
    return
  }
  // An owner may only delete objects inside their OWN prefix in the shared bucket.
  if (!objectPath.startsWith(`${req.owner!.vault_workspace}/`)) {
    res.status(403).json({ error: 'object does not belong to this content workspace' })
    return
  }
  try {
    await deleteObject(objectPath).catch(() => false) // strip metadata even if object already gone
    const result = removeHookVideo(req.owner!, req.params.file as string, objectPath)
    if (!result.ok) {
      res.status(result.error === 'hook doc not found' ? 404 : 400).json({ error: result.error })
      return
    }
    res.json({ ok: true, hook: result.hook })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'delete failed' })
  }
})

// ── Ideas / schedule / run ───────────────────────────────────────────────────

// GET /api/granola-content/ideas — ideas inbox
router.get('/ideas', (req: OwnerRequest, res) => {
  res.json({ workspace: req.owner!.vault_workspace, ideas: listIdeas(req.owner!) })
})

// GET /api/granola-content/schedule — nightly routine state (exists/enabled/last run)
router.get('/schedule', (req: OwnerRequest, res) => {
  res.json(scheduleInfo(req.owner!))
})

// POST /api/granola-content/run — "Run now": spawn this owner's granola-intake
// session (the same routine their nightly schedule fires).
router.post('/run', async (req: OwnerRequest, res) => {
  try {
    const result = await runNow(req.owner!)
    res.status(result.ok ? 201 : 409).json(result)
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'run failed' })
  }
})

export default router
