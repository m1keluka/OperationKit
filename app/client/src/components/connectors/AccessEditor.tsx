/**
 * "Who can use it" for one connector: all agents / only some, all workspaces /
 * only some. Saves to PUT /api/connectors/:id/access. null = everyone.
 */
import { useEffect, useState } from 'react'
import type { ConnectorAccess } from '@operationkit/shared'
import { Button, cn } from '../ui'

interface Option {
  value: string
  label: string
}

function sameList(a: string[] | null, b: string[] | null): boolean {
  if (a === null || b === null) return a === b
  return a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n')
}

const chip =
  'inline-flex min-h-[44px] items-center rounded-md border px-3 text-[12.5px] font-medium transition-colors duration-fast ease-out ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 sm:min-h-[32px] disabled:cursor-not-allowed disabled:opacity-45'
const chipOn = 'border-[color:var(--accent-line)] bg-[var(--accent-tint)] text-fg-0 hover:border-accent'
const chipOff = 'border-line bg-surface-1 text-fg-2 hover:border-line-strong hover:bg-surface-3 hover:text-fg-0'

function ListPicker({
  legend,
  allLabel,
  options,
  value,
  onChange,
  disabled,
}: {
  legend: string
  allLabel: string
  options: Option[]
  value: string[] | null
  onChange: (next: string[] | null) => void
  disabled?: boolean
}) {
  const all = value === null
  const toggle = (v: string) => {
    const cur = value ?? []
    onChange(cur.includes(v) ? cur.filter(x => x !== v) : [...cur, v])
  }
  return (
    <fieldset className="min-w-0" disabled={disabled}>
      <legend className="mb-2 text-[12px] font-medium text-fg-1">{legend}</legend>
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          aria-pressed={all}
          onClick={() => onChange(all ? [] : null)}
          className={cn(chip, all ? chipOn : chipOff)}
        >
          {allLabel}
        </button>
        {options.map(o => {
          const on = !all && (value ?? []).includes(o.value)
          return (
            <button
              key={o.value}
              type="button"
              aria-pressed={on}
              onClick={() => (all ? onChange([o.value]) : toggle(o.value))}
              className={cn(chip, on ? chipOn : chipOff)}
            >
              {o.label}
            </button>
          )
        })}
      </div>
      {value !== null && value.length === 0 && (
        <p className="mt-2 text-[12px] text-signal-amber">None selected — no session will get this connection.</p>
      )}
    </fieldset>
  )
}

export function AccessEditor({
  access,
  agents,
  workspaces,
  onSave,
}: {
  access: ConnectorAccess
  agents: Option[]
  workspaces: Option[]
  onSave: (next: ConnectorAccess) => Promise<void>
}) {
  const [draft, setDraft] = useState<ConnectorAccess>(access)
  const [saving, setSaving] = useState(false)
  useEffect(() => setDraft(access), [access])

  const dirty = !sameList(draft.agents, access.agents) || !sameList(draft.workspaces, access.workspaces)

  async function save() {
    setSaving(true)
    try {
      await onSave(draft)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      <ListPicker
        legend="Agents"
        allLabel="All agents"
        options={agents}
        value={draft.agents}
        onChange={agentsNext => setDraft(d => ({ ...d, agents: agentsNext }))}
        disabled={saving}
      />
      {workspaces.length > 1 && (
        <ListPicker
          legend="Workspaces"
          allLabel="All workspaces"
          options={workspaces}
          value={draft.workspaces}
          onChange={wsNext => setDraft(d => ({ ...d, workspaces: wsNext }))}
          disabled={saving}
        />
      )}
      {dirty && (
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" size="sm" className="min-h-[44px] sm:min-h-0" loading={saving} onClick={save}>
            Save access
          </Button>
          <Button variant="ghost" size="sm" className="min-h-[44px] sm:min-h-0" disabled={saving} onClick={() => setDraft(access)}>
            Undo
          </Button>
        </div>
      )}
    </div>
  )
}
