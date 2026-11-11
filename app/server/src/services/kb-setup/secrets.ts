/**
 * Secret scrubbing for Knowledge Base Setup (obj 900556).
 *
 * People's old folders are full of credentials: a `.env` pasted into meeting
 * notes, an API key in a setup doc, a database URL in a runbook, a password
 * column in a client spreadsheet. The knowledge base is read by every agent on
 * the install and is often synced to git, so a secret that reaches it has
 * leaked. Rule: a value that looks like a credential is replaced with
 * `[REDACTED:<kind>]` BEFORE the text is sent to the AI and BEFORE anything is
 * written to the knowledge base, and the file is flagged so the person can
 * rotate it. The finding records the kind and the line — never the value.
 *
 * Pure functions; the patterns are deliberately conservative on prose (a word
 * "password" alone is not a secret) and aggressive on shapes no prose has.
 */

export interface SecretFinding {
  kind: string
  /** 1-based line in the scanned text. */
  line: number
}

export interface RedactResult {
  text: string
  findings: SecretFinding[]
}

interface Rule {
  kind: string
  re: RegExp
  /** Capture group holding the secret itself (default: the whole match). */
  group?: number
}

/** Ordered: specific vendor shapes first, then generic assignments. */
const RULES: Rule[] = [
  { kind: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g },
  { kind: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: 'openai-key', re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/g },
  { kind: 'stripe-key', re: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { kind: 'github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g },
  { kind: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { kind: 'slack-webhook', re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]{20,}/g },
  { kind: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'sendgrid-key', re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g },
  { kind: 'twilio-key', re: /\bSK[0-9a-fA-F]{32}\b/g },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  // scheme://user:password@host — keep the scheme, user and host readable.
  { kind: 'url-password', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:([^\s@/]{3,})@/gi, group: 1 },
  // KEY=value / "api_key": "value" / Password: value — the NAME says secret, the value is non-trivial.
  {
    kind: 'credential',
    re: /\b(?:[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CLIENT_?SECRET)[A-Z0-9_]*|api[ _-]?key|secret[ _-]?key|access[ _-]?token|auth[ _-]?token|client[ _-]?secret|password|passwd|pwd)\b["']?\s*[:=]\s*["']?([^\s"',;]{6,})/gi,
    group: 1,
  },
]

/** Values that sit in a credential slot but are obviously not secrets. */
const PLACEHOLDER = /^(?:\*+|x+|\.+|<[^>]*>|\$\{?[A-Z_]+\}?|\{\{[^}]*\}\}|changeme|change-me|password|example|your[-_a-z]*|redacted|\[REDACTED[^\]]*\]|none|null|true|false|n\/a|tbd|required|optional)$/i

function lineAt(text: string, index: number): number {
  let n = 1
  for (let i = text.indexOf('\n'); i !== -1 && i < index; i = text.indexOf('\n', i + 1)) n++
  return n
}

/**
 * Replace every credential-shaped value in `text` with `[REDACTED:<kind>]`.
 * Idempotent: redacted text scans clean.
 */
export function redactSecrets(text: string): RedactResult {
  const findings: SecretFinding[] = []
  let out = text
  for (const rule of RULES) {
    out = out.replace(rule.re, (match: string, ...rest: unknown[]) => {
      const groups = rest.slice(0, -2) as Array<string | undefined>
      const offset = rest[rest.length - 2] as number
      const secret = rule.group ? groups[rule.group - 1] : match
      if (!secret || PLACEHOLDER.test(secret) || /^\[REDACTED/.test(secret)) return match
      // Prose guard for the generic rule: "password: see the vault" has a space-free value
      // only when it is a real token-like string — require a digit or symbol mix.
      if (rule.kind === 'credential' && !/[0-9]/.test(secret) && !/[^A-Za-z]/.test(secret)) return match
      findings.push({ kind: rule.kind, line: lineAt(out, offset) })
      const at = match.lastIndexOf(secret)
      return `${match.slice(0, at)}[REDACTED:${rule.kind}]${match.slice(at + secret.length)}`
    })
  }
  findings.sort((a, b) => a.line - b.line || a.kind.localeCompare(b.kind))
  return { text: out, findings }
}

/** "2 secrets (openai-key on line 4, credential on line 9)" — for summaries and the log. */
export function describeFindings(findings: SecretFinding[]): string {
  if (!findings.length) return 'no secrets'
  const shown = findings.slice(0, 5).map(f => `${f.kind} on line ${f.line}`).join(', ')
  const more = findings.length > 5 ? `, and ${findings.length - 5} more` : ''
  return `${findings.length} secret${findings.length === 1 ? '' : 's'} (${shown}${more})`
}
