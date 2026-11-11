/**
 * PostHog Self-Driving PR inbox panel (W2 / obj 712024).
 *
 * Renders open PRs authored by posthog[bot] that were discovered by the
 * server-side sweep. Each item is labelled as "PostHog Self-Driving" and
 * links directly to the GitHub PR.
 */
import { useEffect, useState } from 'react'
import { ExternalLink, Sparkles } from 'lucide-react'
import { api } from '../../lib/api'

interface PosthogBotPrItem {
  id: number
  workspace: string
  title: string
  description: string
  area: string | null
  status: string
  created_at: string
  source_id: string  // the GitHub PR URL
}

interface PosthogBotPrsResponse {
  items: PosthogBotPrItem[]
}

export function PosthogSelfDrivingPanel({ workspace }: { workspace?: string }) {
  const [items, setItems] = useState<PosthogBotPrItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    const qs = workspace ? `?workspace=${encodeURIComponent(workspace)}` : ''
    api
      .get<PosthogBotPrsResponse>(`/admin/workspaces/posthog-bot-prs${qs}`)
      .then(r => {
        setItems(r.items ?? [])
      })
      .catch(err => {
        setError((err as Error).message)
      })
      .finally(() => setLoading(false))
  }, [workspace])

  if (loading) return null
  if (error || items.length === 0) return null

  return (
    <div className="mb-4 rounded-lg border border-border bg-surface-2 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border bg-surface-1">
        <Sparkles className="h-4 w-4 text-violet-500 shrink-0" />
        <span className="text-[13px] font-semibold text-fg-1">PostHog Self-Driving</span>
        <span className="ml-auto rounded-full bg-violet-100 dark:bg-violet-900/40 px-2 py-0.5 text-[11px] font-medium text-violet-700 dark:text-violet-300">
          {items.length} open {items.length === 1 ? 'PR' : 'PRs'}
        </span>
      </div>
      <ul className="divide-y divide-border">
        {items.map(item => {
          const prUrl = item.source_id
          return (
            <li key={item.id} className="flex items-start gap-3 px-4 py-3 hover:bg-surface-3 transition-colors">
              <div className="flex-1 min-w-0">
                <a
                  href={prUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 text-[13px] font-medium text-fg-1 hover:text-violet-600 dark:hover:text-violet-400 truncate"
                  title={item.title}
                >
                  {item.title}
                  <ExternalLink className="h-3 w-3 shrink-0 opacity-60" />
                </a>
                <p className="text-[11.5px] text-fg-3 mt-0.5">{item.workspace}</p>
              </div>
              <span className="shrink-0 rounded px-1.5 py-0.5 text-[10.5px] font-medium bg-violet-50 dark:bg-violet-950/30 text-violet-700 dark:text-violet-400 border border-violet-200 dark:border-violet-800">
                Self-Driving
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
