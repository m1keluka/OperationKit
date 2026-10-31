/**
 * Secret requests pinned in the card chat (obj 718944 → 719065). A worker that
 * is blocked on a missing credential emits request_secret {name, reason, scope};
 * this renders it as a masked form with the name prefilled and the scope picker
 * defaulting to what the worker suggested (the card's organization unless it
 * said otherwise). Submit → POST …/needs-secret/fill → the existing encrypted
 * store; the value is never shown back and the worker resumes on its own.
 */
import { useState } from 'react'
import { KeyRound } from 'lucide-react'
import type { NeedsSecretItem, SecretRequestScope } from '@operationkit/shared'
import { Button } from '../ui'
import { api } from '../../lib/api'
import { MaskedSecretInput, SecretPrivacyNote, SecretScopePicker } from './SecretFields'

function SecretRow({ objectiveId, workspace, item, canFill }: {
  objectiveId: number
  workspace: string
  item: NeedsSecretItem
  canFill: boolean
}) {
  const [value, setValue] = useState('')
  const [scope, setScope] = useState<SecretRequestScope>(item.scope ?? 'workspace')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const inputId = `needs-secret-${objectiveId}-${item.name}`

  async function save() {
    if (!value.trim() || saving) return
    setSaving(true)
    setError(null)
    try {
      await api.post(`/objectives/${objectiveId}/needs-secret/fill`, { name: item.name, value, scope })
      setValue('')
      setSaved(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the secret')
    } finally {
      setSaving(false)
    }
  }

  return (
    <li className="space-y-2 rounded-md border border-line bg-surface-0 p-3">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <label htmlFor={inputId} className="font-mono text-[13px] font-semibold text-fg-0">{item.name}</label>
        <span className="text-[12px] text-fg-2">{item.reason}</span>
      </div>
      {saved ? (
        <div role="status" className="text-[12.5px] text-signal-verify">Saved. The session was told {item.name} is available and is resuming.</div>
      ) : canFill ? (
        <form
          className="space-y-2.5"
          onSubmit={e => { e.preventDefault(); void save() }}
        >
          <SecretScopePicker id={`${inputId}-scope`} value={scope} onChange={setScope} workspace={workspace} disabled={saving} />
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="flex-1"><MaskedSecretInput id={inputId} value={value} onChange={setValue} disabled={saving} /></div>
            <Button type="submit" size="md" variant="primary" loading={saving} disabled={!value.trim() || saving}>
              Save secret
            </Button>
          </div>
        </form>
      ) : (
        <div className="text-[12px] text-fg-2">Only the card owner or an admin can add this, signed in to the web app.</div>
      )}
      {error && <div className="text-[12px] text-flag-blocked" role="alert">{error}</div>}
    </li>
  )
}

export function NeedsSecretPanel({ objectiveId, workspace, items, canFill }: {
  objectiveId: number
  workspace: string
  items: NeedsSecretItem[]
  canFill: boolean
}) {
  if (items.length === 0) return null
  return (
    <section
      aria-label="Secrets this card is waiting on"
      className="cc-pop-in border-b border-status-human/30 bg-status-human/5"
    >
      <div className="mx-auto max-w-4xl space-y-3 px-4 py-3 sm:px-5">
        <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-status-human">
          <KeyRound className="h-3.5 w-3.5" aria-hidden />
          Session is waiting on {items.length === 1 ? 'a secret' : `${items.length} secrets`}
        </div>
        <ul className="space-y-2.5">
          {items.map(item => (
            <SecretRow key={item.name} objectiveId={objectiveId} workspace={workspace} item={item} canFill={canFill} />
          ))}
        </ul>
        {canFill && <SecretPrivacyNote />}
      </div>
    </section>
  )
}
