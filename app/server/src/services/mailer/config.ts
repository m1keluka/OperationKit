/**
 * Email setup storage (obj 900497).
 *
 * Two halves, two stores:
 *   - non-secret config (provider, from, SMTP host/port/user, app URL, last
 *     test result) → JSON in `settings.email_config`;
 *   - the credential (SMTP password / Resend API key / Postmark server token)
 *     → the encrypted secrets store at GLOBAL scope, marked service-only so no
 *     agent session ever receives it. It is never returned by any route.
 */
import { getDb } from '../../db/index.js'
import { deleteSecret, getSecret, getSecretValue, setSecret } from '../secrets-store.js'
import type { EmailConfig, EmailProvider } from './types.js'
import { EMAIL_PROVIDERS } from './types.js'
import { isEmailAddress } from './address.js'

export const EMAIL_CONFIG_SETTING = 'email_config'

/** Secrets-store key per provider. Service-only: the server uses them, sessions never get them. */
export const EMAIL_CREDENTIAL_KEYS: Record<EmailProvider, string> = {
  smtp: 'CC_EMAIL_SMTP_PASSWORD',
  resend: 'CC_EMAIL_RESEND_API_KEY',
  postmark: 'CC_EMAIL_POSTMARK_SERVER_TOKEN',
}

const GLOBAL = { scopeType: 'global' as const }

export function defaultEmailConfig(): EmailConfig {
  return {
    provider: null,
    from_name: '',
    from_address: '',
    reply_to: '',
    app_url: '',
    smtp: { host: '', port: 587, security: 'starttls', username: '' },
    last_test: null,
  }
}

function settingsTableExists(): boolean {
  try {
    getDb().prepare('SELECT 1 FROM settings LIMIT 1').get()
    return true
  } catch {
    return false
  }
}

export function loadEmailConfig(): EmailConfig {
  const base = defaultEmailConfig()
  if (!settingsTableExists()) return base
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(EMAIL_CONFIG_SETTING) as { value: string } | undefined
  if (!row) return base
  try {
    const raw = JSON.parse(row.value) as Partial<EmailConfig>
    return {
      ...base,
      ...raw,
      provider: EMAIL_PROVIDERS.includes(raw.provider as EmailProvider) ? (raw.provider as EmailProvider) : null,
      smtp: { ...base.smtp, ...(raw.smtp ?? {}) },
      last_test: raw.last_test ?? null,
    }
  } catch {
    return base
  }
}

export function saveEmailConfig(cfg: EmailConfig): void {
  getDb()
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(EMAIL_CONFIG_SETTING, JSON.stringify(cfg))
}

export function hasEmailCredential(provider: EmailProvider): boolean {
  try {
    return !!getSecret(GLOBAL, EMAIL_CREDENTIAL_KEYS[provider])
  } catch {
    return false
  }
}

/** SERVER-ONLY plaintext read. The result goes to a provider call and nowhere else. */
export function readEmailCredential(provider: EmailProvider): string | null {
  try {
    return getSecretValue(GLOBAL, EMAIL_CREDENTIAL_KEYS[provider])
  } catch {
    return null
  }
}

export function storeEmailCredential(provider: EmailProvider, value: string, actorUserId: number | null): void {
  setSecret({ scope: GLOBAL, key: EMAIL_CREDENTIAL_KEYS[provider], value, serviceOnly: true, actorUserId, via: 'settings-email' })
}

export function clearEmailCredentials(actorUserId: number | null): void {
  for (const p of EMAIL_PROVIDERS) {
    try { deleteSecret(GLOBAL, EMAIL_CREDENTIAL_KEYS[p], actorUserId) } catch { /* absent */ }
  }
}

/** What is still missing before this install can send. Empty = ready. */
export function emailConfigProblems(cfg: EmailConfig = loadEmailConfig()): string[] {
  const out: string[] = []
  if (!cfg.provider) return ['Pick an email provider']
  if (!isEmailAddress(cfg.from_address)) out.push('Set a from address')
  if (!/^https?:\/\/[^\s/]+/i.test(cfg.app_url)) out.push("Set this site's public URL")
  if (cfg.provider === 'smtp') {
    if (!cfg.smtp.host) out.push('Set the SMTP host')
    if (!(cfg.smtp.port > 0 && cfg.smtp.port < 65536)) out.push('Set the SMTP port')
    if (cfg.smtp.username && !hasEmailCredential('smtp')) out.push('Add the SMTP password')
  } else if (!hasEmailCredential(cfg.provider)) {
    out.push(cfg.provider === 'resend' ? 'Add the Resend API key' : 'Add the Postmark server token')
  }
  return out
}

export function emailConfigured(): boolean {
  try {
    return emailConfigProblems().length === 0
  } catch {
    return false
  }
}
