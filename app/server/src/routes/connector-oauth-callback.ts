/**
 * Generic OAuth callback for every `auth_path: 'oauth_guided'` catalog
 * connector (obj 900508). Mirrors `routes/user-google.ts`'s callback — public
 * (the vendor performs a top-level redirect, so the auth cookie cannot be
 * relied on), CSRF-bound by the signed `state` minted in
 * `services/generic-connector-oauth.ts`, never behind `requireAuth`.
 *
 *   GET /api/user/connector-oauth/:id/callback
 *
 * One route handles every vendor because the token exchange only needs the
 * connector's own `oauth.{authorize_url,token_url,scopes}` (declared on its
 * `ConnectorDefinition`) plus the install's own client id/secret — nothing
 * vendor-specific is hardcoded here.
 */
import { Router } from 'express'
import type { Request, Response } from 'express'
import { getConnector } from '../connectors/registry.js'
import {
  verifyState,
  exchangeCode,
  getOAuthClient,
  upsert,
} from '../services/generic-connector-oauth.js'

const router = Router()

function settingsUrl(status: string, detail?: string): string {
  const base = process.env.APP_BASE_URL || ''
  const q = new URLSearchParams({ connector: status })
  if (detail) q.set('connector_error', detail)
  return `${base}/settings/connectors?${q.toString()}`
}

router.get('/:id/callback', async (req: Request, res: Response) => {
  const connectorId = String(req.params.id)
  const code = typeof req.query.code === 'string' ? req.query.code : ''
  const state = typeof req.query.state === 'string' ? req.query.state : ''
  const oauthError = typeof req.query.error === 'string' ? req.query.error : ''

  if (oauthError) return res.redirect(settingsUrl('error', oauthError))
  if (!code || !state) return res.redirect(settingsUrl('error', 'missing_code'))

  const userId = verifyState(connectorId, state)
  if (userId == null) return res.redirect(settingsUrl('error', 'invalid_state'))

  const def = await getConnector(connectorId)
  if (!def || def.auth_path !== 'oauth_guided' || !def.oauth) {
    return res.redirect(settingsUrl('error', 'unknown_connector'))
  }

  const client = getOAuthClient(connectorId)
  if (!client) return res.redirect(settingsUrl('error', 'not_configured'))

  const result = await exchangeCode(def.oauth, code, client)
  if (!result.ok) return res.redirect(settingsUrl('error', result.error))

  upsert(connectorId, userId, {
    accountLabel: null,
    refreshToken: result.data.refreshToken,
    accessToken: result.data.accessToken,
    accessTokenExpiresAt: result.data.expiresAt,
    scopes: result.data.scopes,
  })
  return res.redirect(settingsUrl('connected'))
})

export default router
