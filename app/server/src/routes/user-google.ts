/**
 * Per-user Google Workspace connection API (obj-706070).
 *
 * Lets an authenticated Command Center user connect / disconnect THEIR OWN
 * Google Workspace account. Every route except the OAuth callback is mounted
 * behind `requireAuth` and reads the caller's id from the JWT (`req.user.id`) —
 * a user can only ever touch their own row.
 *
 *   GET    /api/user/google           → masked summary | null (+ configured flag)
 *   POST   /api/user/google/connect   → { auth_url } : start the consent flow
 *   GET    /api/user/google/callback  → Google redirect target; stores the grant
 *   DELETE /api/user/google           → revoke at Google + delete the row
 *
 * The callback is deliberately NOT behind requireAuth: Google performs a
 * top-level redirect and we cannot rely on the auth cookie surviving the
 * cross-site round-trip. The acting user is derived from the signed `state`
 * JWT minted in POST /connect, which is the CSRF binding.
 *
 * Responses expose ONLY `UserGoogleConnectionSummary`. No access token, refresh
 * token, or client secret is ever echoed back or logged.
 */
import { Router } from 'express'
import type { Request, Response } from 'express'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import {
  getForUser,
  upsert,
  disconnect,
  getOAuthClient,
  buildAuthUrl,
  verifyState,
  exchangeCode,
  fetchUserInfo,
} from '../services/user-google-connections.js'

const router = Router()

/** Resolve the authenticated caller's user id, or 401. */
function callerId(req: AuthRequest, res: Response): number | null {
  const id = req.user?.id
  if (typeof id !== 'number') {
    res.status(401).json({ error: 'Authentication required' })
    return null
  }
  return id
}

/** Where to bounce the browser after the consent round-trip completes. */
function settingsUrl(status: string, detail?: string): string {
  const base = process.env.APP_BASE_URL || ''
  const q = new URLSearchParams({ google: status })
  if (detail) q.set('google_error', detail)
  return `${base}/settings/you?${q.toString()}`
}

// ── Callback (public: Google redirect target, CSRF-bound by signed state) ───
router.get('/callback', async (req: Request, res: Response) => {
  const code = typeof req.query.code === 'string' ? req.query.code : ''
  const state = typeof req.query.state === 'string' ? req.query.state : ''
  const oauthError = typeof req.query.error === 'string' ? req.query.error : ''

  if (oauthError) return res.redirect(settingsUrl('error', oauthError))
  if (!code || !state) return res.redirect(settingsUrl('error', 'missing_code'))

  const userId = verifyState(state)
  if (userId == null) return res.redirect(settingsUrl('error', 'invalid_state'))

  const client = getOAuthClient()
  if (!client) return res.redirect(settingsUrl('error', 'not_configured'))

  const result = await exchangeCode(code, client)
  if (!result.ok) return res.redirect(settingsUrl('error', result.error))

  const info = await fetchUserInfo(result.data.accessToken)
  upsert(userId, {
    googleEmail: info.email,
    googleSub: info.sub,
    refreshToken: result.data.refreshToken,
    accessToken: result.data.accessToken || null,
    accessTokenExpiresAt: result.data.expiresAt,
    scopes: result.data.scopes,
    clientId: client.clientId,
  })
  return res.redirect(settingsUrl('connected'))
})

router.use(requireAuth)

// GET — masked summary of the caller's connection, or null, plus whether the
// server has an OAuth client at all (so the UI can explain a dead Connect button).
router.get('/', (req: AuthRequest, res: Response) => {
  const userId = callerId(req, res)
  if (userId == null) return
  res.json({ connection: getForUser(userId), configured: getOAuthClient() !== null })
})

// POST /connect — mint the consent URL for the caller.
router.post('/connect', (req: AuthRequest, res: Response) => {
  const userId = callerId(req, res)
  if (userId == null) return
  const client = getOAuthClient()
  if (!client) {
    res.status(503).json({ error: 'Google OAuth is not configured on this server.' })
    return
  }
  res.json({ auth_url: buildAuthUrl(userId, client) })
})

// DELETE — revoke at Google and drop the stored credential.
router.delete('/', async (req: AuthRequest, res: Response) => {
  const userId = callerId(req, res)
  if (userId == null) return
  res.json(await disconnect(userId))
})

export default router
