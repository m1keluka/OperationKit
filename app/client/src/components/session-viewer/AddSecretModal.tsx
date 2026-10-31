/**
 * obj 719065 — "+ Add secret" from any card chat, with or without a request,
 * and the "save as secret" path when a key is pasted into the composer. The
 * value goes to POST /objectives/:id/secrets (existing encrypted store,
 * versioned, in History); the session is told only the NAME.
 */
import { useState } from 'react'
import type { SecretRequestScope } from '@operationkit/shared'
import { Button, Modal } from '../ui'
import { api } from '../../lib/api'
import { SECRET_NAME_PATTERN, toSecretName } from '../../lib/secretDetect'
import { MaskedSecretInput, SecretPrivacyNote, SecretScopePicker } from './SecretFields'

export function AddSecretModal({ objectiveId, workspace, initialName = '', initialValue = '', fromPaste = false, onClose, onSaved }: {
  objectiveId: number
  workspace: string
  initialName?: string
  initialValue?: string
  /** Opened from the composer's "looks like a key" prompt. */
  fromPaste?: boolean
  onClose: () => void
  onSaved: (name: string) => void
}) {
  const [name, setName] = useState(initialName)
  const [value, setValue] = useState(initialValue)
  const [scope, setScope] = useState<SecretRequestScope>('workspace')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nameOk = SECRET_NAME_PATTERN.test(name)
  const canSave = nameOk && !!value.trim() && !saving

  async function save() {
    if (!canSave) return
    setSaving(true)
    setError(null)
    try {
      await api.post(`/objectives/${objectiveId}/secrets`, { name, value, scope })
      setValue('')
      onSaved(name)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the secret')
      setSaving(false)
    }
  }

  return (
    <Modal open onClose={onClose} variant="center" labelledBy="add-secret-title" panelClassName="max-w-md bg-surface-raised">
      <form className="space-y-4 p-5 sm:p-6" onSubmit={e => { e.preventDefault(); void save() }}>
        <div className="space-y-1">
          <h2 id="add-secret-title" className="text-[17px] font-semibold text-fg-0">
            {fromPaste ? 'Save as secret' : 'Add a secret'}
          </h2>
          <p className="text-[12.5px] text-fg-2">
            {fromPaste
              ? 'That looked like a key. Save it to the store instead of sending it — your message keeps a [REDACTED] marker in its place.'
              : 'Make a credential available to this card’s session by name.'}
          </p>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="add-secret-name" className="text-[11px] font-medium uppercase tracking-wider text-fg-2">Name</label>
          <input
            id="add-secret-name"
            value={name}
            onChange={e => setName(toSecretName(e.target.value))}
            placeholder="APIFY_API_TOKEN"
            autoFocus={!initialName}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={!!name && !nameOk}
            className="min-h-[44px] w-full rounded-md border border-line bg-surface-1 px-3 py-2 font-mono text-base text-fg-0 placeholder:text-fg-3 transition-colors duration-base hover:border-line-strong focus:border-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-[36px] sm:text-[13px]"
          />
          {name && !nameOk && <p className="text-[11.5px] text-flag-blocked">Use UPPER_SNAKE_CASE, at least two characters.</p>}
        </div>

        <SecretScopePicker id="add-secret-scope" value={scope} onChange={setScope} workspace={workspace} disabled={saving} />

        <div className="space-y-1.5">
          <label htmlFor="add-secret-value" className="text-[11px] font-medium uppercase tracking-wider text-fg-2">Value</label>
          <MaskedSecretInput id="add-secret-value" value={value} onChange={setValue} autoFocus={!!initialName && !initialValue} disabled={saving} />
        </div>

        <SecretPrivacyNote />
        {error && <div className="rounded-md bg-flag-blocked/10 px-3 py-2 text-[12.5px] text-flag-blocked" role="alert">{error}</div>}

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="ghost" size="md" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button type="submit" variant="primary" size="md" loading={saving} disabled={!canSave}>Save secret</Button>
        </div>
      </form>
    </Modal>
  )
}
