import { useCallback, useEffect, useRef, useState } from 'react'
import { Save, X } from 'lucide-react'
import { api } from '../lib/api'
import { useCreateBlockNote } from '@blocknote/react'
import { BlockNoteView } from '@blocknote/mantine'
import { BlockNoteSchema, defaultBlockSpecs, type PartialBlock } from '@blocknote/core'
import '@blocknote/mantine/style.css'
import './docs-page.css'
import { mermaidBlockSpec } from './docs/MermaidBlock'

const docsSchema = BlockNoteSchema.create({
  blockSpecs: { ...defaultBlockSpecs, mermaid: mermaidBlockSpec() },
})

type DocsBlock = PartialBlock<typeof docsSchema.blockSchema, typeof docsSchema.inlineContentSchema, typeof docsSchema.styleSchema>

function blocksMermaidIn(blocks: DocsBlock[]): DocsBlock[] {
  return blocks.map(b => {
    if (b.type === 'codeBlock' && (b.props as { language?: string } | undefined)?.language === 'mermaid') {
      const source = extractCodeText(b)
      return { type: 'mermaid', props: { source } } as DocsBlock
    }
    if (b.children && b.children.length > 0) {
      return { ...b, children: blocksMermaidIn(b.children as DocsBlock[]) }
    }
    return b
  })
}

function blocksMermaidOut(blocks: DocsBlock[]): DocsBlock[] {
  return blocks.map(b => {
    if (b.type === 'mermaid') {
      const source = (b.props as { source?: string } | undefined)?.source ?? ''
      return {
        type: 'codeBlock',
        props: { language: 'mermaid' },
        content: [{ type: 'text', text: source, styles: {} }],
      } as DocsBlock
    }
    if (b.children && b.children.length > 0) {
      return { ...b, children: blocksMermaidOut(b.children as DocsBlock[]) }
    }
    return b
  })
}

function extractCodeText(block: DocsBlock): string {
  const content = (block as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((c: { text?: string }) => c.text || '').join('')
  return ''
}

interface FileData {
  path: string
  content: string
  size: number
  modifiedAt: string
  writable: boolean
}

interface FileEditorOverlayProps {
  filePath: string
  onClose: () => void
}

export function FileEditorOverlay({ filePath, onClose }: FileEditorOverlayProps) {
  const [file, setFile] = useState<FileData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [pendingMarkdown, setPendingMarkdown] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [saveError, setSaveError] = useState<string | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    api.get<FileData>(`/docs/file?path=${encodeURIComponent(filePath)}`)
      .then(data => setFile(data))
      .catch(err => setError(err instanceof Error ? err.message : 'Failed to load file'))
      .finally(() => setLoading(false))
  }, [filePath])

  const performSave = useCallback(async (markdown: string) => {
    if (!file || !file.writable) return
    setSaveState('saving')
    setSaveError(null)
    try {
      await api.put('/docs/file', { path: file.path, content: markdown })
      setSaveState('saved')
      setPendingMarkdown(null)
      setFile(prev => (prev ? { ...prev, content: markdown } : prev))
      setTimeout(() => setSaveState(s => (s === 'saved' ? 'idle' : s)), 1500)
    } catch (err) {
      setSaveState('error')
      setSaveError(err instanceof Error ? err.message : 'Save failed')
    }
  }, [file])

  const handleContentChange = useCallback((markdown: string) => {
    setPendingMarkdown(markdown)
    setSaveState('idle')
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => { performSave(markdown) }, 3000)
  }, [performSave])

  const handleManualSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    if (pendingMarkdown !== null) performSave(pendingMarkdown)
  }, [pendingMarkdown, performSave])

  useEffect(() => {
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current) }
  }, [file?.path])

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const displayPath = filePath.replace(/^\/home\/mike\//, '~/')

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center sm:p-6">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />

      {/* Modal — full-sheet on mobile, centered card on desktop */}
      <div className="cc-drawer-in relative z-10 flex flex-col w-full h-full sm:h-[85vh] sm:w-[min(960px,92vw)] sm:rounded-lg border border-line bg-surface-0 shadow-float overflow-hidden">
        {/* Header — quiet meta line, no decorative chrome */}
        <div className="flex items-center justify-between gap-2 border-b border-line bg-surface-1 px-4 py-2">
          <div className="min-w-0 truncate text-xs">
            <span className="font-mono text-fg-0">{displayPath}</span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {file && !file.writable && (
              <span className="rounded-xs bg-status-review/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-status-review">
                Read-only
              </span>
            )}
            {saveState === 'saving' && <span className="text-[10px] text-fg-3">Saving…</span>}
            {saveState === 'saved' && <span className="text-[10px] text-status-done">Saved</span>}
            {saveState === 'error' && <span className="text-[10px] text-flag-blocked" title={saveError ?? ''}>Save failed</span>}
            {pendingMarkdown !== null && saveState === 'idle' && file?.writable && (
              <span className="text-[10px] text-fg-3">Unsaved</span>
            )}
            <button
              onClick={handleManualSave}
              disabled={!file?.writable || pendingMarkdown === null || saveState === 'saving'}
              className="inline-flex items-center gap-1.5 rounded-sm bg-accent px-3 py-1 text-xs font-medium text-accent-fg transition hover:bg-accent-hover active:bg-accent-press disabled:cursor-not-allowed disabled:bg-surface-3 disabled:text-fg-3"
            >
              <Save className="h-3 w-3" />
              Save
            </button>
            <button
              onClick={onClose}
              className="rounded-sm p-1.5 text-fg-2 transition hover:bg-surface-2 hover:text-fg-0"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Body */}
        {loading && (
          <div className="flex flex-1 items-center justify-center text-sm text-fg-3">Loading…</div>
        )}
        {error && (
          <div className="flex flex-1 items-center justify-center text-sm text-flag-blocked">{error}</div>
        )}
        {file && !loading && (
          <EditorPane key={file.path} file={file} onContentChange={handleContentChange} />
        )}
      </div>
    </div>
  )
}

// ── Inline EditorPane (same as DocsPage but self-contained) ──

function EditorPane({ file, onContentChange }: { file: FileData; onContentChange: (md: string) => void }) {
  const editor = useCreateBlockNote({ schema: docsSchema })
  const loadingRef = useRef(true)

  useEffect(() => {
    let cancelled = false
    loadingRef.current = true
    ;(async () => {
      try {
        const parsed = await editor.tryParseMarkdownToBlocks(file.content)
        if (cancelled) return
        const blocks = blocksMermaidIn(parsed as DocsBlock[])
        const safeBlocks = blocks.length > 0 ? blocks : [{ type: 'paragraph' as const }]
        editor.replaceBlocks(editor.document, safeBlocks as Parameters<typeof editor.replaceBlocks>[1])
      } finally {
        setTimeout(() => { loadingRef.current = false }, 50)
      }
    })()
    return () => { cancelled = true }
  }, [file.path, file.content, editor])

  useEffect(() => {
    const handle = editor.onChange(() => {
      if (loadingRef.current) return
      const serializable = blocksMermaidOut(editor.document as DocsBlock[])
      const md = editor.blocksToMarkdownLossy(serializable as Parameters<typeof editor.blocksToMarkdownLossy>[0])
      Promise.resolve(md).then(onContentChange)
    })
    return () => { if (typeof handle === 'function') handle() }
  }, [editor, onContentChange])

  return (
    <div className="docs-editor flex-1 overflow-y-auto bg-surface-0">
      <BlockNoteView editor={editor} theme="dark" />
    </div>
  )
}
