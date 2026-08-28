/**
 * New-loop modal — extracted from LoopsPage.tsx (behavior frozen).
 */
import { useState, useCallback } from 'react'
import { api } from '../../lib/api'
import { Button, Alert, Modal, cn } from '../ui'
import { PROJECT_KEYS, PROJECT_LABEL, type Loop, type Project } from './types'

export function NewLoopModal({ onClose, onCreated }: { onClose: () => void; onCreated: (loop: Loop) => void }) {
  const [title, setTitle] = useState('')
  const [project, setProject] = useState<Project>('')
  const [due, setDue] = useState('')
  const [people, setPeople] = useState('')
  const [tagsInput, setTagsInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = useCallback(async () => {
    setSaving(true)
    setError(null)
    try {
      const tags = tagsInput.split(',').map(t => t.trim()).filter(Boolean)
      const res = await api.post<{ ok: boolean; loop: Loop }>('/loops', {
        party: people.trim(),
        title: title.trim(),
        project,
        due,
        tags,
      })
      onCreated(res.loop)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create loop')
    } finally {
      setSaving(false)
    }
  }, [people, title, project, due, tagsInput, onCreated])

  const fieldClass =
    'w-full rounded-md border border-line bg-surface-3 px-3 py-2.5 text-sm text-fg-0 outline-none transition-colors duration-fast focus:border-accent'
  const labelClass = 'mb-1 block font-mono text-[10px] uppercase tracking-[0.12em] text-fg-3'

  return (
    <Modal open onClose={onClose} variant="center" labelledBy="new-loop-title" panelClassName="max-w-md bg-surface-2">
      <div className="p-5">
        <h2 id="new-loop-title" className="mb-4 font-display text-base font-semibold tracking-[-0.01em] text-fg-0">New loop</h2>
        <div className="space-y-3">
          <label className="block">
            <span className={labelClass}>Title (required)</span>
            <input
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="e.g. waiting on signed contract — or — ship SMS lead-flow"
              autoFocus
              className={fieldClass}
            />
          </label>
          <div className="flex gap-3">
            <label className="flex-1">
              <span className={labelClass}>Project</span>
              <select
                value={project}
                onChange={e => setProject(e.target.value as Project)}
                className={cn(fieldClass, 'px-2 text-fg-1')}
              >
                <option value="">— none —</option>
                {PROJECT_KEYS.map(p => (
                  <option key={p} value={p}>{PROJECT_LABEL[p]}</option>
                ))}
              </select>
            </label>
            <label className="flex-1">
              <span className={labelClass}>Due date</span>
              <input
                type="date"
                value={due}
                onChange={e => setDue(e.target.value)}
                className={cn(fieldClass, 'px-2 font-mono text-fg-1')}
              />
            </label>
          </div>
          <label className="block">
            <span className={labelClass}>People (optional)</span>
            <input
              value={people}
              onChange={e => setPeople(e.target.value)}
              placeholder="who else is involved — leave blank for a personal to-do"
              className={fieldClass}
            />
          </label>
          <label className="block">
            <span className={labelClass}>Tags (comma-separated, optional)</span>
            <input
              value={tagsInput}
              onChange={e => setTagsInput(e.target.value)}
              placeholder="contract, pricing"
              className={fieldClass}
            />
          </label>
        </div>
        {error && (
          <Alert tone="alarm" className="mt-3">
            {error}
          </Alert>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={submit} disabled={saving || !title.trim()}>
            {saving ? 'Creating…' : 'Create loop'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
