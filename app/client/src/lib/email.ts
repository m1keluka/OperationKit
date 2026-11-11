/**
 * Transactional email (obj 900497) — client types + calls for Settings → Email
 * and the onboarding checklist. Server: routes/admin-email.ts.
 */
import { api } from './api'

export type EmailProvider = 'smtp' | 'resend' | 'postmark'
export type SmtpSecurity = 'tls' | 'starttls' | 'none'

export interface EmailSetup {
  provider: EmailProvider | null
  from_name: string
  from_address: string
  reply_to: string
  app_url: string
  smtp: { host: string; port: number; security: SmtpSecurity; username: string }
  last_test: { ok: boolean; at: string; to_domain: string; error: string | null } | null
  configured: boolean
  problems: string[]
  has_credential: Record<EmailProvider, boolean>
  credential_keys: Record<EmailProvider, string>
}

export interface EmailSetupInput {
  provider: EmailProvider | null
  from_name: string
  from_address: string
  reply_to: string
  app_url: string
  smtp: { host: string; port: number; security: SmtpSecurity; username: string }
  /** Blank = keep the stored one. Never read back. */
  credential?: string
}

export interface DnsRecordHelp { purpose: string; type: string; host: string; value: string; note: string }
export interface DnsHelp {
  domain: string
  provider: EmailProvider
  where_to_get: string
  records: DnsRecordHelp[]
  steps: string[]
  check: { domain: string; spf: string | null; dmarc: string | null; error: string | null } | null
}

export type SetupStepId = 'branding' | 'email' | 'models'
export interface SetupStatus {
  steps: Array<{ id: SetupStepId; title: string; done: boolean; configured?: boolean }>
  complete: boolean
}

/** Outcome the users API returns for an invite / temp-password email. */
export interface EmailOutcome { sent: boolean; error?: string; not_configured?: boolean }

export const PROVIDER_LABEL: Record<EmailProvider, string> = { smtp: 'SMTP', resend: 'Resend', postmark: 'Postmark' }

export const emailApi = {
  get: () => api.get<EmailSetup>('/admin/email'),
  save: (body: EmailSetupInput) => api.put<EmailSetup>('/admin/email', body),
  disable: () => api.del<EmailSetup>('/admin/email'),
  test: (to: string) => api.post<EmailSetup & { ok: true }>('/admin/email/test', { to }),
  dns: (provider: EmailProvider, domain: string) =>
    api.get<DnsHelp>(`/admin/email/dns?provider=${encodeURIComponent(provider)}&domain=${encodeURIComponent(domain)}`),
  setupStatus: () => api.get<SetupStatus>('/admin/setup-status'),
  ackBranding: (done: boolean) => api.post<SetupStatus>('/admin/setup/branding', { done }),
}

/** The "have your coding agent set up email" prompt (Email panel + checklist). */
export function emailAgentPrompt(siteUrl: string): string {
  const site = siteUrl || 'https://<your Operation Kit site>'
  return [
    `Set up transactional email for my Operation Kit install at ${site}.`,
    '',
    'Goal: the app sends its own sign-in links, user invites and password-reset emails from my domain, using my own email provider account (Resend, Postmark, or any SMTP service). No shared or third-party relay.',
    '',
    'Steps:',
    '1. Read docs/email.md in the Operation Kit repo.',
    '2. Ask me which provider I use (or recommend one) and which address mail should come from (e.g. no-reply@mydomain.com).',
    '3. Tell me exactly which DNS records to add for SPF, DKIM and DMARC (use GET /api/admin/email/dns?provider=<provider>&domain=<domain> to see what is published now). If you have access to my DNS provider, add them yourself and wait until the provider shows the domain as verified.',
    '4. Configure it with PUT /api/admin/email (body: provider, from_name, from_address, app_url, smtp{host,port,security,username} for SMTP, and credential = the API key / SMTP password). Authenticate with my personal API key from Settings → You as a Bearer token. If you do not have that key, tell me what to paste into Settings → Email instead.',
    '5. Send a test with POST /api/admin/email/test {"to": "<my email>"} and confirm I received it.',
    '',
    'Never print the API key or password back to me or into logs.',
  ].join('\n')
}
