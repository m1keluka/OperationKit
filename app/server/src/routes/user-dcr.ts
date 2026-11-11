/**
 * Generic DCR/CIMD OAuth callback for every `auth_path: 'dcr_mcp'` connector
 * (Sprint 7.3, obj 900507).
 *
 *   GET /api/user/dcr/:connectorId/callback
 *
 * One route serves every `dcr_mcp` connector: the per-install registration
 * (services/dcr-client-registrations.ts) already recorded which client_id
 * (and, for DCR, client_secret) this install registered and against which
 * issuer, so the exchange itself needs no connector-specific code. This
 * mirrors routes/user-google.ts's callback (also NOT behind `requireAuth` —
 * the provider performs a top-level redirect, so the acting user is derived
 * from the signed `state` JWT, the CSRF binding, never a query param or a
 * cookie that may not have survived the round-trip).
 *
 * The actual OAuth grant is persisted via each connector's own
 * `storeOAuthGrant` (defs/notion.ts, defs/linear.ts) rather than writing
 * user_dcr_connections directly here, so a future `dcr_mcp` connector that
 * needs to resolve its own account label from the token response can do so
 * without this route growing a per-vendor branch.
 */
import { Router } from 'express'
import type { Request, Response } from 'express'
import { getConnector } from '../connectors/registry.js'
import { discoverAuthServerMetadata, exchangeAuthorizationCode } from '../connectors/dcr-client.js'
import { getRegistration, getDecryptedClientSecret } from '../services/dcr-client-registrations.js'
import { verifyDcrState } from '../services/dcr-state.js'
import { appBaseUrl } from '../connectors/dcr-routes.js'
import { DCR_GRANT_STORES } from '../connectors/dcr-grant-stores.js'

const router = Router()

/** Where to bounce the browser after the consent round-trip completes. */
function settingsUrl(connectorId: string, status: string, detail?: string): string {
  const q = new URLSearchParams({ connector: connectorId, [connectorId]: status })
  if (detail) q.set(`${connectorId}_error`, detail)
  return `${appBaseUrl()}/settings/connectors?${q.toString()}`
}

router.get('/:connectorId/callback', async (req: Request, res: Response) => {
  const connectorId = String(req.params.connectorId)
  const code = typeof req.query.code === 'string' ? req.query.code : ''
  const state = typeof req.query.state === 'string' ? req.query.state : ''
  const oauthError = typeof req.query.error === 'string' ? req.query.error : ''

  if (oauthError) return res.redirect(settingsUrl(connectorId, 'error', oauthError))
  if (!code || !state) return res.redirect(settingsUrl(connectorId, 'error', 'missing_code'))

  const def = await getConnector(connectorId)
  if (!def || def.auth_path !== 'dcr_mcp') return res.redirect(settingsUrl(connectorId, 'error', 'not_a_dcr_connector'))

  const payload = verifyDcrState(state, connectorId)
  if (!payload) return res.redirect(settingsUrl(connectorId, 'error', 'invalid_state'))

  const reg = getRegistration(connectorId)
  if (!reg) return res.redirect(settingsUrl(connectorId, 'error', 'not_registered'))

  const metadata = await discoverAuthServerMetadata(reg.issuer)
  if (!metadata) return res.redirect(settingsUrl(connectorId, 'error', 'discovery_failed'))

  const clientSecret = reg.has_client_secret ? (getDecryptedClientSecret(connectorId) ?? undefined) : undefined
  const result = await exchangeAuthorizationCode(metadata, {
    code,
    redirectUri: reg.redirect_uri,
    clientId: reg.client_id,
    clientSecret,
    codeVerifier: payload.verifier,
  })
  if (!result.ok) return res.redirect(settingsUrl(connectorId, 'error', result.error))

  const storeGrant = DCR_GRANT_STORES[connectorId]
  if (!storeGrant) return res.redirect(settingsUrl(connectorId, 'error', 'connector_not_wired'))

  const expiresAt = result.data.expires_in
    ? new Date(Date.now() + result.data.expires_in * 1000).toISOString()
    : null
  storeGrant(payload.uid, {
    accessToken: result.data.access_token,
    refreshToken: result.data.refresh_token,
    expiresAt,
    scopes: result.data.scope ?? null,
  })

  return res.redirect(settingsUrl(connectorId, 'connected'))
})

export default router
