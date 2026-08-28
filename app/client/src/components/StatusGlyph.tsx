import type { ObjectiveStatus } from '@command-center/shared'

/* ─────────────────────────────────────────────────────────
   StatusGlyph — Mission Control circular status glyph (§ board)
   Linear-style pie/ring: a faint ring + a filled wedge whose
   fraction encodes progress through the pipeline; `done` becomes
   a solid disc with a check. Color comes from the W6 --st-* token
   for the status (bound through the `--c` custom property).
   Ported from operationkit-showcase/shared/data.js → OK.glyph.
   ───────────────────────────────────────────────────────── */

const GLYPH: Record<ObjectiveStatus, { fill: number; token: string }> = {
  planning:  { fill: 0.15, token: 'var(--st-planning)' },
  queue:     { fill: 0,    token: 'var(--st-queue)' },
  working:   { fill: 0.6,  token: 'var(--st-working)' },
  ai_review: { fill: 0.85, token: 'var(--st-ai)' },
  review:    { fill: 0.5,  token: 'var(--st-human)' },
  done:      { fill: 1,    token: 'var(--st-done)' },
  // obj 700595 — soft-retire. A hollow ring (fill 0) in the muted cancelled
  // token: reads as "closed but not completed" (no filled disc / check).
  cancelled: { fill: 0,    token: 'var(--st-cancelled)' },
}

export function StatusGlyph({ status, size = 13 }: { status: ObjectiveStatus; size?: number }) {
  const { fill, token } = GLYPH[status] ?? GLYPH.queue
  const r = size / 2 - 1.5
  const cx = size / 2
  const cy = size / 2
  const pr = r * 0.62 // pie radius sits inside the ring

  let pie: React.ReactNode = null
  if (fill >= 1) {
    pie = (
      <>
        <circle cx={cx} cy={cy} r={r} fill="var(--c)" />
        {/* check mark — drawn in surface-0 so it reads as a punch-out */}
        <path
          d={`M${cx - 2.4} ${cy} l1.7 1.8 l3.1-3.4`}
          stroke="var(--surface-0)"
          strokeWidth={1.5}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </>
    )
  } else if (fill > 0) {
    const a = fill * 2 * Math.PI
    const x = cx + pr * Math.sin(a)
    const y = cy - pr * Math.cos(a)
    const large = fill > 0.5 ? 1 : 0
    pie = <path d={`M${cx} ${cy} L${cx} ${cy - pr} A${pr} ${pr} 0 ${large} 1 ${x} ${y} Z`} fill="var(--c)" />
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden="true"
      style={{ ['--c' as string]: token, overflow: 'visible', flexShrink: 0 }}
    >
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--c)" strokeWidth={1.5} opacity={0.55} />
      {pie}
    </svg>
  )
}
