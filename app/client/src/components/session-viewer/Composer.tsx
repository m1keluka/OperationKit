/**
 * Follow-up composer — extracted from SessionViewer.tsx (behavior frozen).
 */
import type { ClipboardEvent, Dispatch, RefObject, SetStateAction } from 'react'
import { Paperclip } from 'lucide-react'
import { Badge, Button } from '../ui'
import { filesFromClipboard, useFileDrop } from '../../hooks/useFileDrop'
import { formatFileSize, type UploadedFile } from './types'

export function Composer({
  attachedFiles,
  removeFile,
  sendError,
  setSendError,
  fileInputRef,
  handleUpload,
  uploading,
  message,
  setMessage,
  messageRef,
  handleSendMessage,
  inputDisabled,
  isActive,
  handleStop,
  interrupting,
  sending,
}: {
  attachedFiles: UploadedFile[]
  removeFile: (index: number) => void
  sendError: string | null
  setSendError: (v: string | null) => void
  fileInputRef: RefObject<HTMLInputElement | null>
  handleUpload: (fileList: FileList) => void
  uploading: boolean
  message: string
  setMessage: Dispatch<SetStateAction<string>>
  messageRef: RefObject<HTMLTextAreaElement | null>
  handleSendMessage: () => void
  inputDisabled: boolean
  isActive: boolean
  handleStop: () => void
  interrupting: boolean
  sending: boolean
}) {
  const canAttach = !inputDisabled && !uploading
  const { isDragging, dropProps } = useFileDrop(handleUpload, canAttach)

  function handlePaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    if (!canAttach) return
    const files = filesFromClipboard(e)
    if (!files) return
    e.preventDefault()
    handleUpload(files)
  }

  return (
    <div className="border-t border-line bg-surface-2">
      <div className="mx-auto max-w-4xl px-3 py-3">
        {/* Attached files chips */}
        {attachedFiles.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {attachedFiles.map((f, i) => {
              const isImage = f.mimetype.startsWith('image/')
              return (
                <Badge key={i} tone="neutral" className="gap-1.5 py-1">
                  <span>{isImage ? '\uD83D\uDDBC\uFE0F' : '\uD83D\uDCC4'}</span>
                  <span className="max-w-[150px] truncate">{f.originalName}</span>
                  <span className="font-mono text-fg-3">{formatFileSize(f.size)}</span>
                  <button onClick={() => removeFile(i)} aria-label="Remove file" className="ml-0.5 text-fg-3 hover:text-flag-blocked">&times;</button>
                </Badge>
              )
            })}
          </div>
        )}
        {sendError && (
          <div className="mb-2 flex items-center justify-between rounded-md bg-flag-blocked/10 px-3 py-1.5 text-xs text-flag-blocked">
            <span>{sendError}</span>
            <button onClick={() => setSendError(null)} aria-label="Dismiss error" className="ml-2 text-flag-blocked/60 hover:text-flag-blocked">&times;</button>
          </div>
        )}
        <div
          {...dropProps}
          className={`flex items-end gap-2 rounded-lg border bg-surface-0 px-2 py-1.5 transition-colors ${
            isDragging
              ? 'border-dashed border-accent bg-accent/5'
              : 'border-line focus-within:border-accent'
          }`}
        >
          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={e => e.target.files && handleUpload(e.target.files)}
          />
          {/* Attach button */}
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={inputDisabled || uploading}
            className="grid h-11 w-11 shrink-0 place-items-center rounded-md text-fg-3 transition-colors hover:bg-surface-3 hover:text-accent disabled:opacity-40 sm:h-9 sm:w-9"
            title="Attach files"
            aria-label="Attach files"
          >
            <Paperclip className={`h-4 w-4 ${uploading ? 'animate-pulse' : ''}`} />
          </button>
          <textarea
            ref={messageRef}
            value={message}
            onChange={e => setMessage(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleSendMessage()
              }
            }}
            onPaste={handlePaste}
            placeholder={
              isDragging
                ? 'Drop files to attach…'
                : isActive
                  ? 'Send follow-up message...'
                  : 'Send follow-up to start new session...'
            }
            disabled={inputDisabled}
            rows={1}
            className="flex-1 resize-none bg-transparent py-1.5 font-mono text-base text-fg-0 placeholder-fg-3 focus:outline-none disabled:opacity-50 sm:text-sm"
          />
          <div className="flex shrink-0 items-center gap-1.5">
            {isActive && (
              <Button
                size="sm"
                variant="danger"
                onClick={handleStop}
                disabled={interrupting}
                title="Stop this objective — kills the session and parks it in review"
              >
                {interrupting ? 'Stopping...' : 'Stop'}
              </Button>
            )}
            <Button
              size="sm"
              variant="primary"
              onClick={handleSendMessage}
              disabled={(!message.trim() && attachedFiles.length === 0) || sending}
            >
              Send
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
