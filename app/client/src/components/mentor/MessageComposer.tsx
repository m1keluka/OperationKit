import { useEffect, useRef, type ClipboardEvent, type KeyboardEvent } from 'react'
import { Button } from '../ui'
import { filesFromClipboard, useFileDrop } from '../../hooks/useFileDrop'

export interface ComposerAttachment {
  originalName: string
  path: string
  size: number
}

interface MessageComposerProps {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  disabled?: boolean
  sending?: boolean
  placeholder?: string
  attachments?: ComposerAttachment[]
  onAttachFiles?: (files: FileList) => void
  onRemoveAttachment?: (path: string) => void
  attachmentError?: string | null
  uploading?: boolean
}

const CHAR_THRESHOLD = 4000

export function MessageComposer({
  value,
  onChange,
  onSubmit,
  disabled,
  sending,
  placeholder,
  attachments,
  onAttachFiles,
  onRemoveAttachment,
  attachmentError,
  uploading,
}: MessageComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Auto-grow textarea up to ~10 lines
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    const next = Math.min(el.scrollHeight, 240)
    el.style.height = `${next}px`
  }, [value])

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Cmd+Enter (mac) or Ctrl+Enter (everywhere) submits.
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      if (!disabled && !sending && value.trim()) onSubmit()
    }
  }

  const canSend = !disabled && !sending && !uploading && value.trim().length > 0
  const showCount = value.length > CHAR_THRESHOLD
  const canAttach = !!onAttachFiles && !disabled && !sending
  const { isDragging, dropProps } = useFileDrop(
    files => onAttachFiles?.(files),
    canAttach,
  )

  function handlePaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    if (!canAttach) return
    const files = filesFromClipboard(e)
    if (!files) return
    e.preventDefault()
    onAttachFiles?.(files)
  }

  return (
    <div className="border-t border-line bg-surface-1 px-3 py-2.5 sm:px-4 sm:py-3">
      <div className="mx-auto max-w-prose">
        {((attachments && attachments.length > 0) || attachmentError) && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {attachments?.map(a => (
              <span
                key={a.path}
                className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-line bg-surface-0 px-2.5 py-1 text-xs text-fg-1"
              >
                <PaperclipIcon className="h-3 w-3 shrink-0 text-fg-3" />
                <span className="truncate" title={a.originalName}>{a.originalName}</span>
                <span className="shrink-0 font-mono text-fg-3">{formatSize(a.size)}</span>
                {onRemoveAttachment && (
                  <button
                    type="button"
                    onClick={() => onRemoveAttachment(a.path)}
                    className="shrink-0 rounded-full text-fg-3 transition-colors hover:text-signal-alarm"
                    aria-label={`Remove ${a.originalName}`}
                  >
                    ×
                  </button>
                )}
              </span>
            ))}
            {attachmentError && <span className="text-xs text-signal-alarm">{attachmentError}</span>}
          </div>
        )}
        <div
          {...dropProps}
          className={`flex items-end gap-2 rounded-xl border bg-surface-0 px-2 py-1.5 transition-colors duration-fast ${
            isDragging
              ? 'border-dashed border-accent bg-accent/5'
              : 'border-line focus-within:border-accent focus-within:ring-1 focus-within:ring-[color:var(--accent-line)]'
          }`}
        >
          {canAttach && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={e => {
                  if (e.target.files && e.target.files.length > 0) onAttachFiles?.(e.target.files)
                  e.target.value = ''
                }}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="grid h-11 w-11 shrink-0 place-items-center rounded-md text-fg-3 transition-colors hover:bg-surface-2 hover:text-accent disabled:opacity-40 sm:h-9 sm:w-9"
                aria-label="Attach files"
              >
                <PaperclipIcon className="h-4 w-4" />
              </button>
            </>
          )}
          <textarea
            ref={textareaRef}
            value={value}
            onChange={e => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={isDragging ? 'Drop files to attach…' : (placeholder ?? 'Ask, vent, or pressure-test something...')}
            disabled={disabled || sending}
            rows={1}
            className="flex-1 resize-none bg-transparent py-2.5 text-base text-fg-0 placeholder-fg-3 focus:outline-none disabled:opacity-50 sm:py-2 sm:text-sm"
          />
          <div className="mb-0.5 flex shrink-0 items-center gap-2">
            {uploading && <span className="text-xs text-accent-hover">Uploading…</span>}
            {sending && <span className="text-xs text-accent-hover">Sending…</span>}
            {showCount && !sending && <span className="font-mono text-xs text-fg-3">{value.length.toLocaleString()}</span>}
            <Button onClick={onSubmit} disabled={!canSend} variant="primary" size="sm" className="h-11 px-4 sm:h-9">
              Send
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function PaperclipIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
    </svg>
  )
}
