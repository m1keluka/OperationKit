/**
 * Loop bulk-action bar — extracted from LoopsPage.tsx (behavior frozen).
 */
import { Button } from '../ui'
import { STATUSES, STATUS_LABEL, type LoopStatus } from './types'

export function BulkActionBar({
  count,
  busy,
  onMove,
  onArchive,
  onClear,
}: {
  count: number
  busy: boolean
  onMove: (status: LoopStatus) => void
  onArchive: () => void
  onClear: () => void
}) {
  return (
    <div className="sticky bottom-0 z-30 mt-3 border-t border-line bg-surface-1 px-3 py-2.5 md:bottom-auto md:top-0 md:mt-0 md:mb-3 md:rounded-lg md:border md:px-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs font-semibold text-fg-0">
          {count} selected
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <label className="relative">
            <span className="sr-only">Move selected to lane</span>
            <select
              value=""
              disabled={busy}
              onChange={e => {
                const v = e.target.value as LoopStatus
                if (v) onMove(v)
                e.target.value = ''
              }}
              className="min-h-[44px] rounded-md border border-line bg-surface-2 px-3 py-2 text-xs font-medium text-fg-1 outline-none transition-colors duration-fast hover:bg-surface-3 focus:border-accent disabled:opacity-45 sm:min-h-[36px]"
            >
              <option value="" disabled>
                Move to ▾
              </option>
              {STATUSES.map(s => (
                <option key={s} value={s}>{STATUS_LABEL[s]}</option>
              ))}
            </select>
          </label>
          <Button variant="danger" size="sm" onClick={onArchive} disabled={busy} leftIcon={<span aria-hidden>🗑</span>}>
            Archive
          </Button>
          <Button variant="secondary" size="sm" onClick={onClear} disabled={busy}>
            Clear
          </Button>
        </div>
      </div>
    </div>
  )
}
