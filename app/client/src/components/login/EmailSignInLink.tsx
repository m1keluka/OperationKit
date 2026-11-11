/**
 * Email sign-in link UI for the login page (obj 900497).
 *
 * Request: enter your email → the server emails a one-time link (same answer
 * whether or not the address has an account). Redeem: the link opens
 * /login?link=…; the person clicks "Sign in" and we POST the token. Requiring
 * the click means an inbox link-scanner that pre-fetches URLs cannot use or
 * burn the link.
 */
import { useState, type FormEvent } from 'react'

const inputCls =
  'w-full rounded border border-line bg-surface-1 min-h-[44px] px-3 py-2 text-fg-0 placeholder-fg-3 outline-none transition focus:border-accent focus-visible:ring-2 focus-visible:ring-accent/40'
const primaryBtn =
  'min-h-[44px] w-full rounded bg-accent py-2 text-sm font-medium text-accent-fg transition duration-150 hover:bg-accent-hover active:bg-accent-press focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:cursor-not-allowed disabled:opacity-50'

/** Token from ?link=… (read once; removed from the address bar). */
export function readLinkToken(): string | null {
  if (typeof window === 'undefined') return null
  const url = new URL(window.location.href)
  const token = url.searchParams.get('link')
  if (!token) return null
  url.searchParams.delete('link')
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
  return token
}

export function EmailLinkRequest({ onBack }: { onBack: () => void }) {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const r = await fetch('/api/auth/email-link', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      })
      if (!r.ok) {
        const b = await r.json().catch(() => ({}))
        throw new Error((b as { error?: string }).error || 'Could not send the link')
      }
      setSent(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the link')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-4 rounded-lg border border-border bg-surface-raised p-6">
      {sent ? (
        <div role="status" className="space-y-2 text-sm text-fg-1">
          <p className="font-medium text-fg-0">Check your email</p>
          <p className="text-fg-2">If <span className="font-mono text-fg-1">{email.trim()}</span> has an account here, a sign-in link is on its way. It works once and expires in 15 minutes.</p>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          {error && <div className="rounded bg-signal-alarm/10 px-3 py-2 text-sm text-signal-alarm">{error}</div>}
          <div>
            <label htmlFor="link-email" className="mb-1 block text-sm text-fg-1">Email</label>
            <input id="link-email" type="email" required autoFocus value={email} onChange={e => setEmail(e.target.value)}
              className={inputCls} placeholder="you@company.com" />
          </div>
          <button type="submit" disabled={loading} className={primaryBtn}>{loading ? 'Sending…' : 'Email me a sign-in link'}</button>
        </form>
      )}
      <button type="button" onClick={onBack} className="w-full text-center text-sm text-fg-2 underline-offset-4 hover:text-fg-0 hover:underline">
        Sign in with a password instead
      </button>
    </div>
  )
}

export function EmailLinkRedeem({ token, brandName }: { token: string; brandName: string }) {
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function redeem() {
    setError('')
    setLoading(true)
    try {
      const r = await fetch('/api/auth/email-link/redeem', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      if (!r.ok) {
        const b = await r.json().catch(() => ({}))
        throw new Error((b as { error?: string }).error || 'This sign-in link did not work')
      }
      window.location.replace('/')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'This sign-in link did not work')
      setLoading(false)
    }
  }

  return (
    <div className="space-y-4 rounded-lg border border-border bg-surface-raised p-6">
      {error ? (
        <>
          <div className="rounded bg-signal-alarm/10 px-3 py-2 text-sm text-signal-alarm">{error}</div>
          <a href="/login" className="block text-center text-sm text-fg-2 underline-offset-4 hover:text-fg-0 hover:underline">Back to sign in</a>
        </>
      ) : (
        <>
          <p className="text-sm text-fg-1">You opened a sign-in link for {brandName}.</p>
          <button type="button" onClick={redeem} disabled={loading} className={primaryBtn}>{loading ? 'Signing in…' : 'Sign in'}</button>
        </>
      )}
    </div>
  )
}
