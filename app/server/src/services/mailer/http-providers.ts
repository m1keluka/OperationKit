/**
 * Resend + Postmark adapters — plain HTTPS calls with the install owner's own
 * key. The key is only ever placed in the request header; error text returned
 * to the admin is the provider's message with the key scrubbed out.
 */
import { formatApiMailbox } from './address.js'
import type { FetchLike, MailMessage } from './types.js'

export const RESEND_ENDPOINT = 'https://api.resend.com/emails'
export const POSTMARK_ENDPOINT = 'https://api.postmarkapp.com/email'
const TIMEOUT_MS = 20_000

export interface HttpSendInput {
  fromName: string
  fromAddress: string
  replyTo?: string
  message: MailMessage
}

function scrub(text: string, secret: string): string {
  const t = text.slice(0, 400)
  return secret ? t.split(secret).join('[redacted]') : t
}

function providerError(body: string): string {
  try {
    const j = JSON.parse(body) as { message?: string; Message?: string; name?: string }
    return j.message || j.Message || j.name || body
  } catch {
    return body
  }
}

async function post(fetchImpl: FetchLike, url: string, headers: Record<string, string>, payload: unknown, secret: string, label: string): Promise<string> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS)
  try {
    const res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: ctl.signal })
    const body = await res.text().catch(() => '')
    if (!res.ok) {
      const hint = res.status === 401 || res.status === 403 ? ' Check the key and that the from domain is verified.' : ''
      throw new Error(`${label} returned ${res.status}: ${scrub(providerError(body), secret)}${hint}`)
    }
    return body
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw new Error(`${label} timed out`)
    if (err instanceof Error && err.message.startsWith(label)) throw err
    throw new Error(`${label} request failed: ${scrub(err instanceof Error ? err.message : String(err), secret)}`)
  } finally {
    clearTimeout(timer)
  }
}

export async function sendViaResend(apiKey: string, input: HttpSendInput, fetchImpl: FetchLike): Promise<string | null> {
  const body = await post(fetchImpl, RESEND_ENDPOINT, {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  }, {
    from: formatApiMailbox(input.fromName, input.fromAddress),
    to: [input.message.to],
    subject: input.message.subject,
    text: input.message.text,
    ...(input.message.html ? { html: input.message.html } : {}),
    ...(input.replyTo ? { reply_to: input.replyTo } : {}),
  }, apiKey, 'Resend')
  try { return (JSON.parse(body) as { id?: string }).id ?? null } catch { return null }
}

export async function sendViaPostmark(serverToken: string, input: HttpSendInput, fetchImpl: FetchLike): Promise<string | null> {
  const body = await post(fetchImpl, POSTMARK_ENDPOINT, {
    'X-Postmark-Server-Token': serverToken,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  }, {
    From: formatApiMailbox(input.fromName, input.fromAddress),
    To: input.message.to,
    Subject: input.message.subject,
    TextBody: input.message.text,
    ...(input.message.html ? { HtmlBody: input.message.html } : {}),
    ...(input.replyTo ? { ReplyTo: input.replyTo } : {}),
    MessageStream: 'outbound',
  }, serverToken, 'Postmark')
  try {
    const j = JSON.parse(body) as { MessageID?: string; ErrorCode?: number; Message?: string }
    if (j.ErrorCode) throw new Error(`Postmark error ${j.ErrorCode}: ${scrub(j.Message ?? '', serverToken)}`)
    return j.MessageID ?? null
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Postmark')) throw err
    return null
  }
}
