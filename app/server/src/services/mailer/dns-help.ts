/**
 * DNS help for the Email panel (obj 900497): which records the chosen provider
 * needs, in plain words, plus a live read-only check of what the from-domain
 * currently publishes (SPF + DMARC are at fixed names, so we can look them up;
 * DKIM selectors are provider-assigned, so we only explain where to find them).
 */
import dns from 'dns'
import type { EmailProvider } from './types.js'

export interface DnsRecordHelp {
  purpose: 'SPF' | 'DKIM' | 'DMARC' | 'Return-Path' | 'MX'
  type: 'TXT' | 'CNAME' | 'MX'
  host: string
  value: string
  note: string
}

export interface DnsHelp {
  domain: string
  provider: EmailProvider
  where_to_get: string
  records: DnsRecordHelp[]
  steps: string[]
}

const DMARC_VALUE = 'v=DMARC1; p=none; rua=mailto:dmarc@{domain}'

export function dnsHelpFor(provider: EmailProvider, domain: string): DnsHelp {
  const d = domain || 'yourdomain.com'
  const dmarc: DnsRecordHelp = {
    purpose: 'DMARC', type: 'TXT', host: `_dmarc.${d}`, value: DMARC_VALUE.replace('{domain}', d),
    note: 'Tells inboxes what to do with mail that fails SPF/DKIM. Start with p=none; move to quarantine once mail is landing.',
  }
  if (provider === 'resend') {
    return {
      domain: d, provider,
      where_to_get: 'Resend dashboard → Domains → Add domain. Resend shows the exact values to copy.',
      records: [
        { purpose: 'DKIM', type: 'TXT', host: `resend._domainkey.${d}`, value: 'p=… (copy from Resend)', note: 'Proves the mail really came from you.' },
        { purpose: 'SPF', type: 'TXT', host: `send.${d}`, value: 'v=spf1 include:amazonses.com ~all', note: 'Lets Resend send for your domain (on the "send" subdomain, so it never clashes with your main SPF).' },
        { purpose: 'MX', type: 'MX', host: `send.${d}`, value: 'feedback-smtp.<region>.amazonses.com (priority 10, copy from Resend)', note: 'Bounce handling for the send subdomain.' },
        dmarc,
      ],
      steps: [
        `In Resend, add the domain ${d}.`,
        'Copy each record Resend shows into your DNS provider (Cloudflare, GoDaddy, …).',
        'Click Verify in Resend. It usually turns green within minutes.',
        'Create an API key with "Sending access" and paste it here.',
        'Click "Send test email".',
      ],
    }
  }
  if (provider === 'postmark') {
    return {
      domain: d, provider,
      where_to_get: 'Postmark → Sender Signatures → Add Domain → DNS Settings. Postmark shows the exact values to copy.',
      records: [
        { purpose: 'DKIM', type: 'TXT', host: `<selector>pm._domainkey.${d}`, value: 'k=rsa; p=… (copy from Postmark)', note: 'Proves the mail really came from you.' },
        { purpose: 'Return-Path', type: 'CNAME', host: `pm-bounces.${d}`, value: 'pm.mtasv.net', note: 'Bounce handling; also makes SPF pass for Postmark — no change to your main SPF needed.' },
        dmarc,
      ],
      steps: [
        `In Postmark, add ${d} as a sender domain.`,
        'Add the DKIM and Return-Path records it shows in your DNS provider.',
        'Click Verify in Postmark.',
        'Open your Server → API Tokens, copy the Server API token and paste it here.',
        'Click "Send test email".',
      ],
    }
  }
  return {
    domain: d, provider,
    where_to_get: 'Your mail provider (Google Workspace, Microsoft 365, Amazon SES, Mailgun, Brevo, Fastmail, …) lists the SMTP host, port and DNS records in its admin console.',
    records: [
      { purpose: 'SPF', type: 'TXT', host: d, value: 'v=spf1 include:<your provider> ~all', note: 'One SPF record per domain. If you already have one, add the provider\'s include: to it instead of adding a second record.' },
      { purpose: 'DKIM', type: 'TXT', host: `<selector>._domainkey.${d}`, value: '(copy from your provider)', note: 'Turn on DKIM signing in your provider and publish the key it gives you.' },
      dmarc,
    ],
    steps: [
      'Find your provider\'s SMTP settings: host, port (587 with STARTTLS, or 465 with TLS), username and an app password.',
      'Make sure SPF and DKIM for your domain include that provider (records above).',
      'Fill in the fields here and click "Send test email".',
    ],
  }
}

export interface DnsCheck {
  domain: string
  spf: string | null
  dmarc: string | null
  error: string | null
}

type TxtResolver = (host: string) => Promise<string[][]>

const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

export async function checkDomainDns(domain: string, resolveTxt: TxtResolver = (h) => dns.promises.resolveTxt(h)): Promise<DnsCheck> {
  const d = domain.trim().toLowerCase()
  if (!DOMAIN_RE.test(d)) return { domain: d, spf: null, dmarc: null, error: 'Not a valid domain' }
  const first = async (host: string, prefix: string): Promise<string | null> => {
    try {
      const rows = await Promise.race([
        resolveTxt(host),
        new Promise<string[][]>((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
      ])
      const hit = rows.map(r => r.join('')).find(v => v.toLowerCase().startsWith(prefix))
      return hit ?? null
    } catch {
      return null
    }
  }
  const [spf, dmarc] = await Promise.all([first(d, 'v=spf1'), first(`_dmarc.${d}`, 'v=dmarc1')])
  return { domain: d, spf, dmarc, error: null }
}
