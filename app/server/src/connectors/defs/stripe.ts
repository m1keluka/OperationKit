/**
 * Stripe connector (obj 900508, Sprint 7.4 catalog preload). `auth_path:
 * 'oauth_guided'` per Sprint 7.5's direct verification
 * (docs/connectors/DCR-CIMD-VENDOR-VERIFICATION.md): Stripe's auth server
 * technically advertises `registration_endpoint` (DCR), but Stripe's own
 * docs steer every first-party client through a named-client wizard
 * (`stripe agent setup`, Cursor/Claude Code/Codex configs) rather than a
 * plain authorize/token pair, and classic Stripe Connect OAuth is a
 * different product (platform onboarding a merchant, not an agent reading
 * one account's own data) — wiring that here would build the wrong feature.
 * Deferred; the mandatory fallback (an Agent API key, required for
 * autonomous/headless clients after 2026-11-30 per Stripe's own deadline) is
 * documented in the setup guide as a plain Settings → Secrets value.
 */
import { deferredConnector } from '../lib/deferred-connector.js'

const stripe = deferredConnector({
  id: 'stripe',
  name: 'Stripe',
  order: 200,
  setup_guide: 'docs/connectors/guides/stripe.md',
  description: 'Lets agents read and manage Stripe charges, customers and subscriptions, once a proper guided connect flow is built.',
  products: [
    { id: 'payments', name: 'Payments', description: 'Read and manage charges, customers and subscriptions.' },
  ],
  auth_path: 'oauth_guided',
  mcp_url: 'https://mcp.stripe.com',
  deferred_reason:
    "Stripe's own docs steer every first-party MCP client through named-client tooling (stripe agent setup / Cursor / Claude Code), not a plain OAuth authorize/token pair, and Stripe Connect OAuth is a different product (merchant onboarding). Add a Stripe Agent API key as a Settings → Secrets value per the setup guide — mandatory for headless clients after 2026-11-30.",
})

export default stripe
