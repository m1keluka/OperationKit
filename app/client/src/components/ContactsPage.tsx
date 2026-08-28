import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { FilePlus2, RefreshCw, Users, X } from 'lucide-react'
import { FileEditorOverlay } from './FileEditorOverlay'
import {
  PageContainer,
  PageHeader,
  Toolbar,
  SearchInput,
  Tabs,
  Badge,
  Button,
  IconButton,
  DataTable,
  Modal,
  cn,
  type Column,
  type TabItem,
} from './ui'

// ── Types (mirrors server/services/contacts.ts ContactSummary) ──
interface Contact {
  vault_path: string
  name: string
  email: string | null
  phone: string | null
  company: string | null
  role: string | null
  tags: string[]
  follow_up_days: number | null
  last_interaction: string | null
  next_touchpoint: string | null
  confidence: string
  workspace: string | null
  updated_at: string
}

type Sort = 'overdue' | 'name' | 'recent'

interface ExtractCreate {
  name: string
  workspace: string
  vault_path: string
  frontmatter: Record<string, unknown>
  body: string
  confidence: 'low' | 'medium' | 'high'
}
interface ExtractUpdate {
  vault_path: string
  name: string
  patch: Record<string, unknown>
  body_append?: string
  confidence: 'low' | 'medium' | 'high'
}
interface ExtractDiff {
  creates: ExtractCreate[]
  updates: ExtractUpdate[]
  notes?: string
}

const SORT_TABS: TabItem[] = [
  { key: 'overdue', label: 'Overdue' },
  { key: 'name', label: 'Name' },
  { key: 'recent', label: 'Recent' },
]

function daysFromToday(iso: string | null): number | null {
  if (!iso) return null
  const t = new Date(iso + 'T00:00:00Z').getTime()
  if (Number.isNaN(t)) return null
  const today = new Date()
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  return Math.round((t - todayUtc) / 86_400_000)
}

function nextTouchpointPill(iso: string | null): { label: string; cls: string; sort: number } {
  if (!iso) return { label: '—', cls: 'text-fg-3', sort: Number.POSITIVE_INFINITY }
  const d = daysFromToday(iso)
  if (d == null) return { label: iso, cls: 'text-fg-2', sort: Number.POSITIVE_INFINITY }
  if (d < 0) return { label: `${Math.abs(d)}d overdue`, cls: 'font-medium text-signal-alarm', sort: d }
  if (d <= 7) return { label: `due in ${d}d`, cls: 'text-signal-amber', sort: d }
  return { label: iso, cls: 'text-fg-2', sort: d }
}

// ── Main page ─────────────────────────────────────────────────────────────
export function ContactsPage() {
  const [contacts, setContacts] = useState<Contact[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sort, setSort] = useState<Sort>('overdue')
  const [tagFilter, setTagFilter] = useState<string>('')
  const [wsFilter, setWsFilter] = useState<string>('')
  const [query, setQuery] = useState<string>('')
  const [openFile, setOpenFile] = useState<string | null>(null)
  const [extractOpen, setExtractOpen] = useState(false)
  const [vaultRoot, setVaultRoot] = useState<string>('/home/operator/second-brain')

  const reload = useCallback(() => {
    const params = new URLSearchParams({ sort })
    if (tagFilter) params.set('tag', tagFilter)
    if (wsFilter) params.set('workspace', wsFilter)
    fetch(`/api/contacts?${params.toString()}`, { credentials: 'include' })
      .then(async r => {
        if (!r.ok) throw new Error(`Failed to load contacts (${r.status})`)
        return r.json() as Promise<{ contacts: Contact[]; vault_root: string }>
      })
      .then(data => { setContacts(data.contacts); setVaultRoot(data.vault_root); setError(null) })
      .catch(err => setError(err instanceof Error ? err.message : String(err)))
  }, [sort, tagFilter, wsFilter])

  useEffect(() => { reload() }, [reload])

  // Workspace + tag chip vocabularies derived from the current result set so
  // the chips only show segments that actually have contacts.
  const workspaces = useMemo(() => {
    const set = new Set<string>()
    for (const c of contacts || []) if (c.workspace) set.add(c.workspace)
    return Array.from(set).sort()
  }, [contacts])
  const topTags = useMemo(() => {
    const counts = new Map<string, number>()
    for (const c of contacts || []) for (const t of c.tags) counts.set(t, (counts.get(t) || 0) + 1)
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([t]) => t)
  }, [contacts])

  // Client-side text filter over the current (already server-sorted/filtered) set.
  const visible = useMemo(() => {
    const list = contacts || []
    const q = query.trim().toLowerCase()
    if (!q) return list
    return list.filter(c =>
      [c.name, c.email, c.company, c.role, c.workspace, ...c.tags]
        .some(v => v && v.toLowerCase().includes(q)),
    )
  }, [contacts, query])

  const columns: Column<Contact>[] = [
    {
      key: 'name',
      header: 'Name',
      sortable: true,
      sortValue: c => c.name.toLowerCase(),
      cell: c => (
        <div>
          <div className="text-fg-0">{c.name}</div>
          {c.role && (
            <div className="text-[11px] text-fg-3">
              {c.role}{c.company ? ` · ${c.company}` : ''}
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'tags',
      header: 'Tags',
      cell: c => (
        <div className="flex flex-wrap gap-1">
          {c.tags.slice(0, 4).map(t => (
            <Badge key={t} tone="info" mono>#{t}</Badge>
          ))}
          {c.tags.length > 4 && (
            <span className="text-[10px] text-fg-3">+{c.tags.length - 4}</span>
          )}
        </div>
      ),
    },
    {
      key: 'workspace',
      header: 'Organization',
      mono: true,
      sortable: true,
      sortValue: c => c.workspace || '',
      cell: c => c.workspace || '—',
    },
    {
      key: 'last',
      header: 'Last touch',
      mono: true,
      sortable: true,
      sortValue: c => c.last_interaction || '',
      cell: c => <span className="text-fg-2">{c.last_interaction || '—'}</span>,
    },
    {
      key: 'next',
      header: 'Next',
      mono: true,
      sortable: true,
      sortValue: c => nextTouchpointPill(c.next_touchpoint).sort,
      cell: c => {
        const pill = nextTouchpointPill(c.next_touchpoint)
        return <span className={pill.cls}>{pill.label}</span>
      },
    },
    {
      key: 'cadence',
      header: 'Cadence',
      mono: true,
      align: 'right',
      sortable: true,
      sortValue: c => c.follow_up_days ?? Number.POSITIVE_INFINITY,
      cell: c => (
        <span className="text-fg-2">{c.follow_up_days != null ? `${c.follow_up_days}d` : '—'}</span>
      ),
    },
  ]

  return (
    <PageContainer width="wide">
      <PageHeader
        title="Contacts"
        breadcrumbs={[{ label: 'OperationKit' }, { label: 'Contacts' }]}
        description={
          contacts != null
            ? `${contacts.length} contact${contacts.length === 1 ? '' : 's'} · synced from vault`
            : 'Synced from vault'
        }
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              leftIcon={<FilePlus2 className="h-3.5 w-3.5" strokeWidth={1.75} />}
              onClick={() => setExtractOpen(true)}
            >
              Drop text
            </Button>
            <Button
              variant="secondary"
              size="sm"
              leftIcon={<RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} />}
              onClick={() => {
                fetch('/api/contacts/reindex', { method: 'POST', credentials: 'include' }).then(reload)
              }}
              title="Rebuild SQLite index from vault"
            >
              Reindex
            </Button>
          </div>
        }
      />

      <Toolbar
        left={
          <>
            {/* shrink-0 keeps the segmented control at its intrinsic width — without it
                the Tabs' overflow-x-auto lets it collapse to a clipped sliver ("Overd…")
                next to the flexible search field. */}
            <Tabs
              items={SORT_TABS}
              value={sort}
              onChange={k => setSort(k as Sort)}
              className="shrink-0"
            />
            <SearchInput
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search name, email, company, tag…"
              wrapClassName="w-full min-w-[10rem] flex-1 sm:w-auto sm:max-w-sm"
            />
          </>
        }
      />

      {/* Filter chips live on their own row — when packed into the Toolbar's
          shrink-0 right slot they starved the sort/search (min-w-0) row to 0px,
          collapsing the segmented control to a clipped "Overd…" sliver. */}
      {(workspaces.length > 0 || topTags.length > 0) && (
        <div className="mb-4 flex flex-wrap items-center gap-1.5">
          {workspaces.length > 0 && (
            <>
              <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-fg-3">ws</span>
              <FilterChip active={wsFilter === ''} onClick={() => setWsFilter('')}>all</FilterChip>
              {workspaces.map(w => (
                <FilterChip key={w} active={wsFilter === w} onClick={() => setWsFilter(wsFilter === w ? '' : w)}>
                  {w}
                </FilterChip>
              ))}
            </>
          )}
          {topTags.length > 0 && (
            <>
              <span className="ml-1 font-mono text-[11px] uppercase tracking-[0.08em] text-fg-3">tag</span>
              <FilterChip active={tagFilter === ''} onClick={() => setTagFilter('')}>all</FilterChip>
              {topTags.map(t => (
                <FilterChip key={t} active={tagFilter === t} onClick={() => setTagFilter(tagFilter === t ? '' : t)}>
                  #{t}
                </FilterChip>
              ))}
            </>
          )}
        </div>
      )}

      {error && (
        <div className="mb-4 rounded-md border border-signal-alarm/30 bg-signal-alarm/10 px-3 py-2 text-[13px] text-signal-alarm">
          {error}
        </div>
      )}

      <DataTable
        columns={columns}
        rows={visible}
        rowKey={c => c.vault_path}
        loading={!error && contacts === null}
        initialSort={{ key: 'next', dir: 'asc' }}
        onRowClick={c => setOpenFile(`${vaultRoot}/${c.vault_path}`)}
        mobileTitle={c => c.name}
        empty={{
          icon: <Users className="h-5 w-5" strokeWidth={1.6} />,
          title: 'No contacts match your filters',
          description: 'Clear search/filters, drop in some text, or reindex the vault.',
        }}
      />

      {/* File editor overlay */}
      {openFile && <FileEditorOverlay filePath={openFile} onClose={() => { setOpenFile(null); reload() }} />}

      {/* Drop-text extract drawer */}
      {extractOpen && <ExtractDrawer onClose={() => setExtractOpen(false)} onApplied={reload} />}
    </PageContainer>
  )
}

// Small token-bound filter chip for the workspace/tag segmented filters.
function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'rounded-full px-2 py-0.5 font-mono text-[11px] transition-colors duration-fast',
        active
          ? 'bg-accent text-accent-fg'
          : 'text-fg-3 hover:text-fg-1 hover:bg-surface-3',
      )}
    >
      {children}
    </button>
  )
}

// ── Drop-text extract drawer ─────────────────────────────────────────────
function ExtractDrawer({ onClose, onApplied }: { onClose: () => void; onApplied: () => void }) {
  const [text, setText] = useState('')
  const [diff, setDiff] = useState<ExtractDiff | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [applyResult, setApplyResult] = useState<{ created: number; updated: number; errors: number } | null>(null)

  async function runExtract() {
    setBusy(true); setErr(null); setDiff(null)
    try {
      const r = await fetch('/api/contacts/extract', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || `extract failed (${r.status})`)
      const data = await r.json() as { diff: ExtractDiff }
      setDiff(data.diff)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }

  async function applyDiff() {
    if (!diff) return
    setBusy(true); setErr(null)
    try {
      const r = await fetch('/api/contacts/extract/apply', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ diff }),
      })
      if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || `apply failed (${r.status})`)
      const data = await r.json() as { created: unknown[]; updated: unknown[]; errors: unknown[] }
      setApplyResult({ created: data.created.length, updated: data.updated.length, errors: data.errors.length })
      onApplied()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }

  return (
    <Modal
      open
      onClose={onClose}
      variant="center"
      labelledBy="extract-drawer-title"
      panelClassName="flex h-[85vh] w-[90vw] max-w-3xl flex-col overflow-hidden p-0"
    >
      <div className="flex shrink-0 items-center justify-between border-b border-line bg-surface-2 px-4 py-2.5">
        <div id="extract-drawer-title" className="font-display text-sm font-medium text-fg-0">Drop text — extract contacts</div>
        <IconButton label="Close" variant="ghost" onClick={onClose}>
          <X className="h-4 w-4" strokeWidth={1.75} />
        </IconButton>
      </div>
      <div className="flex flex-1 flex-col gap-3 overflow-auto p-4">
          <textarea
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder="Paste call notes, intro emails, meeting recaps — anything mentioning people. The LLM will propose contact creates/updates as a diff."
            className="h-40 w-full resize-none rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-fg-0 placeholder-fg-3 transition-colors duration-fast focus:border-[color:var(--accent-line)] focus:outline-none focus:ring-2 focus:ring-accent/40"
          />
          <div className="flex items-center gap-2">
            <Button variant="primary" size="sm" onClick={runExtract} disabled={busy || !text.trim()}>
              {busy && !diff ? 'Extracting…' : 'Extract'}
            </Button>
            {diff && (
              <Button variant="secondary" size="sm" onClick={applyDiff} disabled={busy}>
                {busy ? 'Applying…' : `Apply (${diff.creates.length} new, ${diff.updates.length} updates)`}
              </Button>
            )}
          </div>

          {err && (
            <div className="rounded-md border border-signal-alarm/30 bg-signal-alarm/10 px-3 py-2 text-xs text-signal-alarm">{err}</div>
          )}
          {applyResult && (
            <div className="rounded-md border border-signal-verify/30 bg-signal-verify/10 px-3 py-2 text-xs text-signal-verify">
              Wrote {applyResult.created} new + {applyResult.updated} updated{applyResult.errors > 0 ? ` · ${applyResult.errors} errors` : ''}.
            </div>
          )}

          {diff && (
            <div className="space-y-3">
              {diff.notes && <div className="text-[11px] italic text-fg-3">{diff.notes}</div>}
              {diff.creates.length > 0 && (
                <div>
                  <div className="mb-1 font-mono text-[10px] uppercase tracking-wide text-fg-3">New contacts</div>
                  {diff.creates.map((c, i) => (
                    <div key={i} className="mb-2 rounded-md border border-signal-verify/30 bg-signal-verify/[0.06] p-2 text-xs">
                      <div className="text-fg-0">{c.name} <span className="font-mono text-[10px] text-fg-3">→ {c.vault_path}</span></div>
                      <div className="mt-1 font-mono text-[11px] text-fg-2">organization: {c.workspace} · confidence: {c.confidence}</div>
                      <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px] text-fg-3">{JSON.stringify(c.frontmatter, null, 2)}</pre>
                    </div>
                  ))}
                </div>
              )}
              {diff.updates.length > 0 && (
                <div>
                  <div className="mb-1 font-mono text-[10px] uppercase tracking-wide text-fg-3">Updates</div>
                  {diff.updates.map((u, i) => (
                    <div key={i} className="mb-2 rounded-md border border-signal-amber/30 bg-signal-amber/[0.06] p-2 text-xs">
                      <div className="text-fg-0">{u.name} <span className="font-mono text-[10px] text-fg-3">→ {u.vault_path}</span></div>
                      <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px] text-fg-3">{JSON.stringify(u.patch, null, 2)}</pre>
                      {u.body_append && <div className="mt-1 text-[11px] text-fg-2">+body: {u.body_append}</div>}
                    </div>
                  ))}
                </div>
              )}
              {diff.creates.length === 0 && diff.updates.length === 0 && (
                <div className="text-xs text-fg-3">No contacts extracted from the text.</div>
              )}
            </div>
          )}
        </div>
    </Modal>
  )
}
