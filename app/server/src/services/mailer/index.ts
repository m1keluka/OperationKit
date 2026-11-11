/**
 * Transactional mailer (obj 900497) — the ONE seam that sends email on behalf
 * of this install. Callers build a message (templates.ts) and call sendMail();
 * the configured provider (SMTP / Resend / Postmark, owner's own credentials)
 * delivers it. Never throws: a caller always gets a SendResult and decides how
 * to fall back (e.g. show the temp password on screen instead).
 *
 * Logging: one line per send with provider + recipient DOMAIN + outcome. Never
 * the full address, the body, a link token or a credential.
 */
import { emailConfigProblems, loadEmailConfig, readEmailCredential } from './config.js'
import { emailDomain, isEmailAddress } from './address.js'
import { sendViaSmtp } from './smtp.js'
import { sendViaPostmark, sendViaResend } from './http-providers.js'
import type { EmailConfig, FetchLike, MailMessage, SendResult } from './types.js'

export * from './types.js'
export { emailConfigured, emailConfigProblems, loadEmailConfig } from './config.js'

let fetchOverride: FetchLike | null = null
/** Tests only: swap the HTTP client the Resend/Postmark adapters use. */
export function setMailerFetchForTests(f: FetchLike | null): void { fetchOverride = f }

export async function sendMail(message: MailMessage, cfg: EmailConfig = loadEmailConfig()): Promise<SendResult> {
  const provider = cfg.provider
  const problems = emailConfigProblems(cfg)
  if (!provider || problems.length) {
    return { ok: false, provider, code: 'not_configured', error: `Email is not set up: ${problems.join('; ')}` }
  }
  if (!isEmailAddress(message.to)) {
    return { ok: false, provider, code: 'invalid', error: 'Recipient is not a valid email address' }
  }
  const fromName = cfg.from_name
  const fromAddress = cfg.from_address
  const replyTo = isEmailAddress(cfg.reply_to) ? cfg.reply_to : undefined
  try {
    let id: string | null
    if (provider === 'smtp') {
      const pw = cfg.smtp.username ? readEmailCredential('smtp') : null
      id = await sendViaSmtp(cfg.smtp, pw, { fromName, fromAddress, replyTo, message })
    } else {
      const key = readEmailCredential(provider) ?? ''
      const f = fetchOverride ?? (globalThis.fetch as unknown as FetchLike)
      id = provider === 'resend'
        ? await sendViaResend(key, { fromName, fromAddress, replyTo, message }, f)
        : await sendViaPostmark(key, { fromName, fromAddress, replyTo, message }, f)
    }
    console.log(`[mailer] sent via ${provider} to *@${emailDomain(message.to)}`)
    return { ok: true, provider, id }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    console.warn(`[mailer] ${provider} send to *@${emailDomain(message.to)} failed: ${error}`)
    return { ok: false, provider, code: 'send_failed', error }
  }
}
