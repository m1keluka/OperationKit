import { useEffect, useRef } from 'react'
import type { SessionMessage, MentorSessionState } from '@operationkit/shared'
import { GroupedMessages } from '../SessionMessages'
import { WelcomeState } from './WelcomeState'

interface MessageListProps {
  messages: SessionMessage[]
  state: MentorSessionState
  loading: boolean
  /** Optimistic user follow-up shown immediately while waiting for the JSONL log to catch up */
  pendingUser?: string | null
  errorMessage?: string | null
  onRetry?: () => void
  /** The user's configured assistant name; falls back to 'Assistant' when unset. */
  assistantName?: string
  /** Prefill the composer from a welcome-state quick-start chip. */
  onPickStarter?: (prompt: string) => void
}

export function MessageList({ messages, state, loading, pendingUser, errorMessage, onRetry, assistantName = 'Assistant', onPickStarter }: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const prevSignatureRef = useRef('')
  const lockedToBottomRef = useRef(true)
  const prevPendingUserRef = useRef<string | null | undefined>(undefined)

  // Track whether the user has scrolled up. Re-lock when they return to bottom.
  // Runs after every render (no deps) so scrollRef.current is always fresh.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => {
      lockedToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 50
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  })

  // Auto-scroll on new content, but only when locked to bottom.
  // Re-lock when the user sends a new message (pendingUser goes falsy → truthy).
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const sig = `${messages.length}:${pendingUser || ''}:${state}:${messages.at(-1)?.text?.slice(0, 40) || ''}`
    if (sig !== prevSignatureRef.current) {
      const isFirstRender = !prevSignatureRef.current
      if (!prevPendingUserRef.current && pendingUser) {
        lockedToBottomRef.current = true
      }
      prevPendingUserRef.current = pendingUser
      if (isFirstRender || lockedToBottomRef.current) el.scrollTop = el.scrollHeight
      prevSignatureRef.current = sig
    }
  }, [messages, pendingUser, state])

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-fg-3">
        Loading transcript...
      </div>
    )
  }

  const isEmpty = messages.length === 0 && !pendingUser

  return (
    <div ref={scrollRef} className="h-full overflow-y-auto px-4 py-5 sm:px-6">
      {isEmpty ? (
        <WelcomeState assistantName={assistantName} onPick={(p) => onPickStarter?.(p)} />
      ) : (
        <div className="mx-auto flex max-w-prose flex-col gap-1">
          <GroupedMessages messages={messages} />

          {pendingUser && (
            <div className="my-1 flex justify-end">
              <div
                className="overflow-hidden whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-accent px-4 py-2.5 text-sm leading-relaxed text-accent-fg opacity-70 shadow-pop"
                style={{ maxWidth: 'min(85%, 64ch)' }}
              >
                {pendingUser}
              </div>
            </div>
          )}

          {state === 'working' && (
            <div className="my-1 flex justify-start">
              <div className="flex items-center gap-2 rounded-2xl rounded-bl-md border border-line bg-surface-2 px-4 py-3 text-sm text-fg-2">
                <span className="flex items-end gap-1" aria-hidden="true">
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent" style={{ animationDuration: '1s' }} />
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent" style={{ animationDuration: '1s', animationDelay: '150ms' }} />
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent" style={{ animationDuration: '1s', animationDelay: '300ms' }} />
                </span>
                <span className="ml-1 text-xs text-fg-3">{assistantName} is thinking…</span>
              </div>
            </div>
          )}

          {errorMessage && (
            <div className="my-1 flex justify-start">
              <div className="rounded-lg border border-signal-alarm/30 bg-signal-alarm/10 px-4 py-3 text-sm text-fg-1">
                <div className="font-medium text-signal-alarm">Send failed</div>
                <div className="mt-0.5 text-xs text-fg-2">{errorMessage}</div>
                {onRetry && (
                  <button
                    onClick={onRetry}
                    className="mt-2 rounded-md border border-signal-alarm/30 bg-signal-alarm/10 px-3 py-1.5 text-xs font-medium text-signal-alarm transition-colors hover:bg-signal-alarm/20"
                  >
                    Retry
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
