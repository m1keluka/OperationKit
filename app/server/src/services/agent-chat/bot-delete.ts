// ── Deleting a bot from the Bots sidebar (obj 900798) ──
//
// A bot IS its agent folder (<agents dir>/<slug>/agent.{yaml,md}). "Delete"
// takes that folder out of the agents dir so the bot leaves every person's
// list — but it MOVES the folder into <agents dir>/.deleted/<slug>-<stamp>/
// instead of erasing it. `.deleted` can never be listed as a bot (a leading dot
// fails the slug rule), and an admin can bring the bot back by moving the
// folder back. People's own chat history with the bot is not touched.
//
// What cannot be deleted this way, on purpose:
//   - a BUILT-IN bot ships inside the app (read-only); hide it instead, or
//     switch all built-ins off with AGENT_CHAT_BUILTINS=0.
//   - the DEMO bot is the demo setting; turn the demo off instead.
// The route that calls this is admin + signed-in-browser only (the same gate
// as changing a bot's model or tools).
import fs from 'fs'
import path from 'path'
import { getDb } from '../../db/index.js'
import { agentsDir, type ChatAgent } from './agent-defs.js'
import { forgetBotEverywhere } from './sidebar.js'
import { forgetBotWorkspaceAccess } from './bot-workspaces.js'

export class BotDeleteRefused extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

export interface BotDeleteResult {
  slug: string
  /** Where the agent folder went (inside the agents dir), so it can be restored by hand. */
  moved_to: string
  /** High Agency wakes switched off for the deleted bot. */
  high_agency_disabled: boolean
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
}

export function deleteBotFolder(agent: ChatAgent, opts: { env?: NodeJS.ProcessEnv; now?: Date } = {}): BotDeleteResult {
  if (agent.source === 'builtin') {
    throw new BotDeleteRefused(409, `${agent.name} ships with the app and can't be deleted. Hide it from your sidebar instead.`)
  }
  if (agent.source === 'demo') {
    throw new BotDeleteRefused(409, 'The demo bot is switched by the demo setting. Turn the demo off instead.')
  }
  const root = path.resolve(agentsDir(opts.env))
  const dir = path.resolve(root, agent.slug)
  // The slug came from a folder name that already passed the slug rule; this is
  // belt and braces so a path can never point outside the agents dir.
  if (path.dirname(dir) !== root || !path.basename(dir) || path.basename(dir).startsWith('.')) {
    throw new BotDeleteRefused(400, 'That bot id is not a folder in the agents dir.')
  }
  let real: string
  try {
    real = fs.realpathSync(dir)
  } catch {
    throw new BotDeleteRefused(404, `No agent folder for "${agent.slug}" on this server.`)
  }
  const realRoot = fs.realpathSync(root)
  if (path.dirname(real) !== realRoot) throw new BotDeleteRefused(400, 'That bot folder is outside the agents dir.')

  const trash = path.join(root, '.deleted')
  fs.mkdirSync(trash, { recursive: true })
  let target = path.join(trash, `${agent.slug}-${stamp(opts.now ?? new Date())}`)
  for (let i = 2; fs.existsSync(target); i++) target = `${target.replace(/-\d+$/, '')}-${i}`
  fs.renameSync(dir, target)

  // A deleted bot must not keep waking on a schedule. The routine row is kept
  // (switched off, never deleted) the same way the boot resync treats a bot
  // whose file was removed by hand.
  const db = getDb()
  let haDisabled = false
  try {
    const ha = db.prepare('SELECT enabled, routine_id FROM agent_chat_high_agency WHERE slug = ?').get(agent.slug) as
      | { enabled: number; routine_id: number | null }
      | undefined
    if (ha) {
      haDisabled = Number(ha.enabled) === 1
      db.prepare("UPDATE agent_chat_high_agency SET enabled = 0, updated_at = datetime('now') WHERE slug = ?").run(agent.slug)
      if (ha.routine_id != null) db.prepare('UPDATE routines SET enabled = 0 WHERE id = ?').run(ha.routine_id)
    }
  } catch (err) {
    console.warn('[agent-chat] could not switch off High Agency for a deleted bot:', err instanceof Error ? err.message : err)
  }
  forgetBotEverywhere(agent.slug)
  // Its workspace access goes too (obj 900797): restored or re-created, it starts with none.
  forgetBotWorkspaceAccess(agent.slug)
  return { slug: agent.slug, moved_to: path.relative(root, target), high_agency_disabled: haDisabled }
}
