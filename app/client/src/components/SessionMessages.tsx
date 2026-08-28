import { useEffect, useRef, useState } from 'react'
import type { SessionMessage } from '@command-center/shared'
import { renderMarkdown } from '../lib/markdown'
import { cleanupOrphanMermaid, renderMermaidIn } from '../lib/mermaid'
import { ObjectiveProposalCard } from './mentor/ObjectiveProposalCard'

// ── Objective-proposal block splitter ──

type MsgSegment =
  | { type: 'text'; content: string }
  | { type: 'proposal'; content: string }

function splitObjectiveProposals(text: string): MsgSegment[] {
  const regex = /```objective-proposal\n?([\s\S]*?)```/g
  const segments: MsgSegment[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', content: text.slice(lastIndex, match.index) })
    }
    segments.push({ type: 'proposal', content: match[1].trim() })
    lastIndex = match.index + match[0].length
  }

  if (lastIndex < text.length) {
    segments.push({ type: 'text', content: text.slice(lastIndex) })
  }

  return segments.length > 0 ? segments : [{ type: 'text', content: text }]
}

// ── Reusable CollapsibleDetails ──

interface CollapsibleDetailsProps {
  label: React.ReactNode
  icon?: string
  colorScheme: 'emerald' | 'blue' | 'purple' | 'gray'
  previewLines?: number
  children: string
  defaultExpanded?: boolean
  /** Optional status dot override (tool cards pass pending/success/error). When
   *  omitted, the colorScheme's static dot renders — preserving the existing
   *  System/Thinking/Jarvis/PlanningPanel appearance exactly. */
  statusDot?: React.ReactNode
  /** Optional trailing meta (cost/duration) rendered before the chevron. */
  meta?: React.ReactNode
}

// Mission Control output-block schemes. Every block is the same crisp,
// hairline-bordered surface-2 card; the scheme only colors the status dot +
// header label so role/type stays legible without competing tints. Machine
// output bodies all sit on surface-1 in Geist Mono (see `.cc-block-body`).
const schemeClasses = {
  emerald: { dot: 'bg-status-done', text: 'text-fg-1' },     // tool calls — quiet, green dot
  blue: { dot: 'bg-status-working', text: 'text-status-working' }, // system
  purple: { dot: 'bg-status-planning', text: 'text-status-planning' }, // thinking
  gray: { dot: 'bg-fg-3', text: 'text-fg-2' },
}

const BLOCK = 'overflow-hidden rounded-md border border-line bg-surface-2'
const BLOCK_HEADER = 'flex w-full items-center gap-2 px-3 py-2 text-left text-[12px]'
const BLOCK_BODY =
  'border-t border-line-soft bg-surface-1 px-3 py-2.5 text-[12px] leading-relaxed text-fg-2 font-mono overflow-x-auto whitespace-pre-wrap break-words max-h-80 overflow-y-auto'

export function CollapsibleDetails({ label, icon, colorScheme, previewLines = 5, children, defaultExpanded = false, statusDot, meta }: CollapsibleDetailsProps) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const scheme = schemeClasses[colorScheme]
  const lines = children.split('\n')
  const hasMore = lines.length > previewLines
  const preview = lines.slice(0, previewLines).join('\n')

  return (
    <div className={`${BLOCK} transition-colors duration-fast ease-out hover:border-line-soft`}>
      <button
        onClick={() => setExpanded(!expanded)}
        className={`${BLOCK_HEADER} transition-colors duration-fast ease-out hover:bg-surface-3`}
      >
        {statusDot ?? <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${scheme.dot}`} />}
        {icon && <span className="shrink-0 text-[11px] opacity-80">{icon}</span>}
        <span className={`truncate font-mono font-medium ${scheme.text}`}>{label}</span>
        {meta}
        <span className={`${meta ? '' : 'ml-auto'} shrink-0 text-[10px] text-fg-3 transition-transform ${expanded ? 'rotate-90' : ''}`}>{'▸'}</span>
      </button>
      {(expanded || hasMore) && (
        <pre className={BLOCK_BODY}>
          {expanded ? children : preview}
          {!expanded && hasMore && (
            <button onClick={() => setExpanded(true)} className="mt-1 block text-[10px] text-accent hover:underline">
              +{lines.length - previewLines} more lines
            </button>
          )}
        </pre>
      )}
    </div>
  )
}

// ── Shared anchor cards (result / error) ──
// Extracted so the collapsed ThreadTimeline view renders summaries and errors
// with byte-identical markup/styling to the inline GroupedMessages view.

/** GREEN "result" summary card — markdown body + cost/duration footer. */
export function ResultCard({ text, cost, duration }: { text?: string; cost?: number; duration?: number }) {
  return (
    <div className="my-2 overflow-hidden rounded-md border border-status-done/25 bg-status-done/[0.06]">
      <div className="flex items-center gap-2 border-b border-status-done/15 px-4 py-1.5">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-status-done" />
        <span className="font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-status-done">Result</span>
      </div>
      <div className="px-4 py-3">
        {text && (
          <div className="cc-prose break-words" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
        )}
        {(cost != null || duration != null) && (
          <div className="mt-2 flex gap-4 font-mono text-[11px] text-fg-3">
            {cost != null && <span>${cost.toFixed(4)}</span>}
            {duration != null && <span>{(duration / 1000).toFixed(1)}s</span>}
          </div>
        )}
      </div>
    </div>
  )
}

/** Error/warning card — visible, red-tinted. */
export function ErrorCard({ text }: { text?: string }) {
  return (
    <div className="my-2 overflow-hidden rounded-md border border-flag-blocked/40 bg-flag-blocked/10">
      <div className="flex items-center gap-2 border-b border-flag-blocked/20 px-4 py-1.5">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-flag-blocked" />
        <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-flag-blocked">Error</span>
      </div>
      <div className="cc-prose break-words px-4 py-3" dangerouslySetInnerHTML={{ __html: renderMarkdown(text || '') }} />
    </div>
  )
}

// ── Tool status (dot + meta) ──
// Additive polish for tool-call cards (obj: objective-thread-streaming-polish).
// Purely derived from fields already on SessionMessage — no prop/signature
// changes — so the shared Jarvis (mentor/MessageList) + PlanningPanel usages
// keep rendering exactly as before, just with a status dot + optional
// cost/duration meta when those fields happen to be present.

type ToolStatus = 'pending' | 'success' | 'error'

// A tool result that reads like a failure. Deliberately conservative: only the
// common Claude Code error prefixes, so a benign result containing the word
// "error" isn't miscolored red.
function isErrorResult(result: string): boolean {
  const r = result.trimStart()
  return (
    r.startsWith('Error:') ||
    r.startsWith('<tool_use_error>') ||
    r.startsWith('Error ') ||
    /^(command failed|exit code [1-9])/i.test(r)
  )
}

function toolStatus(msg: SessionMessage): ToolStatus {
  const result = msg.toolResult || ''
  if (!result) return 'pending' // no result yet → still running
  return isErrorResult(result) ? 'error' : 'success'
}

const TOOL_DOT: Record<ToolStatus, string> = {
  pending: 'bg-fg-3',        // grey — awaiting result
  success: 'bg-status-done', // green — completed
  error:   'bg-flag-blocked',// red — failed
}

/** Status dot for a tool card. `pending` gets a subtle pulse; settled dots are
 *  static. Falls back to a plain green dot semantics identical to the old
 *  hardcoded `bg-status-done` when a result is present and clean. */
function ToolStatusDot({ status }: { status: ToolStatus }) {
  return (
    <span
      className={`h-1.5 w-1.5 shrink-0 rounded-full ${TOOL_DOT[status]} ${status === 'pending' ? 'cc-pulse-amber' : ''}`}
    />
  )
}

/** Inline cost/duration meta shown on a tool card header when present. */
function ToolMeta({ cost, duration }: { cost?: number; duration?: number }) {
  if (cost == null && duration == null) return null
  return (
    <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-[10px] text-fg-3">
      {duration != null && <span>{(duration / 1000).toFixed(1)}s</span>}
      {cost != null && <span>${cost.toFixed(4)}</span>}
    </span>
  )
}

// ── Tool-specific summaries ──

function isEditableDocPath(p: string): boolean {
  return /^\/home\/mike\/.+\.md$/.test(p)
}

function getToolSummary(msg: SessionMessage): { label: string; icon: string; filePath?: string } {
  const name = msg.toolName || 'Tool'
  const input = msg.toolInput || ''
  const result = msg.toolResult || ''

  switch (name) {
    case 'Bash': {
      const cmd = input.length > 80 ? input.slice(0, 80) + '...' : input
      return { label: `Bash: ${cmd}`, icon: '⚙️' }
    }
    case 'Read': {
      const p = input.match(/[\w/.-]+\.\w+/)?.[0] || input.slice(0, 60)
      return { label: `Read: ${p}`, icon: '📄', filePath: p }
    }
    case 'Write': {
      const p = input.match(/[\w/.-]+\.\w+/)?.[0] || input.slice(0, 60)
      return { label: `Write: ${p}`, icon: '✏️', filePath: p }
    }
    case 'Edit': {
      const p = input.match(/[\w/.-]+\.\w+/)?.[0] || 'file'
      const added = (result.match(/\n\+/g) || []).length
      const removed = (result.match(/\n-/g) || []).length
      const diffSummary = (added || removed) ? ` (+${added}/-${removed})` : ''
      return { label: `Edit: ${p}${diffSummary}`, icon: '✏️', filePath: p }
    }
    case 'Grep': {
      const pattern = input.match(/"([^"]+)"/)?.[1] || input.slice(0, 40)
      const resultLines = result.trim().split('\n').filter(Boolean)
      return { label: `Grep: "${pattern}" (${resultLines.length} results)`, icon: '🔍' }
    }
    case 'Glob': {
      const pattern = input.match(/"([^"]+)"/)?.[1] || input.slice(0, 40)
      const resultLines = result.trim().split('\n').filter(Boolean)
      return { label: `Glob: ${pattern} (${resultLines.length} files)`, icon: '🔍' }
    }
    default:
      return { label: name, icon: '🔧' }
  }
}

// ── Tinted diff body (Edit tool results) ──
// Splits diff-style text into per-line rows so add/del lines pick up
// cc-diff-add / cc-diff-del tinting from index.css. Used by the Edit-tool
// branch of ToolCallMessage; rendered inside EditDiffCollapsible.

function DiffBody({ text }: { text: string }) {
  const lines = text.split('\n')
  return (
    <div className="border-t border-line-soft bg-surface-1 px-3 py-2 text-[12px] text-fg-3 overflow-x-auto max-h-80 overflow-y-auto font-mono">
      {lines.map((line, i) => {
        // Ignore lines that are part of unified-diff headers (+++/---) so they
        // don't get tinted twice by accident.
        const isHeader = line.startsWith('+++') || line.startsWith('---')
        let cls = ''
        if (!isHeader && line.startsWith('+')) cls = 'cc-diff-add'
        else if (!isHeader && line.startsWith('-')) cls = 'cc-diff-del'
        return (
          <div key={i} className={`whitespace-pre-wrap break-words ${cls}`}>
            {line || ' '}
          </div>
        )
      })}
    </div>
  )
}

function EditDiffCollapsible({ label, icon, text, statusDot, meta }: { label: React.ReactNode; icon?: string; text: string; statusDot?: React.ReactNode; meta?: React.ReactNode }) {
  const [expanded, setExpanded] = useState(false)
  const lines = text.split('\n')
  const previewLines = 5
  const hasMore = lines.length > previewLines
  const previewText = lines.slice(0, previewLines).join('\n')

  return (
    <div className={`${BLOCK} transition-colors duration-fast ease-out hover:border-line-soft`}>
      <button
        onClick={() => setExpanded(!expanded)}
        className={`${BLOCK_HEADER} transition-colors duration-fast ease-out hover:bg-surface-3`}
      >
        {statusDot ?? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-status-done" />}
        {icon && <span className="shrink-0 text-[11px] opacity-80">{icon}</span>}
        <span className="truncate font-mono font-medium text-fg-1">{label}</span>
        {meta}
        {hasMore && !expanded && <span className={`${meta ? '' : 'ml-auto'} shrink-0 font-mono text-[10px] text-fg-3`}>+{lines.length - previewLines}</span>}
        <span className={`${(hasMore && !expanded) || meta ? '' : 'ml-auto'} shrink-0 text-[10px] text-fg-3 transition-transform ${expanded ? 'rotate-90' : ''}`}>{'▸'}</span>
      </button>
      {expanded ? (
        <DiffBody text={text} />
      ) : (
        hasMore && <DiffBody text={previewText} />
      )}
    </div>
  )
}

// ── Tool Call Message ──

function ToolCallMessage({ msg }: { msg: SessionMessage }) {
  const { label, icon, filePath } = getToolSummary(msg)
  const result = msg.toolResult || ''
  const truncated = result.length > 10000 ? result.slice(0, 10000) + '\n... (truncated)' : result
  const status = toolStatus(msg)
  const dot = <ToolStatusDot status={status} />
  const meta = <ToolMeta cost={msg.cost} duration={msg.duration} />

  // Build a label with a clickable doc-path link when applicable
  const toolName = msg.toolName || 'Tool'
  const renderedLabel = filePath && isEditableDocPath(filePath) ? (
    <span>
      {toolName}:{' '}
      <a data-doc-path={filePath} className="text-accent hover:underline cursor-pointer" title="Click to edit">
        {label.slice(toolName.length + 2)}
      </a>
    </span>
  ) : label

  // Edit tool: render the body as tinted diff rows. Plain Write/Read/etc.
  // still flow through the standard CollapsibleDetails.
  if (toolName === 'Edit' && result) {
    return (
      <div className="my-1">
        <EditDiffCollapsible label={renderedLabel} icon={icon} text={truncated} statusDot={dot} meta={meta} />
      </div>
    )
  }

  return (
    <div className="my-1">
      {result ? (
        <CollapsibleDetails label={renderedLabel} icon={icon} colorScheme="emerald" statusDot={dot} meta={meta}>
          {truncated}
        </CollapsibleDetails>
      ) : (
        <div className={`${BLOCK} flex items-center gap-2 px-3 py-2 text-[12px] transition-colors duration-fast ease-out hover:border-line-soft`}>
          {dot}
          {icon && <span className="shrink-0 text-[11px] opacity-80">{icon}</span>}
          <span className="truncate font-mono font-medium text-fg-1">{renderedLabel}</span>
          {meta}
        </div>
      )}
    </div>
  )
}

// ── ToolGroup ──

function ToolGroup({ tools }: { tools: SessionMessage[] }) {
  const [expanded, setExpanded] = useState(false)

  if (tools.length <= 2) {
    return <>{tools.map((t, i) => <ToolCallMessage key={i} msg={t} />)}</>
  }

  const counts: Record<string, number> = {}
  for (const t of tools) {
    counts[t.toolName || 'unknown'] = (counts[t.toolName || 'unknown'] || 0) + 1
  }
  const summary = Object.entries(counts).map(([name, count]) => `${name} x${count}`).join(', ')

  // Example3-style status pills — derived with the SAME toolStatus() deriver the
  // individual tool cards use (obj #239), so a card's dot and the group pill agree.
  const errorCount = tools.filter(t => toolStatus(t) === 'error').length
  const pendingCount = tools.filter(t => toolStatus(t) === 'pending').length

  return (
    <div className="my-1">
      <button
        onClick={() => setExpanded(!expanded)}
        className={`${BLOCK} ${BLOCK_HEADER} transition-colors duration-fast ease-out hover:bg-surface-3`}
      >
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-status-done" />
        <span className="shrink-0 font-mono font-medium text-fg-1">{tools.length} tool calls</span>
        {errorCount > 0 && (
          <span className="shrink-0 rounded-full border border-flag-blocked/40 bg-flag-blocked/10 px-1.5 py-0.5 font-mono text-[11px] font-medium text-flag-blocked">
            {errorCount} error{errorCount === 1 ? '' : 's'}
          </span>
        )}
        {pendingCount > 0 && (
          <span
            className="shrink-0 rounded-full border px-1.5 py-0.5 font-mono text-[11px] font-medium"
            style={{ color: 'var(--ok-amber)', borderColor: 'color-mix(in srgb, var(--ok-amber) 40%, transparent)', background: 'color-mix(in srgb, var(--ok-amber) 10%, transparent)' }}
          >
            {pendingCount} pending
          </span>
        )}
        <span className="truncate font-mono text-fg-3">{summary}</span>
        <span className={`ml-auto shrink-0 text-[10px] text-fg-3 transition-transform ${expanded ? 'rotate-90' : ''}`}>{'▸'}</span>
      </button>
      {expanded && (
        <div className="ml-2 mt-1 space-y-1 border-l border-line pl-3">
          {tools.map((t, i) => <ToolCallMessage key={i} msg={t} />)}
        </div>
      )}
    </div>
  )
}

// ── GroupedMessages ──

interface GroupedMessagesProps {
  messages: SessionMessage[]
  /** Cap initial render at this many groups; user can expand to load more. */
  initialCap?: number
}

/** Group consecutive tool calls into collapsible sections to prevent DOM overload */
export function GroupedMessages({ messages, initialCap = 100 }: GroupedMessagesProps) {
  const [showAll, setShowAll] = useState(false)
  const groups: Array<
    | { type: 'tool-group'; tools: SessionMessage[]; key: number }
    | { type: 'single'; msg: SessionMessage; key: number }
  > = []

  let currentToolGroup: SessionMessage[] = []
  let keyCounter = 0

  for (const msg of messages) {
    if (msg.type === 'user') continue
    if (msg.type === 'system' && (msg.text === 'task_progress' || msg.text?.includes('task_progress') || msg.text === 'task_notification' || msg.text?.includes('task_notification'))) continue

    if (msg.type === 'tool') {
      currentToolGroup.push(msg)
    } else {
      if (currentToolGroup.length > 0) {
        groups.push({ type: 'tool-group', tools: [...currentToolGroup], key: keyCounter++ })
        currentToolGroup = []
      }
      // Skip assistant message if the next non-skippable message is a result with the same content
      if (msg.type === 'assistant' && msg.text) {
        const remaining = messages.slice(messages.indexOf(msg) + 1)
        const nextResult = remaining.find(m => m.type === 'result')
        if (nextResult?.text && msg.text.trim() === nextResult.text.trim()) continue
      }
      groups.push({ type: 'single', msg, key: keyCounter++ })
    }
  }
  if (currentToolGroup.length > 0) {
    groups.push({ type: 'tool-group', tools: currentToolGroup, key: keyCounter++ })
  }

  const visibleGroups = showAll ? groups : groups.slice(-initialCap)
  const hiddenCount = groups.length - visibleGroups.length

  const containerRef = useRef<HTMLDivElement>(null)
  // Mermaid blocks emit a placeholder div (see lib/markdown.ts); swap each for
  // an SVG after every render. renderMermaidIn is idempotent — already-rendered
  // placeholders are skipped. On unmount, sweep any orphan error SVGs that
  // mermaid leaked into document.body so they don't bleed into other pages.
  useEffect(() => {
    renderMermaidIn(containerRef.current)
    return () => cleanupOrphanMermaid()
  })

  return (
    <div ref={containerRef} style={{ display: 'contents' }}>
      {hiddenCount > 0 && (
        <button
          onClick={() => setShowAll(true)}
          className="w-full rounded-md border border-line bg-surface-2 px-3 py-2 text-[12px] text-fg-2 transition-colors duration-fast ease-out hover:bg-surface-3 hover:text-fg-0"
        >
          Load {hiddenCount} earlier messages
        </button>
      )}
      {visibleGroups.map(group => {
        if (group.type === 'tool-group') {
          return <ToolGroup key={group.key} tools={group.tools} />
        }
        const msg = group.msg

        if (msg.type === 'system') {
          const text = msg.text || ''
          if (text.length > 80) {
            return (
              <div key={group.key} className="my-1">
                <CollapsibleDetails label="System" icon="ℹ️" colorScheme="blue">
                  {text}
                </CollapsibleDetails>
              </div>
            )
          }
          return (
            <div key={group.key} className="text-center my-1">
              <span className="inline-block rounded-full border border-line bg-surface-2 px-3 py-1 font-mono text-[11px] text-fg-2">{text}</span>
            </div>
          )
        }

        if (msg.type === 'assistant') {
          const text = msg.text || ''
          const isThinking = text.startsWith('<thinking>') || text.startsWith('<planning>')
          if (isThinking) {
            const cleanText = text.replace(/<\/?(?:thinking|planning)>/g, '').trim()
            return (
              <div key={group.key} className="my-1">
                <CollapsibleDetails label="Thinking" icon="🧠" colorScheme="purple">
                  {cleanText}
                </CollapsibleDetails>
              </div>
            )
          }

          const segments = splitObjectiveProposals(text)
          const hasProposal = segments.some(s => s.type === 'proposal')
          if (hasProposal) {
            return (
              <div key={group.key} className="flex flex-col gap-1 my-1 items-start">
                {segments.map((seg, i) => {
                  if (seg.type === 'proposal') {
                    return <ObjectiveProposalCard key={i} raw={seg.content} />
                  }
                  const trimmed = seg.content.trim()
                  if (!trimmed) return null
                  return (
                    <div
                      key={i}
                      className="cc-prose overflow-hidden break-words rounded-lg border border-line bg-surface-2 px-4 py-3"
                      dangerouslySetInnerHTML={{ __html: renderMarkdown(trimmed) }}
                    />
                  )
                })}
              </div>
            )
          }

          return (
            <div key={group.key} className="my-1 flex justify-start">
              <div className="cc-prose overflow-hidden break-words rounded-lg border border-line bg-surface-2 px-4 py-3">
                <span dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
                {/* Live typing caret — only while tokens are still streaming in.
                    Reuses the cc-caret keyframe (via .cc-think-caret) from index.css. */}
                {msg.streaming && (
                  <span className="cc-think-caret ml-0.5 text-accent" aria-hidden="true" />
                )}
              </div>
            </div>
          )
        }

        if (msg.type === 'followup') {
          return (
            <div key={group.key} className="my-1 flex justify-end">
              <div
                className="overflow-hidden break-words rounded-lg bg-accent px-4 py-3 text-[14px] leading-relaxed text-accent-fg"
                style={{ maxWidth: 'min(85%, 64ch)' }}
              >
                {msg.text}
              </div>
            </div>
          )
        }

        if (msg.type === 'result') {
          return <div key={group.key}><ResultCard text={msg.text} cost={msg.cost} duration={msg.duration} /></div>
        }

        if (msg.type === 'error') {
          return <div key={group.key}><ErrorCard text={msg.text} /></div>
        }

        return null
      })}
    </div>
  )
}
