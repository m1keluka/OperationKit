import { useMemo, useState, type ReactNode } from 'react'
import { ChevronUp, ChevronDown, ChevronsUpDown, Table as TableIcon } from 'lucide-react'
import { cn } from './cn'
import { EmptyState } from './EmptyState'
import { Skeleton } from './Skeleton'

/* ─────────────────────────────────────────────────────────
   DataTable — the centerpiece primitive. ONE table look for the
   whole platform.

   Desktop (>=640px): a real <table> — sticky hairline header,
   sortable column buttons (aria-sort), Geist-Mono for machine-data
   cells, hairline row separators, hover row tint + fade-in row actions.

   Mobile (<640px): the SAME data reflows to stacked label/value
   cards — one card per row, each column rendered as a label→value
   pair. NEVER a horizontal scrollbar.

   Built-in loading (skeleton rows) and empty states. Generic over the
   row type; sorting is internal unless you drive it yourself.
   Styling is 100% Mission Control tokens — zero hardcoded hex.
   ───────────────────────────────────────────────────────── */

export interface Column<T> {
  key: string
  header: ReactNode
  /** Cell renderer. */
  cell: (row: T) => ReactNode
  /** Machine data (ids, costs, timestamps, branches, PRs) → Geist Mono. */
  mono?: boolean
  sortable?: boolean
  /** Value used for client-side sort when `sortable`. */
  sortValue?: (row: T) => string | number
  align?: 'left' | 'right' | 'center'
  /** Hide this column's row in the mobile stacked card (e.g. redundant). */
  hideOnMobile?: boolean
  /** Width hint for desktop (e.g. 'w-32'). */
  className?: string
  headerClassName?: string
}

type SortDir = 'asc' | 'desc'

interface DataTableProps<T> {
  columns: Column<T>[]
  rows: T[]
  rowKey: (row: T) => string | number
  loading?: boolean
  /** Rendered (and reflowed) on the right of each row/card; fades in on hover (desktop). */
  rowActions?: (row: T) => ReactNode
  onRowClick?: (row: T) => void
  empty?: { title: string; description?: string; icon?: ReactNode; action?: ReactNode }
  /** Mobile-card title — the primary identifier line per row. Falls back to first column. */
  mobileTitle?: (row: T) => ReactNode
  initialSort?: { key: string; dir: SortDir }
  className?: string
  /** Skeleton row count while loading. */
  loadingRows?: number
}

const alignCls = (a?: 'left' | 'right' | 'center') =>
  a === 'right' ? 'text-right' : a === 'center' ? 'text-center' : 'text-left'

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading,
  rowActions,
  onRowClick,
  empty,
  mobileTitle,
  initialSort,
  className,
  loadingRows = 5,
}: DataTableProps<T>) {
  const [sort, setSort] = useState<{ key: string; dir: SortDir } | null>(initialSort ?? null)

  const sorted = useMemo(() => {
    if (!sort) return rows
    const col = columns.find((c) => c.key === sort.key)
    if (!col?.sortValue) return rows
    const get = col.sortValue
    const dir = sort.dir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      const av = get(a)
      const bv = get(b)
      if (av < bv) return -1 * dir
      if (av > bv) return 1 * dir
      return 0
    })
  }, [rows, sort, columns])

  function toggleSort(col: Column<T>) {
    if (!col.sortable) return
    setSort((prev) => {
      if (prev?.key !== col.key) return { key: col.key, dir: 'asc' }
      if (prev.dir === 'asc') return { key: col.key, dir: 'desc' }
      return null
    })
  }

  // ── Empty ──
  if (!loading && rows.length === 0) {
    return (
      <div className={cn('rounded-lg border border-line bg-surface-2', className)}>
        <EmptyState
          icon={empty?.icon ?? <TableIcon className="h-5 w-5" strokeWidth={1.6} />}
          title={empty?.title ?? 'No rows yet'}
          description={empty?.description}
          action={empty?.action}
        />
      </div>
    )
  }

  return (
    <div className={cn('min-w-0', className)}>
      {/* ── DESKTOP: real table ── */}
      <div className="hidden overflow-hidden rounded-lg border border-line bg-surface-2 sm:block">
        <table className="w-full border-collapse text-[13px]">
          <thead className="sticky top-0 z-[1] bg-surface-1">
            <tr className="border-b border-line">
              {columns.map((col) => {
                const active = sort?.key === col.key
                return (
                  <th
                    key={col.key}
                    aria-sort={active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                    className={cn(
                      'px-3 py-2.5 font-mono text-[11px] font-medium uppercase tracking-[0.1em] text-fg-3',
                      alignCls(col.align),
                      col.headerClassName,
                      col.className,
                    )}
                  >
                    {col.sortable ? (
                      <button
                        onClick={() => toggleSort(col)}
                        className={cn(
                          'inline-flex items-center gap-1 transition-colors duration-fast hover:text-fg-1',
                          active && 'text-fg-1',
                          col.align === 'right' && 'flex-row-reverse',
                        )}
                      >
                        {col.header}
                        {active ? (
                          sort!.dir === 'asc' ? (
                            <ChevronUp className="h-3.5 w-3.5 text-accent-hover" strokeWidth={2} />
                          ) : (
                            <ChevronDown className="h-3.5 w-3.5 text-accent-hover" strokeWidth={2} />
                          )
                        ) : (
                          <ChevronsUpDown className="h-3.5 w-3.5 opacity-50" strokeWidth={1.75} />
                        )}
                      </button>
                    ) : (
                      col.header
                    )}
                  </th>
                )
              })}
              {rowActions && <th className="w-px px-3 py-2.5" />}
            </tr>
          </thead>
          <tbody>
            {loading
              ? Array.from({ length: loadingRows }).map((_, i) => (
                  <tr key={i} className="border-b border-line-soft last:border-0">
                    {columns.map((col) => (
                      <td key={col.key} className={cn('px-3 py-3', col.className)}>
                        <Skeleton className="h-3.5 w-[70%]" />
                      </td>
                    ))}
                    {rowActions && <td className="px-3 py-3" />}
                  </tr>
                ))
              : sorted.map((row) => (
                  <tr
                    key={rowKey(row)}
                    onClick={onRowClick ? () => onRowClick(row) : undefined}
                    onKeyDown={
                      onRowClick
                        ? (e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              onRowClick(row)
                            }
                          }
                        : undefined
                    }
                    tabIndex={onRowClick ? 0 : undefined}
                    role={onRowClick ? 'button' : undefined}
                    className={cn(
                      'group border-b border-line-soft transition-colors duration-fast ease-out last:border-0 hover:bg-surface-3',
                      onRowClick && 'cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/50',
                    )}
                  >
                    {columns.map((col) => (
                      <td
                        key={col.key}
                        className={cn(
                          'px-3 py-2.5 align-middle text-fg-1',
                          col.mono && 'font-mono text-[12px] text-fg-2',
                          alignCls(col.align),
                          col.className,
                        )}
                      >
                        {col.cell(row)}
                      </td>
                    ))}
                    {rowActions && (
                      <td className="px-3 py-2.5 text-right">
                        <div className="flex items-center justify-end gap-1 opacity-0 transition-opacity duration-fast group-hover:opacity-100 group-focus-within:opacity-100">
                          {rowActions(row)}
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
          </tbody>
        </table>
      </div>

      {/* ── MOBILE: stacked label/value cards ── */}
      <div className="flex flex-col gap-2 sm:hidden">
        {loading
          ? Array.from({ length: loadingRows }).map((_, i) => (
              <div key={i} className="rounded-lg border border-line bg-surface-2 p-3">
                <Skeleton className="mb-3 h-4 w-1/2" />
                <Skeleton className="mb-2 h-3 w-full" />
                <Skeleton className="h-3 w-2/3" />
              </div>
            ))
          : sorted.map((row) => {
              const title = mobileTitle ? mobileTitle(row) : columns[0]?.cell(row)
              const rest = columns.filter((c, i) => !c.hideOnMobile && !(i === 0 && !mobileTitle))
              return (
                <div
                  key={rowKey(row)}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  onKeyDown={
                    onRowClick
                      ? (e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            onRowClick(row)
                          }
                        }
                      : undefined
                  }
                  tabIndex={onRowClick ? 0 : undefined}
                  role={onRowClick ? 'button' : undefined}
                  className={cn(
                    'rounded-lg border border-line bg-surface-2 p-3 transition-colors duration-fast',
                    onRowClick && 'cursor-pointer active:bg-surface-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
                  )}
                >
                  <div className="mb-2 flex items-start justify-between gap-2">
                    <div className="min-w-0 text-[13.5px] font-medium text-fg-0">{title}</div>
                  </div>
                  <dl className="flex flex-col gap-1.5">
                    {rest.map((col) => (
                      <div key={col.key} className="flex items-baseline justify-between gap-3">
                        <dt className="shrink-0 font-mono text-[10.5px] uppercase tracking-[0.08em] text-fg-3">
                          {col.header}
                        </dt>
                        <dd className={cn('min-w-0 truncate text-right text-[12.5px] text-fg-1', col.mono && 'font-mono text-fg-2')}>
                          {col.cell(row)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                  {rowActions && (
                    <div className="mt-3 flex items-center gap-2 border-t border-line-soft pt-3 [&>*]:flex-1">
                      {rowActions(row)}
                    </div>
                  )}
                </div>
              )
            })}
      </div>
    </div>
  )
}
