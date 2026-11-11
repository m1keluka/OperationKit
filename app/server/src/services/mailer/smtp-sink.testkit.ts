/**
 * TEST KIT ONLY — a tiny in-process SMTP sink (obj 900497). Speaks just enough
 * ESMTP for the mailer tests: EHLO, optional AUTH PLAIN/LOGIN, MAIL, RCPT,
 * DATA, QUIT. Captures each message so a test can assert on it. Nothing is
 * relayed anywhere; it binds to 127.0.0.1 on a random port.
 */
import net from 'net'

export interface SinkMessage { from: string; to: string[]; data: string; auth: { user: string; pass: string } | null }

export interface SmtpSink {
  port: number
  messages: SinkMessage[]
  close(): Promise<void>
}

export async function startSmtpSink(opts: { advertiseStartTls?: boolean; authMechs?: string[]; rejectAuth?: boolean } = {}): Promise<SmtpSink> {
  const messages: SinkMessage[] = []
  const sockets = new Set<net.Socket>()
  const server = net.createServer(sock => {
    sockets.add(sock)
    sock.on('close', () => sockets.delete(sock))
    sock.setEncoding('utf8')
    let buf = ''
    let inData = false
    let data = ''
    let cur: SinkMessage = { from: '', to: [], data: '', auth: null }
    let loginStep: 0 | 1 | 2 = 0
    let loginUser = ''
    const send = (l: string) => sock.write(`${l}\r\n`)
    send('220 sink ESMTP')
    sock.on('data', (chunk: string) => {
      buf += chunk
      let idx: number
      while ((idx = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        if (inData) {
          if (line === '.') {
            inData = false
            messages.push({ ...cur, data: data.replace(/^\.\./gm, '.') })
            cur = { from: '', to: [], data: '', auth: cur.auth }
            data = ''
            send('250 2.0.0 Ok: queued as SINK1')
          } else {
            data += `${line}\r\n`
          }
          continue
        }
        if (loginStep === 1) { loginUser = Buffer.from(line, 'base64').toString(); loginStep = 2; send('334 UGFzc3dvcmQ6'); continue }
        if (loginStep === 2) {
          loginStep = 0
          if (opts.rejectAuth) { send('535 5.7.8 Authentication failed'); continue }
          cur.auth = { user: loginUser, pass: Buffer.from(line, 'base64').toString() }
          send('235 2.7.0 Authentication successful')
          continue
        }
        const up = line.toUpperCase()
        if (up.startsWith('EHLO')) {
          const ext = ['250-sink', ...(opts.advertiseStartTls ? ['250-STARTTLS'] : []), `250-AUTH ${(opts.authMechs ?? ['PLAIN', 'LOGIN']).join(' ')}`, '250 8BITMIME']
          for (const e of ext) send(e)
        } else if (up.startsWith('AUTH PLAIN ')) {
          if (opts.rejectAuth) { send('535 5.7.8 Authentication failed'); continue }
          const [, user, pass] = Buffer.from(line.slice(11), 'base64').toString().split('\u0000')
          cur.auth = { user, pass }
          send('235 2.7.0 Authentication successful')
        } else if (up === 'AUTH LOGIN') {
          loginStep = 1
          send('334 VXNlcm5hbWU6')
        } else if (up.startsWith('MAIL FROM:')) {
          cur.from = line.slice(10).replace(/[<>]/g, '')
          send('250 2.1.0 Ok')
        } else if (up.startsWith('RCPT TO:')) {
          cur.to.push(line.slice(8).replace(/[<>]/g, ''))
          send('250 2.1.5 Ok')
        } else if (up === 'DATA') {
          inData = true
          send('354 End data with <CR><LF>.<CR><LF>')
        } else if (up === 'QUIT') {
          send('221 2.0.0 Bye')
          sock.end()
        } else {
          send('502 5.5.2 Error: command not recognized')
        }
      }
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address() as net.AddressInfo
  return {
    port: addr.port,
    messages,
    close: () => new Promise<void>(resolve => { for (const s of sockets) s.destroy(); server.close(() => resolve()) }),
  }
}

/** Decode the base64 MIME parts of a captured message into { text, html }. */
export function decodeParts(raw: string): { headers: string; text: string; html: string } {
  const [headers] = raw.split('\r\n\r\n')
  const parts = raw.split(/\r\n--=_cc_[a-f0-9]+(?:--)?\r\n/)
  let text = ''
  let html = ''
  for (const p of parts) {
    const [h, ...rest] = p.split('\r\n\r\n')
    const body = Buffer.from(rest.join('\r\n\r\n').replace(/\s+/g, ''), 'base64').toString('utf8')
    if (/Content-Type: text\/plain/i.test(h)) text = body
    if (/Content-Type: text\/html/i.test(h)) html = body
  }
  return { headers, text, html }
}
