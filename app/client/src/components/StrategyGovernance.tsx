import { Modal } from './ui'
import { StrategyGovernancePanel } from './StrategyGovernancePanel'

/* ─────────────────────────────────────────────────────────
   StrategyGovernance — the Stage-0 human-confirm gate (acceptance
   criterion "gov-ui") as a center modal. The body now lives in the
   reusable <StrategyGovernancePanel> (shared with the /strategy/:id
   detail-page governance rail); this file is just the modal chrome
   around it, so the ObjectiveCard entry point keeps working.
   ───────────────────────────────────────────────────────── */

interface StrategyGovernanceProps {
  objectiveId: number
  onClose: () => void
}

export function StrategyGovernance({ objectiveId, onClose }: StrategyGovernanceProps) {
  return (
    <Modal
      open
      onClose={onClose}
      variant="center"
      labelledBy="strategy-gov-title"
      panelClassName="max-w-2xl"
    >
      <StrategyGovernancePanel objectiveId={objectiveId} onClose={onClose} className="max-h-[88vh]" />
    </Modal>
  )
}
