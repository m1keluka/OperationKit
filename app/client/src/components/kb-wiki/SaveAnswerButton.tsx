import { useEffect, useState } from 'react'
import { BookmarkPlus, Check } from 'lucide-react'
import { Alert, Button } from '../ui'
import { wikiApi } from './wikiApi'

/* SaveAnswerButton (obj 720117) — files an Ask answer back into the wiki as its
   own page, linked from every page it used. POST /api/kb-wiki/answers. */
export function SaveAnswerButton({
  workspace,
  question,
  answer,
  sources,
  onOpen,
  onSaved,
}: {
  workspace: string
  question: string
  answer: string
  sources: Array<{ rel: string }>
  onOpen: (rel: string) => void
  onSaved?: (page: { rel: string; title: string }) => void
}) {
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState<{ rel: string; title: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  // A new answer gets a fresh button.
  useEffect(() => { setSaved(null); setError(null) }, [answer, question])

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const page = await wikiApi<{ rel: string; title: string }>('/answers', {
        method: 'POST',
        json: { workspace, question, answer, sources: sources.map(s => s.rel) },
      })
      setSaved(page)
      onSaved?.(page)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mt-4 flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          onClick={() => { void save() }}
          loading={saving}
          disabled={!!saved || !question.trim()}
          leftIcon={saved ? <Check className="h-4 w-4 text-signal-verify" aria-hidden="true" /> : <BookmarkPlus className="h-4 w-4" aria-hidden="true" />}
        >
          {saved ? 'Saved to wiki' : 'Save to wiki'}
        </Button>
        {saved ? (
          <span className="flex min-w-0 flex-wrap items-center gap-2 text-[12.5px] text-fg-2" aria-live="polite">
            Saved as <span className="font-medium text-fg-0">{saved.title}</span>
            <Button size="sm" variant="ghost" className="min-h-[44px] sm:min-h-[32px]" onClick={() => onOpen(saved.rel)}>Open</Button>
          </span>
        ) : (
          <span className="text-[12px] text-fg-3">Keeps this answer as a page, linked from the pages it used.</span>
        )}
      </div>
      {error && <Alert tone="alarm" title="Couldn't save the answer">{error}</Alert>}
    </div>
  )
}
