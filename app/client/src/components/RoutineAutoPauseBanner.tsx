import { useCallback, useState } from 'react'
import { PlayCircle } from 'lucide-react'
import { isAutoPaused, type RoutineSummary } from '../hooks/useRoutines'
import { Alert, Button } from './ui'

/**
 * obj 64 Part B — routines disabled by the K-consecutive-failure auto-pause.
 * One row per auto-paused routine: "auto-paused: K failures, last error …" and a
 * one-click Resume (re-enables + clears the failure streak server-side).
 */
export function RoutineAutoPauseBanner({
  routines,
  onResume,
}: {
  routines: RoutineSummary[]
  onResume: (id: number) => Promise<{ ok: boolean; error?: string }>
}) {
  const paused = routines.filter(isAutoPaused)
  if (paused.length === 0) return null
  return (
    <Alert
      tone="alarm"
      className="mb-4"
      title={`${paused.length} ${paused.length === 1 ? 'routine' : 'routines'} auto-paused after repeated failures`}
    >
      <ul className="mt-1 space-y-1.5" data-testid="auto-paused-routines">
        {paused.map(r => (
          <AutoPausedRow key={r.id} routine={r} onResume={onResume} />
        ))}
      </ul>
    </Alert>
  )
}

function AutoPausedRow({
  routine,
  onResume,
}: {
  routine: RoutineSummary
  onResume: (id: number) => Promise<{ ok: boolean; error?: string }>
}) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const handle = useCallback(async () => {
    setBusy(true)
    setErr(null)
    const res = await onResume(routine.id)
    setBusy(false)
    if (!res.ok) setErr(res.error || 'Resume failed')
  }, [routine.id, onResume])

  return (
    <li className="flex flex-wrap items-center gap-2">
      <span className="font-medium text-fg-0">{routine.title}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]" title={routine.auto_pause_reason ?? ''}>
        {routine.auto_pause_reason || `auto-paused: ${routine.consecutive_failures ?? '?'} failures`}
      </span>
      {err && <span className="font-mono text-[11px] text-signal-alarm">{err}</span>}
      <Button
        variant="secondary"
        size="sm"
        onClick={handle}
        disabled={busy}
        aria-label={`Resume ${routine.title}`}
        leftIcon={<PlayCircle className="h-3.5 w-3.5" strokeWidth={1.75} />}
      >
        {busy ? 'Resuming…' : 'Resume'}
      </Button>
    </li>
  )
}
