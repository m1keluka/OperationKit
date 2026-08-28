import { useState } from 'react'

interface ObjectiveProposal {
  title: string
  description: string
  workspace: string
  project?: string | null
  priority?: 'high' | 'medium' | 'low'
}

const PRIORITY_CLASSES: Record<string, string> = {
  high: 'bg-signal-alarm/10 border-signal-alarm/30 text-signal-alarm',
  medium: 'bg-signal-amber/10 border-signal-amber/30 text-signal-amber',
  low: 'bg-surface-3 border-line text-fg-2',
}

const DESC_LIMIT = 120

export function ObjectiveProposalCard({ raw }: { raw: string }) {
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)

  let proposal: ObjectiveProposal | null = null
  let parseError: string | null = null

  try {
    const parsed = JSON.parse(raw) as unknown
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>).title !== 'string'
    ) {
      throw new Error('Missing required field: title')
    }
    proposal = parsed as ObjectiveProposal
  } catch (e) {
    parseError = e instanceof Error ? e.message : 'Invalid JSON'
  }

  if (parseError || !proposal) {
    return (
      <div className="my-2 rounded-lg border border-signal-alarm/30 bg-signal-alarm/10 px-4 py-3 text-sm">
        <div className="font-medium text-signal-alarm mb-1">Invalid objective proposal</div>
        <div className="text-xs text-fg-2">{parseError}</div>
        <pre className="mt-2 font-mono text-xs text-fg-3 overflow-x-auto whitespace-pre-wrap break-words">{raw}</pre>
      </div>
    )
  }

  const { title, description, workspace, project, priority = 'medium' } = proposal
  const priorityCls = PRIORITY_CLASSES[priority] ?? PRIORITY_CLASSES.medium
  const isLong = description.length > DESC_LIMIT
  const visibleDesc =
    expanded || !isLong ? description : description.slice(0, DESC_LIMIT).trimEnd() + '…'

  const handleCreate = async () => {
    setStatus('loading')
    setErrorMsg(null)
    try {
      const descWithPriority = `[Priority: ${priority}]\n\n${description}`
      const res = await fetch('/api/objectives', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          description: descWithPriority,
          workspace,
          project: project ?? null,
          agent_context: 'general',
          category: 'general',
        }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      setStatus('success')
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : 'Failed to create objective')
      setStatus('error')
    }
  }

  return (
    <div
      className="my-2 rounded-lg border border-accent/25 bg-accent/5 p-4"
      style={{ maxWidth: 'min(85%, 700px)' }}
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="font-display text-sm font-semibold text-fg-0 leading-tight">{title}</div>
        <span
          className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] shrink-0 ${priorityCls}`}
        >
          {priority}
        </span>
      </div>

      <div className="flex flex-wrap gap-1.5 mb-3">
        <span className="inline-flex items-center rounded-full border border-[color:var(--accent-line)] bg-[var(--accent-tint)] px-2 py-0.5 text-[11px] font-medium text-accent-hover">
          {workspace}
        </span>
        {project && (
          <span className="inline-flex items-center rounded-full border border-line bg-surface-3 px-2 py-0.5 font-mono text-[11px] text-fg-2">
            {project}
          </span>
        )}
      </div>

      <div className="text-xs text-fg-2 leading-relaxed">
        {visibleDesc}
        {isLong && (
          <button
            onClick={() => setExpanded(e => !e)}
            className="ml-1 text-accent-hover hover:underline text-xs"
          >
            {expanded ? 'show less' : 'show more'}
          </button>
        )}
      </div>

      <div className="mt-3 flex items-center gap-3">
        {status === 'success' ? (
          <a
            href="/"
            className="rounded-md border border-signal-verify/30 bg-signal-verify/10 px-3 py-1.5 text-xs font-medium text-signal-verify transition-colors hover:bg-signal-verify/20"
          >
            View on board →
          </a>
        ) : (
          <button
            onClick={handleCreate}
            disabled={status === 'loading'}
            className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg transition-colors hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {status === 'loading' ? 'Creating…' : 'Create Objective'}
          </button>
        )}
        {status === 'error' && errorMsg && (
          <span className="text-xs text-signal-alarm">{errorMsg}</span>
        )}
      </div>
    </div>
  )
}
