import { useEffect, useState, type FormEvent } from 'react'
import { useAuth } from '../context/AuthContext'
import { useBranding } from '../hooks/useBranding'
import { BrandMark } from './BrandMark'
import { EmailLinkRedeem, EmailLinkRequest, readLinkToken } from './login/EmailSignInLink'

export function LoginPage() {
  const { login } = useAuth()
  const branding = useBranding()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  // obj 900497: "Email me a sign-in link" — only when this site has its own email set up.
  const [linkToken] = useState(readLinkToken)
  const [emailLinkAvailable, setEmailLinkAvailable] = useState(false)
  const [mode, setMode] = useState<'password' | 'email'>('password')
  useEffect(() => {
    let alive = true
    fetch('/api/auth/email-link', { credentials: 'include' })
      .then(r => (r.ok ? r.json() : { available: false }))
      .then((b: { available?: boolean }) => { if (alive) setEmailLinkAvailable(!!b.available) })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      await login(username, password)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-surface px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <BrandMark branding={branding} />
          <p className="mt-3 text-[15px] text-fg-1">Sign in to continue</p>
        </div>

        {linkToken ? (
          <EmailLinkRedeem token={linkToken} brandName={branding.name} />
        ) : mode === 'email' ? (
          <EmailLinkRequest onBack={() => setMode('password')} />
        ) : (
        <>
                <form onSubmit={handleSubmit} className="space-y-4 rounded-xl border border-line bg-surface-1 p-6">
          {error && (
            <div className="rounded-md border border-signal-alarm px-3 py-2 text-sm text-signal-alarm">
              {error}
            </div>
          )}

          <div>
            <label htmlFor="username" className="mb-1.5 block text-[13px] font-medium text-fg-1">
              Username
            </label>
            <input
              id="username"
              autoComplete="username"
              type="text"
              value={username}
              onChange={e => setUsername(e.target.value)}
              className="w-full rounded-md border border-line bg-surface-1 min-h-[44px] px-3 py-2 text-[15px] text-fg-0 placeholder:text-fg-3 outline-none transition focus:border-accent focus-visible:ring-2 focus-visible:ring-accent"
              placeholder="username"
              autoFocus
              required
            />
          </div>

          <div>
            <label htmlFor="password" className="mb-1.5 block text-[13px] font-medium text-fg-1">
              Password
            </label>
            <input
              id="password"
              autoComplete="current-password"
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="w-full rounded-md border border-line bg-surface-1 min-h-[44px] px-3 py-2 text-[15px] text-fg-0 placeholder:text-fg-3 outline-none transition focus:border-accent focus-visible:ring-2 focus-visible:ring-accent"
              placeholder="password"
              required
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="min-h-[44px] w-full rounded-md bg-accent py-2 text-[15px] font-semibold text-accent-fg transition duration-150 hover:bg-accent-hover active:bg-accent-press focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface-1 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        {emailLinkAvailable && (
          <button
            type="button"
            onClick={() => setMode('email')}
            className="mt-4 w-full text-center text-sm text-fg-2 underline-offset-4 hover:text-fg-0 hover:underline"
          >
            Email me a sign-in link instead
          </button>
        )}
        </>
        )}
        {branding.powered_by && (
          <p className="mt-6 text-center text-[12px] text-fg-3">Powered by {branding.default_name}</p>
        )}
      </div>
    </div>
  )
}
