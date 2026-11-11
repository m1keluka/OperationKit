// Per-user Scratchpad surface — a private markdown blob per authenticated account.
//
// Gating: requireAuth only (NOT admin) — every user gets their OWN scratchpad, keyed
// strictly off `req.user.id`. There is no way to read or write another user's content;
// the user id comes from the verified JWT, never from the body or a param.
//
// Agents must never write here — this is a human-only store (see services/scratchpad.ts).
import { Router } from 'express'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import { getScratchpadRow, setScratchpad } from '../services/scratchpad.js'

const router = Router()
router.use(requireAuth)

// Cap the stored blob so a runaway paste can't bloat the DB. ~100k chars.
const MAX_CONTENT_CHARS = 100_000

// GET /api/scratchpad — the authenticated user's content ('' if none) + last update.
router.get('/', (req: AuthRequest, res) => {
  const { content, updated_at } = getScratchpadRow(req.user!.id)
  res.json({ content, updated_at })
})

// PUT /api/scratchpad — upsert the authenticated user's content. Body: { content: string }.
router.put('/', (req: AuthRequest, res) => {
  const { content } = (req.body || {}) as { content?: unknown }
  if (typeof content !== 'string') {
    res.status(400).json({ error: 'content (string) required' })
    return
  }
  if (content.length > MAX_CONTENT_CHARS) {
    res.status(413).json({ error: `content too large (max ${MAX_CONTENT_CHARS} chars)` })
    return
  }
  const updated_at = setScratchpad(req.user!.id, content)
  res.json({ ok: true, updated_at })
})

export default router
