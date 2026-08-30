/**
 * Per-user Command Center API keys.
 * Prefix `cc_live_` so Bearer auth can tell them apart from JWTs.
 * Only the SHA-256 is stored. Plaintext is returned once on generate.
 */
import { createHash, randomBytes } from 'crypto'
import { getDb } from '../db/index.js'
import type { User } from '@operationkit/shared'

export const API_KEY_PREFIX = 'cc_live_'

export interface ApiKeySummary {
  configured: boolean
  last4: string | null
  created_at: string | null
}

export function isApiKey(token: string): boolean {
  return token.startsWith(API_KEY_PREFIX)
}

export function hashApiKey(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex')
}

export function mintApiKey(): string {
  return `${API_KEY_PREFIX}${randomBytes(32).toString('base64url')}`
}

export function getApiKeySummary(userId: number): ApiKeySummary {
  const row = getDb()
    .prepare('SELECT api_token_last4, api_token_created_at FROM users WHERE id = ?')
    .get(userId) as { api_token_last4: string | null; api_token_created_at: string | null } | undefined
  if (!row?.api_token_last4) {
    return { configured: false, last4: null, created_at: null }
  }
  return { configured: true, last4: row.api_token_last4, created_at: row.api_token_created_at }
}

export function issueApiKey(userId: number): { token: string; last4: string; created_at: string } {
  const token = mintApiKey()
  const last4 = token.slice(-4)
  getDb()
    .prepare(
      `UPDATE users
          SET api_token_hash = ?, api_token_last4 = ?, api_token_created_at = datetime('now')
        WHERE id = ?`,
    )
    .run(hashApiKey(token), last4, userId)
  const created = getDb()
    .prepare('SELECT api_token_created_at FROM users WHERE id = ?')
    .get(userId) as { api_token_created_at: string }
  return { token, last4, created_at: created.api_token_created_at }
}

export function revokeApiKey(userId: number): void {
  getDb()
    .prepare(
      'UPDATE users SET api_token_hash = NULL, api_token_last4 = NULL, api_token_created_at = NULL WHERE id = ?',
    )
    .run(userId)
}

export function userFromApiKey(token: string): User | null {
  if (!isApiKey(token)) return null
  const row = getDb()
    .prepare(
      'SELECT id, username, role, created_at FROM users WHERE api_token_hash = ?',
    )
    .get(hashApiKey(token)) as User | undefined
  return row ?? null
}
