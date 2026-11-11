/**
 * Loops review queue (pending) — extracted from LoopsPage.tsx (behavior frozen).
 *
 * Auto-detected loops land in `pending` and wait here for a human decision. The
 * queue is an unobtrusive, COLLAPSED counter-tab by default ("N loops in queue")
 * that expands on click to list the pending loops. Per-loop actions:
 *   Accept → /approve (moves to `queued`, onto the board);
 *   Ignore → /deny (archives, reversible).
 * When there are no pending loops the tab is hidden entirely.
 */
import { useState, useCallback } from 'react'
import { Card, Button, Badge, cn } from '../ui'
import { PROJECT_LABEL, type Loop } from './types'

export function ReviewQueue({
  loops,
  onApprove,
  onDeny,
}: {
  loops: Loop[]
  onApprove: (slug: string) => Promise<void>
  onDeny: (slug: string) => Promise<void>
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)

  const act = useCallback(
    async (slug: string, fn: (s: string) => Promise<void>) => {
      setBusy(slug)
      try {
        await fn(slug)
      } finally {
        setBusy(null)
      }
    },
    [],
  )

  // Empty state: hide the tab entirely — no big empty panel above the board.
  if (loops.length === 0) return null

  return (
    <section className="mb-6">
      {/* Collapsed counter-tab. Click toggles the pending list open/closed. */}
      <button
        type="button"
        onClick={() => setExpanded(e => !e)}
        aria-expanded={expanded}
        className={cn(
          'flex w-full items-center gap-2 rounded-md border border-line-soft bg-surface-2 px-3 py-2 text-left',
          'transition-colors duration-fast hover:border-line focus:border-accent focus:outline-none',
        )}
      >
        <span className="font-mono text-[10px] leading-none text-fg-3">{expanded ? '▾' : '▸'}</span>
        <h2 className="font-display text-sm font-semibold tracking-[-0.01em] text-fg-0">
          {loops.length} loop{loops.length === 1 ? '' : 's'} in queue
        </h2>
        <Badge tone="accent" mono>{loops.length}</Badge>
        <span className="ml-auto font-mono text-[10px] text-fg-3">
          auto-detected — {expanded ? 'accept to add, ignore to dismiss' : 'click to review'}
        </span>
      </button>

      {expanded && (
        <div className="mt-2.5 flex flex-col gap-2.5">
          {loops.map(loop => (
            <Card key={loop.slug} className="p-3">
              <div className="flex flex-wrap items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="font-display text-sm font-semibold leading-snug tracking-[-0.01em] text-fg-0">
                    {loop.title}
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    {loop.project && <Badge tone="neutral" mono>{PROJECT_LABEL[loop.project]}</Badge>}
                    {loop.party && <Badge tone="neutral" mono>{loop.party}</Badge>}
                    {loop.tags.map(t => (
                      <Badge key={t} tone="neutral" mono>{t}</Badge>
                    ))}
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 font-mono text-[10px] text-fg-3">
                    <span>Detected {loop.opened || '—'}</span>
                    {loop.source_meeting && <span>from meeting</span>}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={busy === loop.slug}
                    onClick={() => act(loop.slug, onApprove)}
                  >
                    {busy === loop.slug ? '…' : 'Accept'}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy === loop.slug}
                    onClick={() => act(loop.slug, onDeny)}
                  >
                    Ignore
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </section>
  )
}
