/**
 * Google Workspace card — extracted from AccountSettings.tsx (behavior frozen).
 *
 * Connect / disconnect THIS user's own Google account. Everything here is
 * derived from `UserGoogleConnectionSummary`, which is the only shape the
 * server returns: identity, granted scopes, timestamps, last refresh error.
 * There is deliberately NO token material in that contract and none is
 * rendered here — not even masked.
 *
 * Contract:
 *   GET    /api/user/google         → { connection, configured }
 *   POST   /api/user/google/connect → { auth_url }  (503 when not configured)
 *   DELETE /api/user/google         → { removed, revoked }
 * The consent round-trip lands back on /settings/you?google=connected
 * (or ?google=error&google_error=…), which we surface once and then strip.
 */
import { useEffect, useState } from 'react'
import { api, ApiError } from '../../lib/api'
import { useConfirm } from '../ui'
import type {
  UserGoogleConnectionSummary,
  GoogleConnectStartResponse,
} from '@command-center/shared'
import { fmtDate } from './helpers'

interface GoogleStatusResponse {
  connection: UserGoogleConnectionSummary | null
  configured: boolean
}

/** The six user-facing Workspace surfaces, matched off the granted scope list. */
const GOOGLE_SURFACES: { label: string; match: (scope: string) => boolean }[] = [
  { label: 'Gmail', match: s => s.includes('/auth/gmail') },
  { label: 'Drive', match: s => s.includes('/auth/drive') },
  { label: 'Docs', match: s => s.includes('/auth/documents') },
  { label: 'Sheets', match: s => s.includes('/auth/spreadsheets') },
  { label: 'Slides', match: s => s.includes('/auth/presentations') },
  { label: 'Calendar', match: s => s.includes('/auth/calendar') },
]

/** Split the space-separated grant into a count + per-surface granted flags. */
export function summarizeGoogleScopes(scopes: string): {
  count: number
  surfaces: { label: string; granted: boolean }[]
} {
  const list = (scopes || '').split(/\s+/).filter(Boolean)
  return {
    count: list.length,
    surfaces: GOOGLE_SURFACES.map(s => ({
      label: s.label,
      granted: list.some(scope => s.match(scope)),
    })),
  }
}

/** Human-readable copy for the `google_error` detail Google/our callback passes back. */
function googleErrorCopy(detail: string): string {
  switch (detail) {
    case 'missing_code': return 'Google did not return an authorization code. Please try again.'
    case 'invalid_state': return 'The sign-in request expired or could not be verified. Please try again.'
    case 'not_configured': return 'Google OAuth is not configured on this server.'
    case 'access_denied': return 'You declined the permission request at Google.'
    case '': return 'Connecting your Google account failed. Please try again.'
    default: return `Connecting your Google account failed: ${detail}`
  }
}

export function GoogleWorkspaceSection() {
  const [connection, setConnection] = useState<UserGoogleConnectionSummary | null>(null)
  const [configured, setConfigured] = useState(true)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  // Outcome of the OAuth round-trip, read once from the query string. Kept in
  // its own state so the mount-time reload() (which owns `error`/`notice`)
  // cannot race it away.
  const [callbackError, setCallbackError] = useState('')
  const [callbackNotice, setCallbackNotice] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)
  const { confirm, confirmDialog } = useConfirm()

  async function reload() {
    setLoading(true)
    try {
      const data = await api.get<GoogleStatusResponse>('/user/google')
      setConnection(data?.connection ?? null)
      setConfigured(data?.configured !== false)
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load Google connection')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void reload() }, [])

  // Surface the callback's outcome exactly once, then strip the params so a
  // refresh (or a later navigation) doesn't replay a stale success/failure.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    const status = params.get('google')
    if (!status) return
    if (status === 'connected') {
      setCallbackNotice('Google Workspace connected.')
    } else {
      setCallbackError(googleErrorCopy(params.get('google_error') || ''))
    }
    params.delete('google')
    params.delete('google_error')
    const qs = params.toString()
    window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : ''))
  }, [])

  /** Any fresh user action supersedes the one-shot OAuth callback banner. */
  function clearBanners() {
    setError('')
    setNotice('')
    setCallbackError('')
    setCallbackNotice('')
  }

  async function handleConnect() {
    setConnecting(true)
    clearBanners()
    try {
      const data = await api.post<GoogleConnectStartResponse>('/user/google/connect', {})
      if (!data?.auth_url) throw new Error('Server did not return a consent URL.')
      // Hand the browser to Google. Leave `connecting` true — the pending state
      // should persist for the whole (visible) navigation, not flicker back.
      window.location.href = data.auth_url
    } catch (err) {
      const msg = err instanceof ApiError
        ? (err.body as { error?: string })?.error || err.message
        : err instanceof Error ? err.message : 'Could not start Google sign-in'
      if (err instanceof ApiError && err.status === 503) setConfigured(false)
      setError(msg)
      setConnecting(false)
    }
  }

  async function handleDisconnect() {
    const ok = await confirm({
      title: 'Disconnect Google Workspace?',
      message: 'Your stored credential will be revoked at Google and removed from Command Center. Agents will immediately lose access to your Gmail, Drive, Docs, Sheets, Slides, and Calendar. You can reconnect at any time.',
      confirmLabel: 'Disconnect',
      danger: true,
    })
    if (!ok) return
    setDisconnecting(true)
    clearBanners()
    try {
      await api.del<{ removed: boolean; revoked: boolean }>('/user/google')
      setNotice('Google Workspace disconnected.')
      await reload()
    } catch (err) {
      const msg = err instanceof ApiError
        ? (err.body as { error?: string })?.error || err.message
        : err instanceof Error ? err.message : 'Disconnect failed'
      setError(msg)
    } finally {
      setDisconnecting(false)
    }
  }

  const connected = connection !== null
  const scopeInfo = connection ? summarizeGoogleScopes(connection.scopes) : null

  return (
    <section className="mt-5 rounded-lg border border-border bg-surface-raised p-5">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-fg-0">Google Workspace</h2>
          <p className="mt-1 text-xs text-fg-3">
            Connect your own Google account so agents act as YOU in Gmail, Drive, Docs, Sheets,
            Slides, and Calendar. Cards assigned to you send as this account — never as a teammate.
            Credentials are stored encrypted and are never shown back to you.
          </p>
        </div>
        <span
          className={
            'shrink-0 rounded-sm px-1.5 py-0.5 text-[10px] uppercase tracking-wider transition-colors duration-fast ease-out ' +
            (connected
              ? 'bg-status-review/20 text-status-review'
              : 'bg-fg-3/20 text-fg-3')
          }
        >
          {connected ? 'connected' : 'not connected'}
        </span>
      </div>

      {(callbackError || error) && (
        <div className="mb-3 rounded bg-signal-alarm/10 px-3 py-2 text-sm text-signal-alarm">
          {callbackError || error}
        </div>
      )}
      {(callbackNotice || notice) && (
        <div className="mb-3 rounded bg-accent/10 px-3 py-2 text-sm text-accent">
          {callbackNotice || notice}
        </div>
      )}
      {!loading && !configured && (
        <div className="mb-3 rounded border border-border bg-surface px-3 py-2 text-xs text-fg-2">
          Google OAuth is not configured on this server. An administrator needs to set the Google
          OAuth client ID, secret, and redirect URI before accounts can be connected.
        </div>
      )}

      {loading ? (
        <div className="text-sm text-fg-3">Loading…</div>
      ) : connected ? (
        <div className="space-y-4">
          {connection!.last_error && (
            <div className="rounded border border-signal-alarm/40 bg-signal-alarm/10 px-3 py-2 text-sm text-signal-alarm">
              <span className="font-medium">Google refresh failed.</span>{' '}
              {connection!.last_error}{' '}
              <span className="text-fg-2">Reconnect to restore access.</span>
            </div>
          )}

          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
            <div>
              <dt className="text-[11px] uppercase tracking-wider text-fg-3">Google account</dt>
              <dd className="text-sm text-fg-0 break-all">{connection!.google_email}</dd>
            </div>
            <div>
              <dt className="text-[11px] uppercase tracking-wider text-fg-3">Granted access</dt>
              <dd className="text-sm text-fg-1">
                {scopeInfo!.count} {scopeInfo!.count === 1 ? 'scope' : 'scopes'}
              </dd>
            </div>
            <div>
              <dt className="text-[11px] uppercase tracking-wider text-fg-3">Connected</dt>
              <dd className="text-sm text-fg-1">{fmtDate(connection!.connected_at)}</dd>
            </div>
            <div>
              <dt className="text-[11px] uppercase tracking-wider text-fg-3">Last refreshed</dt>
              <dd className="text-sm text-fg-1">{fmtDate(connection!.last_refreshed_at)}</dd>
            </div>
          </dl>

          <div className="flex flex-wrap gap-1.5">
            {scopeInfo!.surfaces.map(s => (
              <span
                key={s.label}
                title={s.granted ? `${s.label} access granted` : `${s.label} access not granted`}
                className={
                  'rounded-sm px-1.5 py-0.5 text-[11px] transition-colors duration-fast ease-out ' +
                  (s.granted
                    ? 'bg-status-review/15 text-status-review'
                    : 'bg-fg-3/10 text-fg-3 line-through')
                }
              >
                {s.label}
              </span>
            ))}
          </div>

          <div className="flex flex-wrap gap-2 pt-1">
            <button
              onClick={handleConnect}
              disabled={connecting || disconnecting || !configured}
              className="rounded-md border border-border px-3 py-1.5 text-sm text-fg-1 transition-colors duration-fast ease-out hover:bg-surface-2 hover:text-fg-0 disabled:opacity-50"
            >
              {connecting ? 'Redirecting to Google…' : 'Reconnect'}
            </button>
            <button
              onClick={handleDisconnect}
              disabled={disconnecting || connecting}
              className="rounded-md border border-signal-alarm/40 px-3 py-1.5 text-sm text-signal-alarm transition-colors duration-fast ease-out hover:bg-signal-alarm/10 disabled:opacity-50"
            >
              {disconnecting ? 'Disconnecting…' : 'Disconnect'}
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-[11px] text-fg-3">
            You'll be sent to Google to approve access. Nothing is stored until you approve, and you
            can disconnect here at any time.
          </p>
          <button
            onClick={handleConnect}
            disabled={connecting || !configured}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-fg-0 transition-colors duration-fast ease-out hover:bg-accent-hover disabled:opacity-50"
          >
            {connecting ? 'Redirecting to Google…' : 'Connect Google Workspace'}
          </button>
        </div>
      )}
      {confirmDialog}
    </section>
  )
}
