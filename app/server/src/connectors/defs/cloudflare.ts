/**
 * Cloudflare connector (obj 900508, Sprint 7.4 catalog preload). `api_key`
 * per the proposal §3 row 11 — a scoped API token, no OAuth needed.
 */
import { apiKeyConnector } from '../lib/api-key-connector.js'

const cloudflare = apiKeyConnector({
  id: 'cloudflare',
  name: 'Cloudflare',
  order: 80,
  setup_guide: 'docs/connectors/guides/cloudflare.md',
  description: 'Lets agents manage your Cloudflare zones, DNS records and Workers using an account-scoped API token.',
  products: [
    { id: 'dns', name: 'DNS', description: 'Read and edit DNS records.' },
    { id: 'workers', name: 'Workers', description: 'Deploy and manage Workers scripts.' },
  ],
  fields: [
    { key: 'api_key', label: 'API token', where_to_get_it_url: 'https://dash.cloudflare.com/profile/api-tokens' },
  ],
})

export default cloudflare
