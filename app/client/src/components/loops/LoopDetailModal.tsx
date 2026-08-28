/**
 * Loop detail modal — extracted from LoopsPage.tsx (behavior frozen).
 */
import { useState, useCallback } from 'react'
import { api } from '../../lib/api'
import { MarkdownEditor } from '../MarkdownEditor'
import {
  Button, Badge, StatusPill, Alert, Modal, useConfirm, cn,
} from '../ui'
import {
  STATUSES, STATUS_LABEL, PROJECT_KEYS, PROJECT_LABEL, STATUS_PIPELINE,
  type Loop, type LoopStatus, type Project,
} from './types'

export function LoopDetailModal({
  loop,
  onClose,
  onUpdated,
  onArchived,
}: {
  loop: Loop
  onClose: () => void
  onUpdated: (l: Loop) => void
  onArchived: (slug: string) => void
}) {
  const [error, setError] = useState<string | null>(null)
  const [newTag, setNewTag] = useState('')
  const [projectEdit, setProjectEdit] = useState<Project>(loop.project)
  const [dueEdit, setDueEdit] = useState(loop.due)
  const [peopleEdit, setPeopleEdit] = useState(loop.party)
  const [archiving, setArchiving] = useState(false)
  const enc = encodeURIComponent(loop.slug)
  const { confirm, confirmDialog } = useConfirm()

  const archive = useCallback(async () => {
    if (!(await confirm({
      title: 'Archive loop?',
      message: `“${loop.title}” will be removed from the board (reversible).`,
      confirmLabel: 'Archive',
      danger: true,
    }))) return
    setArchiving(true)
    setError(null)
    try {
      await api.del<{ ok: boolean }>(`/loops/${enc}`)
      onArchived(loop.slug)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to archive loop')
      setArchiving(false)
    }
  }, [enc, loop.slug, loop.title, onArchived, confirm])

  const patchMeta = useCallback(
    async (patch: { project?: string; due?: string; party?: string; tags?: string[] }) => {
      setError(null)
      try {
        const res = await api.patch<{ loop: Loop }>(`/loops/${enc}/meta`, patch)
        onUpdated(res.loop)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to update loop')
      }
    },
    [enc, onUpdated],
  )

  const saveBody = useCallback(
    async (body: string) => {
      const res = await api.patch<{ loop: Loop }>(`/loops/${enc}/body`, { body })
      onUpdated(res.loop)
    },
    [enc, onUpdated],
  )

  const setStatus = useCallback(
    async (status: LoopStatus) => {
      setError(null)
      try {
        const res = await api.patch<{ loop: Loop }>(`/loops/${enc}/status`, { status })
        onUpdated(res.loop)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to move loop')
      }
    },
    [enc, onUpdated],
  )

  const addTag = useCallback(() => {
    const t = newTag.trim()
    if (!t || loop.tags.includes(t)) {
      setNewTag('')
      return
    }
    patchMeta({ tags: [...loop.tags, t] })
    setNewTag('')
  }, [newTag, loop.tags, patchMeta])

  const removeTag = useCallback((t: string) => patchMeta({ tags: loop.tags.filter(x => x !== t) }), [loop.tags, patchMeta])

  const fieldClass =
    'w-full rounded-md border border-line bg-surface-3 px-3 py-2 text-sm text-fg-0 outline-none transition-colors duration-fast focus:border-accent'
  const labelClass = 'mb-1.5 block font-mono text-[10px] uppercase tracking-[0.12em] text-fg-3'

  return (
    <Modal open onClose={onClose} variant="center" labelledBy="loop-detail-title" panelClassName="max-w-2xl bg-surface-2">
      {confirmDialog}
      <div className="p-5">
        <div className="mb-4 flex items-start justify-between gap-3">
          <h2 id="loop-detail-title" className="font-display text-base font-semibold leading-snug tracking-[-0.01em] text-fg-0">{loop.title}</h2>
          <button
            onClick={onClose}
            aria-label="close"
            className="-mr-1 -mt-1 grid h-9 w-9 shrink-0 place-items-center rounded-md text-fg-3 transition-colors duration-fast hover:bg-surface-3 hover:text-fg-0"
          >
            ✕
          </button>
        </div>

        {/* Status mover */}
        <div className="mb-4">
          <span className={labelClass}>Stage</span>
          <div className="flex flex-wrap items-center gap-2">
            {STATUSES.map(s => (
              <Button
                key={s}
                size="sm"
                variant={loop.status === s ? 'primary' : 'secondary'}
                onClick={() => setStatus(s)}
              >
                {STATUS_LABEL[s]}
              </Button>
            ))}
            {loop.status !== 'pending' && (
              <StatusPill status={STATUS_PIPELINE[loop.status]} className="ml-1" />
            )}
          </div>
        </div>

        {/* Project + Due */}
        <div className="mb-4 flex flex-wrap gap-3">
          <label className="flex-1 min-w-[140px]">
            <span className={labelClass}>Project</span>
            <select
              value={projectEdit}
              onChange={e => {
                const v = e.target.value as Project
                setProjectEdit(v)
                patchMeta({ project: v })
              }}
              className={cn(fieldClass, 'px-2 text-fg-1')}
            >
              <option value="">— none —</option>
              {PROJECT_KEYS.map(p => (
                <option key={p} value={p}>{PROJECT_LABEL[p]}</option>
              ))}
            </select>
          </label>
          <label className="flex-1 min-w-[140px]">
            <span className={labelClass}>Due date</span>
            <input
              type="date"
              value={dueEdit}
              onChange={e => setDueEdit(e.target.value)}
              onBlur={() => dueEdit !== loop.due && patchMeta({ due: dueEdit })}
              className={cn(fieldClass, 'px-2 font-mono text-fg-1')}
            />
          </label>
        </div>

        {/* People */}
        <label className="mb-4 block">
          <span className={labelClass}>People (optional)</span>
          <input
            value={peopleEdit}
            onChange={e => setPeopleEdit(e.target.value)}
            onBlur={() => peopleEdit.trim() !== loop.party && patchMeta({ party: peopleEdit.trim() })}
            placeholder="who else is involved"
            className={fieldClass}
          />
        </label>

        {/* Meta line */}
        <div className="mb-4 flex flex-wrap items-center gap-2 font-mono text-[11px] text-fg-3">
          <span>Created {loop.opened || '—'}</span>
          {loop.status === 'done' && loop.closed && <span>Done {loop.closed}</span>}
          {loop.source_meeting ? (
            <Badge tone="accent">auto · from meeting</Badge>
          ) : (
            <Badge tone="neutral">manual</Badge>
          )}
        </div>

        {/* Tags */}
        <div className="mb-4">
          <span className={labelClass}>Tags</span>
          <div className="flex flex-wrap items-center gap-2">
            {loop.tags.map(t => (
              <Badge key={t} tone="neutral">
                {t}
                <button
                  onClick={() => removeTag(t)}
                  className="text-fg-3 transition-colors duration-fast hover:text-signal-alarm"
                  aria-label={`remove ${t}`}
                >
                  ×
                </button>
              </Badge>
            ))}
            <input
              value={newTag}
              onChange={e => setNewTag(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  addTag()
                }
              }}
              onBlur={addTag}
              placeholder="+ tag"
              className="w-24 rounded-md border border-line bg-surface-3 px-2 py-1 text-[11px] text-fg-1 outline-none transition-colors duration-fast focus:border-accent"
            />
          </div>
        </div>

        {/* Notes (markdown) */}
        <div>
          <span className={labelClass}>Notes / context</span>
          <MarkdownEditor value={loop.body} onSave={saveBody} rows={10} />
        </div>

        {error && (
          <Alert tone="alarm" className="mt-3">
            {error}
          </Alert>
        )}

        {/* Danger zone — archive (reversible) */}
        <div className="mt-5 flex justify-end border-t border-line-soft pt-4">
          <Button variant="danger" size="sm" onClick={archive} disabled={archiving} leftIcon={<span aria-hidden>🗑</span>}>
            {archiving ? 'Archiving…' : 'Archive loop'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
