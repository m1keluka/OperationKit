import { useState, useEffect, useCallback } from 'react'
import { api } from '../lib/api'
import { Badge, Button, Card, Tabs, EmptyState, Alert } from './ui'
import type { TabItem } from './ui'

interface FileData {
  content: string
  modifiedAt: string
  size: number
}

type AssistantFiles = Record<string, FileData>

type Tab = 'loops' | 'ingest' | 'conversation' | 'context'

const TAB_FILES: Record<Tab, string> = {
  loops: 'loops.md',
  ingest: '',
  conversation: 'conversation.md',
  context: 'context.md',
}

const TAB_LABELS: Record<Tab, string> = {
  loops: 'Open Loops',
  ingest: 'Ingest',
  conversation: 'Conversation',
  context: 'Context',
}

function formatTimeAgo(iso: string): string {
  if (!iso) return 'never'
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

// ── Loop Parser ──

interface LoopEntry {
  timestamp: string
  title: string
  fields: Record<string, string>
}

function parseLoops(content: string): { open: LoopEntry[]; closed: LoopEntry[] } {
  const open: LoopEntry[] = []
  const closed: LoopEntry[] = []
  let target = open
  let current: Partial<LoopEntry> | null = null
  let bodyLines: string[] = []

  function finalizeCurrent() {
    if (!current) return
    if (bodyLines.length > 0) {
      const body = bodyLines.join(' ').trim()
      if (!current.fields?.status) {
        if (/\b(awaiting|waiting|pending)\b/i.test(body)) current.fields!.status = 'waiting'
        else if (/\b(in.?progress|working|started)\b/i.test(body)) current.fields!.status = 'in-progress'
        else if (/\b(parked|deferred|later)\b/i.test(body)) current.fields!.status = 'parked'
        else current.fields!.status = 'open'
      }
      if (!current.fields?.type) {
        const title = current.title || ''
        if (/\b(email|reply|draft|send)\b/i.test(title)) current.fields!.type = 'email'
        else if (/\b(idea|concept|explore)\b/i.test(title)) current.fields!.type = 'idea'
        else if (/\b(question|wonder|should we)\b/i.test(title)) current.fields!.type = 'question'
        else current.fields!.type = 'action'
      }
      const actionMatch = body.match(/Action:\s*(.+?)(?:\.|$)/)
      if (actionMatch && !current.fields?.next) {
        current.fields!.next = actionMatch[1].trim()
      }
      const openedMatch = body.match(/Opened\s+(\d{4}-\d{2}-\d{2})/)
      if (openedMatch && !current.timestamp) {
        current.timestamp = openedMatch[1]
      }
      current.fields!.context = body.length > 300 ? body.slice(0, 300) + '...' : body
    }
    target.push(current as LoopEntry)
  }

  for (const line of content.split('\n')) {
    if (line.startsWith('# Closed Loops')) {
      finalizeCurrent()
      current = null
      bodyLines = []
      target = closed
      continue
    }
    if (line.startsWith('# Open Loops')) continue

    const structuredMatch = line.match(/^## \[(.+?)\] (.+)/)
    const proseMatch = !structuredMatch && line.match(/^## (.+)/)

    if (structuredMatch) {
      finalizeCurrent()
      bodyLines = []
      current = { timestamp: structuredMatch[1], title: structuredMatch[2], fields: {} }
      continue
    }
    if (proseMatch) {
      finalizeCurrent()
      bodyLines = []
      current = { timestamp: '', title: proseMatch[1], fields: {} }
      continue
    }

    if (current) {
      const fieldMatch = line.match(/^- \*\*(.+?):\*\* (.+)/)
      if (fieldMatch) {
        current.fields = current.fields || {}
        current.fields[fieldMatch[1].toLowerCase()] = fieldMatch[2]
      } else if (line.trim() && !line.startsWith('---')) {
        bodyLines.push(line.trim())
      }
    }
  }
  finalizeCurrent()

  return { open, closed }
}

// ── Conversation Parser ──

interface ConversationMessage {
  role: 'User' | 'Assistant'
  text: string
  date: string
}

function parseConversation(content: string): { messages: ConversationMessage[]; currentDate: string } {
  const messages: ConversationMessage[] = []
  let currentDate = ''
  let currentRole: 'User' | 'Assistant' | null = null
  let currentLines: string[] = []

  function finalizeMessage() {
    if (currentRole && currentLines.length > 0) {
      messages.push({ role: currentRole, text: currentLines.join('\n').trim(), date: currentDate })
    }
    currentLines = []
  }

  for (const line of content.split('\n')) {
    if (line.startsWith('# Conversation')) continue

    // Date header: ## 2026-04-23
    const dateMatch = line.match(/^## (\d{4}-\d{2}-\d{2})/)
    if (dateMatch) {
      finalizeMessage()
      currentDate = dateMatch[1]
      currentRole = null
      continue
    }

    // Structured format: ## [timestamp] User/Assistant
    const structuredMatch = line.match(/^## \[(.+?)\] (User|Assistant)/)
    if (structuredMatch) {
      finalizeMessage()
      currentDate = structuredMatch[1]
      currentRole = structuredMatch[2] as 'User' | 'Assistant'
      continue
    }

    // Prose format: **User:** or **Assistant:**
    const proseMatch = line.match(/^\*\*(User|Assistant):\*\*\s*(.*)/)
    if (proseMatch) {
      finalizeMessage()
      currentRole = proseMatch[1] as 'User' | 'Assistant'
      if (proseMatch[2].trim()) currentLines.push(proseMatch[2].trim())
      continue
    }

    if (currentRole && line.trim()) {
      currentLines.push(line)
    }
  }
  finalizeMessage()

  return { messages, currentDate }
}

// ── UI Components ──

type BadgeTone = 'neutral' | 'accent' | 'verify' | 'amber' | 'alarm' | 'info'

function StatusBadge({ status }: { status: string }) {
  const tones: Record<string, BadgeTone> = {
    open: 'info',
    'in-progress': 'amber',
    waiting: 'accent',
    parked: 'neutral',
    closed: 'verify',
  }
  return <Badge tone={tones[status] || 'info'}>{status}</Badge>
}

function TypeBadge({ type }: { type: string }) {
  const tones: Record<string, BadgeTone> = {
    action: 'accent',
    idea: 'info',
    email: 'neutral',
    question: 'info',
    decision: 'alarm',
    objective: 'verify',
  }
  return <Badge tone={tones[type] || 'neutral'}>{type}</Badge>
}

function LoopsView({ content }: { content: string }) {
  const [showClosed, setShowClosed] = useState(false)
  const { open, closed } = parseLoops(content)

  if (open.length === 0 && closed.length === 0) {
    return (
      <EmptyState
        title="No open loops"
        description="Send a brain dump to the Ingest tab and any action items become loops here."
      />
    )
  }

  return (
    <div className="space-y-6">
      {open.length > 0 && (
        <div>
          <h3 className="mb-3 font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-fg-3">Open ({open.length})</h3>
          <div className="space-y-2">
            {open.map((loop, i) => (
              <Card key={i}>
                <div className="mb-2 flex items-center gap-2">
                  <StatusBadge status={loop.fields.status || 'open'} />
                  {loop.fields.type && <TypeBadge type={loop.fields.type} />}
                  {loop.timestamp && (
                    <span className="ml-auto font-mono text-[11px] text-fg-3">{loop.timestamp}</span>
                  )}
                </div>
                <h4 className="mb-1 font-display font-semibold text-fg-0">{loop.title}</h4>
                {loop.fields.context && (
                  <p className="mb-2 text-sm leading-relaxed text-fg-2">{loop.fields.context}</p>
                )}
                {loop.fields.next && (
                  <p className="rounded-md bg-surface-0 px-3 py-1.5 text-sm text-fg-1">
                    <span className="font-medium text-accent-hover">Next:</span> {loop.fields.next}
                  </p>
                )}
              </Card>
            ))}
          </div>
        </div>
      )}

      {closed.length > 0 && (
        <div>
          <button
            onClick={() => setShowClosed(!showClosed)}
            className="mb-3 flex items-center gap-2 font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-fg-3 transition-colors hover:text-fg-1"
          >
            <span className="text-xs">{showClosed ? '\u25BC' : '\u25B6'}</span>
            Closed ({closed.length})
          </button>
          {showClosed && (
            <div className="space-y-2">
              {closed.map((loop, i) => (
                <div key={i} className="rounded-lg border border-line-soft bg-surface-1 p-3 opacity-60">
                  <div className="mb-1 flex items-center gap-2">
                    <StatusBadge status="closed" />
                    {loop.timestamp && (
                      <span className="ml-auto font-mono text-[11px] text-fg-3">{loop.timestamp}</span>
                    )}
                  </div>
                  <h4 className="text-sm text-fg-1">{loop.title}</h4>
                  {(loop.fields.resolution || loop.fields.context) && (
                    <p className="mt-1 text-xs text-fg-3">{loop.fields.resolution || loop.fields.context}</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ConversationView({ content }: { content: string }) {
  const { messages } = parseConversation(content)

  if (messages.length === 0) {
    return <EmptyState title="No conversation yet" description="Messages with the assistant will appear here." />
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-3">
      {messages.map((msg, i) => (
        <div key={i} className={`flex ${msg.role === 'User' ? 'justify-end' : 'justify-start'}`}>
          <div className={`max-w-[85%] px-4 py-2.5 text-sm leading-relaxed ${
            msg.role === 'User'
              ? 'rounded-2xl rounded-br-sm bg-accent text-accent-fg'
              : 'rounded-2xl rounded-bl-sm border border-line bg-surface-2 text-fg-1'
          }`}>
            <div className={`mb-1 font-mono text-[10px] uppercase tracking-[0.12em] ${msg.role === 'User' ? 'text-accent-fg/70' : 'text-fg-3'}`}>
              {msg.role}
            </div>
            <p className="whitespace-pre-wrap">{msg.text}</p>
          </div>
        </div>
      ))}
    </div>
  )
}

function RawView({ content }: { content: string }) {
  if (!content.trim()) {
    return (
      <EmptyState
        title="No compacted context yet"
        description="Fills up after 30+ conversation exchanges."
      />
    )
  }
  return (
    <pre className="whitespace-pre-wrap rounded-lg border border-line bg-surface-1 p-4 font-mono text-sm leading-relaxed text-fg-1">
      {content}
    </pre>
  )
}

function IngestView({ onIngested }: { onIngested: () => void }) {
  const [text, setText] = useState('')
  const [processing, setProcessing] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit() {
    if (!text.trim() || processing) return
    setProcessing(true)
    setResult(null)
    setError(null)

    try {
      const data = await api.post<{ response: string }>('/admin/assistant/ingest', { text: text.trim() })
      setResult(data.response)
      setText('')
      onIngested()
    } catch {
      setError('Failed to process. Try again.')
    } finally {
      setProcessing(false)
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div>
        <p className="mb-3 text-sm leading-relaxed text-fg-2">
          Paste any content — meeting notes, articles, Slack threads, ideas, brain dumps.
          It'll be added to the knowledge base and any action items become loops.
        </p>
        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder="Paste or type content here..."
          disabled={processing}
          className="h-64 w-full resize-y rounded-lg border border-line bg-surface-0 p-4 text-base text-fg-0 placeholder-fg-3 transition-colors focus:border-accent focus:outline-none disabled:opacity-50 sm:text-sm"
        />
        <div className="mt-3 flex items-center justify-between">
          <span className="font-mono text-xs text-fg-3">
            {text.length > 0 ? `${text.length} chars` : ''}
          </span>
          <Button
            onClick={handleSubmit}
            disabled={!text.trim() || processing}
            variant="primary"
          >
            {processing ? 'Processing…' : 'Ingest'}
          </Button>
        </div>
      </div>

      {processing && (
        <Card>
          <div className="flex items-center gap-3">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent" />
            <span className="text-sm text-fg-2">Processing with Claude Code — extracting knowledge and loops…</span>
          </div>
        </Card>
      )}

      {error && <Alert tone="alarm" title="Ingest failed">{error}</Alert>}

      {result && (
        <Card>
          <h4 className="mb-2 font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-fg-3">Result</h4>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-fg-1">{result}</p>
        </Card>
      )}
    </div>
  )
}

// ── Main Page ──

export function AssistantPage() {
  const [files, setFiles] = useState<AssistantFiles | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<Tab>('loops')
  const [loading, setLoading] = useState(true)

  const fetchFiles = useCallback(async () => {
    try {
      const data = await api.get<AssistantFiles>('/admin/assistant')
      setFiles(data)
      setError(null)
    } catch {
      setError('Failed to load assistant files')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchFiles()
    const interval = setInterval(fetchFiles, 5000)
    return () => clearInterval(interval)
  }, [fetchFiles])

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-sm text-fg-3">Loading assistant…</div>
      </div>
    )
  }

  if (error || !files) {
    return (
      <div className="flex h-full items-center justify-center px-4">
        <div className="text-sm text-signal-alarm">{error || 'No data'}</div>
      </div>
    )
  }

  const currentFile = files[TAB_FILES[activeTab]]
  const loopCount = files['loops.md']?.content ? parseLoops(files['loops.md'].content).open.length : 0

  const tabItems: TabItem[] = (Object.keys(TAB_FILES) as Tab[]).map(tab => ({
    key: tab,
    label: TAB_LABELS[tab],
    count: tab === 'loops' && loopCount > 0 ? loopCount : undefined,
  }))

  return (
    <div className="flex h-full flex-col bg-surface-0">
      <div className="flex items-center justify-between gap-3 border-b border-line bg-surface-1 px-4 py-3 sm:px-6">
        <Tabs items={tabItems} value={activeTab} onChange={k => setActiveTab(k as Tab)} className="min-w-0" />
        <div className="flex shrink-0 items-center gap-3 text-xs text-fg-3">
          {activeTab !== 'ingest' && currentFile?.modifiedAt && (
            <span className="hidden font-mono sm:inline">Updated {formatTimeAgo(currentFile.modifiedAt)}</span>
          )}
          <Button onClick={fetchFiles} variant="ghost" size="sm">Refresh</Button>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-4 sm:p-6">
        {activeTab === 'loops' && <LoopsView content={files['loops.md']?.content || ''} />}
        {activeTab === 'ingest' && <IngestView onIngested={fetchFiles} />}
        {activeTab === 'conversation' && <ConversationView content={files['conversation.md']?.content || ''} />}
        {activeTab === 'context' && <RawView content={files['context.md']?.content || ''} />}
      </div>
    </div>
  )
}
