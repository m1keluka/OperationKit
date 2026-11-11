/**
 * Transactional email (obj 900497) — shared types.
 *
 * The install sends sign-in, invite and temp-password emails through ITS OWN
 * sender: generic SMTP, Resend or Postmark, with the install owner's own keys.
 * There is no central relay and no default third-party account — an install
 * that has not configured a provider simply does not send email.
 */

export type EmailProvider = 'smtp' | 'resend' | 'postmark'
export const EMAIL_PROVIDERS: readonly EmailProvider[] = ['smtp', 'resend', 'postmark']

/** How the SMTP connection is protected. */
export type SmtpSecurity = 'tls' | 'starttls' | 'none'

export interface SmtpSettings {
  host: string
  port: number
  security: SmtpSecurity
  /** Empty = no AUTH (e.g. a local relay or a test sink). */
  username: string
}

/**
 * The non-secret part of the email setup, stored as JSON in the `settings`
 * table. The credential (SMTP password / API key / server token) is NOT here —
 * it lives in the encrypted secrets store, see config.ts.
 */
export interface EmailConfig {
  provider: EmailProvider | null
  from_name: string
  from_address: string
  reply_to: string
  /**
   * Public base URL of this install (e.g. https://ops.example.com). Links in
   * emails are built from THIS value only — never from a request's Host
   * header, which a caller controls.
   */
  app_url: string
  smtp: SmtpSettings
  last_test: { ok: boolean; at: string; to_domain: string; error: string | null } | null
}

export interface MailMessage {
  to: string
  subject: string
  text: string
  html?: string
}

export type SendResult =
  | { ok: true; provider: EmailProvider; id: string | null }
  | { ok: false; provider: EmailProvider | null; error: string; code: 'not_configured' | 'invalid' | 'send_failed' }

/** Minimal fetch shape the HTTP adapters need (injectable for tests). */
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean
  status: number
  text(): Promise<string>
}>
