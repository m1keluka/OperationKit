import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react'
import type { User } from '@operationkit/shared'
import { api, ApiError } from '../lib/api'

/**
 * Cloudflare Access let this person in, but no Operation Kit user has their
 * email (obj 720332). Shown instead of the password form; never auto-creates.
 */
export interface AccessDenied {
  email: string
  code: 'no_account' | 'ambiguous_account'
  logoutUrl: string
}

interface AuthContextType {
  user: User | null
  loading: boolean
  /** Set when a verified Cloudflare Access email matched no single user. */
  accessDenied: AccessDenied | null
  /** Drop the access-denied page and show the password form (break-glass). */
  showPasswordLogin: () => void
  login: (username: string, password: string) => Promise<void>
  logout: () => Promise<void>
  /** Replace the password; clears a forced one-time-password state (obj 719935). */
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>
}

const AuthContext = createContext<AuthContextType | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [accessDenied, setAccessDenied] = useState<AccessDenied | null>(null)

  useEffect(() => {
    // No app session yet: behind Cloudflare Access the server can sign us in
    // from Cloudflare's verified identity (one login). Anything else — feature
    // off, no header, token rejected — falls through to the password page.
    async function signInViaCloudflare(): Promise<User | null> {
      try {
        const { user } = await api.post<{ user: User }>('/auth/cloudflare-access')
        return user
      } catch (err) {
        const body = err instanceof ApiError ? (err.body as { code?: string; email?: string; logout_url?: string } | null) : null
        if (body && (body.code === 'no_account' || body.code === 'ambiguous_account') && body.email) {
          setAccessDenied({ email: body.email, code: body.code, logoutUrl: body.logout_url || '/cdn-cgi/access/logout' })
        }
        return null
      }
    }
    api.get<User>('/auth/me')
      .catch(() => signInViaCloudflare())
      .then(data => setUser(data))
      .catch(() => setUser(null))
      .finally(() => setLoading(false))
  }, [])

  const login = useCallback(async (username: string, password: string) => {
    const { user } = await api.post<{ user: User }>('/auth/login', { username, password })
    setAccessDenied(null)
    setUser(user)
  }, [])

  const logout = useCallback(async () => {
    const res = await api.post<{ ok: boolean; access_logout_url?: string }>('/auth/logout')
    // Behind Cloudflare Access, also end the Access session — otherwise the next
    // page load would sign straight back in.
    if (res?.access_logout_url) {
      window.location.assign(res.access_logout_url)
      return
    }
    setUser(null)
  }, [])

  const showPasswordLogin = useCallback(() => setAccessDenied(null), [])

  const changePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    const { user } = await api.post<{ user: User }>('/auth/change-password', {
      current_password: currentPassword,
      new_password: newPassword,
    })
    setUser(user)
  }, [])

  return (
    <AuthContext.Provider value={{ user, loading, accessDenied, showPasswordLogin, login, logout, changePassword }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
