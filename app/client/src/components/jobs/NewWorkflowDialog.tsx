import { useEffect, useId, useState } from 'react'
import { useNavigate } from '../../context/nav'
import { Workflow } from 'lucide-react'
import { Alert, Button, Modal } from '../ui'

/**
 * "New workflow" (obj 900642, card B6 of docs/design/WORKFLOWS.md §5.1).
 *
 * A workflow starts from a GOAL, not from JSON: this posts `{workspace, goal,
 * name?, end_condition?, builder.max_iterations}` to POST /api/flows, which files
 * the workflow and its BUILDER CARD on the board. The builder agent drafts and
 * self-tests versions; the owner publishes from Jobs → Workflows. Opened from the
 * board header and from Jobs → Workflows.
 */
export interface NewWorkflowResult {
  flow_id: number
  slug: string
  workspace: string
  objective_id: number
  builder: { objective_id: number; status: string; max_iterations: number; queue_hold: string | null }
}

export async function createWorkflowFromGoal(body: {
  workspace: string
  goal: string
  name?: string
  end_condition?: { assert: { expr: string }[] }
  builder?: { max_iterations: number }
}): Promise<{ ok: true; result: NewWorkflowResult } | { ok: false; error: string }> {
  try {
    const r = await fetch('/api/flows', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const json = (await r.json().catch(() => ({}))) as Partial<NewWorkflowResult> & { error?: string }
    if (r.status !== 201) return { ok: false, error: json.error || `HTTP ${r.status}` }
    return { ok: true, result: json as NewWorkflowResult }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Request failed' }
  }
}

/** One deterministic assert per non-empty line. */
export function parseAsserts(text: string): { assert: { expr: string }[] } | undefined {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  return lines.length ? { assert: lines.map((expr) => ({ expr })) } : undefined
}

const FIELD =
  'w-full rounded-md border border-line bg-surface-1 px-3 py-2 text-[13px] text-fg-0 placeholder:text-fg-3 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30'
const LABEL = 'mb-1 block text-[12px] font-medium text-fg-1'

export function NewWorkflowDialog({
  open,
  onClose,
  workspaces,
  defaultWorkspace,
  labelOf,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  /** Workspaces the user may create in (slugs). */
  workspaces: string[]
  defaultWorkspace?: string | null
  labelOf?: (slug: string) => string
  onCreated?: (r: NewWorkflowResult) => void
}) {
  const titleId = useId()
  const navigate = useNavigate()
  const go = (href: string) => {
    onClose()
    navigate(href)
  }
  const [workspace, setWorkspace] = useState('')
  const [goal, setGoal] = useState('')
  const [name, setName] = useState('')
  const [asserts, setAsserts] = useState('')
  const [maxIterations, setMaxIterations] = useState(6)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<NewWorkflowResult | null>(null)

  // Reset ONLY when the dialog opens. Parents pass a fresh `workspaces` array on
  // every render (the board re-renders every few seconds for live sessions), so
  // depending on it would wipe what the user is typing (cf. obj 700071 in Modal).
  useEffect(() => {
    if (!open) return
    setWorkspace(defaultWorkspace && workspaces.includes(defaultWorkspace) ? defaultWorkspace : workspaces[0] ?? '')
    setGoal('')
    setName('')
    setAsserts('')
    setMaxIterations(6)
    setError(null)
    setCreated(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  // Workspaces can arrive after the dialog opened (first fetch): fill an empty pick.
  useEffect(() => {
    if (!open || workspace || !workspaces.length) return
    // Functional: the open-reset above may have queued the default in this same commit.
    setWorkspace((w) => w || (defaultWorkspace && workspaces.includes(defaultWorkspace) ? defaultWorkspace : workspaces[0]))
  }, [open, workspace, workspaces, defaultWorkspace])

  const submit = async () => {
    if (!goal.trim() || !workspace) return
    setBusy(true)
    setError(null)
    const r = await createWorkflowFromGoal({
      workspace,
      goal: goal.trim(),
      ...(name.trim() ? { name: name.trim() } : {}),
      ...(parseAsserts(asserts) ? { end_condition: parseAsserts(asserts) } : {}),
      builder: { max_iterations: maxIterations },
    })
    setBusy(false)
    if (!r.ok) {
      setError(r.error)
      return
    }
    setCreated(r.result)
    onCreated?.(r.result)
  }

  return (
    <Modal open={open} onClose={onClose} labelledBy={titleId} panelClassName="max-w-lg">
      <div className="p-5" data-testid="new-workflow-dialog">
        <h2 id={titleId} className="flex items-center gap-2 font-display text-[15px] font-semibold tracking-[-0.01em] text-fg-0">
          <Workflow className="h-4 w-4" strokeWidth={1.75} /> New workflow
        </h2>
        {created ? (
          <div className="mt-3 space-y-3 text-[13px] leading-relaxed text-fg-1" data-testid="new-workflow-created">
            <p>
              Workflow <span className="font-mono">{created.slug}</span> is filed with a builder card. The builder drafts
              and self-tests it (up to {created.builder.max_iterations} drafts); you publish it from Jobs → Workflows.
            </p>
            {created.builder.queue_hold && (
              <Alert tone="amber" title="Held until workflows are on">
                Workflows are switched off on this install, so the builder card waits in the queue. Start it by hand
                once an operator turns them on.
              </Alert>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => go(`/jobs?view=workflows&flow=${created.flow_id}`)}>
                Open in Jobs
              </Button>
              <Button variant="primary" size="sm" onClick={() => go(`/o/${created.objective_id}`)}>
                Open builder card #{created.objective_id}
              </Button>
            </div>
          </div>
        ) : (
          <form
            className="mt-3 space-y-3"
            onSubmit={(e) => {
              e.preventDefault()
              void submit()
            }}
          >
            <p className="text-[12.5px] leading-snug text-fg-2">
              Describe the goal. A builder agent turns it into typed steps, validates them and self-tests them against
              the end condition. Nothing runs or sends until you publish it.
            </p>
            <div>
              <label className={LABEL} htmlFor={`${titleId}-goal`}>Goal</label>
              <textarea
                id={`${titleId}-goal`}
                className={`${FIELD} min-h-[88px]`}
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                placeholder="Every booking created yesterday is in the CRM with a category, and the team got one summary message."
                maxLength={4000}
                required
                data-autofocus
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className={LABEL} htmlFor={`${titleId}-name`}>Name <span className="text-fg-3">(optional)</span></label>
                <input id={`${titleId}-name`} className={FIELD} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="From the goal" />
              </div>
              <div>
                <label className={LABEL} htmlFor={`${titleId}-ws`}>Workspace</label>
                <select id={`${titleId}-ws`} className={FIELD} value={workspace} onChange={(e) => setWorkspace(e.target.value)} required>
                  {workspaces.map((ws) => (
                    <option key={ws} value={ws}>{labelOf ? labelOf(ws) : ws}</option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <label className={LABEL} htmlFor={`${titleId}-asserts`}>
                End condition <span className="text-fg-3">(optional — one check per line; leave empty and the builder proposes one)</span>
              </label>
              <textarea
                id={`${titleId}-asserts`}
                className={`${FIELD} min-h-[56px] font-mono text-[12px]`}
                value={asserts}
                onChange={(e) => setAsserts(e.target.value)}
                placeholder="len(steps.fetch.output.bookings) == steps.upsert.output.count"
              />
            </div>
            <div className="flex items-center gap-2">
              <label className="whitespace-nowrap text-[12px] text-fg-1" htmlFor={`${titleId}-iter`}>Builder attempts</label>
              <input
                id={`${titleId}-iter`}
                type="number"
                min={1}
                max={20}
                className={FIELD.replace('w-full', 'w-20')}
                value={maxIterations}
                onChange={(e) => setMaxIterations(Math.min(20, Math.max(1, Number(e.target.value) || 1)))}
              />
              <span className="text-[12px] text-fg-3">drafts before it hands back to you</span>
            </div>
            {error && <Alert tone="alarm" title="Could not create the workflow">{error}</Alert>}
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" size="sm" type="button" onClick={onClose}>Cancel</Button>
              <Button variant="primary" size="sm" type="submit" disabled={busy || !goal.trim() || !workspace}>
                {busy ? 'Creating…' : 'Create builder card'}
              </Button>
            </div>
          </form>
        )}
      </div>
    </Modal>
  )
}
