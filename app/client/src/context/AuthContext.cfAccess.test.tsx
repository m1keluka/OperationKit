// @vitest-environment jsdom
/**
 * obj 900108 — the browser half. A session that still says "choose a new
 * password" is traded for a Cloudflare Access session where one is available,
 * so a person Access verified never sees the change-password page. Everywhere
 * else the session is left exactly as it was.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { AuthProvider, useAuth } from './AuthContext'

const { apiMock } = vi.hoisted(() => ({ apiMock: { get: vi.fn(), post: vi.fn() } }))
vi.mock('../lib/api', () => ({
  api: apiMock,
  ApiError: class ApiError extends Error {
    constructor(public status: number, public body: unknown, message: string) { super(message) }
  },
}))

async function flush() {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve()
    await new Promise(r => setTimeout(r, 0))
    flushSync(() => {})
    await Promise.resolve()
  }
}

let seen: ReturnType<typeof useAuth> | null = null
function Probe() {
  seen = useAuth()
  return null
}

async function mount(): Promise<Root> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  flushSync(() => root.render(<AuthProvider><Probe /></AuthProvider>))
  await flush()
  return root
}

beforeEach(() => {
  seen = null
  apiMock.get.mockReset()
  apiMock.post.mockReset()
})

describe('a session that is being held on the change-password page', () => {
  it('is traded for the Cloudflare Access session when Access can sign the person in', async () => {
    apiMock.get.mockResolvedValue({ id: 7, username: 'chris', role: 'admin', must_change_password: true })
    apiMock.post.mockResolvedValue({ user: { id: 7, username: 'chris', role: 'admin' } })
    await mount()
    expect(apiMock.post).toHaveBeenCalledWith('/auth/cloudflare-access')
    expect(seen!.user?.must_change_password).toBeUndefined()
    expect(seen!.accessDenied).toBeNull()
  })

  it('keeps the forced-change session when Access is off or cannot verify', async () => {
    const me = { id: 7, username: 'chris', role: 'admin', must_change_password: true }
    apiMock.get.mockResolvedValue(me)
    apiMock.post.mockRejectedValue(new Error('404 cf_access_off'))
    await mount()
    expect(seen!.user?.must_change_password).toBe(true)
    // Already signed in, so a failed trade must not take over the screen with
    // the "no account for this email" page.
    expect(seen!.accessDenied).toBeNull()
  })
})

describe('an ordinary session is untouched', () => {
  it('never calls the Access endpoint when no password change is being forced', async () => {
    apiMock.get.mockResolvedValue({ id: 7, username: 'chris', role: 'admin' })
    await mount()
    expect(apiMock.post).not.toHaveBeenCalled()
    expect(seen!.user?.username).toBe('chris')
  })

  it('still signs in through Access when there is no session at all', async () => {
    apiMock.get.mockRejectedValue(new Error('401'))
    apiMock.post.mockResolvedValue({ user: { id: 9, username: 'owner', role: 'admin' } })
    await mount()
    expect(apiMock.post).toHaveBeenCalledWith('/auth/cloudflare-access')
    expect(seen!.user?.username).toBe('owner')
  })
})
