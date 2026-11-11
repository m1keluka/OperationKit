/**
 * Slack connector (obj 900508, Sprint 7.4 catalog preload). `oauth_guided`
 * per the Sprint 7 proposal (docs/connectors/INTEGRATIONS-PROPOSAL.md §3,
 * row 1) — Slack has no DCR/CIMD support, so the install owner registers
 * their own Slack app once (docs/connectors/guides/slack.md) and this
 * generic OAuth engine (connectors/lib/oauth-guided-connector.ts) drives the
 * authorization-code flow against it.
 */
import { oauthGuidedConnector } from '../lib/oauth-guided-connector.js'

const slack = oauthGuidedConnector({
  id: 'slack',
  name: 'Slack',
  order: 30,
  setup_guide: 'docs/connectors/guides/slack.md',
  description: 'Lets agents read and post Slack messages as your workspace app, on channels you invite it to.',
  products: [
    { id: 'messages', name: 'Messages', description: 'Read channel history and post messages.' },
    { id: 'channels', name: 'Channels', description: 'List and look up channels and members.' },
  ],
  oauth: {
    authorize_url: 'https://slack.com/oauth/v2/authorize',
    token_url: 'https://slack.com/api/oauth.v2.access',
    scopes: ['channels:read', 'channels:history', 'chat:write', 'users:read'],
  },
  button_label: 'Add to Slack',
})

export default slack
