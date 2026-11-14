/**
 * Bot access for ONE secret name (obj 900749).
 *
 * Bots (in-app chat bots, MCP-connected bots, workers) never see a secret.
 * They name it — `{{secret:NAME}}` — and the server adds the value to one
 * outgoing HTTPS request, only to the hosts listed here, then blanks it out of
 * the reply. With no hosts, no bot can use it (default-deny).
 *
 * This dialog edits only that allowlist. It never shows, asks for or changes
 * the value, the scope or any other part of the stored secret.
 */
import { useState, type FormEvent } from 'react'
import { Modal } from '../ui'
import type { SecretSummary } from '@operationkit/shared'
import { BOT_METHODS, clearBotAccess, saveBotAccess, type BotAccessEntry } from './botAccess'

interface Props {
  secret: SecretSummary
  entry: BotAccessEntry | null
  organizations: { slug: string; name: string }[]
  onClose: () => void
  onSaved: () => void | Promise<void>
}

export function BotAccessModal({ secret, entry, organizations, onClose, onSaved }: Props) {
  const isGlobal = secret.scopeType === 'global'
  const [hosts, setHosts] = useState((entry?.hosts ?? []).join('\n'))
  const [methods, setMethods] = useState<string[]>(entry?.methods?.length ? entry.methods : [...BOT_METHODS])
  const [orgs, setOrgs] = useState<string[]>(entry?.workspaces ?? [])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const hostList = hosts.split(/[\s,]+/).map(h => h.trim()).filter(Boolean)
  const allMethods = methods.length === BOT_METHODS.length

  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter(x => x !== v) : [...list, v])

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError('')
    if (hostList.length === 0) {
      setError('Add at least one host, or use "Turn off".')
      return
    }
    if (methods.length === 0) {
      setError('Pick at least one method.')
      return
    }
    setSaving(true)
    try {
      await saveBotAccess(secret.key, {
        hosts: hostList,
        ...(allMethods ? {} : { methods }),
        ...(isGlobal ? { workspaces: orgs } : entry?.workspaces?.length ? { workspaces: entry.workspaces } : {}),
        ...(entry?.description ? { description: entry.description } : {}),
      })
      await onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save')
    } finally {
      setSaving(false)
    }
  }

  async function turnOff() {
    setSaving(true)
    setError('')
    try {
      await clearBotAccess(secret.key)
      await onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not turn off')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open onClose={onClose} variant="center" labelledBy="bot-access-title" panelClassName="max-w-lg bg-surface-raised">
      <form className="p-6" onSubmit={submit} data-testid="bot-access-modal">
        <div className="mb-1 flex items-center justify-between">
          <h2 id="bot-access-title" className="text-lg font-semibold text-fg-0">Bot access</h2>
          <button onClick={onClose} className="text-fg-3 hover:text-fg-1" type="button" aria-label="Close">✕</button>
        </div>
        <p className="mb-4 font-mono text-xs text-fg-1">{secret.key}</p>

        <p className="mb-4 rounded-md border border-border bg-surface px-3 py-2 text-[12px] leading-relaxed text-fg-2">
          Bots never see this value. A bot writes <span className="font-mono text-fg-1">{`{{secret:${secret.key}}}`}</span> in a request;
          the server adds the value, sends it only to the hosts below, and blanks it out of the reply.
          Every use is logged by name.
        </p>

        <label htmlFor="bot-access-hosts" className="mb-1 block text-xs text-fg-2">Allowed hosts</label>
        <textarea
          id="bot-access-hosts"
          data-testid="bot-access-hosts"
          value={hosts}
          onChange={e => setHosts(e.target.value)}
          rows={3}
          placeholder={'api.example.com\n*.example.com'}
          className="w-full rounded border border-border bg-surface px-2 py-1.5 font-mono text-sm text-fg-0 outline-none focus:border-accent"
        />
        <p className="mb-4 mt-1 text-[12px] text-fg-3">One per line. HTTPS only. <span className="font-mono">*.example.com</span> covers its subdomains.</p>

        <fieldset className="mb-4">
          <legend className="mb-1 text-xs text-fg-2">Methods</legend>
          <div className="flex flex-wrap gap-3">
            {BOT_METHODS.map(m => (
              <label key={m} className="flex items-center gap-1.5 text-xs text-fg-1">
                <input type="checkbox" checked={methods.includes(m)} onChange={() => setMethods(cur => toggle(cur, m))} />
                {m}
              </label>
            ))}
          </div>
        </fieldset>

        {isGlobal && (
          <fieldset className="mb-4">
            <legend className="mb-1 text-xs text-fg-2">Workspaces whose bots may use it</legend>
            {organizations.length === 0 ? (
              <p className="text-[12px] text-fg-3">No organizations.</p>
            ) : (
              <div className="flex flex-wrap gap-3" data-testid="bot-access-orgs">
                {organizations.map(o => (
                  <label key={o.slug} className="flex items-center gap-1.5 text-xs text-fg-1">
                    <input type="checkbox" checked={orgs.includes(o.slug)} onChange={() => setOrgs(cur => toggle(cur, o.slug))} />
                    {o.name}
                  </label>
                ))}
              </div>
            )}
            <p className="mt-1 text-[12px] text-fg-3">
              This secret applies everywhere. Bots and API keys only get it in the workspaces ticked here.
            </p>
          </fieldset>
        )}

        {error && <div className="mb-3 rounded bg-signal-alarm/10 px-3 py-2 text-sm text-signal-alarm">{error}</div>}

        <div className="flex items-center justify-between gap-3">
          {entry ? (
            <button type="button" onClick={() => void turnOff()} disabled={saving} className="text-xs text-signal-alarm hover:underline disabled:opacity-50">
              Turn off
            </button>
          ) : <span />}
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-fg-2 hover:text-fg-0">Cancel</button>
            <button
              type="submit"
              disabled={saving}
              data-testid="bot-access-save"
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  )
}
