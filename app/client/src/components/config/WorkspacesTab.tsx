/**
 * Organizations (workspaces) Settings tab — extracted from ConfigPage.tsx
 * (behavior frozen).
 */
import { useState, useEffect, useCallback } from 'react'
import {
  Boxes, FileText, KeyRound, FolderGit2, Plug, Plus, Trash2, ChevronRight, Check, Sparkles, GitBranch, Activity, Unplug,
} from 'lucide-react'
import {
  Card, CardHeader, Button, Badge, Alert, EmptyState, Skeleton, useConfirm, cn,
} from '../ui'
import { useWorkspaces } from '../../hooks/useWorkspaces'
import { useAuth } from '../../context/AuthContext'
import {
  AGENT_CONTEXTS,
  type AgentContext,
  type WorkspacesConfig,
  type WorkspaceConfig,
  type WorkspaceProject,
  type WorkspaceRecord,
  type WorkspaceRepo,
  type WorkspaceIntegration,
  type GithubOrgRepo,
} from '@operationkit/shared'
import { api } from '../../lib/api'
import { inputCls, selectCls, SectionLabel } from './config-form'

// ── Workspaces Tab ──

// Per-slug shape: canonical name from the DB, project/knowledge/context overlaid
// from the legacy JSON config when present.
interface MergedWorkspace {
  name: string
  description: string
  projects: WorkspaceProject[]
  knowledge: WorkspaceConfig['knowledge'] | undefined
  context: string | null
}

export function WorkspacesTab() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const { workspaces: canonicalWorkspaces, loading: canonicalLoading, refresh: refreshWorkspaces } = useWorkspaces()
  const [config, setConfig] = useState<WorkspacesConfig | null>(null)
  const [adminRecords, setAdminRecords] = useState<Record<string, WorkspaceRecord>>({})
  const [repos, setRepos] = useState<Record<string, WorkspaceRepo[]>>({})
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [contextContent, setContextContent] = useState<Record<string, string>>({})
  const [poolSaving, setPoolSaving] = useState<string | null>(null)
  const [poolError, setPoolError] = useState<string | null>(null)

  // Create-workspace form
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const [newSlug, setNewSlug] = useState('')
  const [slugDirty, setSlugDirty] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  // Per-workspace repo form state
  const [repoDraft, setRepoDraft] = useState<Record<string, { name: string; github: string; stack: string }>>({})
  const [repoBusy, setRepoBusy] = useState<string | null>(null)
  const [repoError, setRepoError] = useState<Record<string, string | null>>({})
  const [wsBusy, setWsBusy] = useState<string | null>(null)
  const { confirm, confirmDialog } = useConfirm()

  const loadAdminRecords = useCallback(async () => {
    if (!isAdmin) return
    const records = await api.get<WorkspaceRecord[]>('/admin/workspaces').catch(() => [] as WorkspaceRecord[])
    const byslug: Record<string, WorkspaceRecord> = {}
    for (const r of records || []) byslug[r.slug] = r
    setAdminRecords(byslug)
  }, [isAdmin])

  useEffect(() => {
    const configP = api.get<WorkspacesConfig>('/workspaces-config').catch(() => null)
    Promise.all([configP, loadAdminRecords()])
      .then(([cfg]) => setConfig(cfg))
      .finally(() => setLoading(false))
  }, [loadAdminRecords])

  const loadRepos = useCallback(async (slug: string) => {
    if (!isAdmin) return
    try {
      const list = await api.get<WorkspaceRepo[]>(`/admin/workspaces/${slug}/repos`)
      setRepos(prev => ({ ...prev, [slug]: list }))
    } catch {}
  }, [isAdmin])

  const loadContext = useCallback(async (wsKey: string, contextPath: string) => {
    if (contextContent[wsKey]) return
    try {
      const data = await api.get<{ content: string }>(`/admin/file?path=${encodeURIComponent(contextPath)}`)
      setContextContent(prev => ({ ...prev, [wsKey]: data.content }))
    } catch {}
  }, [contextContent])

  function toggleExpand(key: string, ws: MergedWorkspace) {
    const next = expanded === key ? null : key
    setExpanded(next)
    if (next) {
      if (ws.context) loadContext(key, ws.context)
      if (repos[key] === undefined) loadRepos(key)
    }
  }

  const togglePoolAgent = useCallback(
    async (slug: string, agent: AgentContext) => {
      const current = adminRecords[slug]
      if (!current) return
      const pool = current.default_agent_pool
      const next = pool.includes(agent) ? pool.filter(a => a !== agent) : [...pool, agent]
      setPoolSaving(slug)
      setPoolError(null)
      try {
        const updated = await api.patch<WorkspaceRecord>(`/admin/workspaces/${slug}`, { default_agent_pool: next })
        setAdminRecords(prev => ({ ...prev, [slug]: updated }))
      } catch (e) {
        setPoolError(e instanceof Error ? e.message : 'Pool update failed')
      } finally {
        setPoolSaving(null)
      }
    },
    [adminRecords],
  )

  async function createWorkspace(e: React.FormEvent) {
    e.preventDefault()
    setCreateError(null)
    const name = newName.trim()
    const slug = newSlug.trim()
    if (!name) { setCreateError('Name is required'); return }
    if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(slug)) {
      setCreateError('Slug must be 2–41 chars: lowercase letters, numbers and hyphens')
      return
    }
    setCreating(true)
    try {
      await api.post('/admin/workspaces', { slug, name })
      await Promise.all([refreshWorkspaces(), loadAdminRecords()])
      setNewName(''); setNewSlug(''); setSlugDirty(false); setShowCreate(false)
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : 'Failed to create organization')
    } finally {
      setCreating(false)
    }
  }

  async function removeWorkspace(slug: string, name: string) {
    if (!(await confirm({
      title: 'Remove organization?',
      message: `“${name}” will be archived and hidden from the board.`,
      confirmLabel: 'Remove',
      danger: true,
    }))) return
    setWsBusy(slug)
    try {
      await api.del(`/admin/workspaces/${slug}`)
      await Promise.all([refreshWorkspaces(), loadAdminRecords()])
      if (expanded === slug) setExpanded(null)
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to remove organization')
    } finally {
      setWsBusy(null)
    }
  }

  async function addRepo(slug: string, e: React.FormEvent) {
    e.preventDefault()
    const draft = repoDraft[slug] || { name: '', github: '', stack: '' }
    const name = draft.name.trim()
    if (!name) { setRepoError(prev => ({ ...prev, [slug]: 'Repo name is required' })); return }
    setRepoBusy(slug)
    setRepoError(prev => ({ ...prev, [slug]: null }))
    try {
      const stack = draft.stack.split(',').map(s => s.trim()).filter(Boolean)
      const created = await api.post<WorkspaceRepo>(`/admin/workspaces/${slug}/repos`, {
        name,
        github: draft.github.trim() || null,
        stack,
      })
      setRepos(prev => ({ ...prev, [slug]: [...(prev[slug] || []), created] }))
      setRepoDraft(prev => ({ ...prev, [slug]: { name: '', github: '', stack: '' } }))
    } catch (e) {
      setRepoError(prev => ({ ...prev, [slug]: e instanceof Error ? e.message : 'Failed to add repo' }))
    } finally {
      setRepoBusy(null)
    }
  }

  async function toggleDocs(slug: string, repo: WorkspaceRepo) {
    try {
      const updated = await api.patch<WorkspaceRepo>(`/admin/workspaces/${slug}/repos/${repo.id}`, {
        docs_enabled: !repo.docs_enabled,
      })
      setRepos(prev => ({
        ...prev,
        [slug]: (prev[slug] || []).map(r => (r.id === repo.id ? updated : r)),
      }))
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to update living docs')
    }
  }

  async function removeRepo(slug: string, repo: WorkspaceRepo) {
    if (!(await confirm({
      title: 'Remove repo?',
      message: `“${repo.name}” will be removed from this organization.`,
      confirmLabel: 'Remove',
      danger: true,
    }))) return
    try {
      await api.del(`/admin/workspaces/${slug}/repos/${repo.id}`)
      setRepos(prev => ({ ...prev, [slug]: (prev[slug] || []).filter(r => r.id !== repo.id) }))
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to remove repo')
    }
  }

  if (loading || canonicalLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} inset>
            <div className="flex items-center justify-between p-4">
              <div className="space-y-2">
                <Skeleton className="h-4 w-36" />
                <Skeleton className="h-3 w-52" />
              </div>
              <Skeleton className="h-7 w-7 rounded-md" />
            </div>
          </Card>
        ))}
      </div>
    )
  }

  const metaBySlug = config?.workspaces ?? {}
  const workspaces: Array<[string, MergedWorkspace]> = canonicalWorkspaces.map(w => {
    const meta = metaBySlug[w.slug]
    return [w.slug, {
      name: meta?.name ?? w.name,
      description: meta?.description ?? '',
      projects: meta?.projects ?? [],
      knowledge: meta?.knowledge,
      context: meta?.context ?? null,
    }]
  })

  function draftFor(slug: string) {
    return repoDraft[slug] || { name: '', github: '', stack: '' }
  }
  function setDraft(slug: string, patch: Partial<{ name: string; github: string; stack: string }>) {
    setRepoDraft(prev => ({ ...prev, [slug]: { ...draftFor(slug), ...patch } }))
  }

  return (
    <div className="space-y-4">
      {confirmDialog}
      {/* Create workspace (admin) */}
      {isAdmin && (
        <Card inset>
          <CardHeader
            title="Organizations"
            eyebrow="Manage"
            actions={
              <Button
                size="sm"
                variant={showCreate ? 'ghost' : 'primary'}
                leftIcon={<Plus className="h-4 w-4" />}
                onClick={() => { setShowCreate(s => !s); setCreateError(null) }}
              >
                {showCreate ? 'Cancel' : 'Add organization'}
              </Button>
            }
          />
          {showCreate && (
            <form onSubmit={createWorkspace} className="space-y-3 p-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="space-y-1">
                  <span className="text-[11px] font-medium uppercase tracking-wider text-fg-3">Name</span>
                  <input
                    className={inputCls}
                    placeholder="Acme Co"
                    value={newName}
                    onChange={e => {
                      setNewName(e.target.value)
                      if (!slugDirty) {
                        setNewSlug(e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 41))
                      }
                    }}
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-[11px] font-medium uppercase tracking-wider text-fg-3">Slug</span>
                  <input
                    className={cn(inputCls, 'font-mono')}
                    placeholder="acme"
                    value={newSlug}
                    onChange={e => { setSlugDirty(true); setNewSlug(e.target.value) }}
                  />
                </label>
              </div>
              {createError && <Alert tone="alarm">{createError}</Alert>}
              <div className="flex justify-end">
                <Button type="submit" variant="primary" size="sm" disabled={creating}>
                  {creating ? 'Creating…' : 'Create organization'}
                </Button>
              </div>
            </form>
          )}
        </Card>
      )}

      {workspaces.length === 0 && (
        <Card>
          <EmptyState icon={<Boxes className="h-5 w-5" />} title="No organizations" description="Create one to get started." />
        </Card>
      )}

      {workspaces.map(([key, ws]) => {
        const dbRepos = repos[key] || []
        const isOpen = expanded === key
        return (
          <Card key={key} inset>
            {/* Header row */}
            <div className="flex items-center gap-2 px-4 py-3">
              <button onClick={() => toggleExpand(key, ws)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                <ChevronRight className={cn('h-4 w-4 shrink-0 text-fg-3 transition-transform', isOpen && 'rotate-90')} />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-display text-[14px] font-semibold text-fg-0">{ws.name}</h3>
                    <Badge mono>{key}</Badge>
                    <Badge tone="neutral">{ws.projects.length + dbRepos.length} repos</Badge>
                  </div>
                  {ws.description && <p className="mt-0.5 truncate text-[12px] text-fg-3">{ws.description}</p>}
                </div>
              </button>
              {isAdmin && (
                <Button
                  size="sm"
                  variant="danger"
                  leftIcon={<Trash2 className="h-3.5 w-3.5" />}
                  disabled={wsBusy === key}
                  onClick={() => removeWorkspace(key, ws.name)}
                >
                  Remove
                </Button>
              )}
            </div>

            {isOpen && (
              <div className="space-y-4 border-t border-line p-4">
                {/* Knowledge */}
                {ws.knowledge && (
                  <section>
                    <SectionLabel icon={<FileText className="h-3.5 w-3.5" />}>Knowledge</SectionLabel>
                    <div className="flex flex-wrap gap-2">
                      <Badge tone="neutral" mono>qmd: {ws.knowledge.qmd_collection}</Badge>
                      {ws.knowledge.qmd_filter && <Badge tone="neutral" mono>{ws.knowledge.qmd_filter}</Badge>}
                    </div>
                  </section>
                )}

                {/* Agent pool (admin) */}
                {isAdmin && adminRecords[key] && (
                  <section>
                    <div className="mb-2 flex items-center justify-between">
                      <SectionLabel icon={<KeyRound className="h-3.5 w-3.5" />} className="mb-0">Agent pool</SectionLabel>
                      {poolSaving === key && <span className="text-[11px] text-fg-3">saving…</span>}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {AGENT_CONTEXTS.map(a => {
                        const on = adminRecords[key].default_agent_pool.includes(a)
                        return (
                          <button
                            key={a}
                            onClick={() => togglePoolAgent(key, a)}
                            disabled={poolSaving === key}
                            className={cn(
                              'rounded-md border px-2 py-1 text-[12px] font-medium transition-colors disabled:opacity-50',
                              on
                                ? 'border-[color:var(--accent-line)] bg-[var(--accent-tint)] text-accent-hover'
                                : 'border-line bg-surface-1 text-fg-3 hover:text-fg-1',
                            )}
                          >
                            {a}
                          </button>
                        )
                      })}
                    </div>
                    <p className="mt-1.5 text-[11px] text-fg-3">
                      {adminRecords[key].default_agent_pool.length === 0
                        ? 'Empty pool — every agent is allowed (legacy default).'
                        : 'Only agents above can be assigned to objectives in this organization.'}
                    </p>
                    {poolError && poolSaving !== key && <p className="mt-1 text-[11px] text-signal-alarm">{poolError}</p>}
                  </section>
                )}

                {/* Repos */}
                <section>
                  <SectionLabel icon={<FolderGit2 className="h-3.5 w-3.5" />}>Repos & projects</SectionLabel>
                  <div className="space-y-2">
                    {/* DB-backed (removable) */}
                    {dbRepos.map(repo => (
                      <div key={`db-${repo.id}`} className="flex items-center justify-between gap-3 rounded-md border border-line bg-surface-1 px-3 py-2.5">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-[13px] font-medium text-fg-0">{repo.name}</span>
                            {repo.github && (
                              <a href={`https://github.com/${repo.github}`} target="_blank" rel="noopener noreferrer"
                                 className="font-mono text-[11px] text-status-working hover:underline">{repo.github}</a>
                            )}
                            {repo.stack.map(s => <Badge key={s} tone="neutral">{s}</Badge>)}
                            {repo.docs_enabled && <Badge tone="verify">living docs</Badge>}
                          </div>
                          {repo.description && <p className="mt-0.5 text-[11px] text-fg-3">{repo.description}</p>}
                          {repo.repo_path && (
                            <p className="mt-0.5 font-mono text-[11px] text-fg-3">{repo.repo_path} · {repo.docs_path || 'docs/product'}</p>
                          )}
                        </div>
                        {isAdmin && (
                          <div className="flex shrink-0 items-center gap-1">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => void toggleDocs(key, repo)}
                            >
                              {repo.docs_enabled ? 'Pause docs' : 'Live docs'}
                            </Button>
                            <Button size="sm" variant="ghost" aria-label="Remove repo" onClick={() => removeRepo(key, repo)}>
                              <Trash2 className="h-3.5 w-3.5 text-signal-alarm" />
                            </Button>
                          </div>
                        )}
                      </div>
                    ))}
                    {/* Legacy JSON projects (read-only) */}
                    {ws.projects.map(proj => (
                      <div key={`cfg-${proj.name}`} className="flex items-center justify-between gap-3 rounded-md border border-line-soft bg-surface-1 px-3 py-2.5">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-[13px] font-medium text-fg-1">{proj.name}</span>
                            {proj.github && (
                              <a href={`https://github.com/${proj.github}`} target="_blank" rel="noopener noreferrer"
                                 className="font-mono text-[11px] text-status-working hover:underline">{proj.github}</a>
                            )}
                            {proj.stack.map(s => <Badge key={s} tone="neutral">{s}</Badge>)}
                          </div>
                          {proj.description && <p className="mt-0.5 text-[11px] text-fg-3">{proj.description}</p>}
                        </div>
                        <Badge tone="neutral">config</Badge>
                      </div>
                    ))}
                    {dbRepos.length === 0 && ws.projects.length === 0 && (
                      <p className="text-[12px] text-fg-3">No repos yet.</p>
                    )}
                  </div>

                  {/* Add repo (admin) */}
                  {isAdmin && (
                    <form onSubmit={e => addRepo(key, e)} className="mt-3 flex flex-col gap-2 rounded-md border border-line bg-surface-1 p-3 sm:flex-row sm:items-center">
                      <input className={inputCls} placeholder="repo name" value={draftFor(key).name}
                             onChange={e => setDraft(key, { name: e.target.value })} />
                      <input className={cn(inputCls, 'font-mono')} placeholder="owner/repo (optional)" value={draftFor(key).github}
                             onChange={e => setDraft(key, { github: e.target.value })} />
                      <input className={inputCls} placeholder="stack, comma-sep" value={draftFor(key).stack}
                             onChange={e => setDraft(key, { stack: e.target.value })} />
                      <Button type="submit" variant="secondary" size="sm" disabled={repoBusy === key}
                              leftIcon={<Plus className="h-4 w-4" />} className="shrink-0">
                        {repoBusy === key ? 'Adding…' : 'Add'}
                      </Button>
                    </form>
                  )}
                  {repoError[key] && <p className="mt-1.5 text-[11px] text-signal-alarm">{repoError[key]}</p>}
                </section>

                {/* Connections (admin) — GitHub org + PostHog per workspace */}
                {isAdmin && (
                  <ConnectionsSection slug={key} onRepoAdded={() => loadRepos(key)} />
                )}

                {/* Context preview */}
                {contextContent[key] && (
                  <section>
                    <SectionLabel icon={<FileText className="h-3.5 w-3.5" />}>Context file</SectionLabel>
                    <pre className="max-h-64 overflow-auto rounded-md border border-line bg-surface-1 p-3 font-mono text-[11px] leading-relaxed text-fg-2 whitespace-pre-wrap">
                      {contextContent[key]}
                    </pre>
                  </section>
                )}
              </div>
            )}
          </Card>
        )
      })}
    </div>
  )
}
// ── Connections (GitHub org + PostHog, per workspace) ──

// Inputs here meet the 44px mobile hit-target (taller than the dense forms
// above) since they carry secrets and are the primary connect affordance.
const connInputCls = cn(inputCls, 'min-h-[44px] sm:min-h-[38px]')
const connSelectCls = cn(selectCls, 'min-h-[44px] w-full sm:min-h-[38px]')

const POSTHOG_HOSTS = [
  { value: 'https://us.i.posthog.com', label: 'US Cloud' },
  { value: 'https://eu.i.posthog.com', label: 'EU Cloud' },
  { value: '__self', label: 'Self-hosted' },
] as const

function ConnectionPanel({
  icon, title, connected, children,
}: { icon: React.ReactNode; title: string; connected: boolean; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-line bg-surface-1 p-3.5">
      <div className="mb-3 flex items-center gap-2">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-line bg-surface-2 text-fg-2">
          {icon}
        </span>
        <span className="text-[13px] font-semibold text-fg-0">{title}</span>
        {connected
          ? <Badge tone="verify" className="ml-auto"><Check className="mr-1 inline h-3 w-3" />Connected</Badge>
          : <Badge tone="neutral" className="ml-auto">Not connected</Badge>}
      </div>
      {children}
    </div>
  )
}

function GithubConnect({ slug, integration, onChange, onRepoAdded }: {
  slug: string
  integration: WorkspaceIntegration | undefined
  onChange: () => void
  onRepoAdded: () => void
}) {
  const connected = integration?.status === 'connected'
  const [org, setOrg] = useState('')
  const [tokenVal, setTokenVal] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Org repo picker
  const [showPicker, setShowPicker] = useState(false)
  const [orgRepos, setOrgRepos] = useState<GithubOrgRepo[] | null>(null)
  const [picking, setPicking] = useState<string | null>(null)
  const [pickerError, setPickerError] = useState<string | null>(null)
  const { confirm, confirmDialog } = useConfirm()

  async function connect(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!org.trim() || !tokenVal.trim()) { setError('Org and token are required'); return }
    setBusy(true)
    try {
      await api.post(`/admin/workspaces/${slug}/integrations/github`, { org: org.trim(), token: tokenVal.trim() })
      setOrg(''); setTokenVal(''); onChange()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Connection failed')
    } finally { setBusy(false) }
  }

  async function disconnect() {
    if (!(await confirm({
      title: 'Disconnect GitHub?',
      message: 'GitHub will be disconnected from this organization.',
      confirmLabel: 'Disconnect',
      danger: true,
    }))) return
    try { await api.del(`/admin/workspaces/${slug}/integrations/github`); onChange() }
    catch (e) { alert(e instanceof Error ? e.message : 'Disconnect failed') }
  }

  async function openPicker() {
    setShowPicker(s => !s)
    if (orgRepos === null) {
      setPickerError(null)
      try { setOrgRepos(await api.get<GithubOrgRepo[]>(`/admin/workspaces/${slug}/integrations/github/repos`)) }
      catch (e) { setPickerError(e instanceof Error ? e.message : 'Failed to load repos'); setOrgRepos([]) }
    }
  }

  async function pickRepo(repo: GithubOrgRepo) {
    setPicking(repo.full_name)
    try {
      await api.post(`/admin/workspaces/${slug}/repos`, {
        name: repo.name,
        github: repo.full_name,
        stack: repo.language ? [repo.language] : [],
      })
      onRepoAdded()
    } catch (e) {
      setPickerError(e instanceof Error ? e.message : 'Failed to add repo')
    } finally { setPicking(null) }
  }

  return (
    <ConnectionPanel icon={<GitBranch className="h-4 w-4" />} title="GitHub" connected={connected}>
      {confirmDialog}
      {connected ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-[12px]">
            <Badge mono>{integration?.org}</Badge>
            {integration?.token_last4 && <Badge tone="neutral" mono>token {integration.token_last4}</Badge>}
            {typeof integration?.repo_count === 'number' && (
              <span className="text-fg-3">{integration.repo_count} repos</span>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="md" variant="secondary" leftIcon={<Plus className="h-4 w-4" />} onClick={openPicker}>
              {showPicker ? 'Hide org repos' : 'Add repo from org'}
            </Button>
            <Button size="md" variant="danger" leftIcon={<Unplug className="h-4 w-4" />} onClick={disconnect}>
              Disconnect
            </Button>
          </div>
          {showPicker && (
            <div className="rounded-md border border-line bg-surface-2 p-2">
              {orgRepos === null && (
                <div className="space-y-1.5 px-1 py-2">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <Skeleton key={i} className="h-7 w-full rounded-md" />
                  ))}
                </div>
              )}
              {orgRepos && orgRepos.length === 0 && !pickerError && (
                <p className="px-1 py-2 text-[12px] text-fg-3">No repos found in this org.</p>
              )}
              <div className="max-h-56 space-y-1 overflow-y-auto">
                {orgRepos?.map(r => (
                  <div key={r.full_name} className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-surface-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-[12.5px] font-medium text-fg-1">{r.name}</span>
                        {r.private && <Badge tone="amber">private</Badge>}
                        {r.language && <Badge tone="neutral">{r.language}</Badge>}
                      </div>
                      <div className="truncate font-mono text-[11px] text-fg-3">{r.full_name}</div>
                    </div>
                    <Button size="sm" variant="secondary" disabled={picking === r.full_name}
                            onClick={() => pickRepo(r)} className="shrink-0">
                      {picking === r.full_name ? 'Adding…' : 'Add'}
                    </Button>
                  </div>
                ))}
              </div>
              {pickerError && <p className="mt-1 px-1 text-[11px] text-signal-alarm">{pickerError}</p>}
            </div>
          )}
        </div>
      ) : (
        <form onSubmit={connect} className="space-y-2">
          <input className={connInputCls} placeholder="organization (e.g. acme-inc)"
                 value={org} onChange={e => setOrg(e.target.value)} autoComplete="off" />
          <input className={cn(connInputCls, 'font-mono')} type="password" placeholder="personal access token (repo + read:org)"
                 value={tokenVal} onChange={e => setTokenVal(e.target.value)} autoComplete="off" />
          {error && <Alert tone="alarm">{error}</Alert>}
          <Button type="submit" size="md" variant="primary" disabled={busy} className="w-full sm:w-auto"
                  leftIcon={<Plug className="h-4 w-4" />}>
            {busy ? 'Validating…' : 'Connect GitHub'}
          </Button>
        </form>
      )}
    </ConnectionPanel>
  )
}

function PosthogConnect({ slug, integration, onChange }: {
  slug: string
  integration: WorkspaceIntegration | undefined
  onChange: () => void
}) {
  const connected = integration?.status === 'connected'
  const [hostChoice, setHostChoice] = useState<string>('https://us.i.posthog.com')
  const [selfHost, setSelfHost] = useState('')
  const [projectKey, setProjectKey] = useState('')
  const [personalKey, setPersonalKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { confirm, confirmDialog } = useConfirm()

  async function connect(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    const host = hostChoice === '__self' ? selfHost.trim() : hostChoice
    if (!host || !projectKey.trim()) { setError('Host and project API key are required'); return }
    setBusy(true)
    try {
      await api.post(`/admin/workspaces/${slug}/integrations/posthog`, {
        host,
        project_api_key: projectKey.trim(),
        personal_api_key: personalKey.trim() || null,
      })
      setProjectKey(''); setPersonalKey(''); onChange()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Connection failed')
    } finally { setBusy(false) }
  }

  async function disconnect() {
    if (!(await confirm({
      title: 'Disconnect PostHog?',
      message: 'PostHog will be disconnected from this organization.',
      confirmLabel: 'Disconnect',
      danger: true,
    }))) return
    try { await api.del(`/admin/workspaces/${slug}/integrations/posthog`); onChange() }
    catch (e) { alert(e instanceof Error ? e.message : 'Disconnect failed') }
  }

  return (
    <ConnectionPanel icon={<Activity className="h-4 w-4" />} title="PostHog" connected={connected}>
      {confirmDialog}
      {connected ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-[12px]">
            <Badge mono>{integration?.host}</Badge>
            {integration?.project_api_key_last4 && <Badge tone="neutral" mono>key {integration.project_api_key_last4}</Badge>}
          </div>
          <Button size="md" variant="danger" leftIcon={<Unplug className="h-4 w-4" />} onClick={disconnect}>
            Disconnect
          </Button>
        </div>
      ) : (
        <form onSubmit={connect} className="space-y-2">
          <select className={connSelectCls} value={hostChoice} onChange={e => setHostChoice(e.target.value)}>
            {POSTHOG_HOSTS.map(h => <option key={h.value} value={h.value}>{h.label}</option>)}
          </select>
          {hostChoice === '__self' && (
            <input className={cn(connInputCls, 'font-mono')} placeholder="https://posthog.your-domain.com"
                   value={selfHost} onChange={e => setSelfHost(e.target.value)} autoComplete="off" />
          )}
          <input className={cn(connInputCls, 'font-mono')} type="password" placeholder="project API key (phc_…)"
                 value={projectKey} onChange={e => setProjectKey(e.target.value)} autoComplete="off" />
          <input className={cn(connInputCls, 'font-mono')} type="password" placeholder="personal API key (optional)"
                 value={personalKey} onChange={e => setPersonalKey(e.target.value)} autoComplete="off" />
          {error && <Alert tone="alarm">{error}</Alert>}
          <Button type="submit" size="md" variant="primary" disabled={busy} className="w-full sm:w-auto"
                  leftIcon={<Plug className="h-4 w-4" />}>
            {busy ? 'Validating…' : 'Connect PostHog'}
          </Button>
        </form>
      )}
    </ConnectionPanel>
  )
}

function ConnectionsSection({ slug, onRepoAdded }: { slug: string; onRepoAdded: () => void }) {
  const [integrations, setIntegrations] = useState<WorkspaceIntegration[] | null>(null)

  const load = useCallback(async () => {
    try { setIntegrations(await api.get<WorkspaceIntegration[]>(`/admin/workspaces/${slug}/integrations`)) }
    catch { setIntegrations([]) }
  }, [slug])
  useEffect(() => { void load() }, [load])

  const gh = integrations?.find(i => i.kind === 'github')
  const ph = integrations?.find(i => i.kind === 'posthog')

  return (
    <section>
      <SectionLabel icon={<Plug className="h-3.5 w-3.5" />}>Connections</SectionLabel>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <GithubConnect slug={slug} integration={gh} onChange={load} onRepoAdded={onRepoAdded} />
        <PosthogConnect slug={slug} integration={ph} onChange={load} />
      </div>
    </section>
  )
}
