/**
 * DocuSeal connector (obj 900508, Sprint 7.4 catalog preload). `api_key`
 * per the proposal §3 row 17.
 */
import { apiKeyConnector } from '../lib/api-key-connector.js'

const docuseal = apiKeyConnector({
  id: 'docuseal',
  name: 'DocuSeal',
  order: 130,
  setup_guide: 'docs/connectors/guides/docuseal.md',
  description: 'Lets agents create and track DocuSeal e-signature submissions using an API key.',
  products: [
    { id: 'submissions', name: 'Submissions', description: 'Create, send and track signature requests.' },
  ],
  fields: [
    { key: 'api_key', label: 'API key', where_to_get_it_url: 'https://www.docuseal.com/settings/api' },
    { key: 'base_url', label: 'Base URL (self-hosted only, optional)' },
  ],
})

export default docuseal
