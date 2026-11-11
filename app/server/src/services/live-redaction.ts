/**
 * Redaction for live, mid-run worker output served over the API (obj 715699):
 * progress notes/results and objective-memory artifacts.
 *
 * #715532 (the full server-side secret redaction + transcript scrubbing) had NOT
 * merged when this shipped, so this is the minimal stand-in it asked for: known
 * secret VALUES from the process env become `[REDACTED:NAME]`, and well-known
 * credential shapes become `[REDACTED:FAMILY]`. When 715532 lands, point
 * `redactLive` at its `secret-redaction.ts` and delete the local rules — every
 * caller already goes through this one function.
 */

const SECRET_NAME_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PAT|CREDENTIAL|PRIVATE|DSN|COOKIE|SALT)/i
const MIN_SECRET_LEN = 12

const PATTERNS: Array<{ family: string; re: RegExp }> = [
  { family: 'PRIVATE_KEY', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g },
  { family: 'ANTHROPIC_KEY', re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  { family: 'OPENAI_KEY', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { family: 'GITHUB_TOKEN', re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g },
  { family: 'CC_API_KEY', re: /\bcc_live_[A-Za-z0-9_-]{8,}/g },
  { family: 'AWS_KEY', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { family: 'SLACK_TOKEN', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { family: 'STRIPE_KEY', re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { family: 'JWT', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { family: 'BEARER', re: /(\bBearer\s+)[A-Za-z0-9._~+/=-]{16,}/g },
  { family: 'URL_CREDENTIAL', re: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+(@)/gi },
]

function knownSecretValues(env: NodeJS.ProcessEnv): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = []
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < MIN_SECRET_LEN || !SECRET_NAME_RE.test(name)) continue
    out.push({ name, value })
  }
  // Longest first so a value that contains another is replaced whole.
  return out.sort((a, b) => b.value.length - a.value.length)
}

export interface RedactionResult {
  text: string
  count: number
}

export function redactLive(text: string, env: NodeJS.ProcessEnv = process.env): RedactionResult {
  if (!text) return { text: text ?? '', count: 0 }
  let out = text
  let count = 0
  for (const { name, value } of knownSecretValues(env)) {
    if (!out.includes(value)) continue
    const parts = out.split(value)
    count += parts.length - 1
    out = parts.join(`[REDACTED:${name}]`)
  }
  for (const { family, re } of PATTERNS) {
    out = out.replace(re, (match, ...groups) => {
      count++
      // Patterns with capture groups keep the non-secret framing (scheme+user, "Bearer ").
      if (family === 'BEARER') return `${groups[0]}[REDACTED:${family}]`
      if (family === 'URL_CREDENTIAL') return `${groups[0]}[REDACTED:${family}]${groups[1]}`
      void match
      return `[REDACTED:${family}]`
    })
  }
  return { text: out, count }
}

/** Convenience: redact and return just the string (null-safe). */
export function redactLiveText(text: string | null | undefined): string | null {
  if (text == null) return null
  return redactLive(text).text
}
