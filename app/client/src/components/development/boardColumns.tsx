/**
 * Development board table columns — extracted from DevelopmentPage.tsx
 * (behavior frozen).
 */
import { GripVertical, Image as ImageIcon, Video } from 'lucide-react'
import { Badge, cn, type Column } from '../ui'
import {
  hexColor, relativeTime, scoreOf, TYPE_LABEL, STATUS_LABEL,
  type DevItemRow,
} from '../../lib/devItems'
import { SEV_TONE, STATUS_TONE } from './types'

export function buildDevColumns({
  allSelected,
  rows,
  selected,
  toggleSel,
  setSelected,
  canRank,
  dragId,
  setDragId,
  onDrop,
  shortOf,
}: {
  allSelected: boolean
  rows: DevItemRow[]
  selected: Set<number>
  toggleSel: (id: number) => void
  setSelected: (next: Set<number>) => void
  canRank: boolean
  dragId: number | null
  setDragId: (id: number | null) => void
  onDrop: (targetId: number) => void
  shortOf: (slug: string) => string
}): Column<DevItemRow>[] {
  return [
    {
      key: 'sel',
      className: 'w-8',
      header: (
        <input
          type="checkbox"
          aria-label="Select all in view"
          checked={allSelected}
          onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map(r => r.id)))}
          onClick={e => e.stopPropagation()}
          className="h-3.5 w-3.5 accent-[color:var(--accent)]"
        />
      ),
      hideOnMobile: true,
      cell: row => (
        <input
          type="checkbox"
          aria-label={`Select DEV-${row.id}`}
          checked={selected.has(row.id)}
          onChange={() => toggleSel(row.id)}
          onClick={e => e.stopPropagation()}
          className="h-3.5 w-3.5 accent-[color:var(--accent)]"
        />
      ),
    },
    {
      key: 'rank',
      header: 'Rank',
      className: 'w-16',
      mono: true,
      hideOnMobile: true,
      cell: row => (
        <div
          draggable={canRank}
          onDragStart={e => { if (!canRank) return; setDragId(row.id); e.dataTransfer.effectAllowed = 'move' }}
          onDragOver={e => { if (canRank && dragId) e.preventDefault() }}
          onDrop={e => { e.preventDefault(); e.stopPropagation(); void onDrop(row.id) }}
          onClick={e => e.stopPropagation()}
          title={canRank ? 'Drag to reorder' : 'Select one platform and sort by Rank to reorder.'}
          className={cn(
            'flex items-center gap-1',
            canRank ? 'cursor-grab active:cursor-grabbing' : 'cursor-not-allowed opacity-50',
            dragId === row.id && 'opacity-40',
          )}
        >
          <GripVertical className="h-3.5 w-3.5 text-fg-3" strokeWidth={1.8} />
          <span>{row.priority_rank ?? '—'}</span>
        </div>
      ),
    },
    {
      key: 'ref',
      header: 'Ref',
      mono: true,
      className: 'w-24 whitespace-nowrap',
      sortable: true,
      sortValue: r => r.id,
      cell: row => row.ref,
    },
    {
      key: 'title',
      header: 'Title',
      sortable: true,
      sortValue: r => r.title.toLowerCase(),
      cell: row => (
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[13px] text-fg-0">{row.title}</span>
            {row.has_replay && <Video className="h-3.5 w-3.5 shrink-0 text-fg-3" strokeWidth={1.7} aria-label="has session replay" />}
            {row.has_screenshot && <ImageIcon className="h-3.5 w-3.5 shrink-0 text-fg-3" strokeWidth={1.7} aria-label="has screenshot" />}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 font-mono text-[10.5px] text-fg-3">
            {row.route && <span>{row.route}</span>}
            {row.area && <span>· {row.area}</span>}
            {row.note_count > 0 && <span>· {row.note_count} note{row.note_count === 1 ? '' : 's'}</span>}
            {row.submitter_label && <span>· {row.submitter_label}</span>}
          </div>
        </div>
      ),
    },
    {
      key: 'platform',
      header: 'Platform',
      className: 'w-24',
      cell: row => (
        <span
          className="inline-flex items-center rounded-sm border border-line bg-surface-3 px-1.5 py-0.5 font-mono text-[11px] text-fg-2"
          style={hexColor(row.workspace_badge_color)
            ? {
                borderColor: `${hexColor(row.workspace_badge_color)}55`,
                background: `${hexColor(row.workspace_badge_color)}1a`,
                color: hexColor(row.workspace_badge_color)!,
              }
            : undefined}
        >{row.workspace_label ?? shortOf(row.workspace)}</span>
      ),
    },
    {
      key: 'type',
      header: 'Type',
      className: 'w-28',
      sortable: true,
      sortValue: r => r.type,
      cell: row => <Badge tone="neutral">{TYPE_LABEL[row.type]}</Badge>,
    },
    {
      key: 'severity',
      header: 'Sev',
      className: 'w-24',
      cell: row => row.severity
        ? <Badge tone={SEV_TONE[row.severity]}>{row.severity}</Badge>
        : <span className="text-fg-3">—</span>,
    },
    {
      key: 'score',
      header: 'I/E',
      mono: true,
      className: 'w-16',
      align: 'right',
      cell: row => <span>{scoreOf(row) ?? '—'}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      className: 'w-28',
      cell: row => <Badge tone={STATUS_TONE[row.status]}>{STATUS_LABEL[row.status]}</Badge>,
    },
    {
      key: 'work',
      header: 'Work',
      mono: true,
      className: 'w-32',
      cell: row => row.objective_id
        ? <span className="text-fg-2">#{row.objective_id} {row.objective_status ? `· ${row.objective_status}` : ''}</span>
        : <span className="text-fg-3">unassigned</span>,
    },
    {
      key: 'updated',
      header: 'Updated',
      mono: true,
      className: 'w-24',
      align: 'right',
      sortable: true,
      sortValue: r => r.updated_at,
      cell: row => <span>{relativeTime(row.updated_at)}</span>,
    },
  ]
}
