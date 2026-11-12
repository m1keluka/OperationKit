/**
 * Tools an MCP server offers (obj 900620): name + description, and — for an
 * admin on a saved server — a per-tool on/off switch. A turned-off tool is
 * hidden from chat bots and denied to card sessions (`--disallowedTools`).
 */
import type { McpServerTool } from '@operationkit/shared'
import { cn } from '../ui'

export function McpToolList({
  tools,
  onToggle,
  busyTool,
}: {
  tools: McpServerTool[]
  onToggle?: (name: string, enabled: boolean) => void
  busyTool?: string | null
}) {
  if (tools.length === 0) return <p className="text-[12.5px] text-fg-3">This server lists no tools.</p>
  return (
    <ul className="divide-y divide-line-soft overflow-hidden rounded-md border border-line bg-surface-1" aria-label="Tools">
      {tools.map(t => (
        <li key={t.name} className="flex items-start gap-3 px-3 py-2">
          <div className="min-w-0 flex-1">
            <div className={cn('font-mono text-[12.5px]', t.enabled ? 'text-fg-0' : 'text-fg-3 line-through')}>{t.name}</div>
            {t.description && <div className="mt-0.5 line-clamp-2 text-[12px] leading-relaxed text-fg-2">{t.description}</div>}
          </div>
          {onToggle && (
            <label className="mt-0.5 inline-flex shrink-0 cursor-pointer items-center gap-1.5 text-[12px] text-fg-2">
              <input
                type="checkbox"
                className="h-4 w-4 accent-[color:var(--accent)]"
                checked={t.enabled}
                disabled={busyTool === t.name}
                onChange={e => onToggle(t.name, e.target.checked)}
                aria-label={`${t.enabled ? 'Turn off' : 'Turn on'} ${t.name}`}
              />
              {t.enabled ? 'On' : 'Off'}
            </label>
          )}
        </li>
      ))}
    </ul>
  )
}
