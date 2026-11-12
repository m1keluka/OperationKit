/**
 * Notion connector (Sprint 7.3, obj 900507) — `auth_path: 'dcr_mcp'`.
 *
 * Verified against Notion's own OAuth Authorization Server Metadata
 * (`https://mcp.notion.com/.well-known/oauth-authorization-server`) in Sprint
 * 7.5 (docs/connectors/DCR-CIMD-VENDOR-VERIFICATION.md): Notion advertises
 * BOTH `registration_endpoint` (DCR) and `client_id_metadata_document_supported`
 * (CIMD), with no pre-registered app required either way.
 * connectors/dcr-client.ts prefers CIMD per the MCP spec's own priority order.
 *
 * Registration happens against mcp.notion.com directly from THIS install —
 * no Example callback, no shared client id. The token fallback (an MCP token a
 * workspace owner issues in the Notion developer portal, Business/Enterprise
 * plans only — see the verification doc) is implemented via
 * `connectWithFields` and covered by connector-flow.test.ts; it is not yet
 * reachable from the Settings UI, since `connect.kind: 'oauth'` only renders
 * the sign-in button there — wiring a fallback control into that UI is
 * Sprint 7.2's guided wizard, out of scope here.
 *
 * Order: 160, matching the Sprint 7.4 catalog preload layout (obj 900508) so
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

export const CONNECTOR_ID = 'notion'
const ISSUER = 'https://mcp.notion.com'
const SCOPE = undefined // Notion's hosted MCP server does not document a scope param; omit rather than guess one.

function toStatus(s: UserDcrConnectionSummary | null): ConnectorStatus {
  if (!s) return NOT_CONNECTED
  return {
    state: s.last_error ? 'error' : 'connected',
    account: s.account_label,
    details: [{ label: 'Connected via', value: s.auth_method === 'oauth' ? 'Sign-in (DCR/CIMD)' : 'MCP token' }],
    connected_at: s.connected_at,
    checked_at: s.last_refreshed_at,
    error: s.last_error,
  }
}

const notion: ConnectorDefinition = {
  id: CONNECTOR_ID,
  name: 'Notion',
  order: 160,
  auth_path: 'dcr_mcp',
  mcp_url: ISSUER,
  mcp_server_url: `${ISSUER}/mcp`,
  setup_guide: 'docs/connectors/guides/notion.md',
  description:
    'Lets agents read and write Notion pages and databases through the hosted Notion MCP server, as your Notion account.',
  products: [
    { id: 'pages', name: 'Pages', description: 'Read and create Notion pages.' },
    { id: 'databases', name: 'Databases', description: 'Query and update Notion databases.' },
  ],
  connect: { kind: 'oauth', button_label: 'Connect Notion' },

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
      return {
        ok: false,
        error: `${reg.error} Paste a Notion MCP token instead (Settings → Notion → developer portal "New MCP token").`,
      }
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

  /**
   * Token fallback: an MCP token a workspace owner issues in the Notion
   * developer portal ("New MCP token", Business/Enterprise plans only — see
   * docs/connectors/DCR-CIMD-VENDOR-VERIFICATION.md). Used when DCR/CIMD
   * registration fails at runtime, or is unavailable on the caller's plan.
   */
  async connectWithFields(ctx, fields): Promise<ConnectOutcome> {
    const token = (fields.mcp_token ?? '').trim()
    if (!token) return { ok: false, error: 'Paste a Notion MCP token first.' }
    const summary = upsertApiKey(CONNECTOR_ID, ctx.userId, { accountLabel: null, apiKey: token })
    return { ok: true, status: toStatus(summary) }
  },

  async disconnect(ctx) {
    deleteForUser(CONNECTOR_ID, ctx.userId)
  },
}

export default notion

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
