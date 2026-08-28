import type { ReactNode } from 'react'

/** A quick-start suggestion chip. Clicking prefills the composer with `prompt`. */
export interface StarterChip {
  label: string
  prompt: string
  icon?: ReactNode
}

interface WelcomeStateProps {
  /** The user's configured assistant name; falls back to 'Jarvis' when unset. */
  assistantName?: string
  /** Fires with the chip's prompt so the caller can prefill the composer. */
  onPick: (prompt: string) => void
  /**
   * Kept for backward compatibility with the MessageList empty-state test:
   * the assistant tagline "{name} reads the vault and pushes back." must render.
   */
  showTagline?: boolean
}

// A warm mix of Q&A + quick actions. Each prefills the composer on click.
const STARTERS: StarterChip[] = [
  { label: 'Draft a follow-up email', prompt: 'Draft a follow-up email. Here is the context: ', icon: '✉️' },
  { label: "Today's briefing", prompt: "Give me today's briefing — what is urgent, in progress, and blocked across all organizations.", icon: '📋' },
  { label: 'Create an objective for…', prompt: 'I want to create a new objective. Here is what it should accomplish: ', icon: '🎯' },
  { label: 'Check the deploy', prompt: 'Check the latest deploy — is anything failing or blocked right now?', icon: '🚀' },
  { label: 'Summarize a doc', prompt: 'Summarize this doc for me: ', icon: '📄' },
  { label: 'Pressure-test an idea', prompt: 'Pressure-test this idea and poke holes in it: ', icon: '🧪' },
]

export function WelcomeState({ assistantName = 'Jarvis', onPick, showTagline = true }: WelcomeStateProps) {
  return (
    <div className="mx-auto flex h-full w-full max-w-2xl flex-col items-center justify-center px-4 py-8 text-center">
      <div className="grid h-12 w-12 place-items-center rounded-2xl border border-[color:var(--accent-line)] bg-[var(--accent-tint)] text-2xl">
        ✦
      </div>
      <h2 className="mt-4 font-display text-xl font-semibold tracking-[-0.01em] text-fg-0 sm:text-2xl">
        What can I help you with?
      </h2>
      {showTagline && (
        <p className="mt-2 max-w-md text-sm leading-relaxed text-fg-2">
          {assistantName} reads the vault and pushes back. Ask a question, or pick a quick start below.
        </p>
      )}

      <div className="mt-6 grid w-full grid-cols-1 gap-2 sm:grid-cols-2">
        {STARTERS.map(({ label, prompt, icon }) => (
          <button
            key={label}
            type="button"
            onClick={() => onPick(prompt)}
            className="group flex items-center gap-3 rounded-lg border border-line bg-surface-1 px-3.5 py-3 text-left text-sm text-fg-1 transition-colors duration-fast ease-out hover:border-[color:var(--accent-line)] hover:bg-surface-2 hover:text-fg-0"
          >
            {icon && <span className="shrink-0 text-base opacity-80">{icon}</span>}
            <span className="min-w-0 flex-1 truncate">{label}</span>
            <span className="shrink-0 text-fg-3 opacity-0 transition-opacity group-hover:opacity-100">→</span>
          </button>
        ))}
      </div>
    </div>
  )
}
