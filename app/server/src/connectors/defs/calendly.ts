/**
 * Calendly connector (obj 900508, Sprint 7.4 catalog preload). `api_key`
 * per the proposal §3 row 15 — a personal access token; a separate webhook
 * signing key (for verifying inbound booking webhooks) is documented in the
 * setup guide as a second, optional field.
 */
import { apiKeyConnector } from '../lib/api-key-connector.js'

const calendly = apiKeyConnector({
  id: 'calendly',
  name: 'Calendly',
  order: 110,
  setup_guide: 'docs/connectors/guides/calendly.md',
  description: 'Lets agents read your Calendly scheduled events and availability using a personal access token.',
  products: [
    { id: 'events', name: 'Scheduled events', description: 'Read booked meetings and invitee details.' },
  ],
  fields: [
    { key: 'api_key', label: 'Personal access token', where_to_get_it_url: 'https://calendly.com/integrations/api_webhooks' },
    { key: 'webhook_signing_key', label: 'Webhook signing key (optional)', where_to_get_it_url: 'https://calendly.com/integrations/api_webhooks' },
  ],
})

export default calendly
