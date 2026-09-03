/**
 * Loops page types, constants, and helpers — extracted from LoopsPage.tsx
 * (behavior frozen).
 */
import type { PipelineStatus } from '../ui'

// Board lanes (the Kanban) are queued|working|done. 'pending' is a pre-board
// review lane (auto-detected loops awaiting approve/deny) surfaced separately
// above the board — never rendered as a Kanban column.
export type LoopStatus = 'queued' | 'working' | 'done'
export type LoopStatusAny = LoopStatus | 'pending'
export type Project = '' | 'example' | 'example2' | 'example5' | 'example-project' | 'personal'

export interface Loop {
  slug: string
  title: string
  status: LoopStatusAny
  project: Project
  party: string // "People" in the UI — who else is involved (optional)
  party_type: string
  due: string // YYYY-MM-DD or ''
  tags: string[]
  source_meeting: string
  source_note: string
  opened: string // CREATED date
  closed: string // DONE date (only when status=done)
  body: string
}

export interface BulkResult {
  ok: boolean
  results: Array<{ slug: string; ok: boolean; error?: string }>
}

export const ALL = '__all__'

export const STATUSES: LoopStatus[] = ['queued', 'working', 'done']
export const STATUS_LABEL: Record<LoopStatus, string> = { queued: 'Queued', working: 'Working', done: 'Done' }

export const PROJECT_KEYS: Exclude<Project, ''>[] = ['example', 'example2', 'example5', 'example-project', 'personal']
export const PROJECT_LABEL: Record<Project, string> = {
  '': '—',
  example: 'Example',
  example2: 'EXAMPLE2',
  'example5': 'Example Dental Lab',
  'example-project': 'Example Project',
  personal: 'Personal',
}
// Loop lane status → canonical pipeline status (for StatusPill).
export const STATUS_PIPELINE: Record<LoopStatus, PipelineStatus> = {
  queued: 'queue',
  working: 'working',
  done: 'done',
}

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
}
export function isOverdue(loop: Loop): boolean {
  return loop.status !== 'done' && !!loop.due && loop.due < todayISO()
}
