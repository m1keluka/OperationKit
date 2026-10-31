/**
 * Google Workspace connector (Gmail, Calendar, Drive). Wraps the existing
 * per-person OAuth store (services/user-google-connections.ts): same table,
 * same encryption, same callback route (/api/user/google/callback), so
 * accounts connected before Connectors existed show up here unchanged.
 */
import {
  getForUser,
  getOAuthClient,
  buildAuthUrl,
  disconnect,
} from '../../services/user-google-connections.js'
import type { ConnectorStatus, UserGoogleConnectionSummary } from '@operationkit/shared'
import { NOT_CONNECTED, type ConnectorDefinition } from '../types.js'

/** Which products a granted scope string actually covers. */
export function grantedProducts(scopes: string): string[] {
  const has = (frag: string) => scopes.split(/\s+/).some(s => s.includes(frag))
  const out: string[] = []
  if (has('/auth/gmail')) out.push('Gmail')
  if (has('/auth/calendar')) out.push('Calendar')
  if (has('/auth/drive') || has('/auth/documents') || has('/auth/spreadsheets') || has('/auth/presentations')) {
    out.push('Drive')
  }
  return out
}

function toStatus(s: UserGoogleConnectionSummary | null): ConnectorStatus {
  if (!s) return NOT_CONNECTED
  const products = grantedProducts(s.scopes || '')
  return {
    state: s.last_error ? 'error' : 'connected',
    account: s.google_email,
    details: [{ label: 'Access to', value: products.length ? products.join(', ') : 'Sign-in only' }],
    connected_at: s.connected_at,
    checked_at: s.last_refreshed_at,
    error: s.last_error
      ? 'Google stopped accepting this connection. Disconnect, then connect again.'
      : null,
  }
}

const googleWorkspace: ConnectorDefinition = {
  id: 'google-workspace',
  name: 'Google Workspace',
  order: 20,
  description:
    'Lets agents read and draft email, manage your calendar and work with your Drive files, as your Google account.',
  products: [
    { id: 'gmail', name: 'Gmail', description: 'Read, label, draft and send email.' },
    { id: 'calendar', name: 'Calendar', description: 'See and create events.' },
    { id: 'drive', name: 'Drive', description: 'Find, read and create files, including Docs and Sheets.' },
  ],
  connect: { kind: 'oauth', button_label: 'Sign in with Google' },

  availability() {
    return getOAuthClient()
      ? { ok: true }
      : {
          ok: false,
          reason:
            'Google sign-in is not set up on this server yet. An admin needs to add GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in Settings → Secrets.',
        }
  },

  status: ctx => toStatus(getForUser(ctx.userId)),

  async startOAuth(ctx) {
    const client = getOAuthClient()
    if (!client) return { ok: false, error: 'Google sign-in is not set up on this server yet.' }
    return { ok: true, redirectUrl: buildAuthUrl(ctx.userId, client) }
  },

  async disconnect(ctx) {
    // Revokes at Google, then deletes the stored grant even if revoke fails.
    await disconnect(ctx.userId)
  },
}

export default googleWorkspace
