// ── Which model a bot's CARD runs on (obj 900796) ──
//
// A bot's chat turns already run on the bot's own model (agent file `model:`
// or the bot-page override, obj 900671). The cards a bot works on — High
// Agency wakes in particular — did not: the wake template carried no `model`,
// so `fireRoutine` filed every wake on the board default whatever the bot was
// set to, and a bot switched to Claude Fable 5.2 still woke on Opus.
//
// Rule: the bot's explicit model is carried onto its card when it is a model a
// card session can actually run — an ENABLED row in the model registry
// (Settings → Models), on any engine. Anything else (no model set, a chat-only
// id such as `gpt-5` that is not a registry row, or a model an admin switched
// off) leaves the card on the board default, exactly as before. Never
// hard-codes a model: "any allowed model" means "any enabled registry row".
import { getDb } from '../../db/index.js'
import type { ChatAgent } from './agent-defs.js'

export function cardModelForBot(agent: Pick<ChatAgent, 'model'>): string | null {
  const m = (agent.model ?? '').trim()
  if (!m) return null
  try {
    const row = getDb().prepare('SELECT id FROM models WHERE id = ? AND enabled = 1').get(m) as { id: string } | undefined
    return row?.id ?? null
  } catch {
    return null // no registry table (very old DB) → board default
  }
}
