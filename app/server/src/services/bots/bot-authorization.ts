/**
 * Who may file a bot job, and for which bot (obj 900323, gate G4).
 *
 * The MVP is deliberately ONE person, ONE domain bot, ONE workspace. Everything
 * in this module exists to make that triple EXPLICIT and VALIDATED instead of
 * inferred, because every cheap way to infer it is wrong:
 *
 *  - **Never from a key label.** `agent_api_keys.label` is the key owner's free
 *    text. Two bots can share a key and one bot can hold three; a label is a
 *    nickname, not an identity. Deriving `owner_bot` from it is guessing with
 *    extra steps, and the guess is invisible once it is written to the card.
 *  - **Never from the agent slug alone.** A chat thread tells you which agent is
 *    TALKING. It does not tell you that the person on the other side may file
 *    work in the workspace they named.
 *  - **Never a default workspace.** A card filed into the wrong workspace is a
 *    cross-client data leak the moment a worker starts and reads the KB.
 *
 * So the caller must SUPPLY owner_bot + workspace, and this module checks all
 * four of (person exists) × (person may act in that workspace) × (bot exists in
 * the registry) × (bot owns that chat agent's threads). A failure names what
 * was wrong; it is never coerced into something that works.
 */
import type { Database } from 'better-sqlite3'
import { botForAgentSlug, resolveBot, type BotDefinition } from './bot-registry.js'

export interface BotJobPrincipal {
  /** The person who asked, resolved from the thread. */
  userId: number
  username: string
  /** The validated bot that will own the card. Canonical registry id. */
  bot: BotDefinition
  /** The ONE workspace this job may touch. */
  workspace: string
  /** The chat agent whose thread this is. */
  agentSlug: string
}

export type AuthorizeResult =
  | { ok: true; principal: BotJobPrincipal }
  | { ok: false; code: AuthorizeRefusal; error: string }

export type AuthorizeRefusal =
  | 'unknown_user'
  | 'unknown_bot'
  | 'bot_agent_mismatch'
  | 'workspace_missing'
  | 'workspace_forbidden'

export interface AuthorizeInput {
  userId: number
  agentSlug: string
  /** Caller-supplied, required. Validated against the registry; never inferred. */
  ownerBot: unknown
  /** Caller-supplied, required. Validated against the person's membership. */
  workspace: unknown
}

interface UserRow {
  id: number
  username: string
  role: string | null
}

/**
 * Is this person allowed to act in this workspace?
 *
 * `user_workspaces` membership, or the `admin` role. Admin is a real ceiling,
 * not a bypass of the OTHER three checks: an admin still cannot file for a bot
 * that does not exist, or for a bot that does not own the thread.
 */
export function personMayUseWorkspace(db: Database, user: UserRow, workspace: string): boolean {
  if (user.role === 'admin') return true
  const row = db
    .prepare('SELECT 1 AS ok FROM user_workspaces WHERE user_id = ? AND workspace = ?')
    .get(user.id, workspace) as { ok: number } | undefined
  return !!row
}

export function authorizeBotJob(db: Database, input: AuthorizeInput): AuthorizeResult {
  const user = db
    .prepare('SELECT id, username, role FROM users WHERE id = ?')
    .get(input.userId) as UserRow | undefined
  if (!user) {
    return { ok: false, code: 'unknown_user', error: `No such user (${input.userId}). A bot job is always filed on behalf of a real person.` }
  }

  const resolved = resolveBot(input.ownerBot, db)
  if (!resolved.ok) return { ok: false, code: 'unknown_bot', error: resolved.error }

  // The bot must actually own this thread's agent. Otherwise "Operation Kit"
  // could file a card out of the General's conversation and the
  // completion message would land in a thread nobody asked in.
  const threadBot = botForAgentSlug(input.agentSlug, db)
  if (!threadBot || threadBot.id !== resolved.bot.id) {
    return {
      ok: false,
      code: 'bot_agent_mismatch',
      error:
        `owner_bot "${resolved.bot.id}" does not own the "${input.agentSlug}" conversation` +
        (threadBot ? ` (that thread belongs to "${threadBot.id}")` : ' (no registered bot owns that agent)') +
        '. A job must be owned by the bot the person is actually talking to.',
    }
  }

  if (typeof input.workspace !== 'string' || !input.workspace.trim()) {
    return { ok: false, code: 'workspace_missing', error: 'workspace is required and must be supplied explicitly — no default workspace is assumed.' }
  }
  const workspace = input.workspace.trim()
  if (!personMayUseWorkspace(db, user, workspace)) {
    return {
      ok: false,
      code: 'workspace_forbidden',
      error: `${user.username} is not a member of workspace "${workspace}", so no job may be filed there.`,
    }
  }

  return {
    ok: true,
    principal: { userId: user.id, username: user.username, bot: resolved.bot, workspace, agentSlug: input.agentSlug },
  }
}
