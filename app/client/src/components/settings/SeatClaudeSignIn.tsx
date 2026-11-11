/**
 * "Sign in with Claude" for a Claude seat (obj 720330) — the browser version of
 * `claude setup-token`. The server starts an OAuth + PKCE login and keeps the
 * verifier; we show the link, the operator signs in on claude.ai, copies the
 * "Authentication code" Claude shows (`code#state`) and pastes it here. The
 * server exchanges it, saves the seat and runs its CLAUDE-OK test turn.
 *
 * Used for a new seat (no seatId) and to reconnect an existing one (seatId).
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { api, ApiError } from '../../lib/api'
import { Alert, Button, Skeleton, cn } from '../../components/ui'

export type ClaudeSignInOutcome = 'healthy' | 'unparked' | 'parked' | 'rate_limited' | 'inconclusive' | 'skipped'

interface StartResponse { ok: boolean; loginId: string; url: string; expiresAt: string }
interface FinishResponse<S> { ok: boolean; outcome: ClaudeSignInOutcome; seat: S }

/** Errors after which this link is dead and only a new link helps. */
const DEAD_LINK = new Set(['expired', 'unknown_login', 'too_many_attempts', 'not_subscription'])

const LINK_BUTTON =
  'inline-flex min-h-[44px] select-none items-center justify-center gap-2 rounded-md border border-transparent bg-accent px-4 ' +
  'text-[13px] font-medium tracking-[-0.01em] text-accent-fg transition-colors duration-fast ease-out hover:bg-accent-hover ' +
  'active:bg-accent-press focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 sm:min-h-[36px]'

const INPUT =
  'min-h-[44px] w-full rounded-md border border-line bg-surface-1 px-3 font-mono text-[13px] text-fg-0 outline-none ' +
  'transition-colors duration-fast ease-out placeholder:text-fg-3 hover:border-line-strong focus:border-accent ' +
  'focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-45 sm:min-h-[36px]'

function fmtTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function ExternalIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="M9 3h4v4M13 3L7.5 8.5M11 9.5V13H3V5h3.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function SeatClaudeSignIn<S>({
  seatId,
  label,
  onSuccess,
  onCancel,
}: {
  seatId?: string
  /** Label for a new seat (ignored when reconnecting). */
  label?: string
  onSuccess: (seat: S, outcome: ClaudeSignInOutcome) => void
  onCancel: () => void
}) {
  const [phase, setPhase] = useState<'starting' | 'ready' | 'start_error'>('starting')
  const [link, setLink] = useState<StartResponse | null>(null)
  const [code, setCode] = useState('')
  const [finishing, setFinishing] = useState(false)
  const [error, setError] = useState<{ text: string; dead: boolean } | null>(null)
  const [opened, setOpened] = useState(false)
  const alive = useRef(true)
  const generation = useRef(0)
  const onSuccessRef = useRef(onSuccess)
  onSuccessRef.current = onSuccess

  const start = useCallback(async () => {
    const mine = ++generation.current
    setPhase('starting')
    setError(null)
    setOpened(false)
    setCode('')
    try {
      const r = await api.post<StartResponse>('/admin/seats/claude-oauth/start', seatId ? { seatId } : {})
      if (!alive.current || mine !== generation.current) return
      setLink(r)
      setPhase('ready')
    } catch (err) {
      if (!alive.current || mine !== generation.current) return
      setError({ text: err instanceof ApiError ? (err.body as { error?: string } | null)?.error || err.message : 'Could not start the sign-in.', dead: true })
      setPhase('start_error')
    }
  }, [seatId])

  useEffect(() => {
    alive.current = true
    void start()
    return () => { alive.current = false }
  }, [start])

  const finish = async (e: FormEvent) => {
    e.preventDefault()
    const pasted = code.trim()
    if (!link) return
    if (!pasted) {
      setError({ text: 'Paste the authentication code Claude showed you.', dead: false })
      return
    }
    // The code is single-use; drop it from state before the request goes out.
    setCode('')
    setFinishing(true)
    setError(null)
    try {
      const body: Record<string, unknown> = { loginId: link.loginId, code: pasted }
      if (seatId) body.seatId = seatId
      else if (label?.trim()) body.label = label.trim()
      // The server also runs the seat's test turn, which can take up to ~45s.
      const r = await api.post<FinishResponse<S>>('/admin/seats/claude-oauth/finish', body, { timeoutMs: 90_000 })
      if (!alive.current) return
      onSuccessRef.current(r.seat, r.outcome)
    } catch (err) {
      if (!alive.current) return
      const b = err instanceof ApiError ? (err.body as { error?: string; code?: string } | null) : null
      setError({ text: b?.error || (err instanceof Error ? err.message : 'Signing in failed.'), dead: DEAD_LINK.has(b?.code || '') })
    } finally {
      if (alive.current) setFinishing(false)
    }
  }

  const cancel = () => {
    alive.current = false
    if (link) void api.post('/admin/seats/claude-oauth/cancel', { loginId: link.loginId }).catch(() => {})
    onCancel()
  }

  if (phase === 'starting') {
    return (
      <div className="space-y-3" aria-busy="true" aria-label="Preparing the sign-in link">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-11 w-44 sm:h-9" />
        <Skeleton className="h-4 w-56" />
        <Skeleton className="h-11 w-full sm:h-9" />
      </div>
    )
  }

  if (phase === 'start_error') {
    return (
      <div className="space-y-3">
        <Alert tone="alarm" title="The sign-in did not start">{error?.text}</Alert>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => void start()}>Try again</Button>
          <Button variant="ghost" onClick={cancel}>Cancel</Button>
        </div>
      </div>
    )
  }

  const codeId = `claude-code-${seatId || 'new'}`
  return (
    <form onSubmit={finish} className="space-y-4" aria-label={seatId ? 'Reconnect with Claude' : 'Sign in with Claude'}>
      <ol className="space-y-4 text-[13px] text-fg-2">
        <li className="space-y-2">
          <p className="text-fg-1">
            <span className="font-mono text-fg-3">1.</span> Open Claude and sign in with the subscription account (Pro, Max or Team).
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <a href={link?.url} target="_blank" rel="noopener noreferrer" className={LINK_BUTTON} onClick={() => setOpened(true)}>
              Sign in with Claude <ExternalIcon />
            </a>
            {link && <span className="text-[12px] text-fg-3">Link works until {fmtTime(link.expiresAt)}</span>}
          </div>
        </li>
        <li className="space-y-2">
          <label htmlFor={codeId} className="block text-fg-1">
            <span className="font-mono text-fg-3">2.</span> Claude shows an <span className="text-fg-0">Authentication code</span>. Copy it and paste it here.
          </label>
          <input
            id={codeId}
            type="text"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            className={cn(INPUT, opened && !code && 'border-line-strong')}
            value={code}
            onChange={e => setCode(e.target.value)}
            placeholder="Paste the authentication code"
            disabled={finishing}
            aria-describedby={`${codeId}-hint`}
          />
          <p id={`${codeId}-hint`} className="text-[12px] leading-relaxed text-fg-3">
            The code works once. We swap it for a one-year subscription token, store it encrypted and never show it again.
          </p>
        </li>
      </ol>

      {finishing && (
        <p className="text-[12px] text-fg-3" aria-live="polite">Signing in and running a small test turn. This can take up to a minute.</p>
      )}
      {error && (
        <Alert tone="alarm">
          {error.text}
        </Alert>
      )}
      <div className="flex flex-wrap gap-2">
        {error?.dead ? (
          <Button type="button" variant="primary" onClick={() => void start()}>Get a new link</Button>
        ) : (
          <Button type="submit" variant="primary" loading={finishing}>{finishing ? 'Connecting…' : seatId ? 'Reconnect seat' : 'Connect seat'}</Button>
        )}
        <Button type="button" variant="ghost" onClick={cancel} disabled={finishing}>Cancel</Button>
      </div>
    </form>
  )
}
