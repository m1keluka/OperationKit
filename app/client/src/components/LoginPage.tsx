import { useState, type FormEvent } from 'react'
import { useAuth } from '../context/AuthContext'
import { useBranding } from '../hooks/useBranding'
import { BrandMark } from './BrandMark'

export function LoginPage() {
  const { login } = useAuth()
  const branding = useBranding()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

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
          <p className="mt-2 text-sm text-fg-2">AI Session Management</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 rounded-lg border border-border bg-surface-raised p-6">
          {error && (
            <div className="rounded bg-signal-alarm/10 px-3 py-2 text-sm text-signal-alarm">
              {error}
            </div>
          )}

          <div>
            <label htmlFor="username" className="mb-1 block text-sm text-fg-1">
              Username
            </label>
            <input
              id="username"
              type="text"
              value={username}
              onChange={e => setUsername(e.target.value)}
              className="w-full rounded border border-border bg-surface min-h-[44px] px-3 py-2 text-fg-0 placeholder-fg-3 outline-none transition focus:border-accent focus-visible:ring-2 focus-visible:ring-accent/40"
              placeholder="username"
              autoFocus
              required
            />
          </div>

          <div>
            <label htmlFor="password" className="mb-1 block text-sm text-fg-1">
              Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="w-full rounded border border-border bg-surface min-h-[44px] px-3 py-2 text-fg-0 placeholder-fg-3 outline-none transition focus:border-accent focus-visible:ring-2 focus-visible:ring-accent/40"
              placeholder="password"
              required
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="min-h-[44px] w-full rounded bg-accent py-2 text-sm font-medium text-accent-fg transition duration-150 hover:bg-accent-hover hover:shadow-md active:bg-accent-press focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  )
}
