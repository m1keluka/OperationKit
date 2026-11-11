/**
 * Follow-up composer — extracted from SessionViewer.tsx (behavior frozen).
 */
import { useMemo, useState, type ClipboardEvent, type Dispatch, type RefObject, type SetStateAction } from 'react'
import { KeyRound, Paperclip } from 'lucide-react'
import { Badge, Button } from '../ui'
import { filesFromClipboard, useFileDrop } from '../../hooks/useFileDrop'
import { detectSecrets, redactValue, type SecretCandidate } from '../../lib/secretDetect'
import { AddSecretModal } from './AddSecretModal'
import { formatFileSize, type UploadedFile } from './types'

/** obj 719065: in-chat secret affordances. Omitted → no "+ Add secret", no paste prompt. */
export interface ComposerSecrets {
  objectiveId: number
  workspace: string
  /** Names the card is currently waiting on (for naming a bare pasted token). */
  pendingNames: string[]
}

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
  secrets,
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
  secrets?: ComposerSecrets
}) {
  const canAttach = !inputDisabled && !uploading
  const { isDragging, dropProps } = useFileDrop(handleUpload, canAttach)
  const [secretModal, setSecretModal] = useState<{ candidate?: SecretCandidate } | null>(null)
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set())
  const [savedNote, setSavedNote] = useState<string | null>(null)
  const pendingKey = secrets?.pendingNames.join(',') ?? ''
  const candidates = useMemo(
    () => (secrets ? detectSecrets(message, pendingKey ? pendingKey.split(',') : []).filter(c => !dismissed.has(c.value)) : []),
    [message, pendingKey, dismissed, secrets],
  )
  const candidate = candidates[0]

  function onSecretSaved(name: string) {
    const value = secretModal?.candidate?.value
    if (value) setMessage(m => redactValue(m, value, name))
    setSecretModal(null)
    setSavedNote(`${name} saved. The session was told it is available.`)
  }

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
        {/* obj 719065 — a pasted key: offer to save it instead of sending it */}
        {candidate && !secretModal && (
          <div role="alert" className="cc-pop-in mb-2 flex flex-col gap-2 rounded-md border border-status-human/30 bg-status-human/5 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-2 text-[12.5px] text-fg-1">
              <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0 text-status-human" aria-hidden />
              <span>
                This looks like a key{candidate.suggestedName ? <> (<span className="font-mono text-fg-0">{candidate.suggestedName}</span>)</> : ''}. Save it as a secret instead of sending it as chat text?
              </span>
            </div>
            <div className="flex shrink-0 gap-1.5">
              <Button size="sm" variant="ghost" className="min-h-[44px] sm:min-h-0" onClick={() => setDismissed(d => new Set(d).add(candidate.value))}>Keep as text</Button>
              <Button size="sm" variant="primary" className="min-h-[44px] sm:min-h-0" onClick={() => setSecretModal({ candidate })}>Save as secret</Button>
            </div>
          </div>
        )}
        {savedNote && (
          <div role="status" className="mb-2 flex items-center justify-between rounded-md bg-signal-verify/10 px-3 py-1.5 text-xs text-signal-verify">
            <span>{savedNote}</span>
            <button onClick={() => setSavedNote(null)} aria-label="Dismiss" className="ml-2 grid h-8 w-8 place-items-center rounded text-signal-verify/70 transition-colors hover:bg-signal-verify/10 hover:text-signal-verify">&times;</button>
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
          {secrets && (
            <button
              type="button"
              onClick={() => setSecretModal({})}
              className="flex h-11 min-w-[44px] shrink-0 items-center justify-center gap-1 rounded-md px-2 text-[12.5px] font-medium text-fg-2 transition-[background-color,color,transform] duration-base hover:bg-surface-3 hover:text-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 active:scale-95 sm:h-9"
              title="Add a secret — saved encrypted, never shown in chat"
              aria-label="Add secret"
            >
              <KeyRound className="h-4 w-4" aria-hidden />
              <span className="hidden whitespace-nowrap sm:inline">+ Add secret</span>
            </button>
          )}
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
      {secrets && secretModal && (
        <AddSecretModal
          objectiveId={secrets.objectiveId}
          workspace={secrets.workspace}
          initialName={secretModal.candidate?.suggestedName ?? ''}
          initialValue={secretModal.candidate?.value ?? ''}
          fromPaste={!!secretModal.candidate}
          onClose={() => setSecretModal(null)}
          onSaved={onSecretSaved}
        />
      )}
    </div>
  )
}
