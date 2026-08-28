/**
 * Create / edit / move secret modal — extracted from SecretsPage.tsx
 * (behavior frozen).
 *
 * The scope pickers stay ENABLED while editing: changing them issues a
 * `POST /secrets/move` (source = the row's original scope) BEFORE any value
 * write, so the ciphertext and version history are re-parented without the
 * plaintext ever leaving the server. A value is only required when creating, or
 * when the scope is unchanged (in which case the value is the only thing that
 * could possibly change).
 *
 * CREATE is multi-organization; EDIT/MOVE stays single-scope. At an
 * organization-bearing scope a NEW secret can be scoped to any number of
 * organizations at once: the modal ticks N organizations and fans out N
 * independent `POST /secrets` calls — one row per (key, scope), which keeps the
 * DB shape and every row-level action (Edit/Delete/History/Move) exactly as they
 * were, and needs no new server surface. A row IS one scope, so editing an
 * existing secret still addresses exactly one organization; there is no
 * multi-organization edit.
 *
 * The fan-out reports honestly: each organization's outcome is tracked
 * separately and a partial failure keeps the modal open listing which
 * organizations got the secret and which did not (failed ones stay ticked so the
 * operator can retry just those). It never claims "all created".
 */
import { useCallback, useMemo, useState, type FormEvent } from 'react'
import { api, ApiError } from '../../lib/api'
import { Modal } from '../ui'
import type {
  SecretScopeType,
  SecretSummary,
  SecretPrincipals,
  SetSecretRequest,
  MoveSecretRequest,
} from '@command-center/shared'
import {
  SCOPE_HINTS, SCOPE_HINTS_CREATE, SCOPE_LABELS, sameScope,
  type Scope,
} from './scope'

interface SecretModalProps {
  principals: SecretPrincipals | null
  initialScope: Scope
  editing: SecretSummary | null
  onClose: () => void
  onSaved: () => Promise<void>
  /** Refresh the table WITHOUT closing — used when a fan-out partly succeeded. */
  onRefresh: () => Promise<void>
}

/** Per-organization outcome of a multi-organization create. */
interface FanoutResult {
  slug: string
  name: string
  ok: boolean
  error?: string
}

export function SecretModal({ principals, initialScope, editing, onClose, onSaved, onRefresh }: SecretModalProps) {
  const isEdit = editing !== null
  const orgs = useMemo(() => principals?.organizations ?? [], [principals])
  const users = principals?.users ?? []

  const [key, setKey] = useState(editing?.key || '')
  const [value, setValue] = useState('')
  const [scopeType, setScopeType] = useState<SecretScopeType>(initialScope.scopeType)
  // Organizations are a SET even on the single-scope (edit/move) path, so the
  // target-scope derivation below never has to branch on mode.
  const [workspaces, setWorkspaces] = useState<string[]>(initialScope.workspace ? [initialScope.workspace] : [])
  const [userId, setUserId] = useState<string>(initialScope.userId != null ? String(initialScope.userId) : '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [fanout, setFanout] = useState<FanoutResult[] | null>(null)

  // Members cannot address the Command-Center-wide scope.
  const scopeOptions = useMemo<SecretScopeType[]>(() => {
    const all: SecretScopeType[] = ['global', 'workspace', 'user', 'workspace_user']
    return principals?.canUseGlobal ? all : all.filter(s => s !== 'global')
  }, [principals?.canUseGlobal])

  const needsWorkspace = scopeType === 'workspace' || scopeType === 'workspace_user'
  const needsUser = scopeType === 'user' || scopeType === 'workspace_user'
  /** Multi-organization applies to CREATE only — a row is one scope. */
  const multiOrg = !isEdit && needsWorkspace

  const orgLabel = useCallback(
    (slug: string) => orgs.find(o => o.slug === slug)?.name || slug,
    [orgs],
  )

  /** The single scope this submit addresses (edit/move, or a non-org create). */
  const target: Scope = {
    scopeType,
    workspace: needsWorkspace ? workspaces[0] || null : null,
    userId: needsUser && userId ? Number(userId) : null,
  }
  const scopeChanged = isEdit && !sameScope(initialScope, target)

  function toggleOrg(slug: string) {
    setFanout(null)
    setWorkspaces(prev => (prev.includes(slug) ? prev.filter(s => s !== slug) : [...prev, slug]))
  }

  /**
   * Create the same key/value once per selected organization. Each call is
   * independent, so one organization's 403/409 cannot cancel the others — and
   * the per-organization outcome is what the UI reports.
   */
  async function createAcrossOrgs(): Promise<FanoutResult[]> {
    return Promise.all(
      workspaces.map(async (slug): Promise<FanoutResult> => {
        const body: SetSecretRequest = {
          scopeType,
          workspace: slug,
          userId: needsUser && userId ? Number(userId) : undefined,
          key: key.trim(),
          value,
        }
        try {
          await api.post<SecretSummary>('/secrets', body)
          return { slug, name: orgLabel(slug), ok: true }
        } catch (err) {
          const message =
            err instanceof ApiError && err.status === 409
              ? 'already exists at this scope'
              : err instanceof Error ? err.message : 'failed'
          return { slug, name: orgLabel(slug), ok: false, error: message }
        }
      }),
    )
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setFanout(null)
    if (!key.trim()) { setError('Key is required.'); return }
    if (multiOrg && workspaces.length === 0) { setError('Pick at least one organization for this scope.'); return }
    if (!multiOrg && needsWorkspace && !target.workspace) { setError('Pick an organization for this scope.'); return }
    if (needsUser && ((multiOrg && !userId) || (!multiOrg && target.userId == null))) {
      setError('Pick a user for this scope.'); return
    }
    // Value is optional ONLY when an edit is moving the secret to a new scope.
    if (!value && !scopeChanged) {
      setError(isEdit
        ? 'Value is required (re-enter it — values are never fetched back), or change the scope instead.'
        : 'Value is required.')
      return
    }

    // ── Multi-organization create: N rows, N independent outcomes ──
    if (multiOrg) {
      setSaving(true)
      try {
        const results = await createAcrossOrgs()
        const failed = results.filter(r => !r.ok)
        if (failed.length === 0) { await onSaved(); return }
        // Partial (or total) failure: never close on a half-done write. Show the
        // per-organization breakdown, re-tick only the failures for a retry, and
        // refresh the table behind so the rows that DID land are visible.
        setFanout(results)
        setWorkspaces(failed.map(r => r.slug))
        await onRefresh()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Save failed')
      } finally {
        setSaving(false)
      }
      return
    }

    setSaving(true)
    try {
      if (scopeChanged) {
        // Re-scope first, from the ORIGINAL scope, without the value.
        const move: MoveSecretRequest = {
          scopeType: initialScope.scopeType,
          workspace: initialScope.workspace ?? undefined,
          userId: initialScope.userId ?? undefined,
          key: key.trim(),
          to: {
            scopeType: target.scopeType,
            workspace: target.workspace ?? undefined,
            userId: target.userId ?? undefined,
          },
        }
        await api.post<SecretSummary>('/secrets/move', move)
      }
      // Then set a new version, but only if the operator actually typed one.
      if (value) {
        const body: SetSecretRequest = {
          scopeType: target.scopeType,
          workspace: target.workspace ?? undefined,
          userId: target.userId ?? undefined,
          key: key.trim(),
          value,
        }
        await api.post<SecretSummary>('/secrets', body)
      }
      await onSaved()
    } catch (err) {
      // 409 from /move means the key is already taken at the destination.
      if (err instanceof ApiError && err.status === 409) {
        setError(`'${key.trim()}' already exists at the target scope — delete or rename it there first.`)
      } else {
        setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Save failed')
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open onClose={onClose} variant="center" labelledBy="secret-title" panelClassName="max-w-lg bg-surface-raised">
      <div className="p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 id="secret-title" className="text-lg font-semibold text-fg-0">
            {isEdit ? 'Edit Secret' : 'New Secret'}
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

        {/* Partial-failure report. Per-organization truth: what landed, what did
            not, and why — never a blanket "created". */}
        {fanout && (
          <div
            data-testid="modal-fanout-results"
            className="mb-3 rounded border border-signal-amber/30 bg-signal-amber/10 px-3 py-2"
          >
            <p className="text-sm font-medium text-signal-amber">
              {fanout.some(r => r.ok)
                ? `Created in ${fanout.filter(r => r.ok).length} of ${fanout.length} organizations — ${fanout.filter(r => !r.ok).length} failed.`
                : `Not created — all ${fanout.length} organizations failed.`}
            </p>
            <ul className="mt-1.5 space-y-1">
              {fanout.map(r => (
                <li key={r.slug} data-testid={`fanout-${r.ok ? 'ok' : 'fail'}-${r.slug}`} className="flex gap-2 text-[11px] leading-relaxed">
                  <span className={`flex-none font-medium ${r.ok ? 'text-signal-verify' : 'text-signal-alarm'}`}>
                    {r.ok ? '✓' : '✕'}
                  </span>
                  <span className="text-fg-2">
                    {r.name}
                    {r.ok ? ' — created' : ` — ${r.error}`}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-1.5 text-[11px] text-fg-3">
              The failed organizations are still selected — re-enter the value and submit again to retry just those.
            </p>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="mb-1 block text-xs text-fg-2">Key {isEdit && <span className="text-fg-3">(locked)</span>}</label>
            <input
              type="text"
              value={key}
              onChange={e => setKey(e.target.value)}
              disabled={isEdit}
              placeholder="e.g. OPENAI_API_KEY"
              className="w-full rounded border border-border bg-surface px-2 py-1.5 font-mono text-sm text-fg-0 outline-none focus:border-accent disabled:opacity-50"
            />
          </div>

          {/* The modal carries its OWN scope pickers, so a secret can be created
              at any scope from any view — and an existing one re-scoped. */}
          <div className="rounded border border-border bg-surface p-3">
            <div>
              <label htmlFor="secret-scope-type" className="mb-1 block text-[11px] uppercase tracking-wider text-fg-3">Scope</label>
              <select
                id="secret-scope-type"
                value={scopeType}
                onChange={e => { setScopeType(e.target.value as SecretScopeType); setFanout(null) }}
                data-testid="modal-scope-type"
                aria-describedby="secret-scope-hint"
                className="rounded border border-border bg-surface-raised px-2 py-1.5 text-sm text-fg-0 outline-none transition-colors duration-fast ease-out hover:border-fg-3 focus:border-accent"
              >
                {scopeOptions.map(s => (
                  <option key={s} value={s}>{SCOPE_LABELS[s]}</option>
                ))}
              </select>
              {/* Inline, always-visible — not a hover tooltip. This sentence is
                  the whole reason "Organization" is no longer ambiguous. */}
              <p id="secret-scope-hint" data-testid="modal-scope-hint" className="mt-1.5 text-[11px] leading-relaxed text-fg-3">
                {(isEdit ? SCOPE_HINTS : SCOPE_HINTS_CREATE)[scopeType]}
              </p>
            </div>

            {needsWorkspace && (multiOrg ? (
              <fieldset className="mt-3">
                <legend className="mb-1 text-[11px] uppercase tracking-wider text-fg-3">
                  Organizations <span className="normal-case tracking-normal text-fg-3">(pick one or more)</span>
                </legend>
                {orgs.length === 0 ? (
                  <p className="rounded border border-dashed border-border px-3 py-4 text-center text-[11px] text-fg-3">
                    No organizations available to you.
                  </p>
                ) : (
                  <>
                    <div
                      data-testid="modal-scope-organizations"
                      className="max-h-48 overflow-y-auto rounded border border-border bg-surface-raised"
                    >
                      {orgs.map(o => {
                        const checked = workspaces.includes(o.slug)
                        return (
                          <label
                            key={o.slug}
                            className={`flex min-h-[44px] cursor-pointer items-center gap-2.5 border-b border-border px-3 text-sm last:border-b-0 transition-colors duration-fast ease-out hover:bg-surface-overlay/60 ${checked ? 'text-fg-0' : 'text-fg-2'}`}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleOrg(o.slug)}
                              data-testid={`modal-org-checkbox-${o.slug}`}
                              className="h-4 w-4 flex-none accent-accent outline-none focus-visible:ring-2 focus-visible:ring-accent"
                            />
                            <span className="truncate">{o.name}</span>
                          </label>
                        )
                      })}
                    </div>
                    <div className="mt-1.5 flex items-center gap-3">
                      <p className="text-[11px] text-fg-3" data-testid="modal-org-selection-summary">
                        {workspaces.length === 0
                          ? 'No organizations selected.'
                          : `${workspaces.length} of ${orgs.length} selected — ${workspaces.length} secret ${workspaces.length === 1 ? 'row' : 'rows'} will be created, one per organization.`}
                      </p>
                      <button
                        type="button"
                        onClick={() => { setFanout(null); setWorkspaces(workspaces.length === orgs.length ? [] : orgs.map(o => o.slug)) }}
                        className="ml-auto flex-none rounded px-1.5 py-1 text-[11px] text-accent transition-colors duration-fast ease-out hover:bg-surface-overlay hover:text-accent-hover"
                      >
                        {workspaces.length === orgs.length ? 'Clear all' : 'Select all'}
                      </button>
                    </div>
                  </>
                )}
              </fieldset>
            ) : (
              <div className="mt-3">
                <label htmlFor="secret-scope-org" className="mb-1 block text-[11px] uppercase tracking-wider text-fg-3">Organization</label>
                <select
                  id="secret-scope-org"
                  value={workspaces[0] || ''}
                  onChange={e => setWorkspaces(e.target.value ? [e.target.value] : [])}
                  data-testid="modal-scope-organization"
                  className="rounded border border-border bg-surface-raised px-2 py-1.5 text-sm text-fg-0 outline-none transition-colors duration-fast ease-out hover:border-fg-3 focus:border-accent"
                >
                  <option value="">— select —</option>
                  {orgs.map(o => (
                    <option key={o.slug} value={o.slug}>{o.name}</option>
                  ))}
                </select>
              </div>
            ))}

            {needsUser && (
              <div className="mt-3">
                <label htmlFor="secret-scope-user" className="mb-1 block text-[11px] uppercase tracking-wider text-fg-3">User</label>
                <select
                  id="secret-scope-user"
                  value={userId}
                  onChange={e => setUserId(e.target.value)}
                  data-testid="modal-scope-user"
                  className="rounded border border-border bg-surface-raised px-2 py-1.5 text-sm text-fg-0 outline-none transition-colors duration-fast ease-out hover:border-fg-3 focus:border-accent"
                >
                  <option value="">— select —</option>
                  {users.map(u => (
                    <option key={u.id} value={String(u.id)}>{u.username}</option>
                  ))}
                </select>
              </div>
            )}
            {scopeChanged && (
              <p className="mt-1 text-[11px] text-accent">
                Moving from {SCOPE_LABELS[initialScope.scopeType]} — the value is carried over untouched.
              </p>
            )}
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
            <p className="mt-1 text-[11px] text-fg-3">
              Stored encrypted. The value is never returned by the API — to change it, type a new one.
              {isEdit && ' Leave the value blank to change only the scope.'}
            </p>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="rounded px-3 py-1.5 text-sm text-fg-2 hover:bg-surface-overlay">Cancel</button>
            <button
              type="submit"
              disabled={saving}
              data-testid="modal-submit"
              className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-fg-0 transition-colors duration-fast ease-out hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving
                ? 'Saving...'
                : isEdit
                  ? (scopeChanged && !value ? 'Move' : 'Update')
                  : multiOrg && workspaces.length > 1
                    ? `Create in ${workspaces.length} organizations`
                    : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </Modal>
  )
}
