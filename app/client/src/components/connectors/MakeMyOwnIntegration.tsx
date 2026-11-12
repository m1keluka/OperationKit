/**
 * New Integration → Make my own (obj 900682). Starts the Integrations bot: a
 * board card whose session asks what to connect, reads the API docs, builds the
 * setup (a workspace MCP server through #900620's path, or an OperationKit Tool)
 * and asks for keys through the masked secret form in the card chat. Both
 * fields here are optional — the bot asks for whatever is missing.
 */
import { useEffect, useId, useState } from 'react'
import { Bot, KeyRound, BookOpen, Wrench } from 'lucide-react'
import type { IntegrationBuilderCreateResponse } from '@operationkit/shared'
import { api, ApiError } from '../../lib/api'
import { useNavigate } from '../../context/nav'
import { Alert, Button, Card } from '../ui'

const FIELD =
  'w-full rounded-md border border-line bg-surface-1 px-3 py-2 text-[13px] text-fg-0 outline-none transition-colors duration-fast ease-out placeholder:text-fg-3 hover:border-line-strong focus:border-accent focus-visible:ring-2 focus-visible:ring-accent/40'
const LABEL = 'mb-1 block text-[12px] font-medium text-fg-1'

function errText(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return (err.body as { error?: string } | null)?.error || err.message || fallback
  return err instanceof Error ? err.message : fallback
}

const STEPS = [
  { icon: Bot, text: 'Asks what you want to connect' },
  { icon: BookOpen, text: 'Reads the API docs you link or paste' },
  { icon: Wrench, text: 'Builds the setup and tests the connection' },
  { icon: KeyRound, text: 'Asks for keys in a secure form in the chat — never as a message' },
]

export function MakeMyOwnIntegration({
  isAdmin,
  workspaces,
  defaultWorkspace,
  onStarted,
}: {
  isAdmin: boolean
  workspaces: Array<{ value: string; label: string }>
  defaultWorkspace: string
  /** Called with the result before navigating (tests, notices). */
  onStarted?: (r: IntegrationBuilderCreateResponse) => void
}) {
  const id = useId()
  const navigate = useNavigate()
  const [workspace, setWorkspace] = useState(defaultWorkspace)
  const [target, setTarget] = useState('')
  const [docs, setDocs] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [started, setStarted] = useState<IntegrationBuilderCreateResponse | null>(null)

  useEffect(() => { if (!workspace && defaultWorkspace) setWorkspace(defaultWorkspace) }, [workspace, defaultWorkspace])

  const start = async () => {
    if (!workspace) return
    setBusy(true); setError('')
    try {
      const r = await api.post<IntegrationBuilderCreateResponse>('/integrations/builder', {
        workspace,
        ...(target.trim() ? { target: target.trim() } : {}),
        ...(docs.trim() ? { docs: docs.trim() } : {}),
      })
      setStarted(r)
      onStarted?.(r)
      // Straight into the bot's chat when it is running; otherwise show why it waits.
      if (r.started) navigate(`/o/${r.objective_id}`)
    } catch (err) {
      setError(errText(err, 'Could not start the Integrations bot.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card inset className="p-4 sm:p-5" data-testid="make-my-own">
      <div className="flex items-start gap-3">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-line bg-surface-3 text-fg-1">
          <Bot className="h-5 w-5" strokeWidth={1.75} />
        </div>
        <div className="min-w-0">
          <h3 className="font-display text-[15px] font-semibold text-fg-0">Make my own with the Integrations bot</h3>
          <p className="mt-0.5 text-[12.5px] leading-relaxed text-fg-2">
            For anything not in the list. The bot works in a chat on its own board card:
          </p>
        </div>
      </div>
      <ol className="mt-3 grid gap-2 sm:grid-cols-2">
        {STEPS.map((s, i) => (
          <li key={s.text} className="flex items-start gap-2 rounded-md border border-line-soft bg-surface-1 px-3 py-2 text-[12.5px] text-fg-1">
            <span className="font-mono text-[12px] text-fg-3">{i + 1}</span>
            <s.icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fg-2" strokeWidth={1.75} aria-hidden="true" />
            <span>{s.text}</span>
          </li>
        ))}
      </ol>

      {started && !started.started ? (
        <div className="mt-4 space-y-3" data-testid="make-my-own-queued">
          <Alert tone="amber" title={`Card #${started.objective_id} is waiting in the queue`}>
            {started.start_detail || 'It starts as soon as a session slot is free.'}
          </Alert>
          <div className="flex justify-end">
            <Button variant="primary" size="sm" onClick={() => navigate(`/o/${started.objective_id}`)}>
              Open the Integrations bot card
            </Button>
          </div>
        </div>
      ) : !isAdmin ? (
        <p className="mt-4 text-[12.5px] text-fg-3">Only an admin can start the Integrations bot — ask one to set it up.</p>
      ) : (
        <form
          className="mt-4 space-y-3"
          onSubmit={e => { e.preventDefault(); void start() }}
        >
          <div>
            <label className={LABEL} htmlFor={`${id}-target`}>
              What do you want to connect? <span className="text-fg-3">(optional — the bot asks)</span>
            </label>
            <input
              id={`${id}-target`}
              className={`${FIELD} min-h-[44px] sm:min-h-[36px]`}
              value={target}
              onChange={e => setTarget(e.target.value)}
              maxLength={200}
              placeholder="Our Acme CRM — read contacts and log calls"
            />
          </div>
          <div>
            <label className={LABEL} htmlFor={`${id}-docs`}>
              API docs <span className="text-fg-3">(optional — a link, or paste the docs)</span>
            </label>
            <textarea
              id={`${id}-docs`}
              className={`${FIELD} min-h-[72px]`}
              value={docs}
              onChange={e => setDocs(e.target.value)}
              maxLength={8000}
              placeholder="https://developers.acme.com/api"
            />
            <p className="mt-1 text-[12px] text-fg-3">Do not paste keys here. The bot asks for them in a secure form.</p>
          </div>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <label className={LABEL} htmlFor={`${id}-ws`}>Workspace</label>
              <select
                id={`${id}-ws`}
                className={`${FIELD} min-h-[44px] w-auto sm:min-h-[36px]`}
                value={workspace}
                onChange={e => setWorkspace(e.target.value)}
              >
                {workspaces.map(w => <option key={w.value} value={w.value}>{w.label}</option>)}
              </select>
            </div>
            <Button type="submit" variant="primary" loading={busy} disabled={!workspace}>
              Start the Integrations bot
            </Button>
          </div>
          {error && <Alert tone="alarm" title="Could not start the bot">{error}</Alert>}
        </form>
      )}
    </Card>
  )
}
