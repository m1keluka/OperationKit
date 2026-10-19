/**
 * SessionViewer types and constants — extracted from SessionViewer.tsx
 * (behavior frozen).
 */
import type { Objective, ObjectiveStatus } from '@operationkit/shared'

export type ViewerSize = 'half' | 'full'
export const SIZE_KEY = 'ok.sessionViewer.size'
export function loadViewerSize(): ViewerSize {
  if (typeof localStorage === 'undefined') return 'half'
  return localStorage.getItem(SIZE_KEY) === 'full' ? 'full' : 'half'
}

export type ViewerChrome = 'drawer' | 'dialog' | 'page'

export interface SessionViewerProps {
  objective: Objective
  onClose: () => void
  onChangeStatus?: (id: number, status: ObjectiveStatus) => void
  /**
   * How the viewer is framed.
   * drawer (default) = production right-rail / mobile sheet.
   * dialog = centered popup (workspace preview).
   * page = fill the parent (fullscreen new tab).
   */
  chrome?: ViewerChrome
  /** When set, the expand control opens a new tab instead of stretching the drawer. */
  onOpenInNewTab?: () => void
  /** Fires when Design mode is toggled so the page shell can hide side rails. */
  onDesignModeChange?: (on: boolean) => void
  /** Opens the full edit modal (title, assignees, flags, …). */
  onEdit?: (objective: Objective) => void
}

export const VIEWER_STATUS_ACTIONS: Record<string, { label: string; target: ObjectiveStatus; variant: 'primary' | 'secondary' }[]> = {
  queue:     [{ label: 'Start',      target: 'working', variant: 'primary' }],
  ai_review: [{ label: 'Force Done', target: 'done',    variant: 'primary' }],
  review:    [
    { label: 'Done',   target: 'done',    variant: 'primary' },
    { label: 'Rework', target: 'working', variant: 'secondary' },
  ],
  done:      [{ label: 'Re-Open',    target: 'working', variant: 'secondary' }],
  cancelled: [{ label: 'Re-Open',    target: 'queue',   variant: 'secondary' }],
}

export interface UploadedFile {
  originalName: string
  path: string
  size: number
  mimetype: string
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}
