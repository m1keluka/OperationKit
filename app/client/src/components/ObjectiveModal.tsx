import { memo, useState, useEffect, useRef, type FormEvent, type ChangeEvent } from 'react'
import { X, Plus, Check } from 'lucide-react'
import { Modal, useConfirm } from './ui'
import { useAuth } from '../context/AuthContext'
import { useWorkspaces } from '../hooks/useWorkspaces'
import { api } from '../lib/api'
import { useProjects } from '../hooks/useProjects'
import type {
  Objective,
  CreateObjectiveRequest,
  UpdateObjectiveRequest,
  Workspace,
  ModelsConfig,
  ModelRow,
  User,
} from '@operationkit/shared'
import { fieldCls, labelCls } from './objective-modal/form-tokens'
import { FooterActions } from './objective-modal/FooterActions'

interface ObjectiveModalProps {
  objective: Objective | null
  workspace: Workspace
  onClose: () => void
  onCreate: (data: CreateObjectiveRequest) => Promise<Objective>
  onUpdate: (id: number, data: UpdateObjectiveRequest) => Promise<Objective>
  onDelete: (id: number) => Promise<void>
  onReopen?: (id: number) => void
  /** Project (org subfolder) to preselect when CREATING from inside an open
   *  project on the board. Ignored in edit mode. Null = no project. */
  defaultProjectId?: number | null
}

function ObjectiveModalImpl({ objective, workspace, onClose, onCreate, onUpdate, onDelete, onReopen, defaultProjectId = null }: ObjectiveModalProps) {
  const { user: currentUser } = useAuth()
  const { confirm, confirmDialog } = useConfirm()
  const isAdmin = currentUser?.role === 'admin'
  const isEdit = !!objective
  const [title, setTitle] = useState(objective?.title || '')
  const [description, setDescription] = useState(objective?.description || '')
  const [descHydrated, setDescHydrated] = useState(!objective)
  const [objWorkspace, setObjWorkspace] = useState(objective?.workspace || (workspace === 'all' ? 'example' : workspace))
  const [objProjectId, setObjProjectId] = useState<number | null>(
    objective ? objective.project_id ?? null : defaultProjectId
  )
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [creatingProject, setCreatingProject] = useState(false)
  const [newProjectName, setNewProjectName] = useState('')
  const [projectBusy, setProjectBusy] = useState(false)

  // Model selection
  const [models, setModels] = useState<ModelRow[]>([])
  const [defaultModel, setDefaultModel] = useState('')
  const [model, setModel] = useState(objective?.model || '')

  // Delegator mode (admin-only)
  const [delegateMode, setDelegateMode] = useState(objective?.delegate_mode ?? false)

  // Assign to user (admin-only)
  const [users, setUsers] = useState<Array<{ id: number; username: string }>>([])
  const [assignedUserId, setAssignedUserId] = useState<number | null>(
    objective?.assigned_user_id ?? null
  )

  // File attachments
  const [pendingFiles, setPendingFiles] = useState<File[]>([])
  const [uploading, setUploading] = useState(false)

  const { slugs: wsSlugs, labelOf } = useWorkspaces()

  const workspaceOptions: string[] = isAdmin
    ? wsSlugs
    : (currentUser?.workspaces?.map(w => w.workspace) || [])

  const titleRef = useRef<HTMLTextAreaElement>(null)
  const descRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = titleRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`
  }, [title])

  useEffect(() => {
    const el = descRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`
  }, [description])

  // Hydrate description for edit mode
  useEffect(() => {
    if (!objective) { setDescHydrated(true); return }
    let cancelled = false
    setDescHydrated(false)
    api.get<Objective>(`/objectives/${objective.id}`)
      .then(full => {
        if (cancelled) return
        if (typeof full.description === 'string') setDescription(full.description)
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setDescHydrated(true) })
    return () => { cancelled = true }
  }, [objective?.id])

  // Load enabled models from registry
  useEffect(() => {
    api.get<ModelsConfig>('/models')
      .then(data => {
        const enabled = (data.models || []).filter(m => m.enabled)
        setModels(enabled)
        setDefaultModel(data.default || '')
        // Pre-select: in edit mode use the objective's model; else use registry default
        if (!isEdit && !model) setModel(data.default || '')
      })
      .catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEdit])

  // Load users for assignee picker (admin-only; silently skip on 403)
  useEffect(() => {
    if (!isAdmin) return
    api.get<User[]>('/admin/users')
      .then(list => setUsers(list.map(u => ({ id: u.id, username: u.username }))))
      .catch(() => {})
  }, [isAdmin])

  const { projects: availableProjects, createProject } = useProjects(objWorkspace)

  useEffect(() => {
    if (objProjectId == null) return
    if (availableProjects.length === 0) return
    if (!availableProjects.some(p => p.id === objProjectId)) setObjProjectId(null)
  }, [availableProjects, objProjectId])

  async function handleCreateProject() {
    const name = newProjectName.trim()
    if (!name) return
    setProjectBusy(true)
    setError('')
    try {
      const created = await createProject(name)
      setObjProjectId(created.id)
      setCreatingProject(false)
      setNewProjectName('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create project')
    } finally {
      setProjectBusy(false)
    }
  }

  async function uploadFiles(objectiveId: number) {
    if (pendingFiles.length === 0) return
    const form = new FormData()
    for (const f of pendingFiles) form.append('files', f)
    await fetch(`/api/objectives/${objectiveId}/upload`, {
      method: 'POST',
      credentials: 'include',
      body: form,
    })
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')

    try {
      if (isEdit) {
        await onUpdate(objective.id, {
          title,
          description,
          workspace: objWorkspace,
          project_id: objProjectId,
          model: model || undefined,
          delegate_mode: isAdmin ? delegateMode : undefined,
          assigned_user_id: isAdmin ? assignedUserId : undefined,
        })
        if (pendingFiles.length > 0) {
          setUploading(true)
          await uploadFiles(objective.id)
          setPendingFiles([])
        }
      } else {
        const created = await onCreate({
          title,
          description,
          workspace: objWorkspace,
          project_id: objProjectId,
          model: model || undefined,
          delegate_mode: isAdmin ? delegateMode : undefined,
          assigned_user_id: isAdmin ? assignedUserId : undefined,
        })
        if (pendingFiles.length > 0 && created?.id) {
          setUploading(true)
          await uploadFiles(created.id)
        }
      }
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Operation failed')
    } finally {
      setLoading(false)
      setUploading(false)
    }
  }

  async function handleDelete() {
    if (!objective) return
    if (!(await confirm({
      title: 'Delete this objective?',
      message: 'This permanently removes the objective and its session history. This cannot be undone.',
      confirmLabel: 'Delete',
      danger: true,
    }))) return
    setLoading(true)
    try {
      await onDelete(objective.id)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed')
    } finally {
      setLoading(false)
    }
  }

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || [])
    setPendingFiles(prev => [...prev, ...files])
    e.target.value = ''
  }

  function removeFile(name: string) {
    setPendingFiles(prev => prev.filter(f => f.name !== name))
  }

  return (
    <Modal
      open
      onClose={onClose}
      variant="center"
      labelledBy="objective-modal-title"
      panelClassName="max-w-xl"
    >
      <div className="p-5 sm:p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 id="objective-modal-title" className="text-[17px] font-semibold tracking-tight text-fg-0">
            {isEdit ? 'Edit Objective' : 'New Objective'}
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1.5 text-fg-2 transition-colors duration-fast ease-out hover:bg-surface-3 hover:text-fg-0"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {error && (
          <div className="mb-4 rounded-md border border-flag-blocked/30 bg-flag-blocked/10 px-3 py-2 text-sm text-flag-blocked">{error}</div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className={labelCls}>Title</label>
            <textarea
              ref={titleRef}
              value={title}
              onChange={e => setTitle(e.target.value)}
              rows={1}
              className={`${fieldCls} resize-none overflow-y-auto`}
              placeholder="What needs to be done?"
              autoFocus
              required
            />
          </div>

          <div>
            <label className={labelCls}>Description / Instructions</label>
            <textarea
              ref={descRef}
              value={description}
              onChange={e => setDescription(e.target.value)}
              rows={5}
              className={`${fieldCls} resize-none overflow-y-auto`}
              placeholder="Detailed context and instructions for the AI session…"
            />
          </div>

          <div>
            <label className={labelCls}>Organization</label>
            <select
              value={objWorkspace}
              onChange={e => setObjWorkspace(e.target.value)}
              className={fieldCls}
            >
              {workspaceOptions.map(ws => (
                <option key={ws} value={ws}>{labelOf(ws)}</option>
              ))}
            </select>
          </div>

          <div>
            <label className={labelCls}>Project</label>
            {creatingProject ? (
              <div className="flex items-center gap-2">
                <input
                  value={newProjectName}
                  onChange={e => setNewProjectName(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') { e.preventDefault(); void handleCreateProject() }
                    if (e.key === 'Escape') { setCreatingProject(false); setNewProjectName('') }
                  }}
                  placeholder="New project name"
                  aria-label="New project name"
                  autoFocus
                  className={fieldCls}
                />
                <button
                  type="button"
                  onClick={() => void handleCreateProject()}
                  disabled={projectBusy || !newProjectName.trim()}
                  aria-label="Create project"
                  className="rounded-md p-2 text-fg-2 transition-colors duration-fast ease-out hover:bg-surface-3 hover:text-fg-0 disabled:opacity-40"
                >
                  <Check className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => { setCreatingProject(false); setNewProjectName('') }}
                  aria-label="Cancel new project"
                  className="rounded-md p-2 text-fg-2 transition-colors duration-fast ease-out hover:bg-surface-3 hover:text-fg-0"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <select
                  value={objProjectId ?? ''}
                  onChange={e => setObjProjectId(e.target.value ? Number(e.target.value) : null)}
                  className={fieldCls}
                >
                  <option value="">No project</option>
                  {availableProjects.map(proj => (
                    <option key={proj.id} value={proj.id}>{proj.name}</option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => { setCreatingProject(true); setNewProjectName('') }}
                  aria-label="New project"
                  title="Create a project in this organization"
                  className="inline-flex shrink-0 items-center gap-1 rounded-md border border-line px-2.5 py-2 text-[12.5px] text-fg-2 transition-colors duration-fast ease-out hover:border-line-strong hover:text-fg-0"
                >
                  <Plus className="h-3.5 w-3.5" />
                  New
                </button>
              </div>
            )}
          </div>

          {/* Model selection — shown when the registry returns at least one enabled model */}
          {models.length > 0 && (
            <div>
              <label className={labelCls}>Model</label>
              <select
                value={model || defaultModel}
                onChange={e => setModel(e.target.value)}
                className={fieldCls}
              >
                {models.map(m => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
            </div>
          )}

          {/* Assignee picker — admin-only, shown when user list is available */}
          {isAdmin && users.length > 0 && (
            <div>
              <label className={labelCls}>Assign To</label>
              <select
                value={assignedUserId ?? ''}
                onChange={e => setAssignedUserId(e.target.value ? Number(e.target.value) : null)}
                className={fieldCls}
              >
                <option value="">Unassigned</option>
                {users.map(u => (
                  <option key={u.id} value={u.id}>{u.username}</option>
                ))}
              </select>
            </div>
          )}

          {/* Delegator mode — admin-only */}
          {isAdmin && (
            <div className="flex items-center gap-2">
              <input
                id="delegate-mode"
                type="checkbox"
                checked={delegateMode}
                onChange={e => setDelegateMode(e.target.checked)}
                className="h-4 w-4 rounded border-line-strong accent-accent"
              />
              <label htmlFor="delegate-mode" className="text-[12.5px] font-medium text-fg-1 cursor-pointer select-none">
                Delegator mode
              </label>
            </div>
          )}

          {/* File attachments */}
          <div>
            <label className={labelCls}>Attach Files</label>
            <input
              type="file"
              multiple
              onChange={handleFileChange}
              className="block w-full text-sm text-fg-2 file:mr-3 file:rounded-md file:border file:border-line file:bg-surface-3 file:px-2.5 file:py-1.5 file:text-[12.5px] file:text-fg-1 file:transition-colors file:duration-fast file:ease-out hover:file:border-line-strong hover:file:text-fg-0"
            />
            {pendingFiles.length > 0 && (
              <ul className="mt-2 space-y-1">
                {pendingFiles.map(f => (
                  <li key={f.name} className="flex items-center gap-2 text-[12.5px] text-fg-2">
                    <span className="truncate">{f.name}</span>
                    <button
                      type="button"
                      onClick={() => removeFile(f.name)}
                      aria-label={`Remove ${f.name}`}
                      className="shrink-0 text-fg-3 hover:text-fg-0 transition-colors duration-fast ease-out"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <FooterActions
            isEdit={isEdit}
            loading={loading}
            uploading={uploading}
            descHydrated={descHydrated}
            objective={objective}
            onDelete={handleDelete}
            onClose={onClose}
            onReopen={onReopen}
          />
        </form>
      </div>
      {confirmDialog}
    </Modal>
  )
}

// Memoized so board-level WebSocket broadcasts don't re-render the open modal.
// See obj 700070/700128 for the "bouncing/closing" select bug this prevents.
export const ObjectiveModal = memo(ObjectiveModalImpl)
