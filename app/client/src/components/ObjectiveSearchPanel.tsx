import { useEffect, useState, useRef, useCallback } from 'react'
import type { ObjectiveStatus, Workspace } from '@operationkit/shared'
import {
  searchObjectives,
  searchObjectivesAi,
  ApiError,
  type ObjectiveSearchResult,
  type ObjectiveAiSearchResult,
} from '../lib/api'
import { useWorkspaces } from '../hooks/useWorkspaces'
import { NavIcon } from './nav-icons'
import { STATUS_META, StatusDot } from './design/primitives'

/* ─────────────────────────────────────────────────────────
   Objective search (obj 702389)
   A ⌘K-style overlay that searches objectives ACROSS ALL
   stages (incl. done / cancelled) via the server-side search
   endpoints (obj 702388). The Done column is a lazily-paginated
   backlog never fully loaded client-side, so this is the only
   way to find a completed objective by keyword/idea.

   Two modes in one panel:
     • Keyword — GET /objectives/search, debounced as you type.
     • AI      — POST /objectives/search/ai, run on submit; shows
                 a per-result reason, or a graceful message on 502.
   Selecting a result hands its id up; the board fetches the full
   objective and opens ObjectiveModal (reopen works for done).
   ───────────────────────────────────────────────────────── */

interface ObjectiveSearchPanelProps {
  open: boolean
  workspace: Workspace
  onClose: () => void
  onSelect: (id: number) => void
}

type Mode = 'keyword' | 'ai'

// Small status pill reusing the board's STATUS_META tokens so done/cancelled
// read the same in search as on the board.
function StatusBadge({ status }: { status: ObjectiveStatus }) {
  const meta = STATUS_META[status] ?? STATUS_META.queue
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-sm border border-line-soft bg-surface-3 px-1.5 py-0.5 text-[10.5px] font-medium ${meta.tone}`}
    >
      <StatusDot status={status} size={6} />
      {meta.label}
    </span>
  )
}

export function ObjectiveSearchPanel({ open, workspace, onClose, onSelect }: ObjectiveSearchPanelProps) {
  const { shortOf } = useWorkspaces()
  const [mode, setMode] = useState<Mode>('keyword')
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const [loading, setLoading] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)
  const [kwResults, setKwResults] = useState<ObjectiveSearchResult[]>([])
  const [aiResults, setAiResults] = useState<ObjectiveAiSearchResult[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  // Guards against out-of-order keyword responses (last query wins).
  const seqRef = useRef(0)

  // Reset everything each time the panel opens; focus the input.
  useEffect(() => {
    if (!open) return
    setMode('keyword')
    setQuery('')
    setCursor(0)
    setLoading(false)
    setAiError(null)
    setKwResults([])
    setAiResults([])
    setTimeout(() => inputRef.current?.focus(), 0)
  }, [open])

  // Debounced keyword search as the user types (250ms). AI mode does NOT
  // auto-run — it fires on submit (Enter / button) to bound API cost.
  useEffect(() => {
    if (!open || mode !== 'keyword') return
    const q = query.trim()
    if (!q) {
      setKwResults([])
      setLoading(false)
      return
    }
    const seq = ++seqRef.current
    setLoading(true)
    const t = setTimeout(async () => {
      try {
        const { results } = await searchObjectives(q, workspace, 30)
        if (seq === seqRef.current) {
          setKwResults(results)
          setCursor(0)
        }
      } catch {
        if (seq === seqRef.current) setKwResults([])
      } finally {
        if (seq === seqRef.current) setLoading(false)
      }
    }, 250)
    return () => clearTimeout(t)
  }, [query, mode, workspace, open])

  const runAiSearch = useCallback(async () => {
    const q = query.trim()
    if (!q) return
    const seq = ++seqRef.current
    setLoading(true)
    setAiError(null)
    try {
      const { results } = await searchObjectivesAi(q, workspace)
      if (seq !== seqRef.current) return
      setAiResults(results)
      setCursor(0)
      if (results.length === 0) setAiError(null)
    } catch (err) {
      if (seq !== seqRef.current) return
      setAiResults([])
      if (err instanceof ApiError && err.status === 502) {
        setAiError('AI search unavailable (API key not configured)')
      } else {
        setAiError('AI search failed — try again')
      }
    } finally {
      if (seq === seqRef.current) setLoading(false)
    }
  }, [query, workspace])

  if (!open) return null

  const results: Array<ObjectiveSearchResult | ObjectiveAiSearchResult> =
    mode === 'keyword' ? kwResults : aiResults
  const safeCursor = Math.min(cursor, Math.max(0, results.length - 1))

  function switchMode(next: Mode) {
    if (next === mode) return
    setMode(next)
    setCursor(0)
    setAiError(null)
    setLoading(false)
    seqRef.current++ // invalidate any in-flight request from the previous mode
    if (next === 'ai') setAiResults([])
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') { onClose(); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor(c => Math.min(results.length - 1, c + 1)); return }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setCursor(c => Math.max(0, c - 1)); return }
    if (e.key === 'Enter') {
      e.preventDefault()
      // AI mode: Enter submits the query unless results for it are already shown.
      if (mode === 'ai' && aiResults.length === 0) { runAiSearch(); return }
      const r = results[safeCursor]
      if (r) { onSelect(r.id); onClose() }
    }
  }

  const showEmpty = !loading && query.trim() && results.length === 0 && !aiError

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-surface-0/70 p-4 pt-[10vh]"
      onClick={onClose}
    >
      <div
        className="cc-toast-in flex max-h-[72vh] w-full max-w-xl flex-col overflow-hidden rounded-lg border border-line bg-surface-2 shadow-float"
        onClick={e => e.stopPropagation()}
      >
        {/* Input row */}
        <div className="flex items-center gap-2 border-b border-line-soft px-3 py-2.5">
          <NavIcon name="search" className="h-4 w-4 shrink-0 text-fg-3" />
          <input
            ref={inputRef}
            value={query}
            onChange={e => { setQuery(e.target.value); setCursor(0); if (mode === 'ai') setAiResults([]) }}
            onKeyDown={handleKeyDown}
            placeholder={mode === 'keyword' ? 'Search objectives (all stages)…' : 'Describe what you’re looking for, then Enter…'}
            className="flex-1 bg-transparent text-sm text-fg-0 placeholder-fg-3 outline-none"
          />
          {loading && <span className="shrink-0 font-mono text-[10.5px] text-fg-3">…</span>}
          <span className="shrink-0 font-mono text-[10.5px] text-fg-3">esc</span>
        </div>

        {/* Mode toggle */}
        <div className="flex items-center gap-1 border-b border-line-soft px-3 py-1.5">
          {(['keyword', 'ai'] as const).map(m => (
            <button
              key={m}
              onClick={() => switchMode(m)}
              aria-pressed={mode === m}
              className={`rounded-sm px-2 py-1 text-[12px] font-medium transition-colors duration-fast ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 ${
                mode === m ? 'bg-surface-3 text-fg-0' : 'text-fg-2 hover:text-fg-1'
              }`}
            >
              {m === 'keyword' ? 'Keyword' : 'AI'}
            </button>
          ))}
          {mode === 'ai' && (
            <button
              onClick={runAiSearch}
              disabled={loading || !query.trim()}
              className="ml-auto rounded-sm bg-accent px-2.5 py-1 text-[12px] font-medium text-accent-fg transition-colors duration-fast ease-out hover:bg-accent-hover disabled:opacity-40"
            >
              {loading ? 'Searching…' : 'Search'}
            </button>
          )}
        </div>

        {/* Results */}
        <ul role="listbox" className="min-h-0 flex-1 overflow-y-auto py-1">
          {aiError && (
            <li className="px-3 py-3 text-sm text-[color:var(--ok-alarm)]">{aiError}</li>
          )}
          {showEmpty && <li className="px-3 py-3 text-sm text-fg-3">No matches</li>}
          {mode === 'ai' && !loading && !query.trim() && !aiError && (
            <li className="px-3 py-3 text-sm text-fg-3">Type a natural-language query and press Enter.</li>
          )}
          {results.map((r, i) => {
            const snippet = 'snippet' in r ? r.snippet : r.reason
            const agent = 'agent_context' in r ? r.agent_context : null
            return (
              <li
                key={r.id}
                role="option"
                aria-selected={i === safeCursor}
                onMouseEnter={() => setCursor(i)}
                onClick={() => { onSelect(r.id); onClose() }}
                className={`flex cursor-pointer flex-col gap-1 px-3 py-2 transition-colors duration-fast ease-out ${
                  i === safeCursor ? 'bg-surface-3' : 'hover:bg-surface-3'
                }`}
              >
                <div className="flex items-center gap-2">
                  <StatusBadge status={r.status} />
                  <span className="min-w-0 flex-1 truncate text-sm text-fg-0">{r.title || 'Untitled'}</span>
                  <span className="shrink-0 font-mono text-[10.5px] uppercase tracking-wide text-fg-3">{shortOf(r.workspace as Workspace)}</span>
                </div>
                {(snippet || agent) && (
                  <div className="flex items-center gap-1.5 text-[11.5px] leading-snug text-fg-3">
                    {agent && <span className="shrink-0 font-mono text-fg-2">{agent}</span>}
                    {agent && snippet && <span className="shrink-0 text-fg-3">·</span>}
                    {snippet && <span className="line-clamp-2">{snippet}</span>}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}
