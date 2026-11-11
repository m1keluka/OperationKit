/**
 * sandbox-claude-auth — how a jailed session (SESSION_ISOLATION=docker) signs in
 * to Claude (obj 719935).
 *
 * The jail mounts only the session's worktree and a fresh per-session HOME, so
 * the OAuth credential files in the account slots (`<slot>/.claude/.credentials.json`)
 * never reach it — a jailed `claude` used to start with no credentials at all.
 * Copying a slot's refresh-token file into every jail is not safe either: refresh
 * tokens rotate, so the first jail to refresh would silently log the slot out.
 *
 * Instead a client install hands the server ONE long-lived credential, and every
 * jail receives it as an env var:
 *   SESSION_JAIL_CLAUDE_OAUTH_TOKEN  → CLAUDE_CODE_OAUTH_TOKEN (a `claude setup-token`
 *                                      token: Claude subscription, no refresh)
 *   SESSION_JAIL_ANTHROPIC_API_KEY   → ANTHROPIC_API_KEY (pay-per-use API billing)
 * The OAuth token wins when both are set. Both are ignored unless the jail is on,
 * so the tmux path (and its "never bill the API" unset) is untouched.
 *
 * The router exposes this credential as one extra account slot, `sandbox`, so the
 * existing pick / rate-limit / park bookkeeping applies to it unchanged.
 */
import { jailEnabled } from './session-jail.js'

export const SANDBOX_ACCOUNT_ID = 'sandbox'

export function sandboxClaudeAuthEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (!jailEnabled(env)) return {}
  const token = (env.SESSION_JAIL_CLAUDE_OAUTH_TOKEN || '').trim()
  if (token) return { CLAUDE_CODE_OAUTH_TOKEN: token }
  const apiKey = (env.SESSION_JAIL_ANTHROPIC_API_KEY || '').trim()
  if (apiKey) return { ANTHROPIC_API_KEY: apiKey }
  return {}
}

export function sandboxAuthConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Object.keys(sandboxClaudeAuthEnv(env)).length > 0
}
