import type { ObjectiveStatus, ObjectiveType, EffortLevel } from './types-core.js'

const TRANSITIONS_BY_TYPE: Record<ObjectiveType, Partial<Record<ObjectiveStatus, ObjectiveStatus[]>>> = {
  // `cancelled` (obj 700595) — soft-retire, reachable from every non-terminal
  // state and reopenable to `working`. Distinct from `done` (which asserts
  // completed work); see the ObjectiveStatus comment in types.ts.
  project: {
    planning:  ['queue', 'working', 'done', 'cancelled'],
    queue:     ['planning', 'working', 'done', 'cancelled'],
    working:   ['ai_review', 'review', 'done', 'cancelled'],
    ai_review: ['working', 'review', 'done', 'cancelled'],
    review:    ['working', 'ai_review', 'done', 'cancelled'],
    done:      ['working'],
    cancelled: ['working', 'queue'],
  },
  bug: {
    planning:  [],
    queue:     ['working', 'done', 'cancelled'],
    working:   ['ai_review', 'review', 'done', 'cancelled'],
    ai_review: ['working', 'review', 'done', 'cancelled'],
    review:    ['working', 'ai_review', 'done', 'cancelled'],
    done:      ['working'],
    cancelled: ['working', 'queue'],
  },
  task: {
    planning:  [],
    queue:     ['working', 'done', 'cancelled'],
    working:   ['done', 'review', 'cancelled'],
    ai_review: ['working', 'done', 'cancelled'],
    review:    ['working', 'done', 'cancelled'],
    done:      ['working'],
    cancelled: ['working', 'queue'],
  },
}

export function isTransitionAllowed(
  type: ObjectiveType | null | undefined,
  from: ObjectiveStatus,
  to: ObjectiveStatus,
): boolean {
  const t: ObjectiveType = type ?? 'task'
  return TRANSITIONS_BY_TYPE[t][from]?.includes(to) ?? false
}

export function allowedTransitions(
  type: ObjectiveType | null | undefined,
  from: ObjectiveStatus,
): ObjectiveStatus[] {
  const t: ObjectiveType = type ?? 'task'
  return TRANSITIONS_BY_TYPE[t][from] ?? []
}

export function getInitialStatus(type: ObjectiveType): ObjectiveStatus {
  return type === 'project' ? 'planning' : 'queue'
}

// (obj 708817) DEFAULT_TYPE_BY_CATEGORY was removed with the create-form
// simplification: it existed solely to seed the modal's `type` select from the
// modal's `category` select, and neither control exists any more. `type` now
// defaults to 'task' server-side. OBJECTIVE_CATEGORIES / ObjectiveCategory stay
// — historical rows still carry a category and read views still render it.

export const DEFAULT_EFFORT_BY_TYPE: Record<ObjectiveType, EffortLevel> = {
  project: 'high',
  bug:     'normal',
  task:    'normal',
}

// `type` is an orthogonal KIND-OF-WORK tag (project/bug/task), NOT a hierarchy
// tier. The tier of a row is Strategy > Objective > Sub-objective (a Strategy
// carries the stored is_strategy marker; see STRATEGY_BADGE below and
// docs/terminology-glossary.md). Keep these two axes distinct in the UI.
export const TYPE_LABELS: Record<ObjectiveType, { label: string; cls: string; description: string }> = {
  project: { label: 'PROJECT', cls: 'bg-purple-500/20 text-purple-300 border-purple-500/30', description: 'Full planning + AI review + human sign-off' },
  bug:     { label: 'BUG',     cls: 'bg-red-500/20 text-red-300 border-red-500/30',          description: 'AI-reviewed fix, no human gate' },
  task:    { label: 'TASK',    cls: 'bg-gray-500/20 text-gray-300 border-gray-500/30',       description: 'Light — no review gates' },
}

// Tier badge for the canonical top of the hierarchy. Rendered from the stored
// is_strategy marker (obj 2383), on a separate visual axis from TYPE_LABELS.
export const STRATEGY_BADGE = {
  label: 'STRATEGY',
  cls: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
  description: 'Persistent top-level delegator that owns sub-objectives + jobs and re-wakes to decide',
} as const

// Provenance badges (obj 2386). Render from the stored `origin` column to
// visibly distinguish HOW an objective came to exist. 'manual' is the default
// and intentionally has NO badge (it's the unmarked baseline — badging every
// hand-created row would just add noise); the non-manual origins each get a
// distinct chip so a strategy-invoked objective reads differently from a manual
// one at a glance. Keyed by ObjectiveOrigin; look up with ORIGIN_BADGES[origin].
export const ORIGIN_BADGES: Record<string, { label: string; cls: string; description: string }> = {
  strategy:  { label: 'STRATEGY-INVOKED', cls: 'bg-amber-500/15 text-amber-200 border-amber-500/25', description: 'Decomposed/spawned by a Strategy (delegator), not created by hand' },
  routine:   { label: 'ROUTINE',          cls: 'bg-sky-500/15 text-sky-200 border-sky-500/25',       description: 'Spawned automatically by a recurring routine (a job)' },
  job_reply: { label: 'FROM JOB',         cls: 'bg-teal-500/15 text-teal-200 border-teal-500/25',     description: "Spawned from a job's in-thread reply" },
} as const

/** Machine still owns this row. `review` is the human gate and is not in-flight. */
export const IN_FLIGHT_STATUSES: readonly ObjectiveStatus[] = ['planning', 'queue', 'working', 'ai_review']

export function isInFlightStatus(status: string | null | undefined): boolean {
  return status === 'planning' || status === 'queue' || status === 'working' || status === 'ai_review'
}
