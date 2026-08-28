/**
 * Mermaid renderer — shared by chat bubbles (lib/markdown.ts → SessionMessages)
 * and DocsPage (BlockNote post-render swap).
 *
 * Mermaid is large (~1MB minified). Loaded lazily on first call so users who
 * never see a diagram never pay the cost.
 */

let mermaidPromise: Promise<typeof import('mermaid').default> | null = null

/** Lazy-load + initialize mermaid once. Subsequent calls reuse the same instance. */
async function getMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then(mod => {
      const mermaid = mod.default
      mermaid.initialize({
        startOnLoad: false,
        theme: 'dark',
        securityLevel: 'strict',
        fontFamily: 'inherit',
        themeVariables: {
          background: 'transparent',
          primaryColor: '#1f2937',
          primaryTextColor: '#e5e7eb',
          primaryBorderColor: '#374151',
          lineColor: '#6b7280',
          secondaryColor: '#111827',
          tertiaryColor: '#0f172a',
        },
      })
      return mermaid
    })
  }
  return mermaidPromise
}

let renderCounter = 0

/**
 * All renders are serialized through this queue. mermaid.render() parks a temp
 * `div#dmermaid-svg-*` on document.body and re-selects it mid-render; our
 * cleanupOrphanMermaid() sweep removes ALL such divs. With multiple diagrams on
 * a page (each MermaidBlock fires its own renderMermaidIn), a finishing call's
 * sweep deletes the temp container of renders still in flight, which crashes
 * mermaid with "Cannot read properties of null (reading 'firstChild')".
 * Serializing guarantees the sweep only ever runs between renders.
 */
let renderChain: Promise<void> = Promise.resolve()

/**
 * Render every `.mermaid-block` placeholder inside `container` into an SVG.
 * Each placeholder must carry `data-mermaid-source` with the diagram source.
 *
 * Idempotent: a placeholder marked `data-mermaid-rendered` is skipped, so this
 * is safe to call after every parent re-render.
 */
export function renderMermaidIn(container: HTMLElement | null): Promise<void> {
  const task = renderChain.then(() => renderMermaidInSerial(container))
  renderChain = task.catch(() => {})
  return task
}

async function renderMermaidInSerial(container: HTMLElement | null) {
  if (!container) return
  const placeholders = container.querySelectorAll<HTMLElement>(
    '.mermaid-block:not([data-mermaid-rendered])',
  )
  if (placeholders.length === 0) return
  const mermaid = await getMermaid()

  for (const el of Array.from(placeholders)) {
    const source = el.getAttribute('data-mermaid-source') || ''
    if (!source.trim()) continue
    // Mark rendered FIRST and never unmark on failure: mermaid.render() leaks an
    // error SVG into document.body for each call with bad syntax, so retrying
    // on every parent re-render piles up orphan "Syntax error in text" boxes.
    el.setAttribute('data-mermaid-rendered', '1')
    const id = `mermaid-svg-${++renderCounter}`

    // Validate first — parse() with suppressErrors returns false instead of
    // throwing, and skipping render() entirely avoids the body-leak path.
    const ok = await mermaid
      .parse(source, { suppressErrors: true })
      .catch(() => false)
    if (!ok) {
      el.innerHTML = errorBlockHtml('Mermaid syntax error', source)
      continue
    }

    try {
      const { svg } = await mermaid.render(id, source)
      el.innerHTML = svg
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      el.innerHTML = errorBlockHtml(msg, source)
    }
  }

  cleanupOrphanMermaid()
}

/**
 * Mermaid v11 sometimes leaves its temp render wrapper or an error SVG attached
 * to document.body. Sweep any direct body children that look like they came
 * from a mermaid render call.
 */
export function cleanupOrphanMermaid() {
  document
    .querySelectorAll<HTMLElement>(
      'body > div[id^="dmermaid-svg-"], body > svg[id^="mermaid-svg-"]',
    )
    .forEach((el) => el.remove())
}

function errorBlockHtml(message: string, source: string): string {
  return (
    `<div class="rounded border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300">` +
    `<div class="font-medium mb-1">Mermaid render failed</div>` +
    `<div class="font-mono text-[11px] text-red-400/80 whitespace-pre-wrap">${escapeHtml(message)}</div>` +
    `<details class="mt-2"><summary class="cursor-pointer text-red-300/80">Source</summary>` +
    `<pre class="mt-1 overflow-x-auto bg-black/30 p-2 text-[11px]"><code>${escapeHtml(source)}</code></pre>` +
    `</details></div>`
  )
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Build the placeholder HTML that `renderMermaidIn` knows how to fill in.
 * Used by lib/markdown.ts when it sees a ```mermaid fence.
 *
 * Source must be raw (un-escaped). The fallback shows the source as code if
 * the render hasn't run yet (or JS is disabled).
 */
export function mermaidPlaceholderHtml(source: string): string {
  const escapedAttr = source.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
  const escapedFallback = escapeHtml(source)
  return (
    `<div class="mermaid-block my-3 flex justify-center rounded-lg border border-white/5 bg-black/20 p-3 overflow-x-auto" data-mermaid-source="${escapedAttr}">` +
    `<pre class="text-xs text-gray-500"><code>${escapedFallback}</code></pre>` +
    `</div>`
  )
}
