/**
 * obj 900670 — the masked in-chat secret form (replaces the pinned
 * "waiting on a secret" banner and the composer's "+ Add secret" button/modal
 * from obj 719065).
 *
 * The agent asks (request_secret → objectives.needs_secret) and the request
 * renders as an AGENT-side chat bubble at the bottom of the thread, carrying a
 * masked field. Submit → POST …/needs-secret/fill → the encrypted, write-only
 * store (#900540). The value only ever lives in this component's state until
 * the POST: it is never echoed back, the confirmation names the secret only,
 * and the field is cleared the moment the server accepts it.
 *
 * `SecretForm` is shared with the composer's paste guard ("this looks like a
 * key — save it instead"), which writes through POST …/secrets.
 */
import { useState, type ReactNode } from 'react'
import { KeyRound, Lock } from 'lucide-react'
import type { NeedsSecretItem, SecretRequestScope } from '@operationkit/shared'
import { Button } from '../ui'
import { api } from '../../lib/api'
import { SECRET_NAME_PATTERN, toSecretName } from '../../lib/secretDetect'
import { SCOPE_LABELS } from '../secrets/scope'
import { MaskedSecretInput, SecretScopePicker } from './SecretFields'

/** "Organization (example)" / "Command Center" / "Org + me (example)" — the compact scope line. */
export function scopeSummary(scope: SecretRequestScope, workspace: string): string {
  if (scope === 'global') return `${SCOPE_LABELS.global} (every organization)`
  if (scope === 'workspace_user') return `Only me in ${workspace || 'this organization'}`
  return `${workspace || 'this organization'} secrets`
}

export interface SecretFormProps {
  objectiveId: number
  workspace: string
  /** Fixed name (an agent request). Omit to let the owner type one (paste guard). */
  name?: string
  initialName?: string
  initialValue?: string
  initialScope?: SecretRequestScope
  /** `fill` answers a pending request; `add` saves an unrequested secret. */
  mode: 'fill' | 'add'
  onSaved: (name: string, scope: SecretRequestScope) => void
  onCancel?: () => void
  idPrefix: string
}

export function SecretForm({
  objectiveId, workspace, name: fixedName, initialName = '', initialValue = '', initialScope = 'workspace',
  mode, onSaved, onCancel, idPrefix,
}: SecretFormProps) {
  const [name, setName] = useState(fixedName ?? initialName)
  const [value, setValue] = useState(initialValue)
  const [scope, setScope] = useState<SecretRequestScope>(initialScope)
  const [showScope, setShowScope] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nameOk = SECRET_NAME_PATTERN.test(name)
  const canSave = nameOk && !!value.trim() && !saving

  async function save() {
    if (!canSave) return
    setSaving(true)
    setError(null)
    try {
      const path = mode === 'fill' ? `/objectives/${objectiveId}/needs-secret/fill` : `/objectives/${objectiveId}/secrets`
      await api.post(path, { name, value, scope })
      setValue('')
      onSaved(name, scope)
    } catch (err) {
      // Server errors never carry the value (secret-requests.test.ts); show them as-is.
      setError(err instanceof Error ? err.message : 'Could not save the secret')
      setSaving(false)
    }
  }

  return (
    <form className="space-y-2" onSubmit={e => { e.preventDefault(); void save() }} data-testid="chat-secret-form">
      {fixedName === undefined && (
        <div className="space-y-1">
          <label htmlFor={`${idPrefix}-name`} className="sr-only">Secret name</label>
          <input
            id={`${idPrefix}-name`}
            value={name}
            onChange={e => setName(toSecretName(e.target.value))}
            placeholder="SECRET_NAME"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={!!name && !nameOk}
            disabled={saving}
            className="min-h-[44px] w-full rounded-md border border-line bg-surface-1 px-3 py-2 font-mono text-base text-fg-0 placeholder:text-fg-3 focus:border-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-[36px] sm:text-[13px]"
          />
          {name && !nameOk && <p className="text-[12px] text-flag-blocked">Use UPPER_SNAKE_CASE, at least two characters.</p>}
        </div>
      )}
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="flex-1">
          <label htmlFor={`${idPrefix}-value`} className="sr-only">Value for {name || 'this secret'}</label>
          <MaskedSecretInput id={`${idPrefix}-value`} value={value} onChange={setValue} disabled={saving} />
        </div>
        <div className="flex gap-1.5">
          {onCancel && (
            <Button type="button" size="md" variant="ghost" onClick={onCancel} disabled={saving}>Cancel</Button>
          )}
          <Button type="submit" size="md" variant="primary" loading={saving} disabled={!canSave}>
            Save
          </Button>
        </div>
      </div>
      {showScope ? (
        <SecretScopePicker id={`${idPrefix}-scope`} value={scope} onChange={setScope} workspace={workspace} disabled={saving} />
      ) : (
        <div className="flex flex-wrap items-center gap-x-1.5 text-[12px] text-fg-2">
          <Lock className="h-3 w-3 shrink-0" aria-hidden />
          <span>Saves to <span className="font-medium text-fg-1">{scopeSummary(scope, workspace)}</span>. Encrypted, write-only — never shown in chat.</span>
          <button
            type="button"
            onClick={() => setShowScope(true)}
            disabled={saving}
            className="font-medium text-accent hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            Change
          </button>
        </div>
      )}
      {error && <div className="text-[12px] text-flag-blocked" role="alert">{error}</div>}
    </form>
  )
}

function SavedLine({ name, scope, workspace }: { name: string; scope: SecretRequestScope; workspace: string }) {
  return (
    <div role="status" className="flex items-start gap-2 text-[13px] text-fg-1">
      <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-signal-verify" aria-hidden />
      <span>
        <span className="font-mono font-semibold text-fg-0">{name}</span> saved to {scopeSummary(scope, workspace)}.
        {' '}The value is hidden for good; the agent is told only the name and is resuming.
      </span>
    </div>
  )
}

/** One agent-side chat bubble. */
function SecretBubble({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="cc-land my-1 flex justify-start" data-testid="chat-secret-request">
      <section
        aria-label={label}
        className="w-full space-y-2.5 rounded-lg border border-status-human/30 bg-surface-2 px-4 py-3"
        style={{ maxWidth: 'min(100%, 64ch)' }}
      >
        {children}
      </section>
    </div>
  )
}

export function ChatSecretRequests({ objectiveId, workspace, items, canFill }: {
  objectiveId: number
  workspace: string
  items: NeedsSecretItem[]
  canFill: boolean
}) {
  // Requests answered in this view stay as a "saved" bubble after the card's
  // needs_secret list drops them, so the chat shows what happened.
  const [saved, setSaved] = useState<Array<{ name: string; scope: SecretRequestScope }>>([])
  const savedNames = new Set(saved.map(s => s.name))
  const open = items.filter(i => !savedNames.has(i.name))
  if (open.length === 0 && saved.length === 0) return null

  return (
    <>
      {saved.map(s => (
        <SecretBubble key={`saved-${s.name}`} label={`Secret ${s.name} saved`}>
          <SavedLine name={s.name} scope={s.scope} workspace={workspace} />
        </SecretBubble>
      ))}
      {open.map(item => (
        <SecretBubble key={item.name} label={`The agent is asking for ${item.name}`}>
          <div className="flex items-start gap-2">
            <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-status-human" aria-hidden />
            <div className="min-w-0 text-[14px] leading-relaxed text-fg-1">
              The agent needs <span className="font-mono font-semibold text-fg-0">{item.name}</span>
              {item.reason ? <> — {item.reason}</> : null}
            </div>
          </div>
          {canFill ? (
            <SecretForm
              objectiveId={objectiveId}
              workspace={workspace}
              name={item.name}
              initialScope={item.scope ?? 'workspace'}
              mode="fill"
              idPrefix={`chat-secret-${objectiveId}-${item.name}`}
              onSaved={(name, scope) => setSaved(prev => [...prev.filter(p => p.name !== name), { name, scope }])}
            />
          ) : (
            <p className="text-[12.5px] text-fg-2">Waiting for the card owner or an admin to add it, signed in to the web app.</p>
          )}
        </SecretBubble>
      ))}
    </>
  )
}
