/**
 * Minimal SMTP submission client (RFC 5321 + STARTTLS/RFC 3207 + AUTH PLAIN/
 * LOGIN/RFC 4954). Deliberately dependency-free: adding an npm package means a
 * container rebuild on every install, and transactional mail needs only one
 * message per connection.
 *
 * Security rules:
 *   - TLS certificates are verified (rejectUnauthorized stays on).
 *   - `starttls` REQUIRES the server to advertise STARTTLS — no silent downgrade.
 *   - A password is never sent over an unencrypted connection, except to a
 *     loopback host (a local relay or a test sink such as Mailpit).
 *   - Server replies are echoed in errors only after the AUTH exchange is
 *     stripped, and the password is never part of any error text.
 */
import net from 'net'
import tls from 'tls'
import os from 'os'
import crypto from 'crypto'
import { emailDomain, encodeHeaderWord, formatMailbox, isEmailAddress } from './address.js'
import type { MailMessage, SmtpSettings } from './types.js'

const TIMEOUT_MS = 20_000

export interface SmtpEnvelope {
  fromName: string
  fromAddress: string
  replyTo?: string
  message: MailMessage
}

export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '')
  return h === 'localhost' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h)
}

function wrapBase64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64').replace(/.{1,76}/g, '$&\r\n')
}

/** Build the RFC 5322 message (multipart/alternative when there is HTML). */
export function buildMimeMessage(env: SmtpEnvelope, now = new Date()): string {
  const { message } = env
  const domain = emailDomain(env.fromAddress) || 'localhost'
  const headers = [
    `From: ${formatMailbox(env.fromName, env.fromAddress)}`,
    `To: <${message.to}>`,
    ...(env.replyTo ? [`Reply-To: <${env.replyTo}>`] : []),
    `Subject: ${encodeHeaderWord(message.subject)}`,
    `Date: ${now.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    'MIME-Version: 1.0',
    'Auto-Submitted: auto-generated',
  ]
  if (!message.html) {
    return [
      ...headers,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      wrapBase64(message.text),
    ].join('\r\n')
  }
  const boundary = `=_cc_${crypto.randomBytes(12).toString('hex')}`
  return [
    ...headers,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(message.text),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(message.html),
    `--${boundary}--`,
    '',
  ].join('\r\n')
}

/** Normalise line endings to CRLF and dot-stuff (RFC 5321 §4.5.2). */
export function dotStuff(data: string): string {
  return data.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..')
}

interface Reply { code: number; lines: string[] }

/** Line-oriented reader over a socket that can be swapped after STARTTLS. */
class SmtpConn {
  private buf = ''
  private pending: Array<{ resolve: (r: Reply) => void; reject: (e: Error) => void }> = []
  private replies: Reply[] = []
  private acc: string[] = []
  private failure: Error | null = null

  constructor(public socket: net.Socket | tls.TLSSocket) {
    this.attach(socket)
  }

  attach(socket: net.Socket | tls.TLSSocket): void {
    this.socket = socket
    this.buf = ''
    socket.setEncoding('utf8')
    socket.setTimeout(TIMEOUT_MS, () => this.fail(new Error('SMTP server timed out')))
    socket.on('data', (chunk: string) => this.onData(chunk))
    socket.on('error', (err: Error) => this.fail(new Error(`SMTP connection error: ${err.message}`)))
    socket.on('close', () => this.fail(new Error('SMTP connection closed unexpectedly')))
  }

  detach(): void {
    this.socket.removeAllListeners('data')
    this.socket.removeAllListeners('error')
    this.socket.removeAllListeners('close')
    this.socket.setTimeout(0)
  }

  private onData(chunk: string): void {
    this.buf += chunk
    let idx: number
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).replace(/\r$/, '')
      this.buf = this.buf.slice(idx + 1)
      const m = /^(\d{3})([ -])(.*)$/.exec(line)
      if (!m) continue
      this.acc.push(m[3])
      if (m[2] === ' ') {
        const reply = { code: Number(m[1]), lines: this.acc }
        this.acc = []
        const waiter = this.pending.shift()
        if (waiter) waiter.resolve(reply)
        else this.replies.push(reply)
      }
    }
  }

  private fail(err: Error): void {
    if (this.failure) return
    this.failure = err
    for (const w of this.pending.splice(0)) w.reject(err)
  }

  read(): Promise<Reply> {
    const queued = this.replies.shift()
    if (queued) return Promise.resolve(queued)
    if (this.failure) return Promise.reject(this.failure)
    return new Promise((resolve, reject) => this.pending.push({ resolve, reject }))
  }

  write(line: string): void {
    this.socket.write(`${line}\r\n`)
  }

  async cmd(line: string, expect: number[], label = line.split(' ')[0]): Promise<Reply> {
    this.write(line)
    return this.expect(expect, label)
  }

  async expect(codes: number[], label: string): Promise<Reply> {
    const r = await this.read()
    if (!codes.includes(r.code)) {
      throw new Error(`SMTP ${label} rejected: ${r.code} ${r.lines.join(' ').slice(0, 300)}`)
    }
    return r
  }
}

function connect(settings: SmtpSettings): Promise<net.Socket | tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const opts = { host: settings.host, port: settings.port }
    const sock: net.Socket | tls.TLSSocket = settings.security === 'tls'
      ? tls.connect({ ...opts, servername: net.isIP(settings.host) ? undefined : settings.host })
      : net.connect(opts)
    const onErr = (err: Error) => reject(new Error(`Could not connect to ${settings.host}:${settings.port}: ${err.message}`))
    sock.once('error', onErr)
    sock.setTimeout(TIMEOUT_MS, () => { sock.destroy(); reject(new Error(`Timed out connecting to ${settings.host}:${settings.port}`)) })
    sock.once(settings.security === 'tls' ? 'secureConnect' : 'connect', () => {
      sock.removeListener('error', onErr)
      sock.setTimeout(0)
      resolve(sock)
    })
  })
}

function upgradeToTls(socket: net.Socket, host: string): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ socket, servername: net.isIP(host) ? undefined : host })
    secure.once('secureConnect', () => { secure.removeListener('error', reject); resolve(secure) })
    secure.once('error', (err: Error) => reject(new Error(`STARTTLS handshake failed: ${err.message}`)))
  })
}

function ehloName(): string {
  const h = os.hostname().replace(/[^A-Za-z0-9.-]/g, '')
  return h && h.includes('.') ? h : 'localhost'
}

function extensions(reply: Reply): Set<string> {
  return new Set(reply.lines.slice(1).map(l => l.trim().toUpperCase()))
}

function authMechs(ext: Set<string>): string[] {
  for (const e of ext) if (e.startsWith('AUTH ') || e.startsWith('AUTH=')) return e.slice(5).split(/\s+/)
  return []
}

/**
 * Send one message. Resolves with the server's queue reply (often carries a
 * queue id), rejects with an Error whose message is safe to show an admin.
 */
export async function sendViaSmtp(settings: SmtpSettings, password: string | null, env: SmtpEnvelope): Promise<string> {
  if (!settings.host) throw new Error('SMTP host is not set')
  if (!isEmailAddress(env.fromAddress) || !isEmailAddress(env.message.to)) throw new Error('Invalid from or to address')
  const wantsAuth = !!settings.username
  if (wantsAuth && settings.security === 'none' && !isLoopbackHost(settings.host)) {
    throw new Error('Refusing to send an SMTP password over an unencrypted connection. Use TLS (port 465) or STARTTLS (port 587).')
  }

  let socket = await connect(settings)
  const conn = new SmtpConn(socket)
  try {
    await conn.expect([220], 'greeting')
    let ehlo = await conn.cmd(`EHLO ${ehloName()}`, [250], 'EHLO')
    let ext = extensions(ehlo)

    if (settings.security === 'starttls') {
      if (!ext.has('STARTTLS')) throw new Error('Server does not offer STARTTLS. Pick TLS (port 465) or check the host/port.')
      await conn.cmd('STARTTLS', [220], 'STARTTLS')
      conn.detach()
      socket = await upgradeToTls(socket as net.Socket, settings.host)
      conn.attach(socket)
      ehlo = await conn.cmd(`EHLO ${ehloName()}`, [250], 'EHLO')
      ext = extensions(ehlo)
    }

    if (wantsAuth) {
      const mechs = authMechs(ext)
      const user = settings.username
      const pass = password ?? ''
      if (mechs.includes('PLAIN') || mechs.length === 0) {
        const token = Buffer.from(`\u0000${user}\u0000${pass}`, 'utf8').toString('base64')
        await conn.cmd(`AUTH PLAIN ${token}`, [235], 'AUTH').catch(err => { throw scrubAuth(err) })
      } else if (mechs.includes('LOGIN')) {
        await conn.cmd('AUTH LOGIN', [334], 'AUTH')
        await conn.cmd(Buffer.from(user, 'utf8').toString('base64'), [334], 'AUTH').catch(err => { throw scrubAuth(err) })
        await conn.cmd(Buffer.from(pass, 'utf8').toString('base64'), [235], 'AUTH').catch(err => { throw scrubAuth(err) })
      } else {
        throw new Error(`Server offers no supported AUTH method (has: ${mechs.join(', ')})`)
      }
    }

    await conn.cmd(`MAIL FROM:<${env.fromAddress}>`, [250], 'MAIL FROM')
    await conn.cmd(`RCPT TO:<${env.message.to}>`, [250, 251], 'RCPT TO')
    await conn.cmd('DATA', [354], 'DATA')
    conn.socket.write(`${dotStuff(buildMimeMessage(env))}\r\n.\r\n`)
    const queued = await conn.expect([250], 'message')
    conn.write('QUIT')
    return queued.lines.join(' ').slice(0, 200)
  } finally {
    setTimeout(() => socket.destroy(), 200).unref?.()
  }
}

function scrubAuth(err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err)
  const code = /(\d{3})/.exec(msg)?.[1] ?? ''
  return new Error(`SMTP sign-in failed${code ? ` (${code})` : ''}. Check the username and password.`)
}
