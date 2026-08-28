import { useState, useEffect, useCallback, useRef } from 'react'

// Reusable, prop-driven markdown editor. Standalone so other surfaces (e.g. the
// upcoming "Loops" detail view) can reuse it: pass the current `value`, an
// `onSave(next)` that persists it, and an optional `onCancel`. When `readOnly`
// is set it renders the text without edit affordances.
//
// The component owns only its in-progress draft state; the parent owns the
// source of truth and updates `value` after a successful save. A `value` change
// from the parent resyncs the draft (unless the user is mid-edit with unsaved
// changes — we keep their edits to avoid clobbering them).
//
// Autosave mode (`autosave`): renders an always-on textarea with NO Edit/Save/
// Cancel buttons — it debounces `onSave` ~`autosaveMs` after typing stops and
// shows a subtle saved/saving indicator. Used by the Scratchpad surface.
interface MarkdownEditorProps {
  value: string
  onSave: (next: string) => Promise<void> | void
  onCancel?: () => void
  readOnly?: boolean
  /** Start in edit mode immediately (skip the read-only preview + Edit button). */
  startEditing?: boolean
  /** Rows for the textarea (default 14). */
  rows?: number
  className?: string
  /** Debounced-autosave mode: no buttons, save fires after typing stops. */
  autosave?: boolean
  /** Debounce window for autosave, ms (default 800). */
  autosaveMs?: number
  /** Placeholder for the textarea (autosave mode). */
  placeholder?: string
}

type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error'

export function MarkdownEditor({
  value,
  onSave,
  onCancel,
  readOnly = false,
  startEditing = false,
  rows = 14,
  className = '',
  autosave = false,
  autosaveMs = 800,
  placeholder,
}: MarkdownEditorProps) {
  const [editing, setEditing] = useState(startEditing && !readOnly)
  const [draft, setDraft] = useState(value)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Resync when the parent's value changes and the user isn't mid-edit.
  useEffect(() => {
    if (!editing) setDraft(value)
  }, [value, editing])

  const beginEdit = useCallback(() => {
    setDraft(value)
    setError(null)
    setEditing(true)
  }, [value])

  const cancel = useCallback(() => {
    setDraft(value)
    setError(null)
    setEditing(false)
    onCancel?.()
  }, [value, onCancel])

  const save = useCallback(async () => {
    setSaving(true)
    setError(null)
    try {
      await onSave(draft)
      setEditing(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }, [draft, onSave])

  // ── Autosave mode ─────────────────────────────────────────────────────────
  // Debounce onSave ~autosaveMs after the user stops typing. `value` is the
  // last-persisted content (parent updates it after a successful save), so
  // `draft === value` means "in sync / saved".
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Keep the latest onSave without re-arming the debounce on every render.
  const onSaveRef = useRef(onSave)
  useEffect(() => { onSaveRef.current = onSave }, [onSave])

  useEffect(() => {
    if (!autosave) return
    if (draft === value) {
      // In sync — nothing pending. Leave a 'saved' badge if we just saved.
      setSaveState(prev => (prev === 'saving' ? 'saved' : prev === 'dirty' ? 'saved' : prev))
      return
    }
    setSaveState('dirty')
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(async () => {
      setSaveState('saving')
      try {
        await onSaveRef.current(draft)
        setSaveState('saved')
      } catch {
        setSaveState('error')
      }
    }, autosaveMs)
    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
  }, [draft, value, autosave, autosaveMs])

  if (autosave && !readOnly) {
    const badge: Record<SaveState, { text: string; tone: string }> = {
      idle: { text: 'Saved', tone: 'text-fg-3' },
      saved: { text: 'Saved', tone: 'text-fg-3' },
      dirty: { text: 'Unsaved…', tone: 'text-fg-3' },
      saving: { text: 'Saving…', tone: 'text-accent' },
      error: { text: 'Save failed — retrying on next edit', tone: 'text-signal-alarm' },
    }
    const b = badge[saveState]
    return (
      <div className={className}>
        <textarea
          value={draft}
          onChange={e => setDraft(e.target.value)}
          rows={rows}
          spellCheck
          placeholder={placeholder}
          className="w-full resize-y rounded-md border border-line bg-surface-0 px-3 py-2 font-mono text-sm leading-relaxed text-fg-0 outline-none focus:border-accent"
        />
        <div className="mt-1.5 flex items-center gap-2 font-mono text-[10px]">
          <span className={b.tone}>{b.text}</span>
        </div>
      </div>
    )
  }

  if (readOnly || !editing) {
    return (
      <div className={className}>
        <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-fg-1">
          {value}
        </pre>
        {!readOnly && (
          <button
            onClick={beginEdit}
            className="mt-3 rounded-md border border-line px-3 py-1.5 text-xs font-medium text-fg-1 transition hover:bg-surface-2 hover:text-fg-0"
          >
            Edit
          </button>
        )}
      </div>
    )
  }

  const dirty = draft !== value
  return (
    <div className={className}>
      <textarea
        value={draft}
        onChange={e => setDraft(e.target.value)}
        rows={rows}
        spellCheck
        autoFocus
        className="w-full resize-y rounded-md border border-line bg-surface-0 px-3 py-2 font-mono text-sm leading-relaxed text-fg-0 outline-none focus:border-accent"
      />
      {error && <div className="mt-1 text-xs text-accent">{error}</div>}
      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={save}
          disabled={saving || !dirty}
          className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg transition hover:bg-accent-hover disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          onClick={cancel}
          disabled={saving}
          className="rounded-md border border-line px-3 py-1.5 text-xs font-medium text-fg-1 transition hover:bg-surface-2 hover:text-fg-0 disabled:opacity-50"
        >
          Cancel
        </button>
        {dirty && <span className="text-[10px] text-fg-3">unsaved changes</span>}
      </div>
    </div>
  )
}
