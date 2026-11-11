/**
 * Airtable connector (obj 900508, Sprint 7.4 catalog preload). `api_key`
 * per the proposal §3 row 13 — a base-scoped personal access token.
 */
import { apiKeyConnector } from '../lib/api-key-connector.js'

const airtable = apiKeyConnector({
  id: 'airtable',
  name: 'Airtable',
  order: 90,
  setup_guide: 'docs/connectors/guides/airtable.md',
  description: 'Lets agents read and write records in Airtable bases using a personal access token.',
  products: [
    { id: 'records', name: 'Records', description: 'Read and write rows in the bases the token can reach.' },
  ],
  fields: [
    { key: 'api_key', label: 'Personal access token', where_to_get_it_url: 'https://airtable.com/create/tokens' },
  ],
})

export default airtable
