/**
 * Transactional email templates (obj 900497): sign-in link, user invite, temp
 * password, test. Every template returns BOTH a plain-text body (always
 * complete on its own) and a simple HTML body. Brand name + logo come from the
 * branding config (routes/branding.ts); nothing here names a vendor or a
 * particular company.
 *
 * Every interpolated value is HTML-escaped. Email clients ignore CSS variables,
 * so the HTML uses a small inline palette; the accent follows OK_BRAND_ACCENT
 * when the branding config sets one.
 */
import { brandName, findLogo } from '../../routes/branding.js'
import type { MailMessage } from './types.js'

export interface Brand {
  name: string
  logoUrl: string | null
  accent: string
}

const DEFAULT_ACCENT = '#111827'

export function esc(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/** Normalise the install's public URL: https/http only, no trailing slash. */
export function normaliseAppUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim())
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
    if (u.username || u.password) return null
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`
  } catch {
    return null
  }
}

export function currentBrand(appUrl: string, env: NodeJS.ProcessEnv = process.env): Brand {
  const base = normaliseAppUrl(appUrl)
  let logo: string | null = null
  try { logo = base && findLogo() ? `${base}/api/branding/logo` : null } catch { logo = null }
  const accent = /^#[0-9a-fA-F]{6}$/.test(env.OK_BRAND_ACCENT || '') ? env.OK_BRAND_ACCENT! : DEFAULT_ACCENT
  return { name: brandName(env), logoUrl: logo, accent }
}

interface Block { heading: string; paragraphs: string[]; button?: { label: string; url: string }; code?: Array<[string, string]>; footer: string }

function render(brand: Brand, b: Block): string {
  const header = brand.logoUrl
    ? `<img src="${esc(brand.logoUrl)}" alt="${esc(brand.name)}" height="32" style="height:32px;max-width:200px;border:0;display:block">`
    : `<div style="font-size:18px;font-weight:700;color:#111827">${esc(brand.name)}</div>`
  const paras = b.paragraphs.map(p => `<p style="margin:0 0 14px;font-size:15px;line-height:22px;color:#374151">${esc(p)}</p>`).join('')
  const code = b.code?.length
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:4px 0 18px;border-collapse:collapse;width:100%">${b.code
        .map(([k, v]) => `<tr><td style="padding:6px 10px;font-size:13px;color:#6b7280;border:1px solid #e5e7eb;width:40%">${esc(k)}</td><td style="padding:6px 10px;font-size:14px;font-family:ui-monospace,Menlo,Consolas,monospace;color:#111827;border:1px solid #e5e7eb">${esc(v)}</td></tr>`)
        .join('')}</table>`
    : ''
  const button = b.button
    ? `<p style="margin:6px 0 20px"><a href="${esc(b.button.url)}" style="display:inline-block;background:${esc(brand.accent)};color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:11px 20px;border-radius:8px">${esc(b.button.label)}</a></p>
<p style="margin:0 0 14px;font-size:12px;line-height:18px;color:#6b7280">Or paste this link into your browser:<br><span style="word-break:break-all">${esc(b.button.url)}</span></p>`
    : ''
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(b.heading)}</title></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;border:1px solid #e5e7eb">
<tr><td style="padding:24px 28px 8px">${header}</td></tr>
<tr><td style="padding:12px 28px 8px"><h1 style="margin:0 0 14px;font-size:20px;line-height:28px;color:#111827">${esc(b.heading)}</h1>${paras}${code}${button}</td></tr>
<tr><td style="padding:14px 28px 22px;border-top:1px solid #f3f4f6;font-size:12px;line-height:18px;color:#9ca3af">${esc(b.footer)}</td></tr>
</table></td></tr></table></body></html>`
}

function text(lines: Array<string | null | false>): string {
  return lines.filter((l): l is string => typeof l === 'string').join('\n')
}

export function signInLinkEmail(o: { brand: Brand; to: string; username: string; url: string; minutes: number }): MailMessage {
  const { brand } = o
  const footer = `You got this because someone asked to sign in to ${brand.name} as ${o.username}. If it wasn't you, ignore this email — nothing changes.`
  return {
    to: o.to,
    subject: `Your ${brand.name} sign-in link`,
    text: text([
      `Sign in to ${brand.name}`, '',
      `Open this link to sign in as ${o.username}. It works once and expires in ${o.minutes} minutes:`, '',
      o.url, '',
      footer,
    ]),
    html: render(brand, {
      heading: `Sign in to ${brand.name}`,
      paragraphs: [`Use the button below to sign in as ${o.username}. The link works once and expires in ${o.minutes} minutes.`],
      button: { label: 'Sign in', url: o.url },
      footer,
    }),
  }
}

export function inviteEmail(o: { brand: Brand; to: string; username: string; tempPassword: string; signInUrl: string; invitedBy?: string }): MailMessage {
  const { brand } = o
  const who = o.invitedBy ? `${o.invitedBy} invited you` : 'You have been invited'
  const footer = `If you weren't expecting this invite, you can ignore it. Questions? Reply to this email.`
  return {
    to: o.to,
    subject: `You're invited to ${brand.name}`,
    text: text([
      `${who} to ${brand.name}.`, '',
      `Sign in at: ${o.signInUrl}`,
      `Username: ${o.username}`,
      `Temporary password: ${o.tempPassword}`, '',
      'You will be asked to choose your own password the first time you sign in.', '',
      footer,
    ]),
    html: render(brand, {
      heading: `You're invited to ${brand.name}`,
      paragraphs: [`${who} to ${brand.name}. Sign in with the details below — you will be asked to choose your own password the first time.`],
      code: [['Username', o.username], ['Temporary password', o.tempPassword]],
      button: { label: `Sign in to ${brand.name}`, url: o.signInUrl },
      footer,
    }),
  }
}

export function tempPasswordEmail(o: { brand: Brand; to: string; username: string; tempPassword: string; signInUrl: string }): MailMessage {
  const { brand } = o
  const footer = `An administrator reset this password. If you didn't ask for this, tell your administrator.`
  return {
    to: o.to,
    subject: `Your ${brand.name} password was reset`,
    text: text([
      `Your ${brand.name} password was reset.`, '',
      `Sign in at: ${o.signInUrl}`,
      `Username: ${o.username}`,
      `Temporary password: ${o.tempPassword}`, '',
      'You will be asked to choose a new password when you sign in.', '',
      footer,
    ]),
    html: render(brand, {
      heading: 'Your password was reset',
      paragraphs: [`Sign in to ${brand.name} with this temporary password. You will be asked to choose a new one right away.`],
      code: [['Username', o.username], ['Temporary password', o.tempPassword]],
      button: { label: 'Sign in', url: o.signInUrl },
      footer,
    }),
  }
}

export function testEmail(o: { brand: Brand; to: string; provider: string }): MailMessage {
  const { brand } = o
  const footer = `Sent from the Email settings page of ${brand.name}.`
  return {
    to: o.to,
    subject: `${brand.name}: test email`,
    text: text([
      `It works. ${brand.name} can send email through ${o.provider}.`, '',
      'Sign-in links, invites and password resets will now be emailed.', '',
      footer,
    ]),
    html: render(brand, {
      heading: 'It works',
      paragraphs: [`${brand.name} can send email through ${o.provider}.`, 'Sign-in links, invites and password resets will now be emailed.'],
      footer,
    }),
  }
}
