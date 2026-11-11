/**
 * Cal.com connector (obj 900508, Sprint 7.4 catalog preload). `api_key`
 * per the proposal §3 row 16 — works against both the hosted product and a
 * self-hosted instance (base URL is a field, not hardcoded).
 */
import { apiKeyConnector } from '../lib/api-key-connector.js'

const calCom = apiKeyConnector({
  id: 'cal-com',
  name: 'Cal.com',
  order: 120,
  setup_guide: 'docs/connectors/guides/cal-com.md',
  description: 'Lets agents read and manage Cal.com bookings and event types using an API key.',
  products: [
    { id: 'bookings', name: 'Bookings', description: 'Read and manage scheduled bookings.' },
  ],
  fields: [
    { key: 'api_key', label: 'API key', where_to_get_it_url: 'https://app.cal.com/settings/developer/api-keys' },
    { key: 'base_url', label: 'Base URL (self-hosted only, optional)' },
  ],
})

export default calCom
