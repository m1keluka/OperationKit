/**
 * n8n connector (obj 900508, Sprint 7.4 catalog preload). `api_key` per the
 * proposal §3 row 19 — n8n is treated as an automation TARGET this install
 * can call into (API key for n8n's REST API, plus an optional webhook URL to
 * trigger a workflow directly), not a competing orchestrator for this app.
 */
import { apiKeyConnector } from '../lib/api-key-connector.js'

const n8n = apiKeyConnector({
  id: 'n8n',
  name: 'n8n',
  order: 140,
  setup_guide: 'docs/connectors/guides/n8n.md',
  description: 'Lets agents trigger and inspect n8n workflows as an automation target, using an n8n API key or a workflow webhook URL.',
  products: [
    { id: 'workflows', name: 'Workflows', description: 'Trigger workflows and read their execution status.' },
  ],
  fields: [
    { key: 'api_key', label: 'n8n API key', where_to_get_it_url: 'https://docs.n8n.io/api/authentication/' },
    { key: 'base_url', label: 'n8n instance base URL' },
    { key: 'webhook_url', label: 'Default workflow webhook URL (optional)' },
  ],
})

export default n8n
