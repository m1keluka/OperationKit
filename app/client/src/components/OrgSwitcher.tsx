import { useState, useRef, useEffect, type FormEvent } from 'react'
import { Plus, Check, X, Building2 } from 'lucide-react'
import { FilterDropdown, DropdownOption } from './FilterDropdown'

export interface OrgChoice {
  slug: string
  /** Full name, shown in the list. */
  label: string
  /** Short name for the trigger when several are picked. */
  short?: string
}

interface OrgSwitcherProps {
  /** Organizations the caller can see, in display order. */
  organizations: OrgChoice[]
  /** Currently selected slugs. EMPTY means "All organizations". */
  selected: string[]
  onChange: (next: string[]) => void
  /** Admins may create an organization inline; members just filter. */
  canCreate?: boolean
  /** Create an org. Wired to POST /api/admin/workspaces. */
  onCreate?: (name: string, slug: string) => Promise<unknown>
  /** True while the org list is still loading — suppresses the empty state. */
  loading?: boolean
  /** Extra trigger classes (the mobile bar uses a tighter trigger). */
  triggerClassName?: string
  /** Panel alignment. */
  align?: 'left' | 'right' | 'center'
}

/**
 * Derive a URL/DB-safe slug from a typed organization name, matching the
 * server's rule (`^[a-z0-9][a-z0-9-]{1,40}$` in `admin-workspaces.ts`): lowercase,
 * non-alphanumerics collapse to a single hyphen, trimmed, capped at 41 chars.
 * Exported because the slug is what the app selects afterwards, so the test
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
 * The global organization switcher — lives in the top bar next to "Jump to"
 * and scopes every org-aware page (board, archive, Knowledge, Jobs, Agents).
 *
 * History: obj 900197 added an always-visible org chip row ON the board
 * because the old top-bar dropdown vanished whenever the caller had one
 * visible org. obj 900666 moved the control back to the top bar (Operator: the
 * board header was cluttered and the org should set the whole page) and kept
 * what 900197 fixed: this switcher renders even with a single org, says so
 * when there are none, and an admin creates an organization from inside it.
 */
export function OrgSwitcher({
  organizations, selected, onChange, canCreate = false, onCreate, loading = false,
  triggerClassName, align = 'center',
}: OrgSwitcherProps) {
  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { if (creating) inputRef.current?.focus() }, [creating])

  const allSelected = selected.length === 0
  const shortOf = (slug: string) => {
    const o = organizations.find(x => x.slug === slug)
    return o?.short || o?.label || slug
  }
  const value = allSelected
    ? 'All orgs'
    : selected.length === 1
      ? (organizations.find(o => o.slug === selected[0])?.label ?? selected[0])
      : selected.length === 2
        ? selected.map(shortOf).join(' + ')
        : `${selected.length} orgs`

  function toggle(slug: string) {
    // Deselecting the last org returns to All rather than an empty board —
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
    <FilterDropdown
      testId="org-switcher"
      label="Org"
      value={value}
      ariaLabel={`Organization: ${value}`}
      title="Organization — scopes the whole app"
      icon={<Building2 className="h-3.5 w-3.5 shrink-0 text-fg-3" aria-hidden="true" />}
      align={align}
      panelClassName="w-60"
      triggerClassName={triggerClassName}
    >
      {() => (
        <>
          <div className="max-h-80 overflow-y-auto" role="group" aria-label="Choose organization">
            <DropdownOption selected={allSelected} onClick={() => onChange([])}>
              All orgs
            </DropdownOption>
            {organizations.length > 0 && <div className="my-1 border-t border-line-soft" />}
            {organizations.map(o => (
              <DropdownOption
                key={o.slug}
                multi
                selected={selected.includes(o.slug)}
                onClick={() => toggle(o.slug)}
                data-workspace={o.slug}
              >
                {o.label}
              </DropdownOption>
            ))}
            {!loading && organizations.length === 0 && (
              <div className="px-3 py-1.5 text-[12px] text-fg-3">No organizations yet</div>
            )}
          </div>

          {canCreate && (
            <div className="mt-1 border-t border-line-soft px-2 pb-1 pt-1.5">
              {creating ? (
                <form onSubmit={submit} className="flex items-center gap-1">
                  <input
                    ref={inputRef}
                    value={draft}
                    onChange={e => setDraft(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Escape') { e.stopPropagation(); setCreating(false); setError(null) }
                    }}
                    placeholder="New organization name"
                    aria-label="New organization name"
                    className="min-w-0 flex-1 rounded-md border border-line bg-surface-2 px-2 py-1 text-[12px] text-fg-0 placeholder:text-fg-3 focus:border-accent focus:outline-none"
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
                  className="inline-flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] text-fg-2 transition-colors duration-fast ease-out hover:bg-surface-3 hover:text-fg-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
                >
                  <Plus className="h-3.5 w-3.5" />
                  New organization
                </button>
              )}
              {error && (
                <div className="mt-1.5 rounded-md border border-line bg-surface-2 px-2 py-1 text-[12px] text-[color:var(--ok-alarm)]">
                  {error}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </FilterDropdown>
  )
}
