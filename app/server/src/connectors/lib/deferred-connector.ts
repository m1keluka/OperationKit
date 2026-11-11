/**
 * Factory for a catalog entry whose real connect flow is deferred to a later
 * sprint (obj 900508, Sprint 7.4 preload — see the acceptance criterion
 * "documented reason a row was deferred").
 *
 * Covers the five vendors Sprint 7.5 (#900505, docs/connectors/DCR-CIMD-VENDOR-
 * VERIFICATION.md) verified need more than this card can build:
 *   - Notion, Linear, Sentry, Atlassian (Rovo) — `auth_path: 'dcr_mcp'`. Their
 *     own auth servers support OAuth 2.1 Dynamic Client Registration / CIMD,
 *     but CONNECTING that way needs the shared DCR client, which is Sprint 7.3
 *     — explicitly out of scope here. There is no generic "register this
 *     install with the vendor" code to call yet.
 *   - Stripe — `auth_path: 'oauth_guided'` per #900505, but the vendor's own
 *     docs steer every first-party client (`stripe agent setup`, Cursor/Claude
 *     Code/Codex configs) through a named-client wizard rather than a plain
 *     authorize/token pair this repo's generic OAuth helper could drive, and
 *     Stripe's classic "Connect" OAuth app is a different product (merchant
 *     onboarding for a platform, not an agent reading one account's own data)
 *     — wiring that here would be building the wrong feature, not a shortcut.
 *
 * The entry is real and registry-valid (`isDefinition()` passes — valid id,
 * name, auth_path, status, disconnect), always reports `not_connected`, and
 * `availability()` explains why in one sentence so Settings → Connectors (and
 * a reviewer) sees a clear, truthful reason rather than a silently-broken
 * "Connect" button. The vendor's own setup_guide.md documents the one path
 * that DOES work today: a plain API-key fallback stored as a Settings →
 * Secrets value (the model almost every other integration in this workspace
 * already uses), not a Connectors row.
 */
import { NOT_CONNECTED, type ConnectorDefinition } from '../types.js'
import type { ConnectorProduct } from '@operationkit/shared'
import type { ConnectorAuthPath } from '../types.js'

export interface DeferredConnectorOptions {
  id: string
  name: string
  description: string
  order?: number
  setup_guide: string
  products?: ConnectorProduct[]
  auth_path: ConnectorAuthPath
  /** One plain sentence: what's missing and which sprint/card closes the gap. */
  deferred_reason: string
  mcp_url?: string
}

export function deferredConnector(opts: DeferredConnectorOptions): ConnectorDefinition {
  return {
    id: opts.id,
    name: opts.name,
    description: opts.description,
    order: opts.order,
    auth_path: opts.auth_path,
    setup_guide: opts.setup_guide,
    products: opts.products,
    mcp_url: opts.mcp_url,
    // `kind: 'oauth'` previews the real eventual UX (a consent redirect) even
    // though `startOAuth` below always declines — matches what every one of
    // these vendors actually uses (OAuth 2.1), just not wireable without the
    // DCR client / vendor-specific tooling this card is scoped away from.
    connect: { kind: 'oauth', button_label: `Connect ${opts.name}` },

    availability() {
      return { ok: false, reason: opts.deferred_reason }
    },

    status: () => NOT_CONNECTED,

    async startOAuth() {
      return { ok: false, error: opts.deferred_reason }
    },

    async disconnect() {
      // Nothing is ever stored for a deferred connector.
    },
  }
}
