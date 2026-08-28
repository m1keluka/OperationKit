import { useState, useRef, useEffect, type FormEvent } from 'react'
import { Plus, Pencil, Trash2, Check, X, FolderOpen } from 'lucide-react'
import type { Project } from '@command-center/shared'
import { useConfirm } from './ui'
import { ALL_PROJECTS, UNASSIGNED_PROJECT, type ProjectSelection } from '../lib/projectFilter'

interface ProjectFilterBarProps {
  /** Projects belonging to the currently-open organization. */
  projects: Project[]
  selection: ProjectSelection
  onSelect: (selection: ProjectSelection) => void
  /** Null when the board is showing All / multiple organizations — a project
   *  lives inside exactly one org, so CRUD is disabled in that view. */
  workspace: string | null
  onCreate: (name: string) => Promise<unknown>
  onRename: (id: number, name: string) => Promise<unknown>
  onDelete: (id: number) => Promise<{ detached_objectives: number }>
}

const chipCls =
  'whitespace-nowrap rounded-full border px-2.5 py-1 text-[12px] transition-colors duration-fast ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50'
const chipOn = 'border-accent bg-surface-2 text-fg-0'
const chipOff = 'border-line text-fg-2 hover:border-line-strong hover:text-fg-1'

/**
 * The board's "open a subfolder inside this organization" control (obj 708826).
 *
 * Selecting a project filters the board to objectives whose `project_id`
 * matches; "All projects" is the default. Create / rename / delete all happen
 * inline here — the picker IS the management surface, so Mike never has to go
 * to a settings page or curl the API to make a folder.
 */
export function ProjectFilterBar({
  projects, selection, onSelect, workspace, onCreate, onRename, onDelete,
}: ProjectFilterBarProps) {
  const { confirm, confirmDialog } = useConfirm()
  // null = no inline editor open; 'new' = create; a number = rename that project.
  const [editing, setEditing] = useState<'new' | number | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { if (editing !== null) inputRef.current?.focus() }, [editing])
  // Close any open editor when the organization changes underneath us.
  useEffect(() => { setEditing(null); setError(null) }, [workspace])

  const canManage = !!workspace && workspace !== 'all'
  const selected = typeof selection === 'number' ? projects.find(p => p.id === selection) : undefined

  function openCreate() {
    setDraft('')
    setError(null)
    setEditing('new')
  }

  function openRename(project: Project) {
    setDraft(project.name)
    setError(null)
    setEditing(project.id)
  }

  async function submitEditor(e: FormEvent) {
    e.preventDefault()
    const name = draft.trim()
    if (!name || editing === null) return
    setBusy(true)
    setError(null)
    try {
      if (editing === 'new') {
        const created = await onCreate(name) as Project
        // Opening a folder you just made is the obvious next step.
        if (created && typeof created.id === 'number') onSelect(created.id)
      } else {
        await onRename(editing, name)
      }
      setEditing(null)
      setDraft('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save project')
    } finally {
      setBusy(false)
    }
  }

  async function handleDelete(project: Project) {
    const count = project.objective_count ?? 0
    if (!(await confirm({
      title: `Delete project “${project.name}”?`,
      message: count > 0
        ? `${count} objective${count === 1 ? '' : 's'} in this project will be kept and moved back to “No project”. Nothing is deleted except the folder itself.`
        : 'This project has no objectives. Deleting removes the folder only.',
      confirmLabel: 'Delete project',
      danger: true,
    }))) return
    setBusy(true)
    setError(null)
    try {
      await onDelete(project.id)
      if (selection === project.id) onSelect(ALL_PROJECTS)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete project')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      data-testid="project-filter-bar"
      className="flex items-center gap-2 overflow-x-auto border-b border-line px-4 py-2"
    >
      <span className="inline-flex shrink-0 items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.12em] text-fg-3">
        <FolderOpen className="h-3.5 w-3.5" aria-hidden="true" />
        Project
      </span>

      <div className="flex shrink-0 items-center gap-1" role="group" aria-label="Filter board by project">
        <button
          type="button"
          onClick={() => onSelect(ALL_PROJECTS)}
          aria-pressed={selection === ALL_PROJECTS}
          className={`${chipCls} ${selection === ALL_PROJECTS ? chipOn : chipOff}`}
        >
          All projects
        </button>

        {projects.map(p => (
          <button
            key={p.id}
            type="button"
            onClick={() => onSelect(p.id)}
            aria-pressed={selection === p.id}
            data-project-id={p.id}
            className={`${chipCls} ${selection === p.id ? chipOn : chipOff}`}
          >
            {p.name}
            {typeof p.objective_count === 'number' && (
              <span className="ml-1.5 font-mono text-[10.5px] text-fg-3">{p.objective_count}</span>
            )}
          </button>
        ))}

        {projects.length > 0 && (
          <button
            type="button"
            onClick={() => onSelect(UNASSIGNED_PROJECT)}
            aria-pressed={selection === UNASSIGNED_PROJECT}
            className={`${chipCls} ${selection === UNASSIGNED_PROJECT ? chipOn : chipOff}`}
          >
            No project
          </button>
        )}
      </div>

      {/* Inline create / rename — the picker is also the management surface. */}
      {canManage && editing !== null ? (
        <form onSubmit={submitEditor} className="flex shrink-0 items-center gap-1">
          <input
            ref={inputRef}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Escape') { setEditing(null); setError(null) } }}
            placeholder={editing === 'new' ? 'New project name' : 'Project name'}
            aria-label={editing === 'new' ? 'New project name' : 'Rename project'}
            className="w-44 rounded-md border border-line bg-surface-2 px-2 py-1 text-[12px] text-fg-0 placeholder:text-fg-3 focus:border-accent focus:outline-none"
          />
          <button
            type="submit"
            disabled={busy || !draft.trim()}
            aria-label={editing === 'new' ? 'Create project' : 'Save project name'}
            className="rounded-md p-1.5 text-fg-2 transition-colors duration-fast ease-out hover:bg-surface-3 hover:text-fg-0 disabled:opacity-40"
          >
            <Check className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => { setEditing(null); setError(null) }}
            aria-label="Cancel"
            className="rounded-md p-1.5 text-fg-2 transition-colors duration-fast ease-out hover:bg-surface-3 hover:text-fg-0"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </form>
      ) : canManage && (
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={openCreate}
            className="inline-flex items-center gap-1 rounded-full border border-dashed border-line px-2.5 py-1 text-[12px] text-fg-2 transition-colors duration-fast ease-out hover:border-line-strong hover:text-fg-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
          >
            <Plus className="h-3 w-3" />
            New project
          </button>
          {selected && (
            <>
              <button
                type="button"
                onClick={() => openRename(selected)}
                aria-label={`Rename ${selected.name}`}
                title="Rename this project"
                className="rounded-md p-1.5 text-fg-2 transition-colors duration-fast ease-out hover:bg-surface-3 hover:text-fg-0"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => handleDelete(selected)}
                disabled={busy}
                aria-label={`Delete ${selected.name}`}
                title="Delete this project (objectives are kept)"
                className="rounded-md p-1.5 text-fg-2 transition-colors duration-fast ease-out hover:bg-surface-3 hover:text-[color:var(--ok-alarm)] disabled:opacity-40"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </>
          )}
        </div>
      )}

      {error && (
        <span className="shrink-0 rounded-md border border-line bg-surface-1 px-2 py-1 text-[11.5px] text-[color:var(--ok-alarm)]">
          {error}
        </span>
      )}

      {confirmDialog}
    </div>
  )
}
