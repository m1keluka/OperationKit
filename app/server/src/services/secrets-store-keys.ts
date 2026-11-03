/**
 * Keys that are the SERVER's credentials, not an agent's.
 *
 * These are the shared pieces the per-user connectors are built on: the OAuth
 * client a person's grant is issued against, and the service/mailbox
 * credentials background jobs use. They are global by nature, which is exactly
 * why no session should receive them — a session that holds the OAuth client
 * secret plus any refresh token can mint access to an account that is not the
 * one it was given.
 *
 * A secret named here is marked `service_only` when the column is first added,
 * and newly created global secrets with these names are marked on write. An
 * operator can clear the flag from Settings if their install genuinely needs a
 * key in sessions; nothing here is irreversible.
 *
 * Provider-neutral by construction: these are vendor environment-variable
 * names, not an installation's own data.
 */
export const SERVICE_ONLY_BY_DEFAULT: readonly string[] = [
  'GOOGLE_OAUTH_CLIENT_ID',
  'GOOGLE_OAUTH_CLIENT_SECRET',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REFRESH_TOKEN',
  'GOOGLE_SERVICE_ACCOUNT_JSON',
  'GOOGLE_APPLICATION_CREDENTIALS_JSON',
  'GMAIL_REFRESH_TOKEN',
  'GMAIL_CLIENT_ID',
  'GMAIL_CLIENT_SECRET',
]

/** Is this key one the server keeps to itself by default, at global scope? */
export function isServiceOnlyByDefault(key: string): boolean {
  return SERVICE_ONLY_BY_DEFAULT.includes(key)
}
