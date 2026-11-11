/**
 * Device sign-in for a Codex / Grok seat. Starts the CLI's own device login on
 * the server, shows the approval page + user code, and polls every 3s until the
 * seat is signed in, scoped to that seat.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError } from '../../lib/api'
import { Alert, Button, Spinner } from '../../components/ui'

export const LOGIN_POLL_MS = 3000

interface StartResponse { ok: boolean; flow?: 'device'; url?: string; userCode?: string; error?: string }
interface StatusResponse<S> { ok: boolean; success?: boolean; pending?: boolean; url?: string; userCode?: string; error?: string; seat?: S }

function errText(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return (err.body as { error?: string } | null)?.error || err.message || fallback
  return err instanceof Error ? err.message : fallback
}

export function SeatDeviceLogin<S>({
  seatId,
  engine,
  onSuccess,
  onCancel,
}: {
  seatId: string
  engine: string
  onSuccess: (seat: S | undefined) => void
  onCancel: () => void
}) {
  const [phase, setPhase] = useState<'starting' | 'waiting' | 'error'>('starting')
  const [url, setUrl] = useState<string | null>(null)
  const [userCode, setUserCode] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const alive = useRef(true)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const generation = useRef(0)
  const id = encodeURIComponent(seatId)
  // Held in a ref so a parent re-render never restarts the sign-in.
  const onSuccessRef = useRef(onSuccess)
  onSuccessRef.current = onSuccess

  const stopPolling = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }

  const poll = useCallback(() => {
    timer.current = setTimeout(async () => {
      if (!alive.current) return
      try {
        const s = await api.post<StatusResponse<S>>(`/admin/seats/${id}/login/status`)
        if (!alive.current) return
        if (s.success) {
          onSuccessRef.current(s.seat)
          return
        }
        if (s.url) setUrl(s.url)
        if (s.userCode) setUserCode(s.userCode)
      } catch {
        /* transient; try again on the next tick */
      }
      if (alive.current) poll()
    }, LOGIN_POLL_MS)
  }, [id])

  const start = useCallback(async () => {
    stopPolling()
    const mine = ++generation.current
    setPhase('starting')
    setError('')
    try {
      const r = await api.post<StartResponse>(`/admin/seats/${id}/login/start`, undefined, { timeoutMs: 60_000 })
      if (!alive.current || mine !== generation.current) return
      if (r.ok && r.url) {
        setUrl(r.url)
        setUserCode(r.userCode ?? null)
        setPhase('waiting')
        poll()
      } else {
        setError(r.error || `Could not start the ${engine} sign-in.`)
        setPhase('error')
      }
    } catch (err) {
      if (!alive.current || mine !== generation.current) return
      setError(errText(err, `Could not start the ${engine} sign-in.`))
      setPhase('error')
    }
  }, [id, engine, poll])

  useEffect(() => {
    alive.current = true
    void start()
    return () => {
      alive.current = false
      stopPolling()
    }
  }, [start])

  const copyCode = async () => {
    if (!userCode) return
    try {
      await navigator.clipboard.writeText(userCode)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable; the code is on screen */
    }
  }

  const cancel = () => {
    alive.current = false
    stopPolling()
    onCancel()
  }

  return (
    <div className="space-y-3 rounded-md border border-line bg-surface-1 p-4" aria-live="polite">
      <p className="text-[13px] font-medium text-fg-0">Sign in to {engine}</p>

      {phase === 'starting' && (
        <div className="flex items-center gap-2 text-[13px] text-fg-2">
          <Spinner /> Starting the sign-in…
        </div>
      )}

      {phase === 'error' && (
        <div className="space-y-3">
          <Alert tone="alarm" title="Sign-in did not start">{error}</Alert>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => void start()}>Try again</Button>
            <Button variant="ghost" onClick={cancel}>Cancel</Button>
          </div>
        </div>
      )}

      {phase === 'waiting' && (
        <div className="space-y-3">
          <ol className="space-y-3 text-[13px] text-fg-2">
            <li>
              <span className="text-fg-1">1. Open this page and sign in with the subscription account:</span>
              {url && (
                <a
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1.5 flex min-h-[44px] items-center break-all rounded-md border border-line bg-surface-2 px-3 font-mono text-[12.5px] text-accent-hover underline-offset-2 transition-colors duration-fast ease-out hover:border-line-strong hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
                >
                  {url}
                </a>
              )}
            </li>
            {userCode && (
              <li>
                <span className="text-fg-1">2. Enter this code when asked:</span>
                <div className="mt-1.5 flex flex-wrap items-center gap-2">
                  <span
                    data-testid="seat-user-code"
                    className="select-all rounded-md border border-line bg-surface-3 px-4 py-2 font-mono text-2xl font-semibold tracking-[0.2em] text-fg-0"
                  >
                    {userCode}
                  </span>
                  <Button variant="secondary" onClick={() => void copyCode()}>{copied ? 'Copied' : 'Copy code'}</Button>
                </div>
              </li>
            )}
          </ol>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="flex items-center gap-2 text-[13px] text-fg-2">
              <Spinner /> Waiting for approval…
            </span>
            <Button variant="ghost" onClick={cancel}>Cancel</Button>
          </div>
        </div>
      )}
    </div>
  )
}
