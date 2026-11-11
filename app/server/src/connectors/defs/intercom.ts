/**
 * Intercom connector (obj 900508, Sprint 7.4 catalog preload). Proposal §3
 * row 18 lists both `oauth_guided` and `api_key` as viable; `oauth_guided`
 * is chosen here as the primary path, with an access-token fallback
 * documented in the setup guide for a single-workspace install.
 */
import { oauthGuidedConnector } from '../lib/oauth-guided-connector.js'

const intercom = oauthGuidedConnector({
  id: 'intercom',
  name: 'Intercom',
  order: 70,
  setup_guide: 'docs/connectors/guides/intercom.md',
  description: 'Lets agents read and reply to Intercom conversations as your workspace app.',
  products: [
    { id: 'conversations', name: 'Conversations', description: 'Read and reply to customer conversations.' },
    { id: 'contacts', name: 'Contacts', description: 'Look up contact records.' },
  ],
  oauth: {
    authorize_url: 'https://app.intercom.com/oauth',
    token_url: 'https://api.intercom.io/auth/eagle/token',
    scopes: [],
  },
  button_label: 'Connect Intercom',
})

export default intercom
