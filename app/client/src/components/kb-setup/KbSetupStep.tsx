// Onboarding checklist row: "Set up your knowledge base" (obj 900556).
// Done once a setup run has finished and filed at least one page
// (GET /api/kb-setup/status → step_done).
import { useEffect, useState } from 'react'
import { ArrowRight, CheckCircle2, Circle } from 'lucide-react'
import { useNavigate } from '../../context/nav'
import { createKbSetupApi } from '../../lib/kbSetup'
import { cn } from '../ui'

export const KB_SETUP_STEP = {
  id: 'knowledge_base',
  title: 'Set up your knowledge base',
  body: 'Drop in your existing documents, spreadsheets, decks and notes. The setup agent files them into people, companies, projects, decisions, processes, products and a glossary.',
  href: '/knowledge/setup',
} as const

export interface KbSetupStepProps {
  /** Step number shown in the eyebrow ("Step 4"). */
  index?: number
  /** Workspace to check. Without one (or 'all') the tick is not looked up. */
  workspace?: string
  /** Override the done state (skips the status fetch). */
  done?: boolean
  className?: string
}

export function KbSetupStep({ index = 4, workspace, done: doneProp, className }: KbSetupStepProps) {
  const navigate = useNavigate()
  const [fetched, setFetched] = useState(false)
  const ws = workspace && workspace !== 'all' ? workspace : ''

  useEffect(() => {
    if (doneProp !== undefined || !ws) return
    let live = true
    createKbSetupApi(ws).status()
      .then(s => { if (live) setFetched(!!s.step_done) })
      .catch(() => { /* leave unticked */ })
    return () => { live = false }
  }, [ws, doneProp])

  const done = doneProp ?? fetched
  return (
    <div className={cn('flex items-start gap-3 rounded-lg border border-line bg-surface-2 p-4', className)} data-step-id={KB_SETUP_STEP.id}>
      {done
        ? <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-signal-verify" aria-label="Done" />
        : <Circle className="mt-0.5 h-5 w-5 shrink-0 text-fg-3" aria-label="Not done" />}
      <div className="min-w-0 flex-1">
        <p className="font-mono text-[12px] uppercase tracking-[0.12em] text-fg-3">Step {index}</p>
        <p className={cn('mt-0.5 font-display text-[15px] font-semibold tracking-[-0.01em]', done ? 'text-fg-2' : 'text-fg-0')}>
          {KB_SETUP_STEP.title}
        </p>
        <p className="mt-1 text-[13px] leading-relaxed text-fg-2">{KB_SETUP_STEP.body}</p>
        <a
          href={KB_SETUP_STEP.href}
          onClick={e => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
            e.preventDefault()
            navigate(KB_SETUP_STEP.href)
          }}
          className={cn(
            'mt-3 inline-flex min-h-[44px] items-center gap-1.5 rounded-md border px-3 text-[12.5px] font-medium transition-colors sm:min-h-[32px]',
            done
              ? 'border-line bg-surface-1 text-fg-1 hover:border-line-strong hover:text-fg-0'
              : 'border-transparent bg-accent text-accent-fg hover:bg-accent-hover',
          )}
        >
          {done ? 'Add more files' : 'Set up'}
          <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
        </a>
      </div>
    </div>
  )
}
