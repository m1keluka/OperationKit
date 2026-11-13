/**
 * Secrets table row — extracted from SecretsPage.tsx.
 *
 * obj 900749: the Value cell reads as write-only (lock + mask, no action can
 * reveal it), the version rides with "Updated" instead of its own column, and
 * a Bot access cell shows whether bots may use this NAME through the broker
 * (Off = default-deny; Never = seat/server-only; else the allowed hosts).
 */
import { Lock } from 'lucide-react'
import type { SecretSummary } from '@operationkit/shared'
import {
  BADGE_BASE, MASK, SCOPE_HINTS, SCOPE_TONES, scopeBadgeLabel,
} from './scope'
import type { BotAccessStatus } from './botAccess'

/** Number of columns the table renders (group headers + empty rows span it). */
export const SECRET_TABLE_COLUMNS = 7

interface RowProps {
  secret: SecretSummary
  groupHeader: string | null
  orgName: (slug: string | null) => string
  userName: (id: number | null) => string
  /** null = bot access not loaded / not shown to this caller. */
  botAccess: BotAccessStatus | null
  onBotAccess?: () => void
  onHistory: () => void
  onEdit: () => void
  onDelete: () => void
}

/** 'YYYY-MM-DD HH:MM' from either an ISO string or SQLite's 'YYYY-MM-DD HH:MM:SS' (UTC). */
export function fmtTime(t: string | null | undefined): string {
  return t ? t.slice(0, 16).replace('T', ' ') : '—'
}

function BotAccessCell({ status, onClick }: { status: BotAccessStatus | null; onClick?: () => void }) {
  if (!status) return <span className="text-fg-3">—</span>
  if (status.kind === 'never') {
    return <span data-bot-access="never" className="text-[12px] text-fg-3" title="Seat and server-only secrets can never be used by bots">Never</span>
  }
  const chip = status.kind === 'on'
    ? <span data-bot-access="on" title={status.title} className={`${BADGE_BASE} max-w-[14rem] truncate border-status-working/40 bg-surface-2 font-mono text-status-working`}>{status.label}</span>
    : <span data-bot-access="off" title="No bot can use this secret (default)" className="text-[12px] text-fg-3">Off</span>
  if (!onClick) return chip
  return (
    <button type="button" onClick={onClick} data-testid="secret-bot-access" className="rounded hover:underline focus:outline-none focus-visible:ring-1 focus-visible:ring-accent">
      {chip}
    </button>
  )
}

export function SecretRow({ secret: s, groupHeader, orgName, userName, botAccess, onBotAccess, onHistory, onEdit, onDelete }: RowProps) {
  return (
    <>
      {groupHeader && (
        <tr className="border-b border-border bg-surface-overlay/60">
          <td colSpan={SECRET_TABLE_COLUMNS} className="px-3 py-1.5 text-[12px] uppercase tracking-wider text-fg-3">
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
            <div data-testid="secret-description" className="mt-0.5 max-w-xs truncate text-[12px] text-fg-3" title={s.description}>
              {s.description}
            </div>
          )}
        </td>
        <td className="px-3 py-2 font-mono text-fg-3" aria-label="value hidden, write-only" title="Write-only: never shown after saving">
          <span className="inline-flex items-center gap-1"><Lock aria-hidden className="h-3 w-3" />{MASK}</span>
        </td>
        <td className="px-3 py-2"><BotAccessCell status={botAccess} onClick={onBotAccess} /></td>
        <td className="px-3 py-2 text-fg-3 text-xs whitespace-nowrap" data-testid="secret-updated">
          <span className="text-fg-2">v{s.version}</span> · {fmtTime(s.updatedAt)}
        </td>
        <td className="px-3 py-2 text-fg-3 text-xs whitespace-nowrap" data-testid="secret-last-used">
          {s.lastUsedAt ? fmtTime(s.lastUsedAt) : <span className="text-fg-3">never</span>}
        </td>
        <td className="px-3 py-2 text-right space-x-2 whitespace-nowrap">
          <button onClick={onHistory} className="text-xs text-fg-2 hover:underline">History</button>
          <button onClick={onEdit} className="text-xs text-accent hover:underline">Edit</button>
          <button onClick={onDelete} className="text-xs text-signal-alarm hover:underline">Delete</button>
        </td>
      </tr>
    </>
  )
}
