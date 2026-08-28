/**
 * Assignments Settings tab — extracted from ConfigPage.tsx (behavior frozen).
 *
 * Scope agents/skills to global / workspace / project / user. Mirrors the
 * credential scope-chooser UX from SecretsPage: a scope-type selector that
 * conditionally reveals workspace / project / userId inputs. Adds a
 * resource-type toggle (Agent | Skill) and a resource picker (agent dropdown
 * from AGENT_CONTEXTS; free-text for skills). Backend at
 * /api/resource-assignments (obj-2388) — this UI only surfaces it.
 */
import { useState, useEffect, useCallback } from 'react'
import { Plus, Trash2, KeyRound } from 'lucide-react'
import {
  Card, CardHeader, Button, Alert, EmptyState, Skeleton, useConfirm, cn,
} from '../ui'
import { useWorkspaces } from '../../hooks/useWorkspaces'
import {
  AGENT_CONTEXTS,
  type AgentContext,
  type ResourceAssignment,
  type ResourceType,
  type ResourceScopeType,
  type SetResourceAssignmentRequest,
} from '@command-center/shared'
import { api, ApiError } from '../../lib/api'
import { inputCls, selectCls } from './config-form'

const RESOURCE_SCOPE_LABELS: Record<ResourceScopeType, string> = {
  global: 'Global',
  workspace: 'Organization',
  project: 'Project',
  user: 'User',
}

/** Readable one-line label for an assignment's scope. */
function scopeLabel(a: ResourceAssignment): string {
  switch (a.scopeType) {
    case 'global':
      return 'global'
    case 'workspace':
      return `organization: ${a.workspace ?? '—'}`
    case 'project':
      return `project: ${a.workspace ?? '—'} / ${a.project ?? '—'}`
    case 'user':
      return `user: ${a.userId ?? '—'}`
    default:
      return a.scopeType
  }
}

export function AssignmentsTab() {
  const { slugs: workspaceSlugs } = useWorkspaces()
  const { confirm, confirmDialog } = useConfirm()

  // Filter / form state.
  const [resourceType, setResourceType] = useState<ResourceType>('agent')
  const [scopeType, setScopeType] = useState<ResourceScopeType>('global')
  const [agentId, setAgentId] = useState<AgentContext>(AGENT_CONTEXTS[0])
  const [skillId, setSkillId] = useState('')
  const [workspace, setWorkspace] = useState('')
  const [project, setProject] = useState('')
  const [userId, setUserId] = useState('')

  const [assignments, setAssignments] = useState<ResourceAssignment[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)

  const needsWorkspace = scopeType === 'workspace' || scopeType === 'project'
  const needsProject = scopeType === 'project'
  const needsUser = scopeType === 'user'

  const reload = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const data = await api.get<ResourceAssignment[]>(
        `/resource-assignments?resourceType=${resourceType}`,
      )
      setAssignments(Array.isArray(data) ? data : [])
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Load failed')
      setAssignments([])
    } finally {
      setLoading(false)
    }
  }, [resourceType])

  useEffect(() => {
    void reload()
  }, [reload])

  async function handleCreate() {
    setError('')
    const resourceId = resourceType === 'agent' ? agentId : skillId.trim()
    if (!resourceId) {
      setError(resourceType === 'agent' ? 'Pick an agent.' : 'Enter a skill name.')
      return
    }
    if (needsWorkspace && !workspace) { setError('Select an organization.'); return }
    if (needsProject && !project.trim()) { setError('Enter a project / repo.'); return }
    if (needsUser && !userId.trim()) { setError('Enter a user ID.'); return }

    setCreating(true)
    try {
      const body: SetResourceAssignmentRequest = {
        resourceType,
        resourceId,
        scopeType,
        workspace: needsWorkspace ? workspace : undefined,
        project: needsProject ? project.trim() : undefined,
        userId: needsUser ? Number(userId) : undefined,
      }
      await api.post<ResourceAssignment>('/resource-assignments', body)
      await reload()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Create failed')
    } finally {
      setCreating(false)
    }
  }

  async function handleDelete(a: ResourceAssignment) {
    if (!(await confirm({
      title: 'Remove assignment?',
      message: `${a.resourceType} '${a.resourceId}' will no longer be scoped to ${scopeLabel(a)}.`,
      confirmLabel: 'Remove',
      danger: true,
    }))) return
    setError('')
    try {
      const p = new URLSearchParams({
        resourceType: a.resourceType,
        resourceId: a.resourceId,
        scopeType: a.scopeType,
      })
      if (a.workspace) p.set('workspace', a.workspace)
      if (a.project) p.set('project', a.project)
      if (a.userId != null) p.set('userId', String(a.userId))
      await api.del<void>(`/resource-assignments?${p.toString()}`)
      await reload()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Delete failed')
    }
  }

  return (
    <div className="space-y-4">
      {/* Create form */}
      <Card>
        <CardHeader title="Assign agent / skill to a scope" />
        <div className="mt-3 flex flex-wrap items-end gap-3">
          {/* Resource type toggle */}
          <div>
            <label className="mb-1 block text-[11px] uppercase tracking-wider text-fg-3">Resource</label>
            <div className="inline-flex rounded-md border border-line bg-surface-1 p-0.5">
              {(['agent', 'skill'] as ResourceType[]).map(rt => (
                <button
                  key={rt}
                  type="button"
                  onClick={() => setResourceType(rt)}
                  className={cn(
                    'rounded px-3 py-1.5 text-[13px] capitalize transition-colors',
                    resourceType === rt ? 'bg-accent text-accent-fg' : 'text-fg-2 hover:text-fg-0',
                  )}
                >
                  {rt}
                </button>
              ))}
            </div>
          </div>

          {/* Resource picker */}
          <div>
            <label className="mb-1 block text-[11px] uppercase tracking-wider text-fg-3">
              {resourceType === 'agent' ? 'Agent' : 'Skill name'}
            </label>
            {resourceType === 'agent' ? (
              <select
                value={agentId}
                onChange={e => setAgentId(e.target.value as AgentContext)}
                className={selectCls}
              >
                {AGENT_CONTEXTS.map(a => (
                  <option key={a} value={a}>{a}</option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={skillId}
                onChange={e => setSkillId(e.target.value)}
                placeholder="e.g. campaign-audit"
                className={cn(inputCls, 'w-48')}
              />
            )}
          </div>

          {/* Scope type */}
          <div>
            <label className="mb-1 block text-[11px] uppercase tracking-wider text-fg-3">Scope</label>
            <select
              value={scopeType}
              onChange={e => setScopeType(e.target.value as ResourceScopeType)}
              className={selectCls}
            >
              {(Object.keys(RESOURCE_SCOPE_LABELS) as ResourceScopeType[]).map(s => (
                <option key={s} value={s}>{RESOURCE_SCOPE_LABELS[s]}</option>
              ))}
            </select>
          </div>

          {needsWorkspace && (
            <div>
              <label className="mb-1 block text-[11px] uppercase tracking-wider text-fg-3">Organization</label>
              <select
                value={workspace}
                onChange={e => setWorkspace(e.target.value)}
                className={selectCls}
              >
                <option value="">— select —</option>
                {workspaceSlugs.map(ws => (
                  <option key={ws} value={ws}>{ws}</option>
                ))}
              </select>
            </div>
          )}

          {needsProject && (
            <div>
              <label className="mb-1 block text-[11px] uppercase tracking-wider text-fg-3">Project / repo</label>
              <input
                type="text"
                value={project}
                onChange={e => setProject(e.target.value)}
                placeholder="e.g. example-platform"
                className={cn(inputCls, 'w-48')}
              />
            </div>
          )}

          {needsUser && (
            <div>
              <label className="mb-1 block text-[11px] uppercase tracking-wider text-fg-3">User ID</label>
              <input
                type="number"
                value={userId}
                onChange={e => setUserId(e.target.value)}
                placeholder="e.g. 5"
                className={cn(inputCls, 'w-28')}
              />
            </div>
          )}

          <Button variant="primary" onClick={handleCreate} loading={creating} leftIcon={<Plus className="h-4 w-4" />}>
            Assign
          </Button>
        </div>
        <p className="mt-3 text-[12px] text-fg-3">
          When a resource has any assignment, sessions matching the scope are restricted to the
          assigned resources; resources with no assignments stay available everywhere.
        </p>
      </Card>

      {error && <Alert tone="alarm">{error}</Alert>}

      {/* Existing assignments */}
      <Card inset>
        <div className="border-b border-line px-4 py-3">
          <h3 className="font-display text-[14px] font-semibold text-fg-0 capitalize">{resourceType} assignments</h3>
        </div>
        {loading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-5 w-full" />
            ))}
          </div>
        ) : assignments.length === 0 ? (
          <EmptyState
            icon={<KeyRound className="h-5 w-5" />}
            title="No assignments"
            description={`No ${resourceType}s are scoped yet — all ${resourceType}s are available everywhere.`}
          />
        ) : (
          <table className="w-full text-[13px]">
            <thead className="border-b border-line">
              <tr className="text-left text-[12px] text-fg-3">
                <th className="px-4 py-2 font-medium">Resource</th>
                <th className="px-4 py-2 font-medium">Scope</th>
                <th className="px-4 py-2 font-medium">Created</th>
                <th className="px-4 py-2 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {assignments.map(a => (
                <tr key={a.id} className="border-b border-line last:border-b-0 hover:bg-surface-3">
                  <td className="px-4 py-2 font-mono text-fg-1">{a.resourceId}</td>
                  <td className="px-4 py-2 font-mono text-[12px] text-fg-2">{scopeLabel(a)}</td>
                  <td className="px-4 py-2 text-[12px] text-fg-3">{a.createdAt?.slice(0, 16).replace('T', ' ')}</td>
                  <td className="px-4 py-2 text-right">
                    <Button variant="danger" size="sm" onClick={() => handleDelete(a)} leftIcon={<Trash2 className="h-3.5 w-3.5" />}>
                      Remove
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {confirmDialog}
    </div>
  )
}
