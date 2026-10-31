import { useState, type FormEvent } from 'react'
import { useAuth } from '../context/AuthContext'
import { useBranding } from '../hooks/useBranding'
import { BrandMark } from './BrandMark'

// Mirrors MIN_PASSWORD_LENGTH in server/src/routes/auth.ts — the server is the authority.
const MIN_LENGTH = 12

const inputClass =
  'min-h-[44px] w-full rounded border border-border bg-surface px-3 py-2 text-fg-0 placeholder-fg-3 outline-none ' +
  'transition focus:border-accent focus-visible:ring-2 focus-visible:ring-accent/40'

/**
 * Shown instead of the app while the signed-in user still holds a one-time setup
 * password (obj 719935). The server refuses every other route until this is done.
 */
export function ChangePasswordPage() {
  const { user, changePassword, logout } = useAuth()
  const branding = useBranding()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const tooShort = next.length > 0 && next.length < MIN_LENGTH
  const mismatch = confirm.length > 0 && confirm !== next
  const canSubmit = current.length > 0 && next.length >= MIN_LENGTH && confirm === next && !saving

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!canSubmit) return
    setError('')
    setSaving(true)
    try {
      await changePassword(current, next)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the password')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-surface px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <BrandMark branding={branding} />
          <p className="mt-2 text-sm text-fg-2">Choose your own password to finish setting up</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 rounded-lg border border-border bg-surface-raised p-6" noValidate>
          <p className="text-sm text-fg-1">
            Signed in as <span className="font-medium text-fg-0">{user?.username}</span> with a one-time setup password.
            Pick a new one of at least {MIN_LENGTH} characters. You will use it from now on.
          </p>

          {error && (
            <div role="alert" className="rounded bg-signal-alarm/10 px-3 py-2 text-sm text-signal-alarm">{error}</div>
          )}

          <div>
            <label htmlFor="current-password" className="mb-1 block text-sm text-fg-1">Setup password</label>
            <input id="current-password" type="password" autoComplete="current-password" value={current}
              onChange={e => setCurrent(e.target.value)} className={inputClass} autoFocus required />
          </div>

          <div>
            <label htmlFor="new-password" className="mb-1 block text-sm text-fg-1">New password</label>
            <input id="new-password" type="password" autoComplete="new-password" value={next}
              onChange={e => setNext(e.target.value)} className={inputClass} aria-describedby="new-password-hint"
              aria-invalid={tooShort} required />
            <p id="new-password-hint" className={`mt-1 text-xs ${tooShort ? 'text-signal-amber' : 'text-fg-2'}`}>
              {tooShort ? `${MIN_LENGTH - next.length} more character${MIN_LENGTH - next.length === 1 ? '' : 's'} needed` : `At least ${MIN_LENGTH} characters`}
            </p>
          </div>

          <div>
            <label htmlFor="confirm-password" className="mb-1 block text-sm text-fg-1">Type it again</label>
            <input id="confirm-password" type="password" autoComplete="new-password" value={confirm}
              onChange={e => setConfirm(e.target.value)} className={inputClass} aria-describedby="confirm-hint"
              aria-invalid={mismatch} required />
            {mismatch && <p id="confirm-hint" className="mt-1 text-xs text-signal-amber">The two passwords do not match yet</p>}
          </div>

          <button
            type="submit"
            disabled={!canSubmit}
            className="min-h-[44px] w-full rounded bg-accent py-2 text-sm font-medium text-accent-fg transition duration-150 hover:bg-accent-hover hover:shadow-md active:bg-accent-press focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save new password'}
          </button>
          <button
            type="button"
            onClick={() => { void logout() }}
            className="min-h-[44px] w-full rounded border border-border py-2 text-sm text-fg-1 transition duration-150 hover:border-border-hover hover:text-fg-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            Sign out
          </button>
        </form>
      </div>
    </div>
  )
}
