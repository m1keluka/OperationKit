/**
 * Private scratchpad — extracted from LoopsPage.tsx (behavior frozen).
 *
 * A private per-user markdown scratch surface (GET/PUT /api/scratchpad). Pure
 * human text — no agent involvement. Loads on mount, autosaves (debounced) via
 * the reused MarkdownEditor in `autosave` mode. Deliberately dead-simple: it is
 * "somewhere to put text", not a document system.
 */
import { useState, useEffect, useCallback } from 'react'
import { api } from '../../lib/api'
import { MarkdownEditor } from '../MarkdownEditor'
import { Card, Badge, Skeleton, Alert } from '../ui'

export function Scratchpad() {
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const res = await api.get<{ content: string; updated_at: string | null }>('/scratchpad')
        if (alive) setContent(res.content || '')
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : 'Failed to load scratchpad')
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  const save = useCallback(async (next: string) => {
    await api.put('/scratchpad', { content: next })
    // Reflect the persisted value so MarkdownEditor's autosave sees "in sync".
    setContent(next)
  }, [])

  return (
    <Card className="mb-6 p-4">
      <div className="mb-2 flex items-center gap-2">
        <h2 className="font-display text-sm font-semibold tracking-[-0.01em] text-fg-0">Scratchpad</h2>
        <Badge tone="neutral" mono>private</Badge>
        <span className="ml-auto font-mono text-[10px] text-fg-3">somewhere to put text</span>
      </div>
      {error && (
        <Alert tone="alarm" className="mb-2">
          {error}
        </Alert>
      )}
      {loading ? (
        <Skeleton className="h-40 w-full rounded-md" />
      ) : (
        <MarkdownEditor
          value={content}
          onSave={save}
          autosave
          autosaveMs={800}
          rows={10}
          placeholder="Jot anything — notes, links, a to-do list. Autosaves as you type."
        />
      )}
    </Card>
  )
}
