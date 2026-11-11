import { useState, useRef, useEffect, type FormEvent } from 'react'
import { Plus, Check, X, Building2 } from 'lucide-react'

export interface OrgChoice {
  slug: string
  /** Full name, shown on the chip. */
  label: string
}

interface WorkspaceFilterBarProps {
  /** Organizations the caller can see, in display order. */
  organizations: OrgChoice[]
  /** Currently selected slugs. EMPTY means "All organizations". */
  selected: string[]
  onChange: (next: string[]) => void
  /** Admins may create an organization inline; members just filter. */
  canCreate?: boolean
  /** Create an org and return its slug. Wired to POST /api/admin/workspaces. */
  onCreate?: (name: string, slug: string) => Promise<unknown>
  /** True while the org list is still loading — suppresses the empty state. */
  loading?: boolean
}

const chipCls =
  'whitespace-nowrap rounded-full border px-2.5 py-1 text-[12px] transition-colors duration-fast ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50'
const chipOn = 'border-accent bg-surface-2 text-fg-0'
const chipOff = 'border-line text-fg-2 hover:border-line-strong hover:text-fg-1'

/**
 * Derive a URL/DB-safe slug from a typed organization name, matching the
 * server's rule (`^[a-z0-9][a-z0-9-]{1,40}$` in `admin-workspaces.ts`): lowercase,
 * non-alphanumerics collapse to a single hyphen, trimmed, capped at 41 chars.
 * Exported because the slug is what the board selects afterwards, so the test
 * and the caller must agree on it.
 */
export function slugifyOrg(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 41)
}

/**
 * The board's organization filter — obj 900197.
 *
 * Until now the ONLY way to scope the board to an org was a dropdown in the top
 * bar, which disappeared entirely whenever `availableWorkspaces.length <= 1`
 * (e.g. while `/api/workspaces` was empty or every org but one was archived).
 * The board then showed cards from every org with no visible control, which is
 * exactly what Operator hit. This row lives ON the board, directly above the
 * project row, so the segmentation is always discoverable — and, like
 * `ProjectFilterBar`, the picker is also the management surface: an admin
 * creates an organization right here instead of detouring to Settings.
 */
export function WorkspaceFilterBar({
  organizations, selected, onChange, canCreate = false, onCreate, loading = false,
}: WorkspaceFilterBarProps) {
  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { if (creating) inputRef.current?.focus() }, [creating])

  const allSelected = selected.length === 0

  function toggle(slug: string) {
    // Deselecting the last chip returns to All rather than an empty board —
    // "no organizations" is never a useful view.
    const next = selected.includes(slug) ? selected.filter(s => s !== slug) : [...selected, slug]
    onChange(next)
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    const name = draft.trim()
    if (!name) return
    const slug = slugifyOrg(name)
    if (slug.length < 2) {
      setError('Name needs at least 2 letters or digits')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await onCreate?.(name, slug)
      setCreating(false)
      setDraft('')
      // Open the org you just made — the obvious next step.
      onChange([slug])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create organization')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      data-testid="workspace-filter-bar"
      className="flex items-center gap-2 overflow-x-auto border-b border-line px-4 py-2"
    >
      <span className="inline-flex shrink-0 items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.12em] text-fg-3">
        <Building2 className="h-3.5 w-3.5" aria-hidden="true" />
        Org
      </span>

      <div className="flex shrink-0 items-center gap-1" role="group" aria-label="Filter board by organization">
        <button
          type="button"
          onClick={() => onChange([])}
          aria-pressed={allSelected}
          className={`${chipCls} ${allSelected ? chipOn : chipOff}`}
        >
          All orgs
        </button>
        {organizations.map(o => {
          const on = selected.includes(o.slug)
          return (
            <button
              key={o.slug}
              type="button"
              onClick={() => toggle(o.slug)}
              aria-pressed={on}
              data-workspace={o.slug}
              className={`${chipCls} ${on ? chipOn : chipOff}`}
            >
              {o.label}
            </button>
          )
        })}
        {!loading && organizations.length === 0 && (
          <span className="whitespace-nowrap text-[12px] text-fg-3">No organizations yet</span>
        )}
      </div>

      {canCreate && (creating ? (
        <form onSubmit={submit} className="flex shrink-0 items-center gap-1">
          <input
            ref={inputRef}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Escape') { setCreating(false); setError(null) } }}
            placeholder="New organization name"
            aria-label="New organization name"
            className="w-48 rounded-md border border-line bg-surface-2 px-2 py-1 text-[12px] text-fg-0 placeholder:text-fg-3 focus:border-accent focus:outline-none"
          />
          <button
            type="submit"
            disabled={busy || !draft.trim()}
            aria-label="Create organization"
            className="rounded-md p-1.5 text-fg-2 transition-colors duration-fast ease-out hover:bg-surface-3 hover:text-fg-0 disabled:opacity-40"
          >
            <Check className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => { setCreating(false); setError(null) }}
            aria-label="Cancel"
            className="rounded-md p-1.5 text-fg-2 transition-colors duration-fast ease-out hover:bg-surface-3 hover:text-fg-0"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => { setDraft(''); setError(null); setCreating(true) }}
          className="inline-flex shrink-0 items-center gap-1 rounded-full border border-dashed border-line px-2.5 py-1 text-[12px] text-fg-2 transition-colors duration-fast ease-out hover:border-line-strong hover:text-fg-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
        >
          <Plus className="h-3 w-3" />
          New organization
        </button>
      ))}

      {error && (
        <span className="shrink-0 rounded-md border border-line bg-surface-1 px-2 py-1 text-[11.5px] text-[color:var(--ok-alarm)]">
          {error}
        </span>
      )}
    </div>
  )
}
