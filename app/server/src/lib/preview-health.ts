/**
 * Preview-tier health — pure helpers for preview-health-watchdog.ts (obj 719327).
 *
 * WHY THIS EXISTS: pr-N.cc.example.com TLS outages (Caddy site missing, the
 * cc-preview-spool drain stuck, ACME failure) were only ever discovered by a PR
 * reviewer's Playwright session burning 15-41 failed reachability probes before
 * giving up BLOCKED — no alert, no page, nothing on the board. This watches the
 * tier itself on a fixed interval instead of relying on a reviewer to stumble
 * into it.
 *
 * CANARY CHOICE: rather than a dedicated always-on synthetic host (one more
 * thing to deploy/maintain), probe the MOST RECENTLY UPDATED still-open PR
 * against this repo (project='operationkit', pr_number set, status not
 * done/cancelled) — i.e. whatever preview SHOULD currently be live. When none
 * exists there is nothing to probe and the watchdog reports 'unknown', not
 * 'down' — no open PR is not an outage.
 */
import type { Database } from 'better-sqlite3'

export interface PreviewCanary {
  objectiveId: number
  prNumber: number
  title: string
  updatedAt: string
}

/** Project value stamped on every objective that previews on this host (see db/index.ts). */
export const PREVIEW_CANARY_PROJECT = 'operationkit'

/**
 * The most recently touched open PR against this repo — the preview a healthy
 * tier should currently be serving. Returns null when no open PR has a preview
 * candidate (nothing to probe right now, not a failure).
 */
export function pickPreviewCanary(db: Database): PreviewCanary | null {
  const row = db
    .prepare(
      `SELECT id, pr_number, title, updated_at
         FROM objectives
        WHERE project = ?
          AND pr_number IS NOT NULL
          AND pr_number > 0
          AND status NOT IN ('done', 'cancelled')
        ORDER BY updated_at DESC
        LIMIT 1`,
    )
    .get(PREVIEW_CANARY_PROJECT) as
    | { id: number; pr_number: number; title: string; updated_at: string }
    | undefined
  if (!row) return null
  return { objectiveId: row.id, prNumber: row.pr_number, title: row.title, updatedAt: row.updated_at }
}

export function previewHostFor(prNumber: number): string {
  return `pr-${prNumber}.cc.example.com`
}

export type PreviewProbeResult = { ok: boolean; httpCode: number | null; ms: number | null; error: string | null }

export type PreviewHealthStatus = 'up' | 'down' | 'unknown'

/** No canary to probe right now ('unknown') vs a probe that ran and either succeeded or didn't. */
export function derivePreviewStatus(canary: PreviewCanary | null, probe: PreviewProbeResult | null): PreviewHealthStatus {
  if (!canary || !probe) return 'unknown'
  return probe.ok ? 'up' : 'down'
}
