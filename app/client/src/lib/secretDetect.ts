/**
 * obj 719065 — "this looks like a key" detection for the card chat composer.
 *
 * Runs in the browser BEFORE a message is sent, so the owner can save a pasted
 * credential as a secret instead of sending it as chat text. The server keeps
 * its own backstop (services/chat-secret-capture.ts) for anything that slips
 * through; this one only has to be good enough to offer the choice.
 */

export interface SecretCandidate {
  /** The exact substring to replace in the message. */
  value: string
  /** A suggested UPPER_SNAKE name ('' = the owner must type one). */
  suggestedName: string
}

const SECRETISH_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PAT|AUTH|DSN|WEBHOOK|CREDENTIAL|PRIVATE)/
const ASSIGN = /\b([A-Z][A-Z0-9_]{2,63})\s*(?:=|:)\s*["'`]?([^\s"'`]{12,})/g

/** Vendor shapes → conventional store names. Order matters (sk-ant before sk-). */
const SHAPES: Array<{ re: RegExp; name: string }> = [
  { re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g, name: 'ANTHROPIC_API_KEY' },
  { re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, name: 'OPENAI_API_KEY' },
  { re: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}/g, name: 'STRIPE_SECRET_KEY' },
  { re: /\b(?:ghp|gho|ghs|ghu)_[A-Za-z0-9]{30,}/g, name: 'GITHUB_TOKEN' },
  { re: /\bgithub_pat_[A-Za-z0-9_]{40,}/g, name: 'GITHUB_TOKEN' },
  { re: /\bglpat-[A-Za-z0-9_-]{20,}/g, name: 'GITLAB_TOKEN' },
  { re: /\bxox[bpa]-[A-Za-z0-9-]{20,}/g, name: 'SLACK_BOT_TOKEN' },
  { re: /\bAIza[A-Za-z0-9_-]{30,}/g, name: 'GOOGLE_API_KEY' },
  { re: /\bAKIA[A-Z0-9]{16}\b/g, name: 'AWS_ACCESS_KEY_ID' },
  { re: /\bapify_api_[A-Za-z0-9]{20,}/g, name: 'APIFY_API_TOKEN' },
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, name: '' },
]

const BARE = /(?<![\w[/.:@-])([A-Za-z0-9][A-Za-z0-9_-]{31,})(?![\w/.@-])/g

function looksLikeToken(s: string): boolean {
  if (!/\d/.test(s) || !/[A-Za-z]/.test(s)) return false
  if (/^[0-9a-f]+$/i.test(s)) return false // git SHAs, hex ids
  if (/^cc-\d+-\d+$/.test(s)) return false // session ids
  if (/^[a-z]+(?:[-_][a-z0-9]+)+$/.test(s)) return false // slugs / branch names
  return true
}

/**
 * Find key-like strings in `text`. `pendingNames` = what the card is waiting
 * on; with exactly one, an unnamed value is suggested under that name.
 */
export function detectSecrets(text: string, pendingNames: string[] = []): SecretCandidate[] {
  if (!text) return []
  const single = pendingNames.length === 1 ? pendingNames[0] : ''
  const out: SecretCandidate[] = []
  const seen = new Set<string>()
  const add = (value: string, suggestedName: string) => {
    if (seen.has(value) || value.startsWith('[REDACTED') || value.startsWith('$')) return
    seen.add(value)
    out.push({ value, suggestedName })
  }

  for (const m of text.matchAll(ASSIGN)) {
    if (SECRETISH_NAME.test(m[1]) && /[A-Za-z0-9]/.test(m[2]) && !/^(changeme|example|placeholder|x+)$/i.test(m[2])) add(m[2], m[1])
  }
  for (const s of SHAPES) {
    for (const m of text.matchAll(s.re)) add(m[0], single || s.name)
  }
  if (out.length === 0) {
    const bare = [...text.matchAll(BARE)].map(m => m[1]).filter(looksLikeToken)
    if (bare.length === 1) add(bare[0], single)
  }
  return out
}

/** Replace every occurrence of `value` in `text` with the redaction marker. */
export function redactValue(text: string, value: string, name: string): string {
  return text.split(value).join(`[REDACTED:${name}]`)
}

export const SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/

/** Typing helper: "apify api token" → "APIFY_API_TOKEN". */
export function toSecretName(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9_]+/g, '_').replace(/^_+/, '').slice(0, 64)
}
