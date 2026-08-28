/**
 * Per-user GitHub token API (obj-2200 / W1).
 *
 * Lets an authenticated Command Center user link / re-validate / revoke THEIR
 * OWN GitHub PAT so PRs for objectives they own are attributed to them on
 * GitHub. Every route is mounted behind `requireAuth` and reads the caller's id
 * from the JWT (`req.user.id`) — a user can only ever touch their own row.
 *
 * Responses expose ONLY the masked `UserGithubTokenSummary` (resolved identity
 * + last-4). The raw PAT is accepted on POST over TLS, encrypted at rest, and
 * is NEVER echoed back or logged.
 *
 *   GET    /api/user/github-token          → masked summary | null
 *   POST   /api/user/github-token          → { token } : validate + encrypt + upsert
 *   POST   /api/user/github-token/validate → re-validate the stored token; bump last_validated_at
 *   DELETE /api/user/github-token          → revoke (delete the row)
 */
import { Router } from 'express'
import type { Response } from 'express'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import {
  getForUser,
  upsert,
  deleteForUser,
  touchValidated,
  getDecryptedForUser,
  validatePat,
} from '../services/user-github-tokens.js'

const router = Router()

router.use(requireAuth)

/** Resolve the authenticated caller's user id, or 401. */
function callerId(req: AuthRequest, res: Response): number | null {
  const id = req.user?.id
  if (typeof id !== 'number') {
    res.status(401).json({ error: 'Authentication required' })
    return null
  }
  return id
}

// GET — masked summary of the caller's linked token, or null.
router.get('/', (req: AuthRequest, res: Response) => {
  const userId = callerId(req, res)
  if (userId == null) return
  res.json(getForUser(userId))
})

// POST — link/replace: validate the supplied PAT against GitHub, then encrypt + store.
router.post('/', async (req: AuthRequest, res: Response) => {
  const userId = callerId(req, res)
  if (userId == null) return

  const token = typeof req.body?.token === 'string' ? req.body.token.trim() : ''
  if (!token) {
    res.status(400).json({ error: 'A GitHub token is required.' })
    return
  }

  const result = await validatePat(token)
  if (!result.ok) {
    res.status(400).json({ error: result.error })
    return
  }

  const summary = upsert(userId, {
    rawToken: token,
    login: result.data.login,
    githubUserId: result.data.id,
    email: result.data.email,
    scopes: result.data.scopes,
    tokenType: result.data.type,
  })
  res.json(summary)
})

// POST /validate — re-validate the already-stored token; refresh identity + last_validated_at.
router.post('/validate', async (req: AuthRequest, res: Response) => {
  const userId = callerId(req, res)
  if (userId == null) return

  const existing = getForUser(userId)
  if (!existing) {
    res.status(404).json({ error: 'No GitHub token linked.' })
    return
  }
  const raw = getDecryptedForUser(userId)
  if (!raw) {
    res.status(404).json({ error: 'No GitHub token linked.' })
    return
  }

  const result = await validatePat(raw)
  if (!result.ok) {
    // Keep the row (so the user can re-link) but report the failure clearly.
    res.status(400).json({ error: result.error })
    return
  }

  // Refresh resolved identity in case it changed, then bump the timestamp.
  upsert(userId, {
    rawToken: raw,
    login: result.data.login,
    githubUserId: result.data.id,
    email: result.data.email,
    scopes: result.data.scopes,
    tokenType: result.data.type,
  })
  res.json(touchValidated(userId))
})

// DELETE — revoke the stored token.
router.delete('/', (req: AuthRequest, res: Response) => {
  const userId = callerId(req, res)
  if (userId == null) return
  const removed = deleteForUser(userId)
  res.json({ removed })
})

export default router
