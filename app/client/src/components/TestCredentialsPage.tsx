/**
 * Settings → Test Credentials.
 *
 * Lists, creates, edits, and deletes the test credentials the AI Reviewer
 * uses at QA time. Field values are encrypted at rest on the server; the
 * list view shows only field NAMES (values rendered as ***), and the
 * edit modal fetches the single record's plaintext via GET /:slug only when
 * an admin clicks "Edit" or "Reveal".
 *
 * Visibility is determined by workspace-admin role: the server filters the
 * list by the caller's admin memberships, and the modal's workspace
 * dropdown only offers workspaces where the caller has admin role.
 */
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useAuth } from '../context/AuthContext'
import { useWorkspaces } from '../hooks/useWorkspaces'
import { api, ApiError } from '../lib/api'
import { Modal, Skeleton, useConfirm } from './ui'
import type {
  CreateTestCredentialRequest,
  TestCredential,
  UpdateTestCredentialRequest,
} from '@command-center/shared'

type FieldRow = { key: string; value: string; revealed: boolean }

function toFieldRows(fields: Record<string, string>): FieldRow[] {
  return Object.entries(fields).map(([k, v]) => ({ key: k, value: v, revealed: false }))
}

function rowsToFields(rows: FieldRow[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const r of rows) {
    const k = r.key.trim()
    if (k) out[k] = r.value
  }
  return out
}

export function TestCredentialsPage({ embedded = false }: { embedded?: boolean }) {
  const { user } = useAuth()
  const { slugs: wsSlugs } = useWorkspaces()
  const isGlobalAdmin = user?.role === 'admin'

  // Organizations the caller can admin (server enforces too, this just scopes the dropdown).
  const adminWorkspaces = useMemo<string[]>(() => {
    if (isGlobalAdmin) return wsSlugs
    return (user?.workspaces || []).filter(w => w.role === 'admin').map(w => w.workspace)
  }, [isGlobalAdmin, user?.workspaces, wsSlugs])

  const [creds, setCreds] = useState<TestCredential[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<TestCredential | null>(null)
  const { confirm, confirmDialog } = useConfirm()

  async function reload() {
    setLoading(true)
    setError('')
    try {
      const data = await api.get<TestCredential[]>('/test-credentials')
      setCreds(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Load failed')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void reload() }, [])

  async function openEdit(slug: string) {
    // GET /:slug returns the decrypted fields (server checks admin role).
    try {
      const full = await api.get<TestCredential>(`/test-credentials/${encodeURIComponent(slug)}`)
      setEditing(full)
      setModalOpen(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Load failed')
    }
  }

  function openCreate() {
    setEditing(null)
    setModalOpen(true)
  }

  async function handleDelete(slug: string) {
    if (!(await confirm({
      title: 'Delete test credential?',
      message: `'${slug}' will be permanently removed.`,
      confirmLabel: 'Delete',
      danger: true,
    }))) return
    try {
      await api.del<void>(`/test-credentials/${encodeURIComponent(slug)}`)
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed')
    }
  }

  if (adminWorkspaces.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-fg-3 text-sm">
        Organization admin role required to manage test credentials.
      </div>
    )
  }

  return (
    <div className={embedded ? '' : 'h-full overflow-y-auto p-6'}>
      <div className={embedded ? '' : 'max-w-5xl mx-auto'}>
        <div className={embedded ? 'mb-4 flex items-center justify-between' : 'mb-5 flex items-center justify-between'}>
          <div>
            {!embedded && <h1 className="text-xl font-semibold text-fg-0">Test Credentials</h1>}
            <p className={embedded ? 'text-xs text-fg-3' : 'mt-1 text-xs text-fg-3'}>
              Encrypted at rest. Used by the AI Reviewer to log into deliverables during automated QA.
            </p>
          </div>
          <button
            onClick={openCreate}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-fg-0 transition-colors duration-fast ease-out hover:bg-accent-hover"
          >
            + New
          </button>
        </div>

        {error && (
          <div className="mb-4 rounded bg-signal-alarm/10 px-3 py-2 text-sm text-signal-alarm">{error}</div>
        )}

        {loading ? (
          <div className="overflow-x-auto rounded-lg border border-border bg-surface-raised">
            <table className="w-full text-sm">
              <thead className="bg-surface border-b border-border">
                <tr className="text-left text-xs text-fg-2">
                  <th className="px-3 py-2 font-medium">Slug</th>
                  <th className="px-3 py-2 font-medium">Label</th>
                  <th className="px-3 py-2 font-medium">Organization</th>
                  <th className="px-3 py-2 font-medium">Project</th>
                  <th className="px-3 py-2 font-medium">Login URL</th>
                  <th className="px-3 py-2 font-medium">Updated</th>
                  <th className="px-3 py-2 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: 4 }).map((_, i) => (
                  <tr key={i} className="border-b border-border last:border-b-0">
                    <td className="px-3 py-2"><Skeleton className="h-4 w-28" /></td>
                    <td className="px-3 py-2"><Skeleton className="h-4 w-24" /></td>
                    <td className="px-3 py-2"><Skeleton className="h-4 w-20" /></td>
                    <td className="px-3 py-2"><Skeleton className="h-4 w-16" /></td>
                    <td className="px-3 py-2"><Skeleton className="h-4 w-40" /></td>
                    <td className="px-3 py-2"><Skeleton className="h-4 w-24" /></td>
                    <td className="px-3 py-2"><div className="flex justify-end gap-2"><Skeleton className="h-4 w-8" /><Skeleton className="h-4 w-10" /></div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : creds.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-fg-3">
            No test credentials yet. Click "New" to add one.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border bg-surface-raised">
            <table className="w-full text-sm">
              <thead className="bg-surface border-b border-border">
                <tr className="text-left text-xs text-fg-2">
                  <th className="px-3 py-2 font-medium">Slug</th>
                  <th className="px-3 py-2 font-medium">Label</th>
                  <th className="px-3 py-2 font-medium">Organization</th>
                  <th className="px-3 py-2 font-medium">Project</th>
                  <th className="px-3 py-2 font-medium">Login URL</th>
                  <th className="px-3 py-2 font-medium">Updated</th>
                  <th className="px-3 py-2 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {creds.map(c => (
                  <tr key={c.slug} className="border-b border-border last:border-b-0 hover:bg-surface-overlay/40">
                    <td className="px-3 py-2 font-mono text-xs text-fg-1">{c.slug}</td>
                    <td className="px-3 py-2 text-fg-1">{c.label}</td>
                    <td className="px-3 py-2 text-fg-2">{c.workspace}</td>
                    <td className="px-3 py-2 text-fg-2">{c.project || '—'}</td>
                    <td className="px-3 py-2 text-fg-2 truncate max-w-[260px]">
                      <a href={c.login_url} target="_blank" rel="noopener noreferrer" className="text-status-working/80 hover:text-status-working truncate">
                        {c.login_url}
                      </a>
                    </td>
                    <td className="px-3 py-2 text-fg-3 text-xs">{c.updated_at?.slice(0, 16).replace('T', ' ')}</td>
                    <td className="px-3 py-2 text-right space-x-2">
                      <button onClick={() => openEdit(c.slug)} className="text-xs text-accent hover:underline">Edit</button>
                      <button onClick={() => handleDelete(c.slug)} className="text-xs text-signal-alarm hover:underline">Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {modalOpen && (
        <TestCredentialModal
          existing={editing}
          adminWorkspaces={adminWorkspaces}
          onClose={() => setModalOpen(false)}
          onSaved={async () => {
            setModalOpen(false)
            await reload()
          }}
        />
      )}
      {confirmDialog}
    </div>
  )
}

// ─── Add/Edit modal ─────────────────────────────────────────────────────────

interface ModalProps {
  existing: TestCredential | null
  adminWorkspaces: string[]
  onClose: () => void
  onSaved: () => Promise<void>
}

function TestCredentialModal({ existing, adminWorkspaces, onClose, onSaved }: ModalProps) {
  const isEdit = !!existing
  const [slug, setSlug] = useState(existing?.slug || '')
  const [workspace, setWorkspace] = useState(existing?.workspace || adminWorkspaces[0] || '')
  const [project, setProject] = useState(existing?.project || '')
  const [label, setLabel] = useState(existing?.label || '')
  const [loginUrl, setLoginUrl] = useState(existing?.login_url || '')
  const [notes, setNotes] = useState(existing?.notes || '')
  const [fieldRows, setFieldRows] = useState<FieldRow[]>(
    existing ? toFieldRows(existing.fields) : [{ key: '', value: '', revealed: true }]
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  function addField() {
    setFieldRows(rows => [...rows, { key: '', value: '', revealed: true }])
  }

  function removeField(i: number) {
    setFieldRows(rows => rows.filter((_, idx) => idx !== i))
  }

  function updateField(i: number, patch: Partial<FieldRow>) {
    setFieldRows(rows => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    const fields = rowsToFields(fieldRows)
    if (Object.keys(fields).length === 0) {
      setError('At least one field is required.')
      return
    }
    setSaving(true)
    try {
      if (isEdit && existing) {
        const body: UpdateTestCredentialRequest = {
          workspace,
          project: project || null,
          label,
          login_url: loginUrl,
          fields,
          notes: notes || null,
        }
        await api.put<TestCredential>(`/test-credentials/${encodeURIComponent(existing.slug)}`, body)
      } else {
        const body: CreateTestCredentialRequest = {
          slug,
          workspace,
          project: project || null,
          label,
          login_url: loginUrl,
          fields,
          notes: notes || null,
        }
        await api.post<TestCredential>('/test-credentials', body)
      }
      await onSaved()
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message)
      } else {
        setError(err instanceof Error ? err.message : 'Save failed')
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open onClose={onClose} variant="center" labelledBy="test-cred-title" panelClassName="max-w-xl bg-surface-raised">
      <div className="p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 id="test-cred-title" className="text-lg font-semibold text-fg-0">
            {isEdit ? 'Edit Test Credential' : 'New Test Credential'}
          </h2>
          <button onClick={onClose} className="text-fg-3 hover:text-fg-1" type="button">
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {error && (
          <div className="mb-3 rounded bg-signal-alarm/10 px-3 py-2 text-sm text-signal-alarm">{error}</div>
        )}

        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs text-fg-2">Slug {isEdit && <span className="text-fg-3">(locked)</span>}</label>
              <input
                type="text"
                value={slug}
                onChange={e => setSlug(e.target.value)}
                disabled={isEdit}
                placeholder="e.g. example-staging-admin"
                className="w-full rounded border border-border bg-surface px-2 py-1.5 text-sm text-fg-0 outline-none focus:border-accent disabled:opacity-50"
                required
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-fg-2">Organization</label>
              <select
                value={workspace}
                onChange={e => setWorkspace(e.target.value)}
                className="w-full rounded border border-border bg-surface px-2 py-1.5 text-sm text-fg-0 outline-none focus:border-accent"
                required
              >
                {adminWorkspaces.map(ws => (
                  <option key={ws} value={ws}>{ws}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs text-fg-2">Label</label>
              <input
                type="text"
                value={label}
                onChange={e => setLabel(e.target.value)}
                placeholder="Human-readable name"
                className="w-full rounded border border-border bg-surface px-2 py-1.5 text-sm text-fg-0 outline-none focus:border-accent"
                required
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-fg-2">Project (optional)</label>
              <input
                type="text"
                value={project}
                onChange={e => setProject(e.target.value)}
                placeholder="project slug or blank"
                className="w-full rounded border border-border bg-surface px-2 py-1.5 text-sm text-fg-0 outline-none focus:border-accent"
              />
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs text-fg-2">Login URL</label>
            <input
              type="url"
              value={loginUrl}
              onChange={e => setLoginUrl(e.target.value)}
              placeholder="https://staging.example.com/login"
              className="w-full rounded border border-border bg-surface px-2 py-1.5 text-sm text-fg-0 outline-none focus:border-accent"
              required
            />
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between">
              <label className="text-xs text-fg-2">Fields</label>
              <button
                type="button"
                onClick={addField}
                className="text-xs text-accent hover:underline"
              >
                + Add field
              </button>
            </div>
            <div className="space-y-1.5">
              {fieldRows.map((row, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <input
                    type="text"
                    value={row.key}
                    onChange={e => updateField(i, { key: e.target.value })}
                    placeholder="name (e.g. username)"
                    className="flex-1 rounded border border-border bg-surface px-2 py-1 text-xs text-fg-0 outline-none focus:border-accent"
                  />
                  <input
                    type={row.revealed ? 'text' : 'password'}
                    value={row.value}
                    onChange={e => updateField(i, { value: e.target.value })}
                    placeholder="value"
                    className="flex-[2] rounded border border-border bg-surface px-2 py-1 text-xs text-fg-0 outline-none focus:border-accent"
                  />
                  <button
                    type="button"
                    onClick={() => updateField(i, { revealed: !row.revealed })}
                    className="text-xs text-fg-3 hover:text-fg-1 px-1"
                    title={row.revealed ? 'Hide' : 'Reveal'}
                  >
                    {row.revealed ? '⯇' : '⯈'}
                  </button>
                  <button
                    type="button"
                    onClick={() => removeField(i)}
                    className="text-xs text-signal-alarm hover:text-signal-alarm px-1"
                  >
                    &times;
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs text-fg-2">Notes</label>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              rows={2}
              placeholder="optional context for future operators"
              className="w-full resize-none rounded border border-border bg-surface px-2 py-1.5 text-sm text-fg-0 outline-none focus:border-accent"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded px-3 py-1.5 text-sm text-fg-2 hover:bg-surface-overlay"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-fg-0 hover:bg-accent-hover disabled:opacity-50"
            >
              {saving ? 'Saving...' : isEdit ? 'Update' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </Modal>
  )
}
