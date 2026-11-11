/**
 * Address + header hygiene for outbound mail. Everything that ends up in an
 * SMTP command or a header goes through here, so a CR/LF in a display name or
 * an address can never inject a header or an SMTP verb.
 */

const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/

export function isEmailAddress(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 254 && EMAIL_RE.test(v)
}

/** The part after the @, lower-cased (used for DNS help and redacted logs). */
export function emailDomain(addr: string): string {
  const at = addr.lastIndexOf('@')
  return at < 0 ? '' : addr.slice(at + 1).toLowerCase()
}

/** Drop control characters (incl. CR/LF) and collapse whitespace. */
export function cleanHeaderText(v: string, max = 200): string {
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}

/** RFC 2047 encoded-word for non-ASCII header text; plain text otherwise. */
export function encodeHeaderWord(v: string): string {
  const clean = cleanHeaderText(v, 400)
  // eslint-disable-next-line no-control-regex
  if (/^[\u0020-\u007e]*$/.test(clean)) return clean
  return `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`
}

/** `"Name" <addr>` for SMTP headers (quoted + encoded as needed). */
export function formatMailbox(name: string, addr: string): string {
  const n = cleanHeaderText(name, 120)
  if (!n) return `<${addr}>`
  const enc = encodeHeaderWord(n)
  if (enc !== n) return `${enc} <${addr}>`
  return `"${n.replace(/["\\]/g, '')}" <${addr}>`
}

/** `Name <addr>` for HTTP APIs (Resend/Postmark parse this themselves). */
export function formatApiMailbox(name: string, addr: string): string {
  const n = cleanHeaderText(name, 120).replace(/[<>"]/g, '')
  return n ? `${n} <${addr}>` : addr
}

/** `j***@example.com` — for logs, so a log line never carries a full address. */
export function redactAddress(addr: string): string {
  const at = addr.lastIndexOf('@')
  if (at < 1) return '***'
  return `${addr[0]}***@${addr.slice(at + 1)}`
}
