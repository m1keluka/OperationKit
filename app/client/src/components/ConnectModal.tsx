import { useCallback, useEffect, useState } from 'react'
import { Modal, Button, Spinner } from './ui'
import { api } from '../lib/api'

/**
 * Account connect — no terminal.
 * Claude: server drives the login TUI → URL → paste the auth code.
 * Grok SuperGrok: `grok login --device-auth` → URL + short code shown here;
 * the operator approves in the browser; we poll until ~/.grok/auth.json lands.
 */
export function ConnectModal({
  slot,
  label,
  onClose,
  onConnected,
}: {
  slot: string
  label: string
  onClose: () => void
  onConnected?: () => void
}) {
  const [phase, setPhase] = useState<'starting' | 'url' | 'waiting' | 'submitting' | 'done' | 'error'>('starting')
  const [flow, setFlow] = useState<'oauth' | 'device'>('oauth')
  const [url, setUrl] = useState<string | null>(null)
  const [userCode, setUserCode] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [copied, setCopied] = useState(false)

  const start = useCallback(async () => {
    setPhase('starting')
    setErr(null)
    setUrl(null)
    setUserCode(null)
    try {
      const r = await api.post<{ ok: boolean; url?: string; userCode?: string; flow?: 'device' | 'oauth'; error?: string }>(
        `/admin/accounts/${slot}/connect/start`,
      )
      if (r.ok && r.flow === 'device' && r.url && r.userCode) {
        setFlow('device')
        setUrl(r.url)
        setUserCode(r.userCode)
        setPhase('waiting')
      } else if (r.ok && r.url) {
        setFlow('oauth')
        setUrl(r.url)
        setPhase('url')
      } else {
        setErr(r.error || 'Could not generate the sign-in link.')
        setPhase('error')
      }
    } catch {
      setErr('Could not start the login session.')
      setPhase('error')
    }
  }, [slot])

  useEffect(() => { start() }, [start])

  useEffect(() => {
    if (phase !== 'waiting' || slot !== 'grok') return
    let stopped = false
    const tick = async () => {
      try {
        const s = await api.post<{ ok: boolean; success?: boolean; pending?: boolean; error?: string; url?: string; userCode?: string }>(
          `/admin/accounts/${slot}/connect/status`,
        )
        if (stopped) return
        if (s.ok && s.success) {
          setPhase('done')
          onConnected?.()
          setTimeout(onClose, 1200)
          return
        }
        if (s.error) {
          setErr(s.error)
          setPhase('error')
          return
        }
        if (s.url) setUrl(s.url)
        if (s.userCode) setUserCode(s.userCode)
      } catch { /* next poll */ }
    }
    const t = setInterval(() => { void tick() }, 2000)
    void tick()
    return () => { stopped = true; clearInterval(t) }
    // onConnected / onClose are render-fresh lambdas from the card.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, slot])

  const copy = async () => {
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* clipboard blocked — Open button still works */ }
  }

  const copyCode = async () => {
    if (!userCode) return
    try {
      await navigator.clipboard.writeText(userCode)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* noop */ }
  }

  const submit = async () => {
    const c = code.trim()
    if (!c) return
    setPhase('submitting')
    setErr(null)
    try {
      const r = await api.post<{ ok: boolean; success?: boolean; error?: string }>(
        `/admin/accounts/${slot}/connect/submit`, { code: c },
      )
      if (r.ok && r.success) {
        setPhase('done')
        onConnected?.()
        setTimeout(onClose, 1200)
      } else {
        setErr(r.error || 'Login failed.')
        setPhase('url')
      }
    } catch {
      setErr('Failed to submit the code.')
      setPhase('url')
    }
  }

  const busy = phase === 'starting' || phase === 'submitting' || phase === 'done'

  return (
    <Modal open onClose={onClose} panelClassName="w-[min(560px,94vw)]">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <div className="font-mono text-sm font-semibold text-fg-0">
          Connect · {label} <span className="text-fg-3">({slot.toUpperCase()})</span>
        </div>
        <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
      </div>

      <div className="space-y-4 p-4">
        <div>
          <div className="mb-1.5 flex items-center gap-2">
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-surface-3 font-mono text-[11px] text-fg-2">1</span>
            <span className="text-sm font-medium text-fg-1">
              {flow === 'device' ? 'Open the sign-in link and enter this code' : 'Open the sign-in link & approve'}
            </span>
          </div>
          {phase === 'starting' ? (
            <div className="flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-2.5 text-xs text-fg-2">
              <Spinner /> Generating sign-in link…
            </div>
          ) : phase === 'error' ? (
            <div className="rounded-lg border border-signal-alarm/30 bg-signal-alarm/5 px-3 py-2.5 text-xs text-signal-alarm">
              {err}{' '}
              <button className="ml-1 underline" onClick={start}>Retry</button>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <a href={url ?? '#'} target="_blank" rel="noreferrer">
                  <Button size="sm" variant="primary">Open sign-in ↗</Button>
                </a>
                <Button size="sm" variant="secondary" onClick={copy}>{copied && !userCode ? 'Copied ✓' : 'Copy URL'}</Button>
              </div>
              {flow === 'device' && userCode && (
                <button
                  type="button"
                  onClick={copyCode}
                  className="rounded-lg bg-surface-3 px-3 py-2 font-mono text-lg tracking-[0.2em] text-fg-0"
                  title="Copy code"
                >
                  {userCode}
                </button>
              )}
            </div>
          )}
        </div>

        {flow === 'device' ? (
          <div>
            <div className="mb-1.5 flex items-center gap-2">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-surface-3 font-mono text-[11px] text-fg-2">2</span>
              <span className="text-sm font-medium text-fg-1">Approve in the browser — we wait</span>
            </div>
            {phase === 'waiting' && (
              <div className="flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-2.5 text-xs text-fg-2">
                <Spinner /> Waiting for SuperGrok to confirm…
              </div>
            )}
            {phase === 'done' && <div className="text-xs text-signal-verify">✓ SuperGrok connected.</div>}
          </div>
        ) : (
          <div>
            <div className="mb-1.5 flex items-center gap-2">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-surface-3 font-mono text-[11px] text-fg-2">2</span>
              <span className="text-sm font-medium text-fg-1">Paste the code &amp; connect</span>
            </div>
            <div className="flex items-center gap-2">
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
                placeholder="Authorization code"
                disabled={busy}
                className="min-w-0 flex-1 rounded bg-surface-3 px-2 py-1.5 font-mono text-xs text-fg-1 outline-none focus:ring-1 focus:ring-accent/50 disabled:opacity-50"
              />
              <Button size="sm" variant="primary" loading={phase === 'submitting'} disabled={!code.trim() || phase === 'starting' || phase === 'done'} onClick={submit}>
                Connect
              </Button>
            </div>
            {phase === 'done' && <div className="mt-1.5 text-xs text-signal-verify">✓ Connected — back in rotation.</div>}
            {err && phase === 'url' && <div className="mt-1.5 text-xs text-signal-alarm">{err}</div>}
          </div>
        )}
      </div>
    </Modal>
  )
}
