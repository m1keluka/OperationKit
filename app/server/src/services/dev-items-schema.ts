/**
 * Universal Development vocabularies, row types, and DB helpers —
 * extracted from dev-items.ts (behavior frozen).
 *
 * No listing queries, no writes. scopedDevItems stays in dev-items-query.ts.
 */
import type Database from 'better-sqlite3'
import { getDb } from '../db/index.js'

// ── Canonical vocabularies (schema §2.1) ────────────────────────────────────

export const DEV_ITEM_TYPES = ['bug', 'feature', 'improvement', 'chore'] as const
export const DEV_ITEM_STATUSES = [
  'new',
  'triaged',
  'planned',
  'in_progress',
  'shipped',
  'declined',
  'duplicate',
] as const
export const DEV_ITEM_SEVERITIES = ['blocker', 'high', 'medium', 'low'] as const
export const DEV_SUBMITTED_VIA = ['widget', 'admin', 'api', 'import'] as const
export const DEV_NOTE_VISIBILITIES = ['internal', 'submitter'] as const
export const DEV_PR_STATES = ['open', 'merged', 'closed'] as const
export const DEV_PR_LINK_SOURCES = ['manual', 'pr_body', 'objective'] as const
export const CHANGELOG_CATEGORIES = ['feature', 'fix', 'improvement', 'infra'] as const

export type DevItemType = (typeof DEV_ITEM_TYPES)[number]
export type DevItemStatus = (typeof DEV_ITEM_STATUSES)[number]
export type DevItemSeverity = (typeof DEV_ITEM_SEVERITIES)[number]
export type DevSubmittedVia = (typeof DEV_SUBMITTED_VIA)[number]
export type DevNoteVisibility = (typeof DEV_NOTE_VISIBILITIES)[number]
export type DevPrState = (typeof DEV_PR_STATES)[number]
export type DevPrLinkSource = (typeof DEV_PR_LINK_SOURCES)[number]

/** The three statuses that mean "closed" — they stamp/clear `closed_at`. */
export const CLOSED_STATUSES = new Set<DevItemStatus>(['shipped', 'declined', 'duplicate'])

/** Human labels for P3, which must not leak internal triage vocabulary. */
const STATUS_LABELS: Record<DevItemStatus, string> = {
  new: 'Received',
  triaged: 'Under review',
  planned: 'Planned',
  in_progress: 'In progress',
  shipped: 'Shipped',
  declined: 'Not planned',
  duplicate: 'Duplicate',
}

export function statusLabel(status: string): string {
  return STATUS_LABELS[status as DevItemStatus] ?? status
}

export interface DevItemRow {
  id: number
  workspace: string
  project: string | null
  type: DevItemType
  title: string
  description: string
  steps_to_repro: string | null
  status: DevItemStatus
  severity: DevItemSeverity | null
  impact: number | null
  effort: number | null
  priority_rank: number | null
  area: string | null
  duplicate_of_id: number | null
  submitter_platform_user_id: string | null
  submitter_email: string | null
  submitter_label: string | null
  submitted_via: DevSubmittedVia
  posthog_session_id: string | null
  posthog_replay_url: string | null
  console_log: string | null
  route_history: string
  client_meta: string
  screenshot_path: string | null
  route: string | null
  loom_url: string | null
  loom_transcript: string | null
  objective_id: number | null
  promoted_at: string | null
  changelog_entry_id: number | null
  source_system: string
  source_table: string | null
  source_id: string | null
  legacy_ref: string
  triaged_by: string | null
  triaged_at: string | null
  closed_at: string | null
  deleted_at: string | null
  created_at: string
  updated_at: string
}

/** A board row: the item plus the joins the UI always needs (schema §3). */
export interface DevItemBoardRow extends DevItemRow {
  objective_status: string | null
  branch_name: string | null
  objective_pr_url: string | null
  note_count: number
  attachment_count: number
  changelog_status: string | null
  workspace_name: string | null
  workspace_label: string | null
  workspace_badge_color: string | null
}

export function db(): Database.Database {
  return getDb()
}

/** `DEV-<id>` — the human handle the PR-body convention depends on (schema D16). */
export function devRef(id: number): string {
  return `DEV-${id}`
}

export function nowIso(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19)
}

