/**
 * Secret version history + rollback — extracted from SecretsPage.tsx
 * (behavior frozen).
 */
import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { Modal, useConfirm } from '../ui'
import type {
  SecretSummary,
  SecretVersionSummary,
  RollbackSecretRequest,
} from '@command-center/shared'
import { SCOPE_LABELS, scopeQuery, type Scope } from './scope'

interface VersionHistoryProps {
  /** The ROW's scope — history and rollback always address the row itself. */
  scope: Scope
  secretKey: string
  onClose: () => void
  onRolledBack: () => Promise<void>
}

export function VersionHistoryModal({ scope, secretKey, onClose, onRolledBack }: VersionHistoryProps) {
  const [versions, setVersions] = useState<SecretVersionSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const { confirm, confirmDialog } = useConfirm()
  const q = scopeQuery(scope)

  useEffect(() => {
    let cancelled = false
    api.get<SecretVersionSummary[]>(`/secrets/versions?${q}&key=${encodeURIComponent(secretKey)}`)
      .then(data => { if (!cancelled) { setVersions(data); setLoading(false) } })
      .catch(err => { if (!cancelled) { setError(err instanceof Error ? err.message : 'Load failed'); setLoading(false) } })
    return () => { cancelled = true }
  }, [q, secretKey])

  async function handleRollback(toVersion: number) {
    if (!(await confirm({
      title: `Roll back to v${toVersion}?`,
      message: `This re-applies v${toVersion}'s value as a new version (history is append-only).`,
      confirmLabel: 'Roll back',
    }))) return
    try {
      const body: RollbackSecretRequest = {
        scopeType: scope.scopeType,
        workspace: scope.workspace ?? undefined,
        userId: scope.userId ?? undefined,
        key: secretKey,
        toVersion,
      }
      await api.post<SecretSummary>('/secrets/rollback', body)
      await onRolledBack()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Rollback failed')
    }
  }

  return (
    <Modal open onClose={onClose} variant="center" labelledBy="secret-history-title" panelClassName="max-w-lg bg-surface-raised">
      <div className="p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 id="secret-history-title" className="text-lg font-semibold text-fg-0">
            Version history — <span className="font-mono text-base">{secretKey}</span>
          </h2>
          <button onClick={onClose} className="text-fg-3 hover:text-fg-1" type="button">
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <p className="mb-3 text-[11px] text-fg-3">
          Scope: <span className="text-fg-2">{SCOPE_LABELS[scope.scopeType]}</span>
          {scope.workspace && <span className="text-fg-2"> · {scope.workspace}</span>}
          {scope.userId != null && <span className="text-fg-2"> · user #{scope.userId}</span>}
        </p>

        {error && (
          <div className="mb-3 rounded bg-signal-alarm/10 px-3 py-2 text-sm text-signal-alarm">{error}</div>
        )}

        {loading ? (
          <div className="text-sm text-fg-3">Loading…</div>
        ) : versions.length === 0 ? (
          <div className="text-sm text-fg-3">No version history.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-border">
              <tr className="text-left text-xs text-fg-2">
                <th className="py-2 font-medium">Version</th>
                <th className="py-2 font-medium">Changed by</th>
                <th className="py-2 font-medium">When</th>
                <th className="py-2 font-medium text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {versions.map((v, i) => (
                <tr key={v.version} className="border-b border-border last:border-b-0">
                  <td className="py-2 text-fg-1">v{v.version}{i === 0 && <span className="ml-1 text-[10px] uppercase text-accent">current</span>}</td>
                  <td className="py-2 text-fg-2">{v.changedBy ?? '—'}</td>
                  <td className="py-2 text-fg-3 text-xs">{v.changedAt?.slice(0, 16).replace('T', ' ')}</td>
                  <td className="py-2 text-right">
                    {i !== 0 && (
                      <button onClick={() => handleRollback(v.version)} className="text-xs text-accent hover:underline">Roll back</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {confirmDialog}
    </Modal>
  )
}
