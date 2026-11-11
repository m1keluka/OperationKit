/**
 * URL helpers shared by every `auth_path: 'dcr_mcp'` connector and by the
 * generic routes that serve them (routes/connectors.ts's CIMD metadata
 * endpoint, routes/user-dcr.ts's callback). Kept in one place so a connector
 * def and the route that calls back into it never disagree on the URL shape.
 */
const DEFAULT_APP_BASE_URL = 'https://cc.example.com'

export function appBaseUrl(): string {
  return process.env.APP_BASE_URL || DEFAULT_APP_BASE_URL
}

/** Where the provider redirects back to after the consent screen. */
export function dcrRedirectUri(connectorId: string): string {
  return `${appBaseUrl()}/api/user/dcr/${connectorId}/callback`
}

/** This install's own stable URL hosting the CIMD client metadata document. A CIMD client_id IS this URL. */
export function dcrCimdMetadataUrl(connectorId: string): string {
  return `${appBaseUrl()}/api/connectors/dcr-client-metadata/${connectorId}`
}
