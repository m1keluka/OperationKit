/**
 * Factory for an `auth_path: 'oauth_guided'` catalog entry (obj 900508,
 * Sprint 7.4 preload), backed by the generic `connector_oauth_grants` store +
 * authorization-code flow (services/generic-connector-oauth.ts) instead of a
 * bespoke per-vendor OAuth client. Each def file (slack.ts, microsoft-365.ts,
 * ...) supplies the vendor's own authorize/token endpoints and scopes; the
 * install owner supplies their own app's client id/secret via
 * Settings → Secrets (see each connector's setup_guide.md) — never a shared
 * Example-run app (Sprint 7 proposal §2a).
 *
 * Optional, opt-in (Sprint 7.7, obj 900511): when the install has NO app of
 * its own for this connector AND an admin explicitly turned on a shared
 * third-party app for it (services/shared-oauth-app.ts), the connector can
 * sign in through that third party instead. With the toggle off — the
 * default — nothing below differs from the pre-7.7 behavior.
 */
import * as store from '../../services/generic-connector-oauth.js'
import { getSharedAppConfig, sharedAppHost, startSharedAppOAuth } from '../../services/shared-oauth-app.js'
import { NOT_CONNECTED, type ConnectorDefinition, type ConnectorOAuthEndpoints } from '../types.js'
import type { ConnectorProduct, ConnectorStatus } from '@operationkit/shared'

export interface OAuthGuidedConnectorOptions {
  id: string
  name: string
  description: string
  order?: number
  setup_guide: string
  products?: ConnectorProduct[]
  oauth: ConnectorOAuthEndpoints
  button_label?: string
}

function toStatus(id: string, userId: number): ConnectorStatus {
  const s = store.getForUser(id, userId)
  if (!s) return NOT_CONNECTED
  return {
    state: s.last_error ? 'error' : 'connected',
    account: s.account_label,
    details: s.scopes ? [{ label: 'Scopes', value: s.scopes }] : [],
    connected_at: s.connected_at,
    checked_at: s.last_refreshed_at,
    error: s.last_error,
  }
}

export function oauthGuidedConnector(opts: OAuthGuidedConnectorOptions): ConnectorDefinition {
  return {
    id: opts.id,
    name: opts.name,
    description: opts.description,
    order: opts.order,
    auth_path: 'oauth_guided',
    setup_guide: opts.setup_guide,
    products: opts.products,
    oauth: opts.oauth,
    connect: { kind: 'oauth', button_label: opts.button_label ?? `Connect ${opts.name}` },

    shared_app_eligible: true,

    availability() {
      if (store.getOAuthClient(opts.id)) return { ok: true }
      // Opt-in only: null unless an admin explicitly turned it on for this connector.
      if (getSharedAppConfig(opts.id)) return { ok: true }
      return {
        ok: false,
        reason: `${opts.name} is not set up on this server yet. An admin needs to add the ${opts.id.toUpperCase().replace(/-/g, '_')}_OAUTH_CLIENT_ID / _OAUTH_CLIENT_SECRET pair in Settings → Secrets — see ${opts.setup_guide}.`,
      }
    },

    status: ctx => toStatus(opts.id, ctx.userId),

    async startOAuth(ctx) {
      const client = store.getOAuthClient(opts.id)
      // The install's own app always wins; a shared app is only ever a fallback.
      if (client) return { ok: true, redirectUrl: store.buildAuthUrl(opts.id, ctx.userId, opts.oauth, client) }
      const shared = getSharedAppConfig(opts.id)
      if (!shared) return { ok: false, error: `${opts.name} is not set up on this server yet.` }
      console.log(`[connectors] ${opts.id}: signing in via opt-in shared app at ${sharedAppHost(shared)}`)
      return startSharedAppOAuth(opts.id, ctx.userId, shared, opts.oauth.scopes)
    },

    async disconnect(ctx) {
      store.deleteForUser(opts.id, ctx.userId)
    },
  }
}
