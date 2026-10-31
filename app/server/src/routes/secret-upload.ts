/**
 * POST /api/secret-upload?name=NAME  (obj 719065)
 *
 * The write-only end of an agent-relayed secret request. The caller holds a
 * one-time token minted by POST /api/objectives/:id/secret-requests/:rid/upload-token
 * and sends it in `X-CC-Upload-Token` (a header, so it never lands in an access
 * log line the way a URL path would). The body is the raw value
 * (`Content-Type: text/plain`, e.g. `printf %s "$NAME" | curl --data-binary @-`)
 * or JSON `{ "value": "…" }`.
 *
 * No login: the token IS the capability — single use, ~15 min, bound to one
 * card + NAME + scope. The response names the secret and never echoes the value.
 * Gated by settings.session_secret_access like the rest of the request flow.
 */
import express, { Router } from 'express'
import { SESSION_SECRET_ACCESS_FLAG, readSettingFlag } from '../lib/session-trust.js'
import { SECRET_VALUE_MAX, redeemUploadToken } from '../services/secret-requests.js'

const router = Router()

router.post('/', express.text({ type: 'text/plain', limit: SECRET_VALUE_MAX }), (req, res) => {
  if (!readSettingFlag(SESSION_SECRET_ACCESS_FLAG)) {
    res.status(404).json({ error: 'Not found' })
    return
  }
  const header = req.headers['x-cc-upload-token']
  const token = typeof header === 'string' ? header.trim() : ''
  const name = typeof req.query.name === 'string' ? req.query.name.trim() : ''
  const value =
    typeof req.body === 'string' ? req.body : typeof req.body?.value === 'string' ? (req.body.value as string) : ''
  if (!name) {
    res.status(400).json({ error: 'name query parameter is required (the secret NAME this link is for)' })
    return
  }
  const out = redeemUploadToken(token, name, value)
  if (!out.ok) {
    res.status(out.status).json({ error: out.error })
    return
  }
  res.json({ ok: true, name: out.name, scope: out.scope, card_resumed: out.woke })
})

export default router
