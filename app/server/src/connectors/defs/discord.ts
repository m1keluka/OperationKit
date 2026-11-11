/**
 * Discord connector (obj 900508, Sprint 7.4 catalog preload). `oauth_guided`
 * per the proposal §3 row 12 (bot-token path documented in the setup guide
 * as the simpler server-side alternative, same reasoning as HubSpot above).
 */
import { oauthGuidedConnector } from '../lib/oauth-guided-connector.js'

const discord = oauthGuidedConnector({
  id: 'discord',
  name: 'Discord',
  order: 60,
  setup_guide: 'docs/connectors/guides/discord.md',
  description: 'Lets agents read and post messages in Discord servers your app has been added to.',
  products: [
    { id: 'messages', name: 'Messages', description: 'Read and post channel messages.' },
    { id: 'guilds', name: 'Servers', description: 'List servers and channels the bot can reach.' },
  ],
  oauth: {
    authorize_url: 'https://discord.com/api/oauth2/authorize',
    token_url: 'https://discord.com/api/oauth2/token',
    scopes: ['identify', 'bot', 'applications.commands'],
  },
  button_label: 'Add to Discord',
})

export default discord
