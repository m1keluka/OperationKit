/**
 * Account emails (obj 900497): the three emails the app sends about a person's
 * account. Each returns a SendResult — callers fall back to today's behaviour
 * (show the temp password on screen) whenever `ok` is false.
 */
import { loadEmailConfig, sendMail } from './index.js'
import { currentBrand, inviteEmail, normaliseAppUrl, signInLinkEmail, tempPasswordEmail } from './templates.js'
import type { SendResult } from './types.js'

function signInUrl(appUrl: string): string | null {
  const base = normaliseAppUrl(appUrl)
  return base ? `${base}/login` : null
}

function noUrl(): SendResult {
  return { ok: false, provider: null, code: 'not_configured', error: "Email is not set up: set this site's public URL" }
}

export async function sendInvite(o: { to: string; username: string; tempPassword: string; invitedBy?: string }): Promise<SendResult> {
  const cfg = loadEmailConfig()
  const url = signInUrl(cfg.app_url)
  if (!url) return noUrl()
  return sendMail(inviteEmail({ brand: currentBrand(cfg.app_url), signInUrl: url, ...o }), cfg)
}

export async function sendTempPassword(o: { to: string; username: string; tempPassword: string }): Promise<SendResult> {
  const cfg = loadEmailConfig()
  const url = signInUrl(cfg.app_url)
  if (!url) return noUrl()
  return sendMail(tempPasswordEmail({ brand: currentBrand(cfg.app_url), signInUrl: url, ...o }), cfg)
}

export async function sendSignInLink(o: { to: string; username: string; token: string; minutes: number }): Promise<SendResult> {
  const cfg = loadEmailConfig()
  const base = normaliseAppUrl(cfg.app_url)
  if (!base) return noUrl()
  const url = `${base}/login?link=${encodeURIComponent(o.token)}`
  return sendMail(signInLinkEmail({ brand: currentBrand(cfg.app_url), to: o.to, username: o.username, url, minutes: o.minutes }), cfg)
}
