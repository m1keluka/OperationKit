import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { Alert, Button, cn } from '../ui'
import type { BotWorkspaceAccessInfo, BotWorkspaceAccessResponse, ChatAgentInfo } from './types'

/* Workspace access (obj 900797), on the bot's settings panel.

   Bots are global: one bot for the whole install, never created inside a
   workspace. This section is the bot's list of workspaces it may read, write
   and be woken in. An admin grants or revokes them here; the server enforces
   the list on the board, the knowledge base, the chat tools and High Agency.

   Three states the admin must be able to tell apart at a glance:
     - Not restricted yet: a bot that was here before access lists; it still
       works wherever the person chatting with it can. Granting a workspace
       restricts it to the granted list.
     - N workspaces: exactly those.
     - No workspaces: it can chat, but touches no board or notes.
   Non-admins see the list read-only (only workspaces they belong to). */

function when(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

export function WorkspaceAccessSection({
  agent,
  isAdmin,
  onChanged,
}: {
  agent: Pick<ChatAgentInfo, 'slug' | 'name'>
  isAdmin: boolean
  /** Called after a grant/revoke so siblings (High Agency) can reload. */
  onChanged?: () => void
}) {
  const [access, setAccess] = useState<BotWorkspaceAccessInfo | null>(null)
  const [options, setOptions] = useState<{ slug: string; name: string }[]>([])
  const [pick, setPick] = useState('')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const url = `/agent-chat/agents/${encodeURIComponent(agent.slug)}/workspaces`

  const adopt = (r: BotWorkspaceAccessResponse) => {
    if (!r?.access) throw new Error('This server does not support workspace access yet')
    setAccess(r.access)
    if (r.workspace_options) setOptions(r.workspace_options)
  }

  useEffect(() => {
    let live = true
    setLoadError(null)
    api.get<BotWorkspaceAccessResponse>(url)
      .then(r => { if (live) adopt(r) })
      .catch(e => { if (live) setLoadError(e instanceof Error ? e.message : 'Could not load workspace access') })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url])

  const granted = access?.workspaces ?? []
  const addable = options.filter(o => !granted.includes(o.slug))
  const chosen = addable.some(o => o.slug === pick) ? pick : addable[0]?.slug ?? ''
  const label = (slug: string) => {
    const o = options.find(x => x.slug === slug)
    return o && o.name && o.name !== slug ? `${o.name} (${slug})` : slug
  }
  const unrestricted = access?.mode === 'unrestricted'

  const run = async (key: string, fn: () => Promise<BotWorkspaceAccessResponse>, done: (r: BotWorkspaceAccessResponse) => string) => {
    setBusy(key)
    setError(null)
    setNotice(null)
    try {
      const r = await fn()
      adopt(r)
      setNotice(done(r))
      onChanged?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not work')
    } finally {
      setBusy(null)
    }
  }

  const grant = (ws: string) =>
    run(`grant:${ws}`, () => api.post<BotWorkspaceAccessResponse>(url, { workspace: ws }), () =>
      unrestricted
        ? `Granted ${ws}. ${agent.name} is now restricted to the workspaces listed here.`
        : `Granted ${ws}.`)

  const revoke = (ws: string) =>
    run(`revoke:${ws}`, () => api.del<BotWorkspaceAccessResponse>(`${url}/${encodeURIComponent(ws)}`), r =>
      r.high_agency_switched_off
        ? `Revoked ${ws}. High Agency was switched off because it woke in ${ws}.`
        : `Revoked ${ws}.`)

  const lockOut = () =>
    run('none', () => api.put<BotWorkspaceAccessResponse>(url, { workspaces: [] }), r =>
      r.high_agency_switched_off
        ? `${agent.name} now has no workspace. High Agency was switched off.`
        : `${agent.name} now has no workspace.`)

  const id = (k: string) => `bot-ws-${k}-${agent.slug}`
  const badge = !access
    ? '…'
    : unrestricted
      ? 'Not restricted'
      : granted.length === 0
        ? 'No workspaces'
        : `${granted.length} workspace${granted.length === 1 ? '' : 's'}`

  return (
    <section aria-labelledby={id('title')} className="flex flex-col gap-3 border-t border-line pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 id={id('title')} className="font-display text-[13px] font-semibold text-fg-0">Workspace access</h4>
        <span
          className={cn(
            'rounded-full px-2 py-0.5 text-[12px]',
            unrestricted ? 'bg-signal-amber/10 text-signal-amber' : granted.length ? 'bg-[var(--accent-tint)] text-accent-hover' : 'bg-surface-2 text-fg-2',
          )}
        >
          {badge}
        </span>
      </div>
      <p className="text-[12px] text-fg-2">
        {agent.name} is shared across this install. These are the workspaces it may read, write and be woken in: its board cards, knowledge base notes, secrets and connected tools there. It never reaches further than the person chatting with it, and access gives it no new tools and no right to send, merge or deploy.
      </p>

      {loadError && <Alert tone="alarm">{loadError}</Alert>}

      {access && unrestricted && (
        <Alert tone="amber">
          Not restricted yet. {agent.name} was set up before workspace access lists, so it can still work in any workspace the person chatting with it can see. Grant the workspaces it should use, and every other workspace is switched off for it.
        </Alert>
      )}
      {access && !unrestricted && granted.length === 0 && (
        <Alert tone="info">
          No workspaces. {agent.name} can still chat, but it can&apos;t read or write any board or knowledge base, and High Agency can&apos;t wake it{isAdmin ? '. Grant a workspace below.' : '.'}
        </Alert>
      )}

      {granted.length > 0 && (
        <ul aria-label={`Workspaces ${agent.name} may use`} className="flex flex-col divide-y divide-line rounded-md border border-line bg-surface-0">
          {access!.grants.map(g => (
            <li key={g.workspace} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <span>
                <span className="block text-[13px] text-fg-0">{label(g.workspace)}</span>
                {(g.granted_by || g.granted_at) && (
                  <span className="block text-[12px] text-fg-2">
                    Granted{g.granted_by ? ` by ${g.granted_by}` : ''}{g.granted_at ? ` · ${when(g.granted_at)}` : ''}
                  </span>
                )}
              </span>
              {isAdmin && (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Revoke ${g.workspace}`}
                  loading={busy === `revoke:${g.workspace}`}
                  disabled={busy !== null}
                  onClick={() => void revoke(g.workspace)}
                >
                  Revoke
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {isAdmin && access && (
        <div className="flex flex-wrap items-end gap-2">
          {addable.length > 0 ? (
            <>
              <div className="min-w-[200px] flex-1">
                <label htmlFor={id('add')} className="mb-1 block text-[12px] font-medium text-fg-1">Grant a workspace</label>
                <select
                  id={id('add')}
                  value={chosen}
                  onChange={e => { setPick(e.target.value); setNotice(null) }}
                  disabled={busy !== null}
                  className="min-h-[40px] w-full rounded-md border border-line bg-surface-0 px-2 text-[13px] text-fg-0 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-60"
                >
                  {addable.map(o => <option key={o.slug} value={o.slug}>{label(o.slug)}</option>)}
                </select>
              </div>
              <Button variant="primary" size="sm" loading={busy === `grant:${chosen}`} disabled={!chosen || busy !== null} onClick={() => void grant(chosen)}>
                {unrestricted ? 'Grant and restrict' : 'Grant access'}
              </Button>
            </>
          ) : (
            <p className="text-[12px] text-fg-2">Every workspace on this install is granted.</p>
          )}
          {unrestricted && (
            <Button variant="ghost" size="sm" loading={busy === 'none'} disabled={busy !== null} onClick={() => void lockOut()}>
              Restrict to no workspace
            </Button>
          )}
        </div>
      )}

      {error && <Alert tone="alarm">{error}</Alert>}
      {notice && <p role="status" className="text-[12px] text-fg-2">{notice}</p>}
      {!notice && isAdmin && access?.updated_by && access.updated_by !== 'migration' && (
        <p className="text-[12px] text-fg-2">Changed by {access.updated_by}</p>
      )}
      {!isAdmin && <p className="text-[12px] text-fg-2">Only an admin can change which workspaces a bot may use.</p>}
    </section>
  )
}
