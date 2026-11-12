import { useEffect, useRef } from 'react'
import { renderMermaidIn } from '../../lib/mermaid'

/**
 * Read-only workflow diagram, viewer V1 (docs/design/WORKFLOWS.md §6.1): the
 * server renders `definitionToMermaid(definition, { status })` and this draws it
 * through the client's existing lazy Mermaid path. Nothing here is editable.
 */
export function FlowDiagram({ source, className }: { source: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const placeholder = el.querySelector<HTMLElement>('.mermaid-block')
    if (placeholder) {
      placeholder.removeAttribute('data-mermaid-rendered')
      placeholder.setAttribute('data-mermaid-source', source)
      placeholder.innerHTML = ''
    }
    void renderMermaidIn(el)
  }, [source])
  return (
    <div ref={ref} className={className} data-testid="flow-diagram">
      <div
        className="mermaid-block flex justify-center overflow-x-auto rounded-lg border border-line bg-surface-1 p-4"
        data-mermaid-source={source}
      />
    </div>
  )
}

/** What the shapes and outlines mean — kept next to every diagram. */
export function FlowDiagramLegend() {
  const item = 'inline-flex items-center gap-1.5'
  const sw = 'inline-block h-3 w-3 rounded-sm border-2'
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-[12px] text-fg-2" data-testid="flow-diagram-legend">
      <span className={item}>⏰ trigger</span>
      <span className={item}>🔧 tool</span>
      <span className={item}>🔌 MCP connector</span>
      <span className={item}><span className={sw} style={{ background: '#efe3ff', borderColor: '#7a4cc2' }} />🧠 LLM</span>
      <span className={item}><span className={sw} style={{ background: '#fff8db', borderColor: '#a68500' }} />write</span>
      <span className={item}><span className={sw} style={{ background: '#ffe9e0', borderColor: '#c2562b' }} />SEND</span>
      <span className={item}><span className={sw} style={{ background: '#ffe3ea', borderColor: '#c22b55' }} />SPEND</span>
      <span className="text-fg-3">·</span>
      <span className={item}><span className={sw} style={{ borderColor: '#2f8f4e' }} />succeeded</span>
      <span className={item}><span className={sw} style={{ borderColor: '#c22b2b', borderStyle: 'dashed' }} />failed</span>
      <span className={item}><span className={sw} style={{ borderColor: '#2b6fc2' }} />running</span>
      <span className={item}><span className={sw} style={{ borderColor: '#c2952b', borderStyle: 'dotted' }} />waiting</span>
      <span className={item}><span className={sw} style={{ background: '#f2f2f2', borderColor: '#bbbbbb' }} />skipped</span>
    </div>
  )
}
