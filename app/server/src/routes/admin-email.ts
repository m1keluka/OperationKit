/**
 * Settings → Email admin API (obj 900497). Mounted under /api/admin, so the
 * admin.ts facade applies requireAuth + requireAdmin.
 *
 *   GET    /email            current setup (never the credential — only has_credential)
 *   PUT    /email            save setup; `credential` (optional) goes to the secrets store
 *   DELETE /email            turn email off and delete the stored credentials
 *   POST   /email/test       send a test email { to }
 *   GET    /email/dns        DNS records the provider needs + live SPF/DMARC check
 *   GET    /setup-status     onboarding checklist: branding → email → coding account
 *   POST   /setup/branding   { done } mark "keep the default branding" as done
 */
import { Router } from 'express'
import type { AuthRequest } from '../middleware/auth.js'
import { getDb } from '../db/index.js'
import {
  clearEmailCredentials, EMAIL_CREDENTIAL_KEYS, emailConfigProblems, hasEmailCredential,
  loadEmailConfig, saveEmailConfig, storeEmailCredential,
} from '../services/mailer/config.js'
import { sendMail } from '../services/mailer/index.js'
import { currentBrand, normaliseAppUrl, testEmail } from '../services/mailer/templates.js'
import { checkDomainDns, dnsHelpFor } from '../services/mailer/dns-help.js'
import { cleanHeaderText, emailDomain, isEmailAddress } from '../services/mailer/address.js'
import { EMAIL_PROVIDERS, type EmailConfig, type EmailProvider, type SmtpSecurity } from '../services/mailer/types.js'
import { findLogo } from './branding.js'
import { isCustomized } from '../services/branding-config.js'

const router = Router()

const PROVIDER_LABEL: Record<EmailProvider, string> = { smtp: 'SMTP', resend: 'Resend', postmark: 'Postmark' }

export function emailView(cfg: EmailConfig = loadEmailConfig()) {
  const problems = emailConfigProblems(cfg)
  return {
    provider: cfg.provider,
    from_name: cfg.from_name,
    from_address: cfg.from_address,
    reply_to: cfg.reply_to,
    app_url: cfg.app_url,
    smtp: cfg.smtp,
    last_test: cfg.last_test,
    configured: problems.length === 0,
    problems,
    has_credential: Object.fromEntries(EMAIL_PROVIDERS.map(p => [p, hasEmailCredential(p)])) as Record<EmailProvider, boolean>,
    credential_keys: EMAIL_CREDENTIAL_KEYS,
  }
}

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? cleanHeaderText(v, max) : ''
}

router.get('/email', (_req, res) => {
  res.json(emailView())
})

router.put('/email', (req: AuthRequest, res) => {
  const body = (req.body || {}) as Record<string, unknown>
  const prev = loadEmailConfig()
  const provider = body.provider === null || body.provider === '' ? null : body.provider
  if (provider !== null && !EMAIL_PROVIDERS.includes(provider as EmailProvider)) {
    res.status(400).json({ error: 'provider must be smtp, resend or postmark' })
    return
  }
  const fromAddress = str(body.from_address, 254).toLowerCase()
  if (fromAddress && !isEmailAddress(fromAddress)) {
    res.status(400).json({ error: 'From address must look like name@yourdomain.com', field: 'from_address' })
    return
  }
  const replyTo = str(body.reply_to, 254).toLowerCase()
  if (replyTo && !isEmailAddress(replyTo)) {
    res.status(400).json({ error: 'Reply-to must look like name@yourdomain.com', field: 'reply_to' })
    return
  }
  const rawUrl = str(body.app_url, 300)
  const appUrl = rawUrl ? normaliseAppUrl(rawUrl) : ''
  if (appUrl === null) {
    res.status(400).json({ error: 'Site URL must start with https:// (or http://)', field: 'app_url' })
    return
  }
  const smtpIn = (body.smtp && typeof body.smtp === 'object' ? body.smtp : {}) as Record<string, unknown>
  const security = (['tls', 'starttls', 'none'] as const).includes(smtpIn.security as SmtpSecurity) ? (smtpIn.security as SmtpSecurity) : prev.smtp.security
  const port = Number(smtpIn.port ?? prev.smtp.port)
  if (provider === 'smtp' && !(Number.isInteger(port) && port > 0 && port < 65536)) {
    res.status(400).json({ error: 'SMTP port must be a number like 587 or 465', field: 'smtp.port' })
    return
  }
  const host = str(smtpIn.host ?? prev.smtp.host, 253)
  if (host && !/^[A-Za-z0-9.\-:[\]]+$/.test(host)) {
    res.status(400).json({ error: 'SMTP host must be a hostname like smtp.example.com', field: 'smtp.host' })
    return
  }

  const credential = typeof body.credential === 'string' ? body.credential.trim() : ''
  if (credential.length > 4096) {
    res.status(400).json({ error: 'That credential is too long', field: 'credential' })
    return
  }

  const smtp = { host, port: Number.isInteger(port) ? port : 587, security, username: str(smtpIn.username ?? prev.smtp.username, 254) }
  const senderUnchanged = prev.provider === provider && prev.from_address === fromAddress
    && JSON.stringify(prev.smtp) === JSON.stringify(smtp) && !credential
  const next: EmailConfig = {
    provider: provider as EmailProvider | null,
    from_name: str(body.from_name, 120),
    from_address: fromAddress,
    reply_to: replyTo,
    app_url: appUrl,
    smtp,
    // A changed sender has not been proven by a test yet.
    last_test: senderUnchanged ? prev.last_test : null,
  }
  if (credential && next.provider) storeEmailCredential(next.provider, credential, req.user?.id ?? null)
  saveEmailConfig(next)
  res.json(emailView(next))
})

router.delete('/email', (req: AuthRequest, res) => {
  const cfg = loadEmailConfig()
  clearEmailCredentials(req.user?.id ?? null)
  saveEmailConfig({ ...cfg, provider: null, last_test: null })
  res.json(emailView())
})

// Tiny in-memory throttle: a test send is a real email; keep it to a handful.
const testSends: number[] = []
const TEST_WINDOW_MS = 10 * 60 * 1000
const TEST_MAX = 10

router.post('/email/test', async (req: AuthRequest, res) => {
  const to = str((req.body || {}).to, 254).toLowerCase()
  if (!isEmailAddress(to)) {
    res.status(400).json({ error: 'Enter the address to send the test to', field: 'to' })
    return
  }
  const now = Date.now()
  while (testSends.length && now - testSends[0] > TEST_WINDOW_MS) testSends.shift()
  if (testSends.length >= TEST_MAX) {
    res.status(429).json({ error: 'Too many test emails. Wait a few minutes.' })
    return
  }
  testSends.push(now)

  const cfg = loadEmailConfig()
  const result = await sendMail(testEmail({ brand: currentBrand(cfg.app_url), to, provider: cfg.provider ? PROVIDER_LABEL[cfg.provider] : 'email' }), cfg)
  const lastTest = { ok: result.ok, at: new Date().toISOString(), to_domain: emailDomain(to), error: result.ok ? null : result.error }
  saveEmailConfig({ ...loadEmailConfig(), last_test: lastTest })
  if (!result.ok) {
    res.status(result.code === 'not_configured' ? 409 : 502).json({ error: result.error, ...emailView() })
    return
  }
  res.json({ ok: true, id: result.id, ...emailView() })
})

router.get('/email/dns', async (req, res) => {
  const cfg = loadEmailConfig()
  const provider = (EMAIL_PROVIDERS.includes(req.query.provider as EmailProvider) ? req.query.provider : cfg.provider ?? 'smtp') as EmailProvider
  const domain = (typeof req.query.domain === 'string' && req.query.domain) || emailDomain(cfg.from_address)
  const help = dnsHelpFor(provider, domain)
  const check = domain ? await checkDomainDns(domain) : null
  res.json({ ...help, check })
})

// ── Onboarding checklist (branding → email → coding account) ────────────────

export const BRANDING_ACK_SETTING = 'setup_branding_done'

function readSetting(key: string): string | null {
  try {
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value ?? null
  } catch {
    return null
  }
}

async function codingAccountReady(): Promise<boolean> {
  try {
    const { getRouterStatus, seatCredentialUsable } = await import('../services/account-router.js')
    return getRouterStatus().accounts.some(a => seatCredentialUsable(a as Parameters<typeof seatCredentialUsable>[0]))
  } catch {
    return false
  }
}

export async function setupStatus() {
  let customBrand = false
  try { customBrand = isCustomized() || !!findLogo() } catch { customBrand = false }
  const brandingDone = customBrand || readSetting(BRANDING_ACK_SETTING) === '1'
  const email = emailView()
  const emailDone = email.configured && !!email.last_test?.ok
  const modelsDone = await codingAccountReady()
  const steps = [
    { id: 'branding', title: 'Branding', done: brandingDone },
    { id: 'email', title: 'Transactional email', done: emailDone, configured: email.configured },
    { id: 'models', title: 'Add one coding subscription account', done: modelsDone },
  ]
  return { steps, complete: steps.every(s => s.done) }
}

router.get('/setup-status', async (_req, res) => {
  res.json(await setupStatus())
})

// Admin-only (admin.ts facade: requireAuth + requireAdmin); one idempotent
// settings upsert, no email, no external call — nothing worth throttling.
// codeql[js/missing-rate-limiting] -- admin-auth route; single idempotent settings row write
router.post('/setup/branding', async (req, res) => {
  const done = (req.body || {}).done !== false
  getDb()
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(BRANDING_ACK_SETTING, done ? '1' : '0')
  res.json(await setupStatus())
})

export default router
