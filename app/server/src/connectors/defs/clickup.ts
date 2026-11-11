/**
 * ClickUp connector (obj 900508, Sprint 7.4 catalog preload). `api_key`
 * per the proposal §3 row 14 — a simple per-user token.
 */
import { apiKeyConnector } from '../lib/api-key-connector.js'

const clickup = apiKeyConnector({
  id: 'clickup',
  name: 'ClickUp',
  order: 100,
  setup_guide: 'docs/connectors/guides/clickup.md',
  description: 'Lets agents read and update ClickUp tasks using your personal API token.',
  products: [
    { id: 'tasks', name: 'Tasks', description: 'Read and update tasks across the workspaces the token can reach.' },
  ],
  fields: [
    { key: 'api_key', label: 'API token', where_to_get_it_url: 'https://app.clickup.com/settings/apps' },
  ],
})

export default clickup
