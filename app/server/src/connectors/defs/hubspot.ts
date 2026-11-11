/**
 * HubSpot connector (obj 900508, Sprint 7.4 catalog preload). `oauth_guided`
 * per the proposal §3 row 7; a private-app token is documented in the setup
 * guide as a simpler fallback for a small install, but is not a separate
 * catalog row (would duplicate this entry rather than extend it).
 */
import { oauthGuidedConnector } from '../lib/oauth-guided-connector.js'

const hubspot = oauthGuidedConnector({
  id: 'hubspot',
  name: 'HubSpot',
  order: 50,
  setup_guide: 'docs/connectors/guides/hubspot.md',
  description: 'Lets agents read and update contacts, companies and deals in your HubSpot CRM.',
  products: [
    { id: 'contacts', name: 'Contacts', description: 'Read and update contact records.' },
    { id: 'deals', name: 'Deals', description: 'Read and update the sales pipeline.' },
  ],
  oauth: {
    authorize_url: 'https://app.hubspot.com/oauth/authorize',
    token_url: 'https://api.hubapi.com/oauth/v1/token',
    scopes: ['crm.objects.contacts.read', 'crm.objects.contacts.write', 'crm.objects.deals.read', 'crm.objects.deals.write'],
  },
  button_label: 'Connect HubSpot',
})

export default hubspot
