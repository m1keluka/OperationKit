/**
 * Secrets table row — extracted from SecretsPage.tsx (behavior frozen).
 */
import type { SecretSummary } from '@command-center/shared'
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

export function SecretRow({ secret: s, groupHeader, orgName, userName, onHistory, onEdit, onDelete }: RowProps) {
  return (
    <>
      {groupHeader && (
        <tr className="border-b border-border bg-surface-overlay/60">
          <td colSpan={6} className="px-3 py-1.5 text-[11px] uppercase tracking-wider text-fg-3">
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
        <td className="px-3 py-2 font-mono text-xs text-fg-1">{s.key}</td>
        <td className="px-3 py-2 font-mono text-fg-3">{MASK}</td>
        <td className="px-3 py-2 text-fg-2">v{s.version}</td>
        <td className="px-3 py-2 text-fg-3 text-xs">{s.updatedAt?.slice(0, 16).replace('T', ' ')}</td>
        <td className="px-3 py-2 text-right space-x-2">
          <button onClick={onHistory} className="text-xs text-fg-2 hover:underline">History</button>
          <button onClick={onEdit} className="text-xs text-accent hover:underline">Edit</button>
          <button onClick={onDelete} className="text-xs text-signal-alarm hover:underline">Delete</button>
        </td>
      </tr>
    </>
  )
}
