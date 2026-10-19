import { mermaidPlaceholderHtml } from './mermaid'

/**
 * Markdown-to-HTML using v1.0 design system tokens (§07 prose).
 *
 * Output is passed to dangerouslySetInnerHTML — all input is HTML-escaped after
 * code-block extraction. Mermaid fences emit a placeholder that renderMermaidIn
 * swaps to SVG. Diff fences (```diff) are tinted per-line via .cc-diff-add /
 * .cc-diff-del.
 */
export function renderMarkdown(text: string): string {
  // Extract code blocks first to protect them from other transforms
  const codeBlocks: string[] = []
  let html = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
    const idx = codeBlocks.length
    const trimmed = code.trim()
    if (lang === 'mermaid') {
      codeBlocks.push(mermaidPlaceholderHtml(trimmed))
      return `\x00CODEBLOCK${idx}\x00`
    }
    const escaped = trimmed.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    if (lang === 'diff') {
      const rows = escaped.split('\n').map((line: string) => {
        if (line.startsWith('+++') || line.startsWith('---')) {
          return `<span class="block text-fg-3">${line}</span>`
        }
        if (line.startsWith('+')) return `<span class="block cc-diff-add px-2">${line}</span>`
        if (line.startsWith('-')) return `<span class="block cc-diff-del px-2">${line}</span>`
        return `<span class="block text-fg-2 px-2">${line}</span>`
      }).join('')
      codeBlocks.push(
        `<div class="relative group my-2">` +
        `<button data-copy-code class="absolute top-1.5 right-1.5 rounded-xs px-1.5 py-0.5 text-[10px] text-fg-3 bg-surface-3 hover:bg-surface-4 hover:text-fg-1 opacity-0 group-hover:opacity-100 transition-opacity" title="Copy">Copy</button>` +
        `<pre class="bg-surface-1 rounded-md p-2 pr-14 text-xs overflow-x-auto border border-line-soft font-mono">${rows}</pre>` +
        `</div>`
      )
      return `\x00CODEBLOCK${idx}\x00`
    }
    codeBlocks.push(
      `<div class="relative group my-2">` +
      `<button data-copy-code class="absolute top-1.5 right-1.5 rounded-xs px-1.5 py-0.5 text-[10px] text-fg-3 bg-surface-3 hover:bg-surface-4 hover:text-fg-1 opacity-0 group-hover:opacity-100 transition-opacity" title="Copy">Copy</button>` +
      `<pre class="bg-surface-1 rounded-md p-3 pr-14 text-xs overflow-x-auto border border-line-soft"><code class="font-mono text-fg-0">${escaped}</code></pre>` +
      `</div>`
    )
    return `\x00CODEBLOCK${idx}\x00`
  })

  // Escape HTML (after code blocks extracted)
  html = html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  // Headers — §07 prose hierarchy
  html = html.replace(/^#### (.+)$/gm, '<h4 class="text-xs font-semibold uppercase tracking-wider text-fg-2 mt-3 mb-1">$1</h4>')
  html = html.replace(/^### (.+)$/gm, '<h3 class="text-sm font-semibold text-fg-0 mt-3 mb-1">$1</h3>')
  html = html.replace(/^## (.+)$/gm, '<h2 class="text-base font-semibold text-fg-0 mt-4 mb-1.5">$1</h2>')
  html = html.replace(/^# (.+)$/gm, '<h1 class="text-lg font-semibold text-fg-0 mt-4 mb-2">$1</h1>')

  // Horizontal rule
  html = html.replace(/^---+$/gm, '<hr class="border-line-soft my-3"/>')

  // Tables (simple pipe-delimited)
  html = html.replace(/((?:^\|.+\|$\n?)+)/gm, (tableBlock) => {
    const rows = tableBlock.trim().split('\n').filter(r => r.trim())
    if (rows.length < 2) return tableBlock
    const isSep = /^\|[\s-:|]+\|$/.test(rows[1])
    const dataRows = isSep ? [rows[0], ...rows.slice(2)] : rows
    const rowsHtml = dataRows.map((row, i) => {
      const cells = row.split('|').filter((_, ci, arr) => ci > 0 && ci < arr.length - 1)
      const tag = i === 0 && isSep ? 'th' : 'td'
      const cls = i === 0 && isSep
        ? 'text-left text-[11px] font-medium uppercase tracking-wider text-fg-2 px-2 py-1.5 border-b border-line'
        : 'text-left text-xs text-fg-1 px-2 py-1 border-b border-line-soft'
      return `<tr>${cells.map(c => `<${tag} class="${cls}">${c.trim()}</${tag}>`).join('')}</tr>`
    }).join('')
    return `<table class="w-full my-2 text-xs">${rowsHtml}</table>`
  })

  // Unordered lists (- item)
  html = html.replace(/^(\s*)- (.+)$/gm, (_m, indent, content) => {
    const depth = Math.floor(indent.length / 2)
    const ml = depth > 0 ? ` ml-${depth * 4}` : ''
    return `<div class="flex gap-2 my-0.5${ml}"><span class="text-fg-3 select-none">•</span><span class="text-fg-1">${content}</span></div>`
  })

  // Ordered lists (1. item)
  html = html.replace(/^(\s*)(\d+)\. (.+)$/gm, (_m, indent, num, content) => {
    const depth = Math.floor(indent.length / 2)
    const ml = depth > 0 ? ` ml-${depth * 4}` : ''
    return `<div class="flex gap-2 my-0.5${ml}"><span class="text-fg-3 select-none min-w-[1.2em] text-right font-mono">${num}.</span><span class="text-fg-1">${content}</span></div>`
  })

  // Inline code — mono signal on quiet surface, neutral fg
  html = html.replace(/`([^`]+)`/g, '<code class="bg-surface-3 rounded-xs px-1.5 py-0.5 text-[11px] font-mono text-fg-0">$1</code>')

  // Bold + italic
  html = html.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong class="text-fg-0"><em>$1</em></strong>')
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong class="text-fg-0">$1</strong>')
  html = html.replace(/\*([^*]+)\*/g, '<em class="text-fg-1">$1</em>')

  // Links [text](url)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" class="text-accent hover:underline">$1</a>')

  // Clickable markdown file paths — any .md under /home/operator/
  const docPathRe = /(?:\/home\/mike\/[\w./-]+\.md|~\/[\w./-]+\.md)/g
  html = html.replace(docPathRe, (match) => {
    const fullPath = match.startsWith('~/')
      ? '/home/operator/' + match.slice(2)
      : match
    return `<a data-doc-path="${fullPath}" class="text-accent hover:underline cursor-pointer font-mono" title="Click to edit">${match}</a>`
  })

  // Newlines to <br> (but not after block elements)
  html = html.replace(/\n/g, '<br/>')

  // Clean up excessive <br/> after block elements
  html = html.replace(/(<\/h[1-4]>)(<br\/>)+/g, '$1')
  html = html.replace(/(<\/div>)(<br\/>)+/g, '$1')
  html = html.replace(/(<hr[^>]*\/>)(<br\/>)+/g, '$1')
  html = html.replace(/(<\/table>)(<br\/>)+/g, '$1')
  html = html.replace(/(<br\/>)+(<h[1-4])/g, '$2')
  html = html.replace(/(<br\/>)+(<hr)/g, '$2')

  // Restore code blocks
  html = html.replace(/\x00CODEBLOCK(\d+)\x00/g, (_m, idx) => codeBlocks[parseInt(idx)])

  return html
}
