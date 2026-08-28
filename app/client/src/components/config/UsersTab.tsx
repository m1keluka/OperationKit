/**
 * Users Settings tab — extracted from ConfigPage.tsx (behavior frozen).
 */
import { useState, useEffect, useCallback } from 'react'
import { Plus, ChevronRight } from 'lucide-react'
import {
  Card, CardHeader, Button, Badge, Alert, Skeleton, useConfirm, cn,
} from '../ui'
import { useWorkspaces } from '../../hooks/useWorkspaces'
import {
  type User,
  type UserRole,
  type Workspace,
  type WorkspaceMembership,
  type ObjectiveVisibility,
} from '@command-center/shared'
import { api } from '../../lib/api'
import { inputCls, selectCls, SectionLabel } from './config-form'

interface AdminUser extends User {
  workspaces: WorkspaceMembership[]
}

function generateTempPassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
  let out = ''
  for (let i = 0; i < 12; i++) out += chars[Math.floor(Math.random() * chars.length)]
  return out
}

export function UsersTab() {
  const [users, setUsers] = useState<AdminUser[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<number | null>(null)
  const { slugs: allWorkspaceSlugs } = useWorkspaces()

  const [newUsername, setNewUsername] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [newRole, setNewRole] = useState<UserRole>('member')
  const [creating, setCreating] = useState(false)
  const [revealed, setRevealed] = useState<{ username: string; password: string } | null>(null)
  const { confirm, confirmDialog } = useConfirm()

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await api.get<AdminUser[]>('/admin/users')
      setUsers(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load users')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  async function createUser(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!newUsername.trim() || newPassword.length < 8) {
      setError('Username and password (8+ chars) required')
      return
    }
    setCreating(true)
    try {
      await api.post('/admin/users', { username: newUsername.trim(), password: newPassword, role: newRole })
      setRevealed({ username: newUsername.trim(), password: newPassword })
      setNewUsername(''); setNewPassword(''); setNewRole('member')
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create user')
    } finally {
      setCreating(false)
    }
  }

  async function resetPassword(user: AdminUser) {
    const pwd = generateTempPassword()
    try {
      await api.post(`/admin/users/${user.id}/reset-password`, { password: pwd })
      setRevealed({ username: user.username, password: pwd })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Reset failed')
    }
  }

  async function setUserRole(user: AdminUser, role: UserRole) {
    try { await api.patch(`/admin/users/${user.id}`, { role }); await reload() }
    catch (e) { setError(e instanceof Error ? e.message : 'Role update failed') }
  }

  async function grantWorkspace(user: AdminUser, workspace: Workspace) {
    try { await api.post(`/admin/workspaces/${workspace}/users`, { user_id: user.id, role: 'member' }); await reload() }
    catch (e) { setError(e instanceof Error ? e.message : 'Grant failed') }
  }

  async function updateMembership(
    user: AdminUser,
    workspace: string,
    patch: Partial<{ role: UserRole; can_use_jarvis: boolean; objective_visibility: ObjectiveVisibility }>,
  ) {
    const existing = user.workspaces.find(w => w.workspace === workspace)
    if (!existing) return
    try {
      await api.post(`/admin/workspaces/${workspace}/users`, {
        user_id: user.id,
        role: patch.role ?? existing.role,
        can_use_jarvis: patch.can_use_jarvis ?? existing.can_use_jarvis,
        objective_visibility: patch.objective_visibility ?? existing.objective_visibility,
      })
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Update failed')
    }
  }

  async function revokeWorkspace(user: AdminUser, workspace: string) {
    if (!(await confirm({
      title: 'Remove from organization?',
      message: `${user.username} will lose access to ${workspace}.`,
      confirmLabel: 'Remove',
      danger: true,
    }))) return
    try { await api.del(`/admin/workspaces/${workspace}/users/${user.id}`); await reload() }
    catch (e) { setError(e instanceof Error ? e.message : 'Revoke failed') }
  }

  async function deleteUser(user: AdminUser) {
    if (!(await confirm({
      title: 'Delete user?',
      message: `"${user.username}" will be permanently deleted. This cannot be undone.`,
      confirmLabel: 'Delete',
      danger: true,
    }))) return
    try { await api.del(`/admin/users/${user.id}`); await reload() }
    catch (e) { setError(e instanceof Error ? e.message : 'Delete failed') }
  }

  if (loading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <Card key={i} inset>
            <div className="flex items-center justify-between p-4">
              <div className="space-y-2">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3 w-44" />
              </div>
              <Skeleton className="h-6 w-16 rounded-md" />
            </div>
          </Card>
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {confirmDialog}
      {/* Create user */}
      <Card inset>
        <CardHeader title="Create user" eyebrow="Manage" />
        <form onSubmit={createUser} className="space-y-3 p-4">
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              type="text" placeholder="username" value={newUsername}
              onChange={e => setNewUsername(e.target.value)} className={cn(inputCls, 'sm:flex-1')}
            />
            <div className="flex flex-1 gap-2">
              <input
                type="text" placeholder="temp password (8+ chars)" value={newPassword}
                onChange={e => setNewPassword(e.target.value)} className={cn(inputCls, 'flex-1 font-mono')}
              />
              <Button type="button" variant="secondary" size="sm" className="shrink-0" onClick={() => setNewPassword(generateTempPassword())}>
                Generate
              </Button>
            </div>
            <select value={newRole} onChange={e => setNewRole(e.target.value as UserRole)} className={selectCls}>
              <option value="member">member</option>
              <option value="admin">admin</option>
            </select>
            <Button type="submit" variant="primary" size="sm" className="shrink-0" disabled={creating}>
              {creating ? 'Creating…' : 'Create'}
            </Button>
          </div>
          {error && <Alert tone="alarm">{error}</Alert>}
          {revealed && (
            <Alert tone="amber" title={<>Password set for <span className="font-mono">{revealed.username}</span></>}>
              <div className="mt-1 font-mono text-fg-0">{revealed.password}</div>
              <div className="mt-1">Copy this now — it will not be shown again. Share with the user over a secure channel.</div>
              <button type="button" onClick={() => setRevealed(null)} className="mt-1 text-signal-amber underline">dismiss</button>
            </Alert>
          )}
        </form>
      </Card>

      {/* User list */}
      {users.map(user => {
        const memberships = user.workspaces
        const ungranted = allWorkspaceSlugs.filter(ws => !memberships.some(m => m.workspace === ws)) as Workspace[]
        const isOpen = expanded === user.id
        return (
          <Card key={user.id} inset>
            <button onClick={() => setExpanded(isOpen ? null : user.id)} className="flex w-full items-center gap-3 px-4 py-3 text-left">
              <ChevronRight className={cn('h-4 w-4 shrink-0 text-fg-3 transition-transform', isOpen && 'rotate-90')} />
              <span className="text-[13px] font-medium text-fg-0">{user.username}</span>
              <Badge tone={user.role === 'admin' ? 'accent' : 'neutral'}>{user.role}</Badge>
              <span className="ml-auto text-[11px] text-fg-3">
                {memberships.length} organization{memberships.length === 1 ? '' : 's'}
              </span>
            </button>

            {isOpen && (
              <div className="space-y-4 border-t border-line p-4">
                {/* Global role + actions */}
                <div className="flex flex-wrap items-center gap-2 text-[12px]">
                  <span className="text-fg-3">Global role:</span>
                  <select value={user.role} onChange={e => setUserRole(user, e.target.value as UserRole)} className={selectCls}>
                    <option value="member">member</option>
                    <option value="admin">admin</option>
                  </select>
                  <div className="ml-auto flex gap-2">
                    <Button size="sm" variant="secondary" onClick={() => resetPassword(user)}>Reset password</Button>
                    <Button size="sm" variant="danger" onClick={() => deleteUser(user)}>Delete user</Button>
                  </div>
                </div>

                {/* Memberships */}
                <section>
                  <SectionLabel>Organization access</SectionLabel>
                  <div className="space-y-2">
                    {memberships.map(m => (
                      <div key={m.workspace} className="space-y-2 rounded-md border border-line bg-surface-1 p-3">
                        <div className="flex items-center justify-between">
                          <span className="text-[13px] font-medium text-fg-0">{m.workspace}</span>
                          <button onClick={() => revokeWorkspace(user, m.workspace)} className="text-[12px] text-signal-alarm hover:underline">Revoke</button>
                        </div>
                        <div className="flex flex-wrap gap-4 text-[12px]">
                          <label className="flex items-center gap-2">
                            <span className="text-fg-3">Role:</span>
                            <select value={m.role} onChange={e => updateMembership(user, m.workspace, { role: e.target.value as UserRole })} className={selectCls}>
                              <option value="member">member</option>
                              <option value="admin">admin</option>
                            </select>
                          </label>
                          <label className="flex items-center gap-2">
                            <input type="checkbox" checked={!!m.can_use_jarvis}
                                   onChange={e => updateMembership(user, m.workspace, { can_use_jarvis: e.target.checked })}
                                   className="rounded border-line bg-surface-1 accent-[var(--accent)]" />
                            <span className="text-fg-1">Jarvis chat</span>
                          </label>
                          <label className="flex items-center gap-2">
                            <span className="text-fg-3">Sees:</span>
                            <select value={m.objective_visibility}
                                    onChange={e => updateMembership(user, m.workspace, { objective_visibility: e.target.value as ObjectiveVisibility })}
                                    className={selectCls}>
                              <option value="own">own objectives</option>
                              <option value="all">all in organization</option>
                            </select>
                          </label>
                        </div>
                      </div>
                    ))}
                    {memberships.length === 0 && <p className="text-[12px] text-fg-3">No organization access — grant one below.</p>}
                  </div>
                </section>

                {/* Grant */}
                {ungranted.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[11px] uppercase tracking-wider text-fg-3">Grant:</span>
                    {ungranted.map(ws => (
                      <Button key={ws} size="sm" variant="secondary" leftIcon={<Plus className="h-3.5 w-3.5" />} onClick={() => grantWorkspace(user, ws)}>
                        {ws}
                      </Button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </Card>
        )
      })}
      {users.length === 0 && !loading && <p className="text-[13px] text-fg-3">No users yet.</p>}
    </div>
  )
}
