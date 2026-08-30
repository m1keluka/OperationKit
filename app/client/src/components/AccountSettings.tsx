/**
 * Settings → Account (obj-2200 / W1).
 *
 * Per-user surface — renders for EVERY authenticated user (not admin-gated).
 * Cards: "GitHub Account" (link a personal PAT so PRs are attributed to you),
 * "Google Workspace" (obj-706070 — connect your own Google account via OAuth),
 * "Your Assistant", and "My Secrets".
 *
 * Security posture mirrored from the server:
 *   - The raw PAT is sent once over TLS on Link and is NEVER echoed back. The
 *     paste field is cleared the moment the link succeeds.
 *   - The server only ever returns the masked summary (resolved login/email +
 *     last-4), which is all this UI displays.
 *   - The Google contract returns NO token material at all (no access token,
 *     refresh token, or client secret) and this UI renders none.
 */
import { useEffect, useState } from 'react'
import { api, ApiError } from '../lib/api'
import { useConfirm } from './ui'
import type { UserGithubTokenSummary } from '@operationkit/shared'
import { ApiKeySection } from './account-settings/ApiKeySection'
import { GithubSection } from './account-settings/GithubSection'
import { GoogleWorkspaceSection } from './account-settings/GoogleWorkspaceSection'
import { YourAssistantSection } from './account-settings/YourAssistantSection'
import { MySecretsSection } from './account-settings/MySecretsSection'

export { summarizeGoogleScopes } from './account-settings/GoogleWorkspaceSection'

export function AccountSettings({ embedded = false }: { embedded?: boolean }) {
  const [summary, setSummary] = useState<UserGithubTokenSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  // Paste flow
  const [tokenInput, setTokenInput] = useState('')
  const [linking, setLinking] = useState(false)
  const [validating, setValidating] = useState(false)
  const { confirm, confirmDialog } = useConfirm()

  async function reload() {
    setLoading(true)
    setError('')
    try {
      const data = await api.get<UserGithubTokenSummary | null>('/user/github-token')
      setSummary(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void reload() }, [])

  async function handleLink() {
    const token = tokenInput.trim()
    if (!token) return
    setLinking(true)
    setError('')
    setNotice('')
    try {
      const data = await api.post<UserGithubTokenSummary>('/user/github-token', { token })
      setSummary(data)
      setTokenInput('') // never keep the raw token around after a successful link
      setNotice(`Linked as ${data.github_login}.`)
    } catch (err) {
      const msg = err instanceof ApiError ? (err.body as { error?: string })?.error || err.message
        : err instanceof Error ? err.message : 'Link failed'
      setError(msg)
    } finally {
      setLinking(false)
    }
  }

  async function handleRevalidate() {
    setValidating(true)
    setError('')
    setNotice('')
    try {
      const data = await api.post<UserGithubTokenSummary>('/user/github-token/validate')
      setSummary(data)
      setNotice('Token re-validated.')
    } catch (err) {
      const msg = err instanceof ApiError ? (err.body as { error?: string })?.error || err.message
        : err instanceof Error ? err.message : 'Re-validation failed'
      setError(msg)
    } finally {
      setValidating(false)
    }
  }

  async function handleRevoke() {
    const ok = await confirm({
      title: 'Revoke GitHub token?',
      message: 'Command Center will stop using this token to attribute your PRs. This does not revoke the token on GitHub — do that in your GitHub settings too.',
      confirmLabel: 'Revoke',
      danger: true,
    })
    if (!ok) return
    setError('')
    setNotice('')
    try {
      await api.del('/user/github-token')
      setSummary(null)
      setNotice('Token revoked.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Revoke failed')
    }
  }

  const linked = summary !== null

  const body = (
    <>
        {!embedded && (
        <div className="mb-5">
          <h1 className="text-xl font-semibold text-fg-0">Account</h1>
          <p className="mt-1 text-xs text-fg-3">Your personal Command Center settings.</p>
        </div>
        )}

        {error && (
          <div className="mb-4 rounded bg-signal-alarm/10 px-3 py-2 text-sm text-signal-alarm">{error}</div>
        )}
        {notice && (
          <div className="mb-4 rounded bg-accent/10 px-3 py-2 text-sm text-accent">{notice}</div>
        )}

        <ApiKeySection />

        <GithubSection
          loading={loading}
          linked={linked}
          summary={summary}
          tokenInput={tokenInput}
          setTokenInput={setTokenInput}
          linking={linking}
          validating={validating}
          handleLink={handleLink}
          handleRevalidate={handleRevalidate}
          handleRevoke={handleRevoke}
        />

        <GoogleWorkspaceSection />

        <YourAssistantSection />

        <MySecretsSection />
    </>
  )

  if (embedded) {
    return (
      <div className="max-w-3xl">
        {body}
        {confirmDialog}
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-3xl mx-auto">
        {body}
      </div>
      {confirmDialog}
    </div>
  )
}
