/**
 * Delete / reopen / cancel / submit — extracted from ObjectiveModal.tsx
 * (behavior frozen).
 */
import type { Objective } from '@operationkit/shared'

export function FooterActions({
  isEdit,
  loading,
  uploading,
  descHydrated,
  objective,
  onDelete,
  onClose,
  onReopen,
}: {
  isEdit: boolean
  loading: boolean
  uploading: boolean
  descHydrated: boolean
  objective: Objective | null
  onDelete: () => void
  onClose: () => void
  onReopen?: (id: number) => void
}) {
  return (
    <div className="flex items-center justify-between border-t border-line-soft pt-3">
      {isEdit ? (
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onDelete}
            disabled={loading}
            className="rounded-md px-3 py-2 text-sm text-flag-blocked transition-colors duration-fast ease-out hover:bg-flag-blocked/10"
          >
            Delete
          </button>
          {/* Re-Open a terminal-state objective (obj 702389) — the reopen
              path for a DONE/cancelled objective found via search. Target
              is 'queue' per VALID_TRANSITIONS (done/cancelled → queue). */}
          {onReopen && objective && (objective.status === 'done' || objective.status === 'cancelled') && (
            <button
              type="button"
              onClick={() => onReopen(objective.id)}
              disabled={loading}
              className="rounded-md px-3 py-2 text-sm text-fg-1 transition-colors duration-fast ease-out hover:bg-surface-3 hover:text-fg-0"
            >
              Re-Open
            </button>
          )}
        </div>
      ) : (
        <div />
      )}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md px-4 py-2 text-sm text-fg-1 transition-colors duration-fast ease-out hover:bg-surface-3 hover:text-fg-0"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={loading || !descHydrated}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg transition-colors duration-fast ease-out hover:bg-accent-hover active:bg-accent-press disabled:opacity-50 min-h-[36px]"
        >
          {uploading ? 'Uploading…' : loading ? 'Saving…' : !descHydrated ? 'Loading…' : isEdit ? 'Update' : 'Create'}
        </button>
      </div>
    </div>
  )
}
