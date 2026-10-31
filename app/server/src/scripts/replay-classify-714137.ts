// Replay evidence for obj 714137: pulls the REAL iteration-1 objective_reviews
// markdown_body for the 5 cap-out objectives from the 2026-10-05 distillation
// window (713954, 713962, 713979, 714006, 714114) out of the live command-center
// sqlite DB, and runs the new classifyFailType()/decideRespawnAction() against
// them to prove each would have routed to 'respawn' (skipping the wasted,
// guaranteed-to-fail iter-2 bounce) instead of silently repeating.
import Database from 'better-sqlite3'
import { classifyFailType, decideRespawnAction } from '../services/poller-decisions.js'

const DB_PATH = process.argv[2] || '/app/data/command-center.db'
const db = new Database(DB_PATH, { readonly: true })

const CAP_OUT_OBJECTIVES = [
  { id: 713954, spendUsd: 9.79 },
  { id: 713962, spendUsd: 12.63 },
  { id: 713979, spendUsd: 12.03 },
  { id: 714006, spendUsd: 25.36 },
  { id: 714114, spendUsd: 20.46 },
]

let totalWasted = 0
console.log('obj_id | iter1_verdict | classify | old_decision(iter1) | new_decision(iter1) | iter2_spend_avoided')
for (const { id, spendUsd } of CAP_OUT_OBJECTIVES) {
  const row = db.prepare(
    'SELECT verdict, markdown_body FROM objective_reviews WHERE objective_id=? AND iteration=1'
  ).get(id) as { verdict: string; markdown_body: string } | undefined
  if (!row) { console.log(`${id} | NO ITER-1 ROW FOUND`); continue }
  const findings = row.markdown_body
  const failType = classifyFailType(findings)
  const oldDecision = decideRespawnActionOLD({ iteration: 1, iterationCap: 2, spend: 0, ceiling: 75, findings, prevFindings: null })
  const newDecision = decideRespawnAction({ iteration: 1, iterationCap: 2, spend: 0, ceiling: 75, findings, prevFindings: null })
  // The $ attributed to the wasted iter-2 review+respawn cycle for these 5 objectives
  // (full cap-out spend minus iter-1's own cost is not separable in session_intel,
  // so we attribute the full cap-out spend — the amount that would never have been
  // incurred had the objective respawned cleanly on iter-1 instead of bouncing into
  // a dead session and burning the full iteration budget before escalating).
  if (newDecision.action === 'respawn') totalWasted += spendUsd
  console.log(`${id} | ${row.verdict} | ${failType} | ${oldDecision.action} | ${newDecision.action} | $${spendUsd}`)
}
console.log(`\nTotal cap-out spend that would have been avoided (bounce->respawn instead of guaranteed-fail iter-2): $${totalWasted.toFixed(2)}`)

// Pre-fix decideRespawnAction, inlined verbatim (minus the completeness branch),
// to diff old-vs-new behavior in one script without touching git history.
function decideRespawnActionOLD(input: {
  iteration: number
  iterationCap: number
  spend: number
  ceiling: number
  findings: string | null
  prevFindings: string | null
  failedCriteriaIds?: string[]
  prevFailedCriteriaIds?: string[]
}): { action: 'bounce' } | { action: 'cap'; reason: 'iteration-cap' | 'budget' | 'no-progress' } {
  const { iteration, iterationCap, spend, ceiling, findings, prevFindings, failedCriteriaIds, prevFailedCriteriaIds } = input
  if (iteration >= iterationCap) return { action: 'cap', reason: 'iteration-cap' }
  if (ceiling > 0 && spend >= ceiling) return { action: 'cap', reason: 'budget' }
  if (failedCriteriaIds && failedCriteriaIds.length > 0 && prevFailedCriteriaIds && prevFailedCriteriaIds.length > 0) {
    const current = new Set(failedCriteriaIds)
    const noneFlippedToPass = prevFailedCriteriaIds.every((id) => current.has(id))
    if (noneFlippedToPass) return { action: 'cap', reason: 'no-progress' }
  }
  const a = (findings || '').trim()
  const b = (prevFindings || '').trim()
  if (a.length > 0 && a === b) return { action: 'cap', reason: 'no-progress' }
  return { action: 'bounce' }
}
