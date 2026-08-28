/**
 * Tools Settings tab — extracted from ConfigPage.tsx (behavior frozen).
 */
import { Plug } from 'lucide-react'
import { Card } from '../ui'

export function ToolsTab() {
  const tools = ['Google Workspace', 'Playwright', 'Resend', 'Notion', 'Gmail', 'Google Calendar', 'Fireflies', 'Canva']
  return (
    <Card>
      <div className="text-center">
        <div className="mx-auto grid h-11 w-11 place-items-center rounded-lg border border-line bg-surface-3 text-fg-2">
          <Plug className="h-5 w-5" />
        </div>
        <h3 className="mt-3 font-display text-[15px] font-semibold text-fg-1">MCP Tool Connections</h3>
        <p className="mx-auto mt-1.5 max-w-md text-[13px] leading-relaxed text-fg-3">
          No MCP servers configured on the VPS. Tool connections (Google Workspace, Playwright, Resend, Notion, etc.)
          are configured on your local machine and available when running Claude Code locally.
        </p>
      </div>
      <div className="mx-auto mt-5 grid max-w-lg grid-cols-2 gap-2.5 sm:grid-cols-4">
        {tools.map(tool => (
          <div key={tool} className="rounded-md border border-line bg-surface-1 px-3 py-2 text-center">
            <div className="text-[12px] font-medium text-fg-2">{tool}</div>
            <div className="mt-0.5 font-mono text-[10px] text-fg-3">Local only</div>
          </div>
        ))}
      </div>
    </Card>
  )
}
