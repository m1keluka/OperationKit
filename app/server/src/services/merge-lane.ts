/**
 * Merge lanes — risk-tiered routing so the board does not wait on a 3-minute
 * LLM reviewer for every worker-end (2026-08-25 redesign).
 *
 *   green  — CI is the gate. Skip the tmux reviewer. Auto-done / auto-merge.
 *   yellow — keep the existing AI reviewer (UI PRs, unknown file lists).
 *   red    — human. Projects, money/auth, delegator parents.
 *
 * Cheap/fast quality: deterministic CI + floor/oracle still run. The LLM
 * reviewer is a Yellow/Red sensor, not a serial lock on Green.
 */
import type { ObjectiveType } from '@operationkit/shared'

export type MergeLane = 'green' | 'yellow' | 'red'

/** Synthetic reviewer findings when Green skips the tmux LLM session. */
export const GREEN_LANE_FINDINGS =
  'Green lane: skipped LLM reviewer. A human or the Agent API marks this done.'

const MONEY_RE = /\b(stripe|payout|commission|paypal)\b/i
const AUTH_RE = /\b(oauth|jwt|rls|pci)\b/i
const MIGRATION_RE = /\bmigrations?\b/i

export function isMoneyPath(obj: { title?: string | null; description?: string | null }): boolean {
  return MONEY_RE.test(`${obj.title || ''} ${obj.description || ''}`)
}

export function isRedLaneText(obj: { title?: string | null; description?: string | null }): boolean {
  const blob = `${obj.title || ''} ${obj.description || ''}`
  return MONEY_RE.test(blob) || AUTH_RE.test(blob) || MIGRATION_RE.test(blob)
}

export function classifyMergeLane(input: {
  type: ObjectiveType | string | null | undefined
  createPr: boolean
  delegateMode: boolean
  redPath: boolean
  /** True when we have a non-empty file list for this run. */
  filesKnown: boolean
  /** True when that list includes frontend/UI files. */
  uiTouched: boolean
}): MergeLane {
  if (input.delegateMode) return 'red'
  if (input.type === 'project') return 'red'
  if (input.redPath) return 'red'
  // UI PRs still get the Playwright reviewer. Unknown file lists fail closed
  // to yellow so a genuine UI change never skips the browser path.
  if (input.createPr && (!input.filesKnown || input.uiTouched)) return 'yellow'
  return 'green'
}
