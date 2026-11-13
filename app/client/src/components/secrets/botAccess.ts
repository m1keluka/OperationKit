/**
 * Bot access — which destination hosts a secret may be SENT to by a bot
 * through the secrets broker (obj 900749). Names and hosts only: nothing here
 * ever carries, fetches or displays a secret value.
 *
 * Default-deny: a secret with no entry cannot be used by any bot. An entry is
 * the broker policy for that NAME (every scope of that name shares it), stored
 * in the server's `secrets_broker_policy` setting — never on the secret row.
 */
import { api } from '../../lib/api'

export interface BotAccessEntry {
  hosts: string[]
  methods?: string[]
  /** Global secrets only: organizations whose bots may use it (empty = none). */
  workspaces?: string[]
  description?: string
}

export interface BotAccessState {
  /** Where the policy lives: `settings` (editable here), `env` (install file), `none` (nothing set yet). */
  source: 'settings' | 'env' | 'none'
  policy: Record<string, BotAccessEntry>
  /** Seat + server-only names: bots can never use these. */
  blockedKeys: Set<string>
}

export const BOT_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] as const

/** Admin-only. Tolerates an unexpected shape (e.g. an old server) as "nothing set". */
export async function loadBotAccess(): Promise<BotAccessState> {
  const raw = await api.get<unknown>('/secrets/bot-access')
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const policy = r.policy && typeof r.policy === 'object' && !Array.isArray(r.policy) ? (r.policy as Record<string, BotAccessEntry>) : {}
  const source = r.source === 'settings' || r.source === 'env' ? r.source : 'none'
  const blocked = Array.isArray(r.blocked_keys) ? (r.blocked_keys as unknown[]).filter((k): k is string => typeof k === 'string') : []
  return { source, policy, blockedKeys: new Set(blocked) }
}

export function saveBotAccess(name: string, entry: BotAccessEntry): Promise<{ name: string; entry: BotAccessEntry | null }> {
  return api.put(`/secrets/bot-access/${encodeURIComponent(name)}`, entry)
}

export function clearBotAccess(name: string): Promise<{ name: string; entry: null }> {
  return api.del(`/secrets/bot-access/${encodeURIComponent(name)}`)
}

export type BotAccessStatus =
  | { kind: 'never' }
  | { kind: 'off' }
  | { kind: 'on'; label: string; title: string }

/** One-glance status for a row. */
export function botAccessStatus(key: string, state: BotAccessState | null): BotAccessStatus | null {
  if (!state) return null
  if (state.blockedKeys.has(key)) return { kind: 'never' }
  const e = state.policy[key]
  if (!e || !Array.isArray(e.hosts) || e.hosts.length === 0) return { kind: 'off' }
  const first = e.hosts[0]!
  const more = e.hosts.length > 1 ? ` +${e.hosts.length - 1}` : ''
  const methods = e.methods && e.methods.length ? ` (${e.methods.join(', ')})` : ''
  return { kind: 'on', label: `${first}${more}`, title: `Bots may send this to ${e.hosts.join(', ')}${methods}` }
}
