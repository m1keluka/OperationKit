// Small connection-status pill for the SessionViewer header. Mirrors the
// example3 "Cattle AI Terminal" live indicator, tuned for this app's dark
// theme + existing tokens. Driven by ThreadTimeline's EventSource readyState
// (bubbled up via onConnState):
//   'live'       → SSE open, streaming        (green, breathing dot)
//   'connecting' → SSE opening / retrying     (amber, pulsing dot)
//   'offline'    → fallback poll (no stream)  (grey, static dot)
// A settled/done thread reports 'offline' too — its transcript is static, so
// the fallback poll is the correct, quiet resting state.

export type ConnState = 'live' | 'connecting' | 'offline'

const META: Record<ConnState, { label: string; color: string; dotClass: string }> = {
  live:       { label: 'Live',       color: 'var(--ok-verify)', dotClass: 'cc-live-breathe' },
  connecting: { label: 'Connecting', color: 'var(--ok-amber)',  dotClass: 'cc-pulse-amber' },
  offline:    { label: 'Offline',    color: 'var(--fg-3)',      dotClass: '' },
}

export function ConnStatusPill({ state }: { state: ConnState }) {
  const meta = META[state]
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[10.5px] font-medium text-fg-2 transition-colors duration-fast ease-out"
      title={`Session stream: ${meta.label}`}
      aria-live="polite"
    >
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${meta.dotClass}`}
        style={meta.dotClass ? undefined : { background: meta.color }}
      />
      <span style={{ color: meta.color }}>{meta.label}</span>
    </span>
  )
}
