/**
 * Secrets table row — extracted from SecretsPage.tsx (behavior frozen).
 */
import type { SecretSummary } from '@operationkit/shared'
import {
  BADGE_BASE, MASK, SCOPE_HINTS, SCOPE_TONES, scopeBadgeLabel,
} from './scope'

interface RowProps {
  secret: SecretSummary
  groupHeader: string | null
  orgName: (slug: string | null) => string
  userName: (id: number | null) => string
  onHistory: () => void
  onEdit: () => void
  onDelete: () => void
}

/** 'YYYY-MM-DD HH:MM' from either an ISO string or SQLite's 'YYYY-MM-DD HH:MM:SS' (UTC). */
export function fmtTime(t: string | null | undefined): string {
  return t ? t.slice(0, 16).replace('T', ' ') : '—'
}

export function SecretRow({ secret: s, groupHeader, orgName, userName, onHistory, onEdit, onDelete }: RowProps) {
  return (
    <>
      {groupHeader && (
        <tr className="border-b border-border bg-surface-overlay/60">
          <td colSpan={7} className="px-3 py-1.5 text-[11px] uppercase tracking-wider text-fg-3">
            {groupHeader}
          </td>
        </tr>
      )}
      <tr data-testid="secret-row" className="border-b border-border last:border-b-0 hover:bg-surface-overlay/40">
        <td className="px-3 py-2">
          <span
            data-testid="secret-scope-badge"
            data-scope={s.scopeType}
            title={SCOPE_HINTS[s.scopeType]}
            className={`${BADGE_BASE} ${SCOPE_TONES[s.scopeType]}`}
          >
            {scopeBadgeLabel(s, orgName, userName)}
          </span>
        </td>
        <td className="px-3 py-2">
          <div className="font-mono text-xs text-fg-1">{s.key}</div>
          {s.description && (
            <div data-testid="secret-description" className="mt-0.5 max-w-xs truncate text-[11px] text-fg-3" title={s.description}>
              {s.description}
            </div>
          )}
        </td>
        <td className="px-3 py-2 font-mono text-fg-3" aria-label="value hidden">{MASK}</td>
        <td className="px-3 py-2 text-fg-2">v{s.version}</td>
        <td className="px-3 py-2 text-fg-3 text-xs">{fmtTime(s.updatedAt)}</td>
        <td className="px-3 py-2 text-fg-3 text-xs" data-testid="secret-last-used">
          {s.lastUsedAt ? fmtTime(s.lastUsedAt) : <span className="text-fg-3/70">never</span>}
        </td>
        <td className="px-3 py-2 text-right space-x-2">
          <button onClick={onHistory} className="text-xs text-fg-2 hover:underline">History</button>
          <button onClick={onEdit} className="text-xs text-accent hover:underline">Edit</button>
          <button onClick={onDelete} className="text-xs text-signal-alarm hover:underline">Delete</button>
        </td>
      </tr>
    </>
  )
}
