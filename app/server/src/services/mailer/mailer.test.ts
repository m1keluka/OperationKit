import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { sendViaSmtp, buildMimeMessage, dotStuff, isLoopbackHost } from './smtp.js'
import { sendViaPostmark, sendViaResend, RESEND_ENDPOINT, POSTMARK_ENDPOINT } from './http-providers.js'
import { formatMailbox, isEmailAddress, cleanHeaderText, redactAddress } from './address.js'
import { inviteEmail, signInLinkEmail, tempPasswordEmail, normaliseAppUrl, esc } from './templates.js'
import { dnsHelpFor, checkDomainDns } from './dns-help.js'
import { startSmtpSink, decodeParts, type SmtpSink } from './smtp-sink.testkit.js'
import type { FetchLike } from './types.js'

const brand = { name: 'Acme Ops', logoUrl: null, accent: '#112233' }

describe('address hygiene', () => {
  it('validates addresses and strips header-injection characters', () => {
    expect(isEmailAddress('a.b+c@example.co.uk')).toBe(true)
    expect(isEmailAddress('a@b')).toBe(false)
    expect(isEmailAddress('x@example.com\r\nBcc: evil@x.com')).toBe(false)
    expect(cleanHeaderText('Hi\r\nBcc: evil@x.com')).toBe('Hi Bcc: evil@x.com')
    expect(formatMailbox('Acme "Ops"', 'a@b.co')).toBe('"Acme Ops" <a@b.co>')
    expect(formatMailbox('Café', 'a@b.co')).toMatch(/^=\?UTF-8\?B\?.+\?= <a@b\.co>$/)
    expect(redactAddress('jane@example.com')).toBe('j***@example.com')
  })

  it('treats only loopback hosts as loopback', () => {
    expect(isLoopbackHost('localhost')).toBe(true)
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('[::1]')).toBe(true)
    expect(isLoopbackHost('smtp.example.com')).toBe(false)
    expect(isLoopbackHost('10.0.0.5')).toBe(false)
  })
})

describe('MIME building', () => {
  it('builds multipart/alternative with both parts and dot-stuffs', () => {
    const raw = buildMimeMessage({ fromName: 'Acme', fromAddress: 'no-reply@acme.test', message: { to: 'u@acme.test', subject: 'Hello\r\nBcc: x@y.z', text: 'line\n.dot', html: '<p>hi</p>' } })
    expect(raw).toContain('multipart/alternative')
    expect(raw).not.toMatch(/\r\nBcc:/)
    const { text, html } = decodeParts(raw)
    expect(text).toBe('line\n.dot')
    expect(html).toBe('<p>hi</p>')
    expect(dotStuff('a\n.b\r\n..c')).toBe('a\r\n..b\r\n...c')
  })
})

describe('SMTP client against a local sink', () => {
  let sink: SmtpSink
  beforeAll(async () => { sink = await startSmtpSink() })
  afterAll(async () => { await sink.close() })

  it('delivers a message with AUTH PLAIN to a loopback host over plain TCP', async () => {
    const msg = inviteEmail({ brand, to: 'new.user@example.com', username: 'newbie', tempPassword: 'Temp-Pass-123', signInUrl: 'https://ops.acme.test/login' })
    const reply = await sendViaSmtp({ host: '127.0.0.1', port: sink.port, security: 'none', username: 'mailer' }, 's3cret', { fromName: 'Acme Ops', fromAddress: 'no-reply@acme.test', message: msg })
    expect(reply).toContain('queued')
    const got = sink.messages.at(-1)!
    expect(got.from).toBe('no-reply@acme.test')
    expect(got.to).toEqual(['new.user@example.com'])
    expect(got.auth).toEqual({ user: 'mailer', pass: 's3cret' })
    const { headers, text, html } = decodeParts(got.data)
    expect(headers).toContain('Subject: You\'re invited to Acme Ops')
    expect(text).toContain('Temporary password: Temp-Pass-123')
    expect(html).toContain('https://ops.acme.test/login')
  })

  it('falls back to AUTH LOGIN when PLAIN is not offered', async () => {
    const s2 = await startSmtpSink({ authMechs: ['LOGIN'] })
    try {
      await sendViaSmtp({ host: 'localhost', port: s2.port, security: 'none', username: 'u1' }, 'p1', { fromName: '', fromAddress: 'a@acme.test', message: { to: 'b@acme.test', subject: 's', text: 't' } })
      expect(s2.messages[0].auth).toEqual({ user: 'u1', pass: 'p1' })
    } finally { await s2.close() }
  })

  it('never sends a password over plain TCP to a non-loopback host', async () => {
    await expect(sendViaSmtp({ host: 'smtp.example.com', port: 25, security: 'none', username: 'u' }, 'p', { fromName: '', fromAddress: 'a@acme.test', message: { to: 'b@acme.test', subject: 's', text: 't' } }))
      .rejects.toThrow(/unencrypted/)
  })

  it('requires STARTTLS when asked for it (no silent downgrade)', async () => {
    await expect(sendViaSmtp({ host: '127.0.0.1', port: sink.port, security: 'starttls', username: '' }, null, { fromName: '', fromAddress: 'a@acme.test', message: { to: 'b@acme.test', subject: 's', text: 't' } }))
      .rejects.toThrow(/STARTTLS/)
  })

  it('reports a failed sign-in without echoing the password', async () => {
    const s3 = await startSmtpSink({ rejectAuth: true })
    try {
      const err = await sendViaSmtp({ host: '127.0.0.1', port: s3.port, security: 'none', username: 'u' }, 'hunter2-secret', { fromName: '', fromAddress: 'a@acme.test', message: { to: 'b@acme.test', subject: 's', text: 't' } }).catch(e => e as Error)
      expect(String(err)).toMatch(/sign-in failed \(535\)/)
      expect(String(err)).not.toContain('hunter2-secret')
    } finally { await s3.close() }
  })
})

describe('Resend + Postmark adapters', () => {
  function fakeFetch(status: number, body: string, seen: Array<{ url: string; headers: Record<string, string>; body: string }>): FetchLike {
    return async (url, init) => { seen.push({ url, headers: init.headers, body: init.body }); return { ok: status < 300, status, text: async () => body } }
  }
  const input = { fromName: 'Acme Ops', fromAddress: 'no-reply@acme.test', replyTo: 'help@acme.test', message: { to: 'u@example.com', subject: 'Hi', text: 'plain', html: '<b>x</b>' } }

  it('Resend: posts the documented payload with the bearer key', async () => {
    const seen: Array<{ url: string; headers: Record<string, string>; body: string }> = []
    const id = await sendViaResend('re_test_key', input, fakeFetch(200, '{"id":"abc"}', seen))
    expect(id).toBe('abc')
    expect(seen[0].url).toBe(RESEND_ENDPOINT)
    expect(seen[0].headers.Authorization).toBe('Bearer re_test_key')
    expect(JSON.parse(seen[0].body)).toEqual({ from: 'Acme Ops <no-reply@acme.test>', to: ['u@example.com'], subject: 'Hi', text: 'plain', html: '<b>x</b>', reply_to: 'help@acme.test' })
  })

  it('Postmark: posts the documented payload with the server token', async () => {
    const seen: Array<{ url: string; headers: Record<string, string>; body: string }> = []
    const id = await sendViaPostmark('pm-token', input, fakeFetch(200, '{"ErrorCode":0,"MessageID":"m-1"}', seen))
    expect(id).toBe('m-1')
    expect(seen[0].url).toBe(POSTMARK_ENDPOINT)
    expect(seen[0].headers['X-Postmark-Server-Token']).toBe('pm-token')
    expect(JSON.parse(seen[0].body)).toMatchObject({ From: 'Acme Ops <no-reply@acme.test>', To: 'u@example.com', TextBody: 'plain', HtmlBody: '<b>x</b>', MessageStream: 'outbound' })
  })

  it('scrubs the key out of a provider error', async () => {
    const err = await sendViaResend('re_leaky', input, fakeFetch(401, '{"message":"bad key re_leaky"}', [])).catch(e => e as Error)
    expect(String(err)).toContain('Resend returned 401')
    expect(String(err)).not.toContain('re_leaky')
  })
})

describe('templates', () => {
  it('escapes interpolated values and always carries a plain-text body', () => {
    const m = signInLinkEmail({ brand: { ...brand, name: '<script>x</script>' }, to: 'a@b.co', username: 'u', url: 'https://x.test/login?link=abc', minutes: 15 })
    expect(m.html).not.toContain('<script>x</script>')
    expect(m.html).toContain(esc('<script>x</script>'))
    expect(m.text).toContain('https://x.test/login?link=abc')
    const t = tempPasswordEmail({ brand, to: 'a@b.co', username: 'u', tempPassword: 'P@ss', signInUrl: 'https://x.test/login' })
    expect(t.text).toContain('Temporary password: P@ss')
  })

  it('normalises the site URL and rejects non-http(s)', () => {
    expect(normaliseAppUrl('https://ops.acme.test/')).toBe('https://ops.acme.test')
    expect(normaliseAppUrl('javascript:alert(1)')).toBeNull()
    expect(normaliseAppUrl('https://user:pw@x.test')).toBeNull()
  })
})

describe('DNS help', () => {
  it('lists provider records and checks SPF/DMARC via the resolver', async () => {
    expect(dnsHelpFor('resend', 'acme.test').records.map(r => r.purpose)).toEqual(['DKIM', 'SPF', 'MX', 'DMARC'])
    expect(dnsHelpFor('postmark', 'acme.test').records.find(r => r.purpose === 'Return-Path')?.value).toBe('pm.mtasv.net')
    const check = await checkDomainDns('acme.test', async host => host === 'acme.test' ? [['v=spf1 include:x ~all']] : [['v=DMARC1; p=none']])
    expect(check).toEqual({ domain: 'acme.test', spf: 'v=spf1 include:x ~all', dmarc: 'v=DMARC1; p=none', error: null })
    expect((await checkDomainDns('not a domain')).error).toBe('Not a valid domain')
  })
})
