/**
 * Settings → Secrets (obj-2353 / W2 admin surface, cross-org rewrite).
 *
 * The Doppler-replacement admin surface over the native scoped secrets store.
 * The default view for a global admin is now **All scopes**: `GET /secrets` with
 * NO query params returns every summary the caller may see, across every
 * organization and every user, so an admin manages the whole Command Center from
 * one table instead of hunting one bucket at a time. A scope filter still narrows
 * to a single bucket (`GET /secrets?scopeType=&workspace=&userId=`).
 *
 * Because the all-scopes table has NO single page-level scope, every row-level
 * action (Edit / Delete / History / Rollback / Move) derives its scope from the
 * ROW (`s.scopeType`, `s.workspace`, `s.userId`) — never from the filter. Passing
 * the page scope would address the wrong row entirely once the filter is "all".
 *
 * Pickers come from `GET /secrets/principals` (organizations + users the caller
 * may target) — never a raw numeric user-id box again. The same pickers live in
 * the create/edit modal, so a secret can be created at ANY scope from anywhere,
 * and an existing secret can be RE-SCOPED via `POST /secrets/move` without ever
 * re-entering its value (leave the value blank to change only the scope).
 *
 * SECURITY: the raw value is NEVER fetched back — the table shows `••••••` for
 * every key, and setting a new value requires typing it (the server only ever
 * returns metadata summaries). Access is enforced server-side too; this UI just
 * scopes what it offers.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { api, ApiError } from '../lib/api'
import { Skeleton, useConfirm } from './ui'
import type {
  SecretScopeType,
  SecretSummary,
  SecretPrincipals,
} from '@operationkit/shared'
import {
  ALL_SCOPES, SCOPE_HINTS, SCOPE_LABELS, SCOPE_ORDER,
  scopeDescription, scopeOf, scopeQuery,
  type Scope, type ScopeFilter,
} from './secrets/scope'
import { SecretRow } from './secrets/SecretRow'
import { SecretModal } from './secrets/SecretModal'
import { VersionHistoryModal } from './secrets/VersionHistoryModal'

export function SecretsPage({ embedded = false }: { embedded?: boolean }) {
  const { user } = useAuth()
  const isGlobalAdmin = user?.role === 'admin'

  // Principals drive every picker (and the slug→name / id→username resolution
  // the scope badges need). Members get only what they may target.
  const [principals, setPrincipals] = useState<SecretPrincipals | null>(null)
  // Memoized so the `?? []` fallback doesn't churn identity every render (the
  // lookup callbacks below feed a useMemo).
  const orgs = useMemo(() => principals?.organizations ?? [], [principals])
  const users = useMemo(() => principals?.users ?? [], [principals])

  // Scope filter. Admins land on the cross-organization all-scopes view.
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>(isGlobalAdmin ? ALL_SCOPES : 'workspace')
  const [workspace, setWorkspace] = useState<string>('')
  const [userId, setUserId] = useState<string>(String(user?.id ?? ''))

  const [secrets, setSecrets] = useState<SecretSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [modalTarget, setModalTarget] = useState<SecretSummary | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [historyTarget, setHistoryTarget] = useState<SecretSummary | null>(null)
  const { confirm, confirmDialog } = useConfirm()

  // Available scope types depend on role: members cannot address Command Center.
  const scopeOptions = useMemo<SecretScopeType[]>(() => {
    const all: SecretScopeType[] = ['global', 'workspace', 'user', 'workspace_user']
    return principals?.canUseGlobal ? all : all.filter(s => s !== 'global')
  }, [principals?.canUseGlobal])

  const isAllScopes = scopeFilter === ALL_SCOPES
  const needsWorkspace = scopeFilter === 'workspace' || scopeFilter === 'workspace_user'
  const needsUser = scopeFilter === 'user' || scopeFilter === 'workspace_user'

  // ── Lookups for the scope badges ──
  const orgName = useCallback(
    (slug: string | null) => (slug ? orgs.find(o => o.slug === slug)?.name || slug : '—'),
    [orgs],
  )
  const userName = useCallback(
    (id: number | null) => (id == null ? '—' : users.find(u => u.id === id)?.username || `#${id}`),
    [users],
  )

  // Load the pickers once. A principals failure is non-fatal for the table, but
  // it degrades the pickers, so surface it.
  useEffect(() => {
    let cancelled = false
    api.get<SecretPrincipals>('/secrets/principals')
      .then(data => { if (!cancelled) setPrincipals(data) })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load scope pickers') })
    return () => { cancelled = true }
  }, [])

  // Default the organization picker to the caller's first organization once
  // principals arrive (members typically have exactly one).
  useEffect(() => {
    setWorkspace(prev => prev || orgs[0]?.slug || '')
  }, [orgs])

  const reload = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      // The all-scopes path is the bare endpoint — NO params. The server returns
      // everything an admin may see, or the member's accessible subset.
      const path = isAllScopes
        ? '/secrets'
        : `/secrets?${scopeQuery({
            scopeType: scopeFilter as SecretScopeType,
            workspace: needsWorkspace ? workspace : null,
            userId: needsUser && userId ? Number(userId) : null,
          })}`
      const data = await api.get<SecretSummary[]>(path)
      setSecrets(data)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Load failed')
      setSecrets([])
    } finally {
      setLoading(false)
    }
  }, [isAllScopes, scopeFilter, workspace, userId, needsWorkspace, needsUser])

  useEffect(() => {
    // Don't fetch an incomplete scope (e.g. Organization selected but none chosen).
    if (!isAllScopes && needsWorkspace && !workspace) { setSecrets([]); setLoading(false); return }
    if (!isAllScopes && needsUser && !userId) { setSecrets([]); setLoading(false); return }
    void reload()
  }, [reload, isAllScopes, needsWorkspace, needsUser, workspace, userId])

  // Sorted for reading: broadest scope first, then organization, user, key. The
  // all-scopes view additionally breaks on scope type with a group header.
  const rows = useMemo(() => {
    return [...secrets].sort((a, b) =>
      SCOPE_ORDER[a.scopeType] - SCOPE_ORDER[b.scopeType] ||
      orgName(a.workspace).localeCompare(orgName(b.workspace)) ||
      userName(a.userId).localeCompare(userName(b.userId)) ||
      a.key.localeCompare(b.key),
    )
  }, [secrets, orgName, userName])

  const orgCount = useMemo(
    () => new Set(secrets.filter(s => s.workspace).map(s => s.workspace)).size,
    [secrets],
  )

  /** The scope a freshly-opened "New" modal should prefill. */
  const defaultNewScope = useMemo<Scope>(() => {
    if (!isAllScopes) {
      return {
        scopeType: scopeFilter as SecretScopeType,
        workspace: needsWorkspace ? workspace || null : null,
        userId: needsUser && userId ? Number(userId) : null,
      }
    }
    // No page scope in the all view: admins default to Command Center, members
    // to their first organization.
    if (principals?.canUseGlobal) return { scopeType: 'global', workspace: null, userId: null }
    return { scopeType: 'workspace', workspace: orgs[0]?.slug || null, userId: null }
  }, [isAllScopes, scopeFilter, workspace, userId, needsWorkspace, needsUser, principals?.canUseGlobal, orgs])

  function openCreate() {
    setModalTarget(null)
    setModalOpen(true)
  }
  function openEdit(s: SecretSummary) {
    setModalTarget(s)
    setModalOpen(true)
  }

  async function handleDelete(s: SecretSummary) {
    if (!(await confirm({
      title: 'Delete secret?',
      message: `'${s.key}' will be permanently removed from ${scopeDescription(s, orgName, userName)}.`,
      confirmLabel: 'Delete',
      danger: true,
    }))) return
    try {
      // Row scope, NOT the page filter — in the all-scopes view there is no page scope.
      const q = scopeQuery(scopeOf(s))
      await api.del<void>(`/secrets?${q}&key=${encodeURIComponent(s.key)}`)
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed')
    }
  }

  if (principals && !principals.canUseGlobal && orgs.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-fg-3 text-sm">
        No organization membership — nothing to manage here. Manage your personal secrets under Settings → You.
      </div>
    )
  }

  return (
    <div className={embedded ? '' : 'h-full overflow-y-auto p-6'}>
      <div className={embedded ? '' : 'max-w-5xl mx-auto'}>
        <div className={embedded ? 'mb-4 flex items-center justify-between' : 'mb-5 flex items-center justify-between'}>
          <div>
            {!embedded && <h1 className="text-xl font-semibold text-fg-0">Secrets</h1>}
            <p className={embedded ? 'text-xs text-fg-3' : 'mt-1 text-xs text-fg-3'}>
              Scoped, encrypted-at-rest secrets. Values are never shown — type a new one to change it.
            </p>
            {!loading && (
              <p className="mt-1 text-xs text-fg-2" data-testid="secret-count">
                {secrets.length} {secrets.length === 1 ? 'secret' : 'secrets'}
                {isAllScopes && ` across ${orgCount} ${orgCount === 1 ? 'organization' : 'organizations'}`}
              </p>
            )}
          </div>
          <button
            onClick={openCreate}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-fg-0 transition-colors duration-fast ease-out hover:bg-accent-hover"
          >
            + New
          </button>
        </div>

        {/* Scope filter. "All scopes" is the cross-organization admin view. */}
        <div className="mb-4 flex flex-wrap items-end gap-3 rounded-lg border border-border bg-surface-raised p-4">
          <div>
            <label className="mb-1 block text-[11px] uppercase tracking-wider text-fg-3">Scope</label>
            <select
              value={scopeFilter}
              onChange={e => setScopeFilter(e.target.value as ScopeFilter)}
              data-testid="scope-filter"
              className="rounded border border-border bg-surface px-2 py-1.5 text-sm text-fg-0 outline-none focus:border-accent"
            >
              <option value={ALL_SCOPES}>All scopes</option>
              {scopeOptions.map(s => (
                <option key={s} value={s}>{SCOPE_LABELS[s]}</option>
              ))}
            </select>
          </div>
          {!isAllScopes && needsWorkspace && (
            <div>
              <label className="mb-1 block text-[11px] uppercase tracking-wider text-fg-3">Organization</label>
              <select
                value={workspace}
                onChange={e => setWorkspace(e.target.value)}
                className="rounded border border-border bg-surface px-2 py-1.5 text-sm text-fg-0 outline-none focus:border-accent"
              >
                <option value="">— select —</option>
                {orgs.map(o => (
                  <option key={o.slug} value={o.slug}>{o.name}</option>
                ))}
              </select>
            </div>
          )}
          {!isAllScopes && needsUser && (
            <div>
              <label className="mb-1 block text-[11px] uppercase tracking-wider text-fg-3">User</label>
              <select
                value={userId}
                onChange={e => setUserId(e.target.value)}
                title={SCOPE_HINTS.user}
                className="rounded border border-border bg-surface px-2 py-1.5 text-sm text-fg-0 outline-none focus:border-accent"
              >
                <option value="">— select —</option>
                {users.map(u => (
                  <option key={u.id} value={String(u.id)}>{u.username}</option>
                ))}
              </select>
            </div>
          )}
          <p className="ml-auto max-w-prose text-[11px] text-fg-3">
            {isAllScopes
              ? 'Every secret you may see, across every organization and user. Each row acts on its own scope.'
              : SCOPE_HINTS[scopeFilter as SecretScopeType]}
          </p>
        </div>

        {error && (
          <div className="mb-4 rounded bg-signal-alarm/10 px-3 py-2 text-sm text-signal-alarm">{error}</div>
        )}

        <div className="overflow-x-auto rounded-lg border border-border bg-surface-raised">
          <table className="w-full text-sm">
            <thead className="bg-surface border-b border-border">
              <tr className="text-left text-xs text-fg-2">
                <th className="px-3 py-2 font-medium">Scope</th>
                <th className="px-3 py-2 font-medium">Key</th>
                <th className="px-3 py-2 font-medium">Value</th>
                <th className="px-3 py-2 font-medium">Version</th>
                <th className="px-3 py-2 font-medium">Updated</th>
                <th className="px-3 py-2 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: 3 }).map((_, i) => (
                  <tr key={i} className="border-b border-border last:border-b-0">
                    <td className="px-3 py-2"><Skeleton className="h-4 w-32" /></td>
                    <td className="px-3 py-2"><Skeleton className="h-4 w-28" /></td>
                    <td className="px-3 py-2"><Skeleton className="h-4 w-16" /></td>
                    <td className="px-3 py-2"><Skeleton className="h-4 w-8" /></td>
                    <td className="px-3 py-2"><Skeleton className="h-4 w-24" /></td>
                    <td className="px-3 py-2"><div className="flex justify-end gap-2"><Skeleton className="h-4 w-8" /><Skeleton className="h-4 w-10" /></div></td>
                  </tr>
                ))
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-sm text-fg-3">
                    {isAllScopes ? 'No secrets yet. Click "New" to add one.' : 'No secrets at this scope. Click "New" to add one.'}
                  </td>
                </tr>
              ) : (
                rows.map((s, i) => (
                  <SecretRow
                    key={s.id}
                    secret={s}
                    // Group the all-scopes list by scope type so it reads as
                    // "everything Command-Center-wide, then per organization…".
                    groupHeader={isAllScopes && (i === 0 || rows[i - 1]!.scopeType !== s.scopeType) ? SCOPE_LABELS[s.scopeType] : null}
                    orgName={orgName}
                    userName={userName}
                    onHistory={() => setHistoryTarget(s)}
                    onEdit={() => openEdit(s)}
                    onDelete={() => void handleDelete(s)}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {modalOpen && (
        <SecretModal
          principals={principals}
          initialScope={modalTarget ? scopeOf(modalTarget) : defaultNewScope}
          editing={modalTarget}
          onClose={() => setModalOpen(false)}
          onSaved={async () => { setModalOpen(false); await reload() }}
          // Partial fan-out: refresh the rows that DID land, keep the modal open.
          onRefresh={reload}
        />
      )}
      {historyTarget && (
        // Row scope again — the history/rollback of a row belongs to that row.
        <VersionHistoryModal
          scope={scopeOf(historyTarget)}
          secretKey={historyTarget.key}
          onClose={() => setHistoryTarget(null)}
          onRolledBack={async () => { setHistoryTarget(null); await reload() }}
        />
      )}
      {confirmDialog}
    </div>
  )
}
