/**
 * GET /api/system/disk — host-disk state for the dashboard low-disk banner (obj 718070).
 *
 * Reads the disk watchdog's last tick (5 min cadence) rather than shelling out to
 * df per request; falls back to a fresh read when the watchdog has not ticked.
 * Any authenticated user may read it — it is the same number the AlertBell pages.
 */
import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { readDiskStateNow, type DiskWatchdogState } from '../services/disk-watchdog.js'
import { freePct, type DiskAction } from '../lib/host-disk.js'
import { getPreviewHealthState, type PreviewHealthState } from '../services/preview-health-watchdog.js'

export interface SystemDiskResponse {
  usedPct: number | null
  freePct: number | null
  availBytes: number | null
  totalBytes: number | null
  low: boolean
  action: DiskAction
  checkedAt: string
}

export function toSystemDiskResponse(state: DiskWatchdogState): SystemDiskResponse {
  const d = state.disk
  return {
    usedPct: d ? d.usedPct : null,
    freePct: d ? Math.round(freePct(d) * 10) / 10 : null,
    availBytes: d ? d.availBytes : null,
    totalBytes: d ? d.totalBytes : null,
    low: state.low,
    action: state.action,
    checkedAt: state.checkedAt,
  }
}

export interface SystemPreviewHealthResponse {
  status: 'up' | 'down' | 'unknown'
  prNumber: number | null
  previewUrl: string | null
  httpCode: number | null
  error: string | null
  checkedAt: string | null
}

export function toSystemPreviewHealthResponse(state: PreviewHealthState | null): SystemPreviewHealthResponse {
  if (!state) return { status: 'unknown', prNumber: null, previewUrl: null, httpCode: null, error: null, checkedAt: null }
  return {
    status: state.status,
    prNumber: state.canary?.prNumber ?? null,
    previewUrl: state.canary ? `https://pr-${state.canary.prNumber}.cc.example.com` : null,
    httpCode: state.probe?.httpCode ?? null,
    error: state.probe?.error ?? null,
    checkedAt: state.checkedAt,
  }
}

export function createSystemRouter(
  read: () => DiskWatchdogState = readDiskStateNow,
  readPreviewHealth: () => PreviewHealthState | null = getPreviewHealthState,
): Router {
  const router: Router = Router()
  router.use(requireAuth)
  router.get('/disk', (_req, res) => {
    try {
      res.json(toSystemDiskResponse(read()))
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'disk read failed' })
    }
  })
  router.get('/preview-health', (_req, res) => {
    try {
      res.json(toSystemPreviewHealthResponse(readPreviewHealth()))
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'preview-health read failed' })
    }
  })
  return router
}

export default createSystemRouter()
