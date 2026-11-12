import { useEffect, useState } from 'react'
import { Network } from 'lucide-react'
import { useWorkspaces } from '../../hooks/useWorkspaces'
import { WorkspaceGraph } from './WorkspaceGraph'

/* KnowledgeGraphPane (obj 900674) — the Knowledge base page's default view:
   the Obsidian-style graph of how every page in a workspace connects. Shown
   whenever no page is open, and from the toolbar's "Graph" toggle. Clicking a
   dot opens that page in the page's own editor. */
export function KnowledgeGraphPane({
  workspace,
  onOpenPath,
  refreshKey = 0,
}: {
  /** The board's workspace selection; 'all' lets the user pick one here. */
  workspace: string
  /** Open an absolute page path in the editor. */
  onOpenPath: (absPath: string) => void
  refreshKey?: number
}) {
  const { slugs, labelOf } = useWorkspaces()
  const [ws, setWs] = useState('')

  // Board selection wins when it names one workspace; otherwise the first one this user has.
  useEffect(() => {
    if (workspace && workspace !== 'all') setWs(workspace)
    else if ((!ws || !slugs.includes(ws)) && slugs.length) setWs(slugs[0])
  }, [workspace, slugs, ws])

  const picker = slugs.length > 1 && workspace === 'all'

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3 sm:p-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="flex items-center gap-2 font-display text-[16px] font-semibold tracking-[-0.01em] text-fg-0">
            <Network className="h-4 w-4 text-accent" aria-hidden="true" />
            How your knowledge base connects
          </h2>
          <p className="max-w-[72ch] text-[12.5px] leading-relaxed text-fg-2">
            Every page is a dot; every link, mention, source and saved answer between two pages is a line.
          </p>
        </div>
        {picker && (
          <label className="flex items-center gap-2 text-[12.5px] text-fg-2">
            Workspace
            <select
              value={ws}
              onChange={e => setWs(e.target.value)}
              className="min-h-[44px] rounded-md border border-line bg-surface-1 px-2 text-[13px] text-fg-0 transition-colors duration-fast hover:border-line-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:min-h-[36px]"
            >
              {slugs.map(s => <option key={s} value={s}>{labelOf(s)}</option>)}
            </select>
          </label>
        )}
      </div>
      {ws && (
        <WorkspaceGraph
          workspace={ws}
          fill
          refreshKey={refreshKey}
          onOpenNote={(rel, root) => { if (root) onOpenPath(`${root.replace(/\/+$/, '')}/${rel}`) }}
        />
      )}
    </div>
  )
}
