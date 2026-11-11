/**
 * Microsoft 365 connector (obj 900508, Sprint 7.4 catalog preload).
 * `oauth_guided` per the proposal §3 row 4 — Azure AD app registration,
 * multi-step but well-documented (docs/connectors/guides/microsoft-365.md).
 */
import { oauthGuidedConnector } from '../lib/oauth-guided-connector.js'

const microsoft365 = oauthGuidedConnector({
  id: 'microsoft-365',
  name: 'Microsoft 365',
  order: 40,
  setup_guide: 'docs/connectors/guides/microsoft-365.md',
  description: 'Lets agents read and send mail, manage calendar events and work with OneDrive/SharePoint files, as your Microsoft 365 account.',
  products: [
    { id: 'mail', name: 'Outlook Mail', description: 'Read and send email.' },
    { id: 'calendar', name: 'Calendar', description: 'See and create events.' },
    { id: 'files', name: 'OneDrive / SharePoint', description: 'Find, read and create files.' },
  ],
  oauth: {
    authorize_url: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    token_url: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scopes: ['offline_access', 'Mail.ReadWrite', 'Mail.Send', 'Calendars.ReadWrite', 'Files.ReadWrite'],
  },
  button_label: 'Sign in with Microsoft',
})

export default microsoft365
