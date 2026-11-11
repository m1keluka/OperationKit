import { useEffect, useRef, type ClipboardEvent, type KeyboardEvent } from 'react'
import { AttachmentChip } from './AttachmentChip'
import { filesFromClipboard, useFileDrop } from '../hooks/useFileDrop'

export interface ComposerAttachment {
  originalName: string
  path: string
  size: number
  mimetype?: string
}

export interface QuickAction {
  label: string
  onClick: () => void
}

interface InputComposerProps {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  disabled?: boolean
  sending?: boolean
  uploading?: boolean
  placeholder?: string
  attachments?: ComposerAttachment[]
  onAttachFiles?: (files: FileList) => void
  onRemoveAttachment?: (path: string) => void
  attachmentError?: string | null
  quickActions?: QuickAction[]
}

const CHAR_THRESHOLD = 4000

export function InputComposer({
  value,
  onChange,
  onSubmit,
  disabled,
  sending,
  uploading,
  placeholder,
  attachments,
  onAttachFiles,
  onRemoveAttachment,
  attachmentError,
  quickActions,
}: InputComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  }, [value])

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends; Shift+Enter inserts a newline.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (canSend) onSubmit()
    }
  }

  const hasAttachments = attachments && attachments.length > 0
  const canSend = !disabled && !sending && !uploading && (value.trim().length > 0 || !!hasAttachments)
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
    <div className="border-t border-border bg-surface-raised px-3 py-2 sm:px-4 sm:py-3">
      <div className="mx-auto max-w-3xl">
        {quickActions && quickActions.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {quickActions.map(({ label, onClick }) => (
              <button
                key={label}
                onClick={onClick}
                className="rounded-full border border-gray-700 px-3 py-1 text-xs text-gray-400 transition-colors hover:border-gray-500 hover:text-gray-200"
              >
                {label}
              </button>
            ))}
          </div>
        )}
        {(hasAttachments || attachmentError) && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {attachments?.map(a => (
              <AttachmentChip
                key={a.path}
                name={a.originalName}
                size={a.size}
                mimetype={a.mimetype}
                onRemove={onRemoveAttachment ? () => onRemoveAttachment(a.path) : undefined}
              />
            ))}
            {attachmentError && <span className="text-xs text-red-400">{attachmentError}</span>}
          </div>
        )}
        <div
          {...dropProps}
          className={`flex items-end gap-2 rounded-lg border bg-surface px-2 py-1.5 transition-colors ${
            isDragging
              ? 'border-dashed border-accent bg-accent/5'
              : 'border-border focus-within:border-accent'
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
                className="mb-1 shrink-0 rounded p-1 text-gray-500 hover:text-accent disabled:opacity-40 transition-colors"
                aria-label="Attach files"
              >
                {uploading ? (
                  <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                ) : (
                  <PaperclipIcon className="h-4 w-4" />
                )}
              </button>
            </>
          )}
          <textarea
            ref={textareaRef}
            value={value}
            onChange={e => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={isDragging ? 'Drop files to attach…' : (placeholder ?? 'Send a message...')}
            disabled={disabled || sending}
            rows={1}
            className="flex-1 resize-none bg-transparent py-1.5 text-sm text-white placeholder-gray-600 focus:outline-none disabled:opacity-50"
          />
          <div className="mb-1 flex shrink-0 items-center gap-2">
            {sending && <span className="text-xs text-accent">Sending…</span>}
            {showCount && !sending && <span className="text-xs text-gray-500">{value.length.toLocaleString()}</span>}
            <button
              onClick={onSubmit}
              disabled={!canSend}
              className="rounded-md bg-accent px-3 py-1 text-sm font-medium text-white transition hover:bg-accent/80 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function PaperclipIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
    </svg>
  )
}
