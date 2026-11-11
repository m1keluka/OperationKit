import { useState, type FormEvent } from 'react'
import { Alert, Button, Modal, cn } from '../ui'
import { DEV_SEVERITIES, DEV_TYPES, TYPE_LABEL, createDevItem, type DevSeverity, type DevType } from '../../lib/devItems'

/* New item — the admin-authored path (A3 POST /api/dev-items, api.md §5.3).
   `submitted_via` is server-set to 'admin'; supplying any of
   severity/impact/effort/area stamps triage, so the type/severity controls are
   deliberately on the same screen as the title. */
export function NewItemModal({
  open, onClose, onCreated, workspaces, defaultWorkspace,
}: {
  open: boolean
  onClose: () => void
  onCreated: () => void
  workspaces: { slug: string; label: string }[]
  defaultWorkspace: string
}) {
  const [workspace, setWorkspace] = useState(defaultWorkspace)
  const [type, setType] = useState<DevType>('bug')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [steps, setSteps] = useState('')
  const [severity, setSeverity] = useState<DevSeverity | null>(null)
  const [area, setArea] = useState('')
  const [route, setRoute] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const input =
    'w-full rounded-md border border-line bg-surface-2 px-2.5 py-1.5 text-[13px] text-fg-0 placeholder:text-fg-3 ' +
    'transition-colors duration-fast hover:border-line-strong focus:border-[color:var(--accent-line)] focus:outline-none focus:ring-2 focus:ring-accent/40'

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!title.trim()) return
    setSaving(true)
    setError(null)
    try {
      await createDevItem({
        workspace,
        type,
        title: title.trim(),
        description: description.trim(),
        steps_to_repro: steps.trim() || undefined,
        severity,
        area: area.trim() || null,
        route: route.trim() || null,
      })
      setTitle(''); setDescription(''); setSteps(''); setSeverity(null); setArea(''); setRoute('')
      onCreated()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create item')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} variant="center" labelledBy="new-dev-item" panelClassName="max-w-xl">
      <form onSubmit={submit} className="p-4">
        <h2 id="new-dev-item" className="mb-3 font-display text-[16px] font-semibold tracking-[-0.01em] text-fg-0">New development item</h2>
        {error && <Alert tone="alarm" className="mb-3">{error}</Alert>}

        <div className="mb-3 flex flex-wrap gap-2">
          {DEV_TYPES.map(t => (
            <button
              key={t}
              type="button"
              onClick={() => setType(t)}
              className={cn(
                'rounded-md border px-2.5 py-1.5 text-[12.5px] transition-colors duration-fast',
                type === t ? 'border-[color:var(--accent-line)] bg-accent/10 text-fg-0' : 'border-line bg-surface-2 text-fg-2 hover:text-fg-0',
              )}
            >{TYPE_LABEL[t]}</button>
          ))}
        </div>

        <div className="mb-3 grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block font-mono text-[10.5px] uppercase tracking-[0.1em] text-fg-3">Platform</span>
            <select className={input} value={workspace} onChange={e => setWorkspace(e.target.value)}>
              {workspaces.map(w => <option key={w.slug} value={w.slug}>{w.label}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block font-mono text-[10.5px] uppercase tracking-[0.1em] text-fg-3">Severity</span>
            <select className={input} value={severity ?? ''} onChange={e => setSeverity((e.target.value || null) as DevSeverity | null)}>
              <option value="">none</option>
              {DEV_SEVERITIES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
        </div>

        <label className="mb-3 block">
          <span className="mb-1 block font-mono text-[10.5px] uppercase tracking-[0.1em] text-fg-3">Title</span>
          <input data-autofocus className={input} value={title} onChange={e => setTitle(e.target.value)} placeholder="What is wrong, in one line" />
        </label>

        <label className="mb-3 block">
          <span className="mb-1 block font-mono text-[10.5px] uppercase tracking-[0.1em] text-fg-3">Description</span>
          <textarea className={cn(input, 'min-h-[80px] resize-y')} value={description} onChange={e => setDescription(e.target.value)} />
        </label>

        {type === 'bug' && (
          <label className="mb-3 block">
            <span className="mb-1 block font-mono text-[10.5px] uppercase tracking-[0.1em] text-fg-3">Steps to reproduce</span>
            <textarea className={cn(input, 'min-h-[70px] resize-y font-mono text-[12px]')} value={steps} onChange={e => setSteps(e.target.value)} />
          </label>
        )}

        <div className="mb-4 grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block font-mono text-[10.5px] uppercase tracking-[0.1em] text-fg-3">Area</span>
            <input className={input} value={area} onChange={e => setArea(e.target.value)} placeholder="checkout" />
          </label>
          <label className="block">
            <span className="mb-1 block font-mono text-[10.5px] uppercase tracking-[0.1em] text-fg-3">Route</span>
            <input className={input} value={route} onChange={e => setRoute(e.target.value)} placeholder="/checkout" />
          </label>
        </div>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={saving} disabled={!title.trim()}>Create item</Button>
        </div>
      </form>
    </Modal>
  )
}
