/**
 * Per-user secrets card — extracted from AccountSettings.tsx (behavior frozen).
 *
 * Every authenticated user can manage their own `user`-scoped secrets here.
 * Values are encrypted server-side and NEVER returned — the list shows a mask,
 * and editing requires re-entering the value.
 */
import { useEffect, useState, type FormEvent } from 'react'
import { api, ApiError } from '../../lib/api'
import { useAuth } from '../../context/AuthContext'
import { Modal, useConfirm } from '../ui'
import type { SecretSummary, SetSecretRequest } from '@operationkit/shared'

const MASK = '••••••'

export function MySecretsSection() {
  const { user } = useAuth()
  const [secrets, setSecrets] = useState<SecretSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const { confirm, confirmDialog } = useConfirm()

  async function reload() {
    if (!user) return
    setLoading(true)
    setError('')
    try {
      const data = await api.get<SecretSummary[]>(`/secrets?scopeType=user&userId=${user.id}`)
      setSecrets(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void reload() }, [user?.id])

  async function handleDelete(key: string) {
    if (!user) return
    const ok = await confirm({
      title: 'Delete secret?',
      message: `'${key}' will be permanently removed.`,
      confirmLabel: 'Delete',
      danger: true,
    })
    if (!ok) return
    try {
      await api.del<void>(`/secrets?scopeType=user&userId=${user.id}&key=${encodeURIComponent(key)}`)
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed')
    }
  }

  if (!user) return null

  return (
    <section className="mt-5 rounded-lg border border-border bg-surface-raised p-5">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-fg-0">My Secrets</h2>
          <p className="mt-1 text-xs text-fg-3">
            Personal secrets scoped to you. Stored encrypted; the value is never shown again after you save it.
          </p>
        </div>
        <button
          onClick={() => { setEditingKey(null); setModalOpen(true) }}
          className="shrink-0 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-fg-0 transition-colors duration-fast ease-out hover:bg-accent-hover"
        >
          + New
        </button>
      </div>

      {error && (
        <div className="mb-3 rounded bg-signal-alarm/10 px-3 py-2 text-sm text-signal-alarm">{error}</div>
      )}

      {loading ? (
        <div className="text-sm text-fg-3">Loading…</div>
      ) : secrets.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-fg-3">
          No personal secrets yet.
        </div>
      ) : (
        <table className="w-full text-sm">
          <thead className="border-b border-border">
            <tr className="text-left text-xs text-fg-2">
              <th className="py-2 font-medium">Key</th>
              <th className="py-2 font-medium">Value</th>
              <th className="py-2 font-medium">Version</th>
              <th className="py-2 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {secrets.map(s => (
              <tr key={s.key} className="border-b border-border last:border-b-0">
                <td className="py-2 font-mono text-xs text-fg-1">{s.key}</td>
                <td className="py-2 font-mono text-fg-3">{MASK}</td>
                <td className="py-2 text-fg-2">v{s.version}</td>
                <td className="py-2 text-right space-x-2">
                  <button onClick={() => { setEditingKey(s.key); setModalOpen(true) }} className="text-xs text-accent hover:underline">Edit</button>
                  <button onClick={() => handleDelete(s.key)} className="text-xs text-signal-alarm hover:underline">Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {modalOpen && (
        <MySecretModal
          userId={user.id}
          editingKey={editingKey}
          onClose={() => setModalOpen(false)}
          onSaved={async () => { setModalOpen(false); await reload() }}
        />
      )}
      {confirmDialog}
    </section>
  )
}

function MySecretModal({ userId, editingKey, onClose, onSaved }: {
  userId: number
  editingKey: string | null
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const isEdit = editingKey !== null
  const [key, setKey] = useState(editingKey || '')
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    if (!key.trim()) { setError('Key is required.'); return }
    if (!value) { setError('Value is required.'); return }
    setSaving(true)
    try {
      const body: SetSecretRequest = { scopeType: 'user', userId, key: key.trim(), value }
      await api.post<SecretSummary>('/secrets', body)
      await onSaved()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open onClose={onClose} variant="center" labelledBy="my-secret-title" panelClassName="max-w-lg bg-surface-raised">
      <div className="p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 id="my-secret-title" className="text-lg font-semibold text-fg-0">{isEdit ? 'Edit Secret' : 'New Secret'}</h2>
          <button onClick={onClose} className="text-fg-3 hover:text-fg-1" type="button">
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        {error && <div className="mb-3 rounded bg-signal-alarm/10 px-3 py-2 text-sm text-signal-alarm">{error}</div>}
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="mb-1 block text-xs text-fg-2">Key {isEdit && <span className="text-fg-3">(locked)</span>}</label>
            <input
              type="text"
              value={key}
              onChange={e => setKey(e.target.value)}
              disabled={isEdit}
              placeholder="e.g. MY_API_KEY"
              className="w-full rounded border border-border bg-surface px-2 py-1.5 font-mono text-sm text-fg-0 outline-none focus:border-accent disabled:opacity-50"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-fg-2">Value</label>
            <input
              type="password"
              autoComplete="off"
              value={value}
              onChange={e => setValue(e.target.value)}
              placeholder={isEdit ? 're-enter the value to set a new version' : 'secret value'}
              className="w-full rounded border border-border bg-surface px-2 py-1.5 font-mono text-sm text-fg-0 outline-none focus:border-accent"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="rounded px-3 py-1.5 text-sm text-fg-2 hover:bg-surface-overlay">Cancel</button>
            <button type="submit" disabled={saving} className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-fg-0 hover:bg-accent-hover disabled:opacity-50">
              {saving ? 'Saving...' : isEdit ? 'Update' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </Modal>
  )
}
