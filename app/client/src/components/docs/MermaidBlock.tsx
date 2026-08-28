import { useEffect, useRef, useState } from 'react'
import { createReactBlockSpec } from '@blocknote/react'
import { renderMermaidIn } from '../../lib/mermaid'

/**
 * Custom BlockNote block: renders a mermaid diagram.
 *
 * On parse, ```mermaid code blocks are converted to this block (see DocsPage).
 * The diagram is read-only; click "Show source" to reveal a textarea that
 * edits the underlying mermaid source. Changes flow back into the block's
 * `source` prop, which serializes as ```mermaid on save.
 */
export const mermaidBlockSpec = createReactBlockSpec(
  {
    type: 'mermaid',
    propSchema: {
      source: { default: '' },
    },
    content: 'none',
  },
  {
    render: ({ block, editor }) => {
      const source = (block.props as { source: string }).source
      const containerRef = useRef<HTMLDivElement>(null)
      const [showSource, setShowSource] = useState(false)
      const [draft, setDraft] = useState(source)

      // Whenever the saved source changes (e.g. doc reload), kick mermaid to
      // re-render. Mermaid's render is keyed off the source attr we put on
      // the placeholder.
      useEffect(() => {
        setDraft(source)
        const el = containerRef.current
        if (!el) return
        // Reset rendered marker so renderMermaidIn picks it up again with new source.
        const placeholder = el.querySelector<HTMLElement>('.mermaid-block')
        if (placeholder) {
          placeholder.removeAttribute('data-mermaid-rendered')
          placeholder.setAttribute('data-mermaid-source', source)
          placeholder.innerHTML = ''
        }
        renderMermaidIn(el)
      }, [source])

      const commit = () => {
        if (draft !== source) {
          editor.updateBlock(block, { props: { source: draft } })
        }
      }

      return (
        <div className="my-2 w-full">
          <div ref={containerRef}>
            <div
              className="mermaid-block flex justify-center rounded-lg border border-white/5 bg-black/20 p-3 overflow-x-auto"
              data-mermaid-source={source}
            />
          </div>
          <details
            className="mt-1 text-xs text-gray-400"
            open={showSource}
            onToggle={(e) => setShowSource((e.target as HTMLDetailsElement).open)}
          >
            <summary className="cursor-pointer select-none text-[11px] text-gray-500 hover:text-gray-300">
              Mermaid source
            </summary>
            <textarea
              className="mt-1 w-full rounded border border-border bg-black/30 p-2 font-mono text-[11px] text-gray-200 focus:border-accent focus:outline-none"
              rows={Math.max(3, Math.min(12, draft.split('\n').length + 1))}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              spellCheck={false}
            />
          </details>
        </div>
      )
    },
    // Round-trip serialization: emit ```mermaid so blocksToMarkdownLossy
    // produces a fence the markdown parser will reconvert on next load.
    toExternalHTML: ({ block }) => {
      const source = (block.props as { source: string }).source
      return (
        <pre>
          <code className="language-mermaid">{source}</code>
        </pre>
      )
    },
  },
)
