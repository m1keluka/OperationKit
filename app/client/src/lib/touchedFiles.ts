import type { SessionIntel } from '@operationkit/shared'

export type TouchedFileKind = 'created' | 'modified' | 'attachment'

export interface TouchedFile {
  path: string
  name: string
  lastTouchedAt: string
  kind: TouchedFileKind
  sessionId?: string
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  const i = trimmed.lastIndexOf('/')
  return i >= 0 ? trimmed.slice(i + 1) : trimmed
}

function asList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown
      return asList(parsed)
    } catch {
      return value.trim() ? [value] : []
    }
  }
  return []
}

/**
 * Union session_intel created/modified paths across sessions.
 * Last write wins: a later session's touch replaces an earlier one.
 * Recency is the session `ended_at` (fallback started_at / created_at).
 */
export function filesFromIntel(intel: SessionIntel[]): TouchedFile[] {
  const byPath = new Map<string, TouchedFile>()
  const rows = [...intel].sort((a, b) => {
    const at = a.ended_at || a.started_at || a.created_at || ''
    const bt = b.ended_at || b.started_at || b.created_at || ''
    return at.localeCompare(bt)
  })
  for (const row of rows) {
    const when = row.ended_at || row.started_at || row.created_at
    if (!when) continue
    for (const path of asList(row.files_created)) {
      byPath.set(path, {
        path,
        name: basename(path),
        lastTouchedAt: when,
        kind: 'created',
        sessionId: row.session_id,
      })
    }
    for (const path of asList(row.files_modified)) {
      byPath.set(path, {
        path,
        name: basename(path),
        lastTouchedAt: when,
        kind: 'modified',
        sessionId: row.session_id,
      })
    }
  }
  return [...byPath.values()].sort((a, b) => b.lastTouchedAt.localeCompare(a.lastTouchedAt) || a.path.localeCompare(b.path))
}

export function mergeAttachments(
  files: TouchedFile[],
  uploads: Array<{ name: string; path: string; modifiedAt?: string }>,
): TouchedFile[] {
  const extra: TouchedFile[] = uploads.map(u => ({
    path: u.path,
    name: u.name,
    lastTouchedAt: u.modifiedAt || '',
    kind: 'attachment' as const,
  }))
  return [...files, ...extra].sort((a, b) => {
    if (a.lastTouchedAt && b.lastTouchedAt) return b.lastTouchedAt.localeCompare(a.lastTouchedAt)
    if (a.lastTouchedAt) return -1
    if (b.lastTouchedAt) return 1
    return a.name.localeCompare(b.name)
  })
}
