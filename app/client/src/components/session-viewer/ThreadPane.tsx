/**
 * Thread pane (timeline + empty states + optimistic echo) — extracted from
 * SessionViewer.tsx (behavior frozen).
 */
import type { RefObject } from 'react'
import type { ObjectiveStatus } from '@operationkit/shared'
import { ThreadTimeline } from '../ThreadTimeline'
import { ThinkingIndicator } from '../design/primitives'
import type { ConnState } from '../ConnStatusPill'

export function ThreadPane({
  scrollRef,
  threadHasContent,
  isActive,
  objectiveId,
  status,
  onStatus,
  onContentChange,
  onConnState,
  pendingEcho,
  onEchoLanded,
}: {
  scrollRef: RefObject<HTMLDivElement | null>
  threadHasContent: boolean
  isActive: boolean
  objectiveId: number
  status: ObjectiveStatus
  onStatus: (status: string) => void
  onContentChange: () => void
  onConnState: (s: ConnState) => void
  pendingEcho: string | null
  onEchoLanded?: () => void
}) {
  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto select-text">
      <div className="max-w-4xl mx-auto px-3 py-4 space-y-2">
        {/* Flex spacer to push messages to bottom */}
        <div className="flex-1" />
        {!threadHasContent && isActive && (
          <div className="mt-16 flex flex-col items-center justify-center gap-3">
            <ThinkingIndicator variant="dots" tone="accent" />
            <div className="text-sm text-fg-2">Session starting…</div>
          </div>
        )}
        {!threadHasContent && !isActive && (
          <div className="mt-8 text-center text-sm text-fg-3">No session output</div>
        )}
        {/* Collapsed thread: visible anchors + lazily-expandable action gaps. */}
        <ThreadTimeline
          objectiveId={objectiveId}
          status={status}
          onStatus={onStatus}
          scrollContainerRef={scrollRef}
          onContentChange={onContentChange}
          onConnState={onConnState}
          pendingEcho={pendingEcho}
          onEchoLanded={onEchoLanded}
        />
        {/* Optimistic echo of the just-sent follow-up (OK-13). Mirrors the
            `followup` user bubble in SessionMessages.tsx so it reads identically
            once the real message lands and this is retired. */}
        {pendingEcho && (
          <div className="cc-land my-1 flex justify-end">
            <div
              className="overflow-hidden break-words rounded-lg bg-accent px-4 py-3 text-[14px] leading-relaxed text-accent-fg"
              style={{ maxWidth: 'min(85%, 64ch)' }}
            >
              {pendingEcho}
            </div>
          </div>
        )}
        {/* Activity indicator — single thinking language across the app. */}
        {isActive && threadHasContent && (
          <div className="pb-2 pl-2 pt-1">
            <ThinkingIndicator variant="dots" tone="status-working" label="Working…" />
          </div>
        )}
      </div>
    </div>
  )
}
