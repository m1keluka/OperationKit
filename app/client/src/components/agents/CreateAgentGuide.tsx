import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../../lib/api'
import { CopyButton, cn } from '../ui'
import { agentsTabRoute } from '../../lib/routes'

/**
 * "Make a new bot, agent or skill" (obj 900672). Before this, the Agents page
 * had no create path at all — only a copy-paste prompt — and three different
 * things were all called "agent". This panel names the three nouns in one line
 * each and gives three ways in, easiest first:
 *
 *   1. Ask the Dev bot (the built-in `operation-kit-dev` chat bot) — a deep link that
 *      opens its conversation with the request already typed, never sent.
 *   2. Start from a template (the Templates tab).
 *   3. Paste or import a file (the Templates tab, paste box open).
 *
 * The Dev bot is a built-in an install can switch off (AGENT_CHAT_BUILTINS=0),
 * so path 1 is existence-gated on the live bot list. Without it, the panel
 * offers the copy-paste prompt for an outside assistant instead.
 */

export const DEV_BOT_SLUG = 'operation-kit-dev'

export const CREATE_PROMPTS = {
  bot: 'Help me create a new bot I can chat with. Ask me what it is for, then write the agent file for me.',
  agent: 'Help me create a new worker agent that picks up board cards. Ask me what role it plays, then write the file and tell me how to add it.',
  skill: 'Help me create a new skill for a task we repeat. Ask me what the task is, then write the SKILL.md and tell me how to add it.',
} as const

export const SETUP_PROMPT =
  `Configure a new agent, skill, and (if it needs non-default scoping) an assignment on this platform, for me:\n\n` +
  `- Agent: who does the work — a named profile with a model, effort level, and default workspace.\n` +
  `- Skill: how-to instructions an agent follows for a kind of task.\n` +
  `- Tool: an integration an agent can reach (see Settings → Integrations) — connect it there, then reference ` +
  `it from the skill/agent.\n` +
  `- Assignment (only if needed): scopes an agent or skill to one organization, project, or user instead of ` +
  `applying globally.\n\n` +
  `Ask me what the agent/skill is for, then use the platform API (docs/api/README.md, GET /api/openapi.json) ` +
  `to set it up rather than describing steps for me to click through.`

export function devBotLink(kind: keyof typeof CREATE_PROMPTS): string {
  return `/chat/${DEV_BOT_SLUG}?prompt=${encodeURIComponent(CREATE_PROMPTS[kind])}`
}

const NOUNS: Array<{ term: string; text: string }> = [
  { term: 'Bot', text: 'someone you chat with on the Bots page.' },
  { term: 'Agent', text: 'a worker that picks up board cards and does the work.' },
  { term: 'Skill', text: 'how-to steps an agent follows for one recurring task.' },
]

const tile = 'flex flex-col gap-2 rounded-lg border border-line bg-surface-1 p-4'
const linkBtn = cn(
  'inline-flex min-h-[40px] items-center rounded-md border border-line bg-surface-0 px-3 text-[13px] font-medium text-fg-1',
  'transition-colors duration-fast hover:border-line-strong hover:text-fg-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
)

export function CreateAgentGuide() {
  // null = still checking; the Dev bot tile waits rather than flashing the fallback.
  const [hasDevBot, setHasDevBot] = useState<boolean | null>(null)
  // Its name comes from the live bot list, never a literal: an install can
  // rename it (a same-slug agent file), and the client stays white-label.
  const [devBotName, setDevBotName] = useState('the Dev bot')

  useEffect(() => {
    let live = true
    api
      .get<{ agents?: Array<{ slug: string; name?: string }> }>('/agent-chat/agents')
      .then(r => {
        if (!live) return
        const dev = r?.agents?.find(a => a.slug === DEV_BOT_SLUG)
        setHasDevBot(!!dev)
        if (dev?.name) setDevBotName(dev.name)
      })
      .catch(() => { if (live) setHasDevBot(false) })
    return () => { live = false }
  }, [])

  return (
    <section aria-labelledby="create-agent-guide" className="mb-6 rounded-xl border border-line bg-surface-0 p-4 sm:p-5">
      <h2 id="create-agent-guide" className="font-display text-[16px] font-semibold text-fg-0">Make a new bot, agent or skill</h2>
      <ul className="mt-2 space-y-0.5 text-[13px] leading-relaxed text-fg-2">
        {NOUNS.map(n => (
          <li key={n.term}><span className="font-medium text-fg-0">{n.term}</span> — {n.text}</li>
        ))}
      </ul>

      <ol className="mt-4 grid gap-3 md:grid-cols-3">
        <li className={tile}>
          <p className="text-[12px] font-semibold uppercase tracking-[0.06em] text-fg-3">1 · Easiest</p>
          {hasDevBot === false ? (
            <>
              <h3 className="text-[14px] font-semibold text-fg-0">Ask an assistant</h3>
              <p className="text-[12.5px] leading-relaxed text-fg-2">
                Copy this prompt into your coding assistant. It asks what you need and sets it up through the platform API.
              </p>
              <div><CopyButton value={SETUP_PROMPT} label="Copy setup prompt" /></div>
            </>
          ) : (
            <>
              <h3 className="text-[14px] font-semibold text-fg-0">Ask {devBotName}</h3>
              <p className="text-[12.5px] leading-relaxed text-fg-2">
                It asks a few questions, writes the file for you, and tells you exactly where it goes.
              </p>
              <div className="flex flex-wrap gap-2" aria-busy={hasDevBot === null}>
                <Link to={devBotLink('bot')} className={linkBtn}>Create a bot</Link>
                <Link to={devBotLink('agent')} className={linkBtn}>Create an agent</Link>
                <Link to={devBotLink('skill')} className={linkBtn}>Create a skill</Link>
              </div>
            </>
          )}
        </li>
        <li className={tile}>
          <p className="text-[12px] font-semibold uppercase tracking-[0.06em] text-fg-3">2 · Start from a template</p>
          <h3 className="text-[14px] font-semibold text-fg-0">Add a starter bot</h3>
          <p className="text-[12.5px] leading-relaxed text-fg-2">Pick a ready-made bot, add it, then change its instructions to fit.</p>
          <div><Link to={agentsTabRoute('templates')} className={linkBtn}>Browse templates</Link></div>
        </li>
        <li className={tile}>
          <p className="text-[12px] font-semibold uppercase tracking-[0.06em] text-fg-3">3 · Already have the file</p>
          <h3 className="text-[14px] font-semibold text-fg-0">Paste or import it</h3>
          <p className="text-[12.5px] leading-relaxed text-fg-2">Paste a bot file {devBotName} wrote, or upload one someone sent you. It is checked before it is added.</p>
          <div><Link to={`${agentsTabRoute('templates')}&paste=1`} className={linkBtn}>Paste a bot file</Link></div>
        </li>
      </ol>
      {hasDevBot && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[12px] text-fg-3">
          <span>Using an outside assistant instead? Copy the setup prompt.</span>
          <CopyButton value={SETUP_PROMPT} label="Copy setup prompt" />
        </div>
      )}
    </section>
  )
}
