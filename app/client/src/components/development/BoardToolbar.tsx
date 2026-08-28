/**
 * Development board filter/bulk toolbar — extracted from DevelopmentPage.tsx
 * (behavior frozen).
 */
import { Rocket, Trash2 } from 'lucide-react'
import { Badge, Button, SearchInput, Toolbar } from '../ui'
import {
  DEV_SEVERITIES, DEV_STATUSES, DEV_TYPES, STATUS_LABEL, TYPE_LABEL,
  type DevItemQuery, type DevListResponse, type DevSeverity, type DevStatus, type DevType,
} from '../../lib/devItems'
import {
  ClearFiltersButton, MultiSelectChip, SelectChip, ToggleChip, TriStateChip,
  type Option as ChipOption,
} from './FilterChips'
import { DATE_PRESETS, SORTS, TAB_LABEL, TAB_SORT, type Tab, type UiFilters } from './types'

export function BoardToolbar({
  tab,
  filters,
  setFilters,
  searchDraft,
  setSearchDraft,
  wsOptions,
  projectOptions,
  areaOptions,
  routeOptions,
  resp,
  facets,
  filterCount,
  clearAll,
  selected,
  setSelected,
  runBulk,
  bulkPromote,
  sortOverride,
  setSortOverride,
}: {
  tab: Tab
  filters: UiFilters
  setFilters: (fn: (f: UiFilters) => UiFilters) => void
  searchDraft: string
  setSearchDraft: (v: string) => void
  wsOptions: ChipOption[]
  projectOptions: ChipOption[]
  areaOptions: ChipOption[]
  routeOptions: ChipOption[]
  resp: DevListResponse | null
  facets: Record<string, number>
  filterCount: number
  clearAll: () => void
  selected: Set<number>
  setSelected: (next: Set<number>) => void
  runBulk: (label: string, op: Parameters<typeof import('../../lib/devItems').bulkDevItems>[1], destructive?: boolean) => void
  bulkPromote: () => void
  sortOverride: NonNullable<DevItemQuery['sort']> | null
  setSortOverride: (v: NonNullable<DevItemQuery['sort']> | null) => void
}) {
  if (tab === 'changelog') {
    return (
      <Toolbar
        left={
          <>
            <MultiSelectChip
              label="Platform" allLabel="All platforms" options={wsOptions}
              value={filters.workspace} onChange={v => setFilters(f => ({ ...f, workspace: v, wsExplicit: true }))}
            />
            <SearchInput
              id="dev-search"
              placeholder="Search changelog"
              value={searchDraft}
              onChange={e => setSearchDraft(e.target.value)}
              wrapClassName="w-[220px]"
            />
          </>
        }
      />
    )
  }

  return (
    <Toolbar
      left={
        <>
          <MultiSelectChip
            label="Platform" allLabel="All platforms" options={wsOptions}
            value={filters.workspace} onChange={v => setFilters(f => ({ ...f, workspace: v, project: [], wsExplicit: true }))}
          />
          <MultiSelectChip
            label="Project" options={projectOptions} value={filters.project}
            onChange={v => setFilters(f => ({ ...f, project: v }))}
            disabled={filters.workspace.length > 1}
            disabledHint="Select one platform to filter by project"
          />
          <MultiSelectChip
            label="Type" options={DEV_TYPES.map(t => ({ value: t, label: TYPE_LABEL[t], count: resp?.facets.type[t] }))}
            value={filters.type} onChange={v => setFilters(f => ({ ...f, type: v as DevType[] }))}
          />
          <MultiSelectChip
            label="Status" allLabel={`Lane (${TAB_LABEL[tab]})`}
            options={DEV_STATUSES.map(s => ({ value: s, label: STATUS_LABEL[s], count: facets[s] }))}
            value={filters.status} onChange={v => setFilters(f => ({ ...f, status: v as DevStatus[] }))}
          />
          <MultiSelectChip
            label="Severity" options={[...DEV_SEVERITIES.map(s => ({ value: s, label: s })), { value: 'none', label: 'none' }]}
            value={filters.severity} onChange={v => setFilters(f => ({ ...f, severity: v }))}
          />
          <SelectChip label="Area" options={areaOptions} value={filters.area} onChange={v => setFilters(f => ({ ...f, area: v }))} />
          <SelectChip label="Route" options={routeOptions} value={filters.route} onChange={v => setFilters(f => ({ ...f, route: v }))} />
          <TriStateChip label="Replay" value={filters.has_replay} onChange={v => setFilters(f => ({ ...f, has_replay: v }))} />
          <TriStateChip label="Shot" value={filters.has_screenshot} onChange={v => setFilters(f => ({ ...f, has_screenshot: v }))} />
          <ToggleChip label="Unassigned" value={filters.unassigned} onChange={v => setFilters(f => ({ ...f, unassigned: v }))} />
          <ToggleChip label="Untriaged" value={filters.untriaged} onChange={v => setFilters(f => ({ ...f, untriaged: v }))} />
          <SelectChip
            label="Date" allLabel={tab === 'shipped' || tab === 'closed' ? 'Last 30 days' : 'All time'}
            options={DATE_PRESETS.map(d => ({ value: d.value, label: d.label }))}
            value={filters.date} onChange={v => setFilters(f => ({ ...f, date: v }))}
          />
          <SearchInput
            id="dev-search"
            placeholder="Search title + description  ( / )"
            value={searchDraft}
            onChange={e => setSearchDraft(e.target.value)}
            wrapClassName="w-[240px]"
          />
          <ClearFiltersButton count={filterCount} onClear={clearAll} />
        </>
      }
      right={
        selected.size > 0 ? (
          <>
            <Badge tone="accent">{selected.size} selected</Badge>
            <SelectChip
              label="Status" allLabel="Set status" value={null}
              options={DEV_STATUSES.map(s => ({ value: s, label: STATUS_LABEL[s] }))}
              onChange={v => v && runBulk('Set status', { op: 'set_status', params: { status: v as DevStatus } }, v === 'declined' || v === 'duplicate')}
            />
            <SelectChip
              label="Severity" allLabel="Set severity" value={null}
              options={DEV_SEVERITIES.map(s => ({ value: s, label: s }))}
              onChange={v => v && runBulk('Set severity', { op: 'set_severity', params: { severity: v as DevSeverity } })}
            />
            <Button size="sm" variant="secondary" leftIcon={<Rocket className="h-3.5 w-3.5" />} onClick={bulkPromote}>Promote</Button>
            <Button size="sm" variant="danger" leftIcon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => runBulk('Delete', { op: 'delete' }, true)}>Delete</Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
          </>
        ) : (
          <SelectChip
            label="Sort" allLabel={SORTS.find(s => s.value === TAB_SORT[tab])?.label ?? 'Rank'}
            options={SORTS.map(s => ({ value: s.value, label: s.label }))}
            value={sortOverride}
            onChange={v => setSortOverride(v as NonNullable<DevItemQuery['sort']> | null)}
          />
        )
      }
    />
  )
}
