import { Button, cn } from '../ui'
import { AgentAvatar } from './ChatItems'
import type { ChatAgentInfo } from './types'

/* The "i" panel on a bot's conversation (obj 900672): what this bot is for, how
   to use it, example prompts to start from, and what it can actually reach.

   The words come from the bot's own agent file (`how_to_use`,
   `example_prompts`), so a bot an install adds gets a real panel without a
   client change. A file that has neither still gets a useful panel: a generic
   explanation plus prompts derived from the tools it lists. */

/** Plain-language names for what a bot can reach, keyed by its `tools:` entries. */
const REACH: Array<{ tools: string[]; text: (a: ChatAgentInfo) => string }> = [
  {
    tools: ['search', 'list_folders', 'read_file'],
    text: a => (a.knowledge_folders.length
      ? `Reads your knowledge base folders: ${a.knowledge_folders.join(', ')}`
      : 'Reads your knowledge base'),
  },
  { tools: ['write_doc', 'file_answer'], text: () => 'Saves notes into those folders — each save shows up in the conversation' },
  { tools: ['list_objectives', 'get_objective', 'board_briefing'], text: () => 'Reads the board cards you can see' },
  { tools: ['create_objective'], text: () => 'Files bigger jobs as board cards for the team’s coding tools' },
  { tools: ['email'], text: () => 'Reads your inbox and writes email drafts — nothing is sent until you press Send' },
  { tools: ['calendar'], text: () => 'Reads your calendar and drafts invites — nothing is added until you press Add' },
  { tools: ['mcp'], text: () => 'Uses the MCP servers connected for this workspace in Settings → Integrations' },
]

export function reachLines(a: ChatAgentInfo): string[] {
  return REACH.filter(r => r.tools.some(t => a.tools.includes(t))).map(r => r.text(a))
}

const GENERIC_HOW_TO =
  'Write to this bot the way you would message a colleague. It keeps one ongoing conversation with you, so you can pick up where you left off.\n\n' +
  '- Be specific about what you want and what "done" looks like.\n' +
  '- Use + Side thread for a separate topic; it runs alongside this conversation.\n' +
  '- Never paste a password or API key. Store it in Settings → Secrets and refer to it by name.'

type Block = { kind: 'p'; text: string } | { kind: 'ul'; items: string[] }

/** Paragraphs split on blank lines; consecutive "- " lines become one bullet list. No HTML is ever produced from the text. */
export function howToBlocks(raw: string): Block[] {
  const out: Block[] = []
  for (const chunk of raw.replace(/\r\n?/g, '\n').split(/\n\s*\n/)) {
    const lines = chunk.split('\n').map(l => l.trim()).filter(Boolean)
    let para: string[] = []
    let list: string[] = []
    const flushPara = () => { if (para.length) out.push({ kind: 'p', text: para.join(' ') }); para = [] }
    const flushList = () => { if (list.length) out.push({ kind: 'ul', items: list }); list = [] }
    for (const l of lines) {
      if (/^[-*•]\s+/.test(l)) {
        flushPara()
        list.push(l.replace(/^[-*•]\s+/, ''))
      } else {
        flushList()
        para.push(l)
      }
    }
    flushPara()
    flushList()
  }
  return out
}

export function AgentInfoPanel({
  agent,
  prompts,
  onUsePrompt,
  onClose,
  id,
}: {
  agent: ChatAgentInfo
  /** Example prompts to offer (the file's own, or ones derived from its tools). */
  prompts: string[]
  /** Puts the prompt in the message box for the person to edit and send. */
  onUsePrompt: (text: string) => void
  onClose: () => void
  id: string
}) {
  const custom = (agent.how_to_use ?? '').trim()
  const blocks = howToBlocks(custom || GENERIC_HOW_TO)
  const reach = reachLines(agent)
  return (
    <section
      id={id}
      aria-label={`About ${agent.name}`}
      className="max-h-[55vh] overflow-y-auto border-b border-line bg-surface-1 px-3 py-4 sm:px-6"
    >
      <div className="mx-auto max-w-[760px] space-y-4">
        <div className="flex items-start gap-3">
          <AgentAvatar agent={agent} />
          <div className="min-w-0 flex-1">
            <h3 className="font-display text-[15px] font-semibold text-fg-0">About {agent.name}</h3>
            {agent.description && <p className="mt-0.5 text-[13px] leading-relaxed text-fg-2">{agent.description}</p>}
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} className="min-h-[44px] sm:min-h-0">Close</Button>
        </div>

        <div>
          <h4 className="mb-1.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-fg-3">How to use</h4>
          <div className="space-y-2 text-[13.5px] leading-relaxed text-fg-1">
            {blocks.map((b, i) =>
              b.kind === 'p' ? (
                <p key={i}>{b.text}</p>
              ) : (
                <ul key={i} className="list-disc space-y-1 pl-5">
                  {b.items.map((it, j) => <li key={j}>{it}</li>)}
                </ul>
              ),
            )}
          </div>
        </div>

        {prompts.length > 0 && (
          <div>
            <h4 className="mb-1.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-fg-3">Example prompts</h4>
            <p className="mb-2 text-[12px] text-fg-2">Pick one to put it in the message box. You can edit it before you send.</p>
            <ul className="flex flex-wrap gap-2" aria-label="Example prompts">
              {prompts.map(p => (
                <li key={p}>
                  <button
                    type="button"
                    onClick={() => onUsePrompt(p)}
                    className={cn(
                      'min-h-[40px] rounded-full border border-line bg-surface-0 px-3.5 text-left text-[13px] text-fg-1 transition-all duration-fast',
                      'hover:-translate-y-px hover:border-line-strong hover:text-fg-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
                    )}
                  >
                    {p}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div>
          <h4 className="mb-1.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-fg-3">What it can reach</h4>
          {reach.length ? (
            <ul className="list-disc space-y-1 pl-5 text-[13px] text-fg-1">
              {reach.map(r => <li key={r}>{r}</li>)}
            </ul>
          ) : (
            <p className="text-[13px] text-fg-1">Only this conversation — it has no tools, so it answers from its instructions.</p>
          )}
        </div>
      </div>
    </section>
  )
}
