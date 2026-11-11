/**
 * obj 719065 — the two inputs every in-chat secret form shares: a scope picker
 * (Organization = the card's workspace, Command Center, Organization + me) and
 * a masked value field. Labels come from the Settings → Secrets vocabulary so
 * the chat and the settings page say the same thing.
 */
import type { SecretRequestScope } from '@operationkit/shared'
import { SECRET_REQUEST_SCOPES } from '@operationkit/shared'
import { SCOPE_HINTS, SCOPE_LABELS } from '../secrets/scope'

const SHORT_LABEL: Record<SecretRequestScope, string> = {
  workspace: SCOPE_LABELS.workspace,
  global: SCOPE_LABELS.global,
  workspace_user: 'Org + me',
}

export function SecretScopePicker({ id, value, onChange, workspace, disabled }: {
  id: string
  value: SecretRequestScope
  onChange: (v: SecretRequestScope) => void
  workspace: string
  disabled?: boolean
}) {
  return (
    <fieldset className="space-y-1.5" disabled={disabled}>
      <legend className="mb-1 text-[11px] font-medium uppercase tracking-wider text-fg-2">Save to</legend>
      <div role="radiogroup" aria-describedby={`${id}-hint`} className="grid grid-cols-3 gap-1 rounded-md border border-line bg-surface-1 p-1">
        {SECRET_REQUEST_SCOPES.map(s => {
          const on = s === value
          return (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onChange(s)}
              className={`min-h-[44px] rounded px-2 text-[12.5px] font-medium transition-[background-color,color,box-shadow] duration-base focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-[32px] ${
                on ? 'bg-surface-3 text-fg-0 shadow-sm ring-1 ring-line-strong' : 'text-fg-2 hover:bg-surface-2 hover:text-fg-0'
              }`}
            >
              {SHORT_LABEL[s]}
            </button>
          )
        })}
      </div>
      <p id={`${id}-hint`} className="text-[11.5px] leading-snug text-fg-2">
        {value === 'workspace' ? (
          <>Only the <span className="font-medium text-fg-1">{workspace}</span> organization. {SCOPE_HINTS.workspace}</>
        ) : value === 'workspace_user' ? (
          <>Only you, only inside <span className="font-medium text-fg-1">{workspace}</span>.</>
        ) : (
          SCOPE_HINTS.global
        )}
      </p>
    </fieldset>
  )
}

export function MaskedSecretInput({ id, value, onChange, autoFocus, disabled }: {
  id: string
  value: string
  onChange: (v: string) => void
  autoFocus?: boolean
  disabled?: boolean
}) {
  return (
    <input
      id={id}
      type="password"
      autoComplete="off"
      spellCheck={false}
      autoFocus={autoFocus}
      disabled={disabled}
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder="Paste the value"
      className="min-h-[44px] w-full rounded-md border border-line bg-surface-1 px-3 py-2 font-mono text-base text-fg-0 placeholder:text-fg-3 transition-colors duration-base hover:border-line-strong focus:border-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50 sm:min-h-[36px] sm:text-[13px]"
    />
  )
}

/** One line of reassurance under every secret form. */
export function SecretPrivacyNote() {
  return (
    <p className="text-[11.5px] leading-snug text-fg-2">
      Goes straight to the encrypted secrets store. It never enters this chat, the transcript, logs or the model — the session is only told the name.
    </p>
  )
}
