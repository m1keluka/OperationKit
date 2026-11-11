/**
 * Linear connector (Sprint 7.3, obj 900507) — `auth_path: 'dcr_mcp'`.
 *
 * Verified against Linear's own OAuth Authorization Server Metadata
 * (`https://mcp.linear.app/.well-known/oauth-authorization-server`) in Sprint
 * 7.5 (docs/connectors/DCR-CIMD-VENDOR-VERIFICATION.md) — the cleanest-
 * documented case of the six vendors checked: Linear's docs state outright
 * that "the interactive setup flow uses OAuth 2.1 with dynamic client
 * registration", and the metadata advertises BOTH `registration_endpoint`
 * (DCR) and `client_id_metadata_document_supported` (CIMD), no pre-registered
 * app required either way. connectors/dcr-client.ts prefers CIMD per the MCP
 * spec's own priority order.
 *
 * Registration happens against mcp.linear.app directly from THIS install —
 * no Example callback, no shared client id. The token fallback (a bearer token /
 * Linear API key, per Linear's own docs) is implemented via
 * `connectWithFields` and covered by connector-flow.test.ts; it is not yet
 * reachable from the Settings UI for the same reason as Notion's — see
 * defs/notion.ts's header comment.
 *
 * Order: 170, matching the Sprint 7.4 catalog preload layout (obj 900508) so
 * it slots alongside the other 19 preloaded entries rather than colliding
 * with slack.ts's order 30.
 */
import { ensureRegisteredClient, generatePkceVerifier, pkceChallengeFromVerifier, buildAuthorizationUrl } from '../dcr-client.js'
import { dcrRedirectUri, dcrCimdMetadataUrl } from '../dcr-routes.js'
import { getRegistration, saveRegistration } from '../../services/dcr-client-registrations.js'
import {
  getForUser,
  upsertOAuth,
  upsertApiKey,
  deleteForUser,
  type UserDcrConnectionSummary,
} from '../../services/user-dcr-connections.js'
import { signDcrState } from '../../services/dcr-state.js'
import type { ConnectorStatus } from '@operationkit/shared'
import { NOT_CONNECTED, type ConnectorDefinition, type ConnectOutcome } from '../types.js'

export const CONNECTOR_ID = 'linear'
const ISSUER = 'https://mcp.linear.app'
const SCOPE = undefined // Linear's docs do not publish a scope param for the hosted MCP server; omit rather than guess one.

function toStatus(s: UserDcrConnectionSummary | null): ConnectorStatus {
  if (!s) return NOT_CONNECTED
  return {
    state: s.last_error ? 'error' : 'connected',
    account: s.account_label,
    details: [{ label: 'Connected via', value: s.auth_method === 'oauth' ? 'Sign-in (DCR/CIMD)' : 'API key' }],
    connected_at: s.connected_at,
    checked_at: s.last_refreshed_at,
    error: s.last_error,
  }
}

const linear: ConnectorDefinition = {
  id: CONNECTOR_ID,
  name: 'Linear',
  order: 170,
  auth_path: 'dcr_mcp',
  mcp_url: ISSUER,
  setup_guide: 'docs/connectors/guides/linear.md',
  description:
    'Lets agents read and manage Linear issues and projects through the hosted Linear MCP server, as your Linear account.',
  products: [
    { id: 'issues', name: 'Issues', description: 'Read, create and update Linear issues.' },
    { id: 'projects', name: 'Projects', description: 'See and organize Linear projects.' },
  ],
  connect: { kind: 'oauth', button_label: 'Connect Linear' },

  status: ctx => toStatus(getForUser(CONNECTOR_ID, ctx.userId)),

  async startOAuth(ctx): Promise<ConnectOutcome> {
    const redirectUri = dcrRedirectUri(CONNECTOR_ID)
    const reg = await ensureRegisteredClient({
      issuerBaseUrl: ISSUER,
      clientName: 'Command Center',
      redirectUri,
      cimdMetadataUrl: dcrCimdMetadataUrl(CONNECTOR_ID),
      scope: SCOPE,
    })
    if (!reg.ok) {
      return { ok: false, error: `${reg.error} Paste a Linear API key instead.` }
    }
    const existing = getRegistration(CONNECTOR_ID)
    if (!existing || existing.client_id !== reg.data.clientId) {
      saveRegistration(CONNECTOR_ID, {
        issuer: ISSUER,
        method: reg.data.method,
        clientId: reg.data.clientId,
        clientSecret: reg.data.clientSecret,
        redirectUri,
      })
    }
    const verifier = generatePkceVerifier()
    const challenge = pkceChallengeFromVerifier(verifier)
    const state = signDcrState(ctx.userId, CONNECTOR_ID, verifier)
    const redirectUrl = buildAuthorizationUrl(reg.data.metadata, {
      clientId: reg.data.clientId,
      redirectUri,
      scope: SCOPE,
      state,
      codeChallenge: challenge,
    })
    return { ok: true, redirectUrl }
  },

  /** Token fallback: a bearer token / Linear API key, per Linear's own docs. */
  async connectWithFields(ctx, fields): Promise<ConnectOutcome> {
    const key = (fields.api_key ?? '').trim()
    if (!key) return { ok: false, error: 'Paste a Linear API key first.' }
    const summary = upsertApiKey(CONNECTOR_ID, ctx.userId, { accountLabel: null, apiKey: key })
    return { ok: true, status: toStatus(summary) }
  },

  async disconnect(ctx) {
    deleteForUser(CONNECTOR_ID, ctx.userId)
  },
}

export default linear

/** Called by routes/user-dcr.ts after a successful token exchange. */
export function storeOAuthGrant(
  userId: number,
  tokens: { accessToken: string; refreshToken?: string; expiresAt?: string | null; scopes?: string | null },
): void {
  upsertOAuth(CONNECTOR_ID, userId, {
    accountLabel: null,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken ?? null,
    accessTokenExpiresAt: tokens.expiresAt ?? null,
    scopes: tokens.scopes ?? null,
  })
}
