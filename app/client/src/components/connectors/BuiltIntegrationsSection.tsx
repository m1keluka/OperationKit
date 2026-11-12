/**
 * Settings → Integrations → "Built with the Integrations bot" (obj 900682).
 *
 * OperationKit Tools an Integrations bot scaffolded for ONE workspace. MCP
 * servers a bot connected are ordinary #900620 servers and already show in the
 * MCP servers list, so only Tools are listed here. Only secret NAMES are shown.
 */
import { useEffect, useState } from 'react'
import type { IntegrationBuildSummary } from '@operationkit/shared'
import { api } from '../../lib/api'
import { Badge, Card } from '../ui'
import { useNavigate } from '../../context/nav'

export function BuiltIntegrationsSection({
  workspace,
  onLoaded,
}: {
  workspace: string
  onLoaded?: (tools: IntegrationBuildSummary[]) => void
}) {
  const [builds, setBuilds] = useState<IntegrationBuildSummary[]>([])
  const navigate = useNavigate()

  useEffect(() => {
    if (!workspace) return
    let live = true
    api.get<IntegrationBuildSummary[]>(`/integrations/builds?workspace=${encodeURIComponent(workspace)}`)
      .then(list => {
        if (!live) return
        const tools = (Array.isArray(list) ? list : []).filter(b => b.kind === 'tool')
        setBuilds(tools)
        onLoaded?.(tools)
      })
      .catch(() => { if (live) { setBuilds([]); onLoaded?.([]) } })
    return () => { live = false }
    // onLoaded is a parent callback; re-fetch only when the workspace changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace])

  if (builds.length === 0) return null
  return (
    <section aria-labelledby="built-integrations-title" className="space-y-3" data-testid="built-integrations">
      <div>
        <h3 id="built-integrations-title" className="font-display text-[15px] font-semibold text-fg-0">Built with the Integrations bot</h3>
        <p className="mt-0.5 text-[12.5px] leading-relaxed text-fg-2">
          Tools agents in this workspace can use. Keys live in Settings → Secrets under the names shown.
        </p>
      </div>
      {builds.map(b => (
        <Card inset key={b.id} className="p-4 sm:p-5" data-testid={`built-${b.ref}`}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h4 className="text-[14.5px] font-semibold text-fg-0">{b.name}</h4>
                <Badge tone="verify">Connected</Badge>
                <Badge tone="neutral">Tool</Badge>
              </div>
              {b.description && <p className="mt-1 text-[12.5px] leading-relaxed text-fg-2">{b.description}</p>}
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[12px] text-fg-3">
                <span>Tool <code className="font-mono text-fg-2">{b.ref}</code></span>
                {b.secret_names.length > 0 && <span>· uses</span>}
                {b.secret_names.map(n => <code key={n} className="rounded bg-surface-3 px-1 font-mono text-fg-2">{n}</code>)}
              </div>
            </div>
            <button
              type="button"
              onClick={() => navigate(`/o/${b.objective_id}`)}
              className="min-h-[36px] rounded-md px-2 text-[12.5px] text-fg-2 underline-offset-2 hover:text-fg-0 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
            >
              Built on card #{b.objective_id}
            </button>
          </div>
        </Card>
      ))}
    </section>
  )
}
