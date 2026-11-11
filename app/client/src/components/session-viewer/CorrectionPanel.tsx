/**
 * Flag-mistake correction surface — extracted from SessionViewer.tsx
 * (behavior frozen).
 */
import { Button } from '../ui'

export function CorrectionPanel({
  correctionText,
  setCorrectionText,
  correctionError,
  setCorrectionError,
  setShowCorrection,
  submitCorrection,
  submittingCorrection,
}: {
  correctionText: string
  setCorrectionText: (v: string) => void
  correctionError: string | null
  setCorrectionError: (v: string | null) => void
  setShowCorrection: (v: boolean) => void
  submitCorrection: () => void
  submittingCorrection: boolean
}) {
  return (
    <div className="border-b border-line bg-status-review/5">
      <div className="px-4 py-3 sm:px-5 space-y-2">
        <label className="block text-[11px] font-medium text-fg-2">
          What did this session get wrong? This becomes a high-priority gotcha injected into the next spawn for this objective.
        </label>
        <textarea
          value={correctionText}
          onChange={e => setCorrectionText(e.target.value)}
          rows={3}
          maxLength={2000}
          placeholder="e.g. Edited the live checkout instead of an isolated worktree — always branch first."
          className="w-full resize-y rounded-md border border-line bg-surface-1 px-3 py-2 text-base text-fg-0 placeholder:text-fg-3 focus:border-accent focus:outline-none sm:text-[13px]"
        />
        {correctionError && <div className="text-[11px] text-flag-blocked">{correctionError}</div>}
        <div className="flex items-center justify-end gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => { setShowCorrection(false); setCorrectionError(null) }}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={submitCorrection}
            disabled={!correctionText.trim() || submittingCorrection}
          >
            {submittingCorrection ? 'Submitting…' : 'Submit correction'}
          </Button>
        </div>
      </div>
    </div>
  )
}
