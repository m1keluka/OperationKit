// Knowledge base (served at /knowledge; /docs redirects here). Reads and edits the
// markdown folders the server exposes through /api/docs.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen, Menu, Save, Upload } from 'lucide-react'
import { api } from '../lib/api'
import { Button, EmptyState, SkeletonText } from './ui'
import { KnowledgeImportPanel, useKnowledgeImportEnabled } from './KnowledgeImport'
import { useCreateBlockNote } from '@blocknote/react'
import { BlockNoteView } from '@blocknote/mantine'
import { BlockNoteSchema, defaultBlockSpecs, type PartialBlock } from '@blocknote/core'
import '@blocknote/mantine/style.css'
import './docs-page.css'
import { mermaidBlockSpec } from './docs/MermaidBlock'

// Custom schema: defaults + a mermaid block. Code fences with `language: mermaid`
// are swapped into mermaid blocks on load (see EditorPane), and converted back
// into ```mermaid code blocks before save so markdown round-trips cleanly.
const docsSchema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    mermaid: mermaidBlockSpec(),
  },
})

type DocsBlock = PartialBlock<typeof docsSchema.blockSchema, typeof docsSchema.inlineContentSchema, typeof docsSchema.styleSchema>

/** Walk parsed blocks; replace codeBlock(language=mermaid) with our mermaid block. */
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

/** Walk live blocks; replace mermaid blocks with codeBlock(language=mermaid) for serialization. */
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
  if (Array.isArray(content)) {
    return content.map((c: { text?: string }) => c.text || '').join('')
  }
  return ''
}

// ── Types ──

interface TreeNode {
  name: string
  path: string
  type: 'dir' | 'file'
  children?: TreeNode[]
}

interface KnowledgeFolder {
  path: string
  label: string
}

/** GET /api/docs/tree — the one knowledge base (obj 720348); there is no source picker. */
interface TreeResponse {
  root: string
  folders?: KnowledgeFolder[]
  writeRoots: string[]
  tree: TreeNode[]
}

interface FileResponse {
  path: string
  content: string
  size: number
  modifiedAt: string
  writable: boolean
}

/**
 * Where a page sits in the knowledge base, for the breadcrumb: the path below
 * the knowledge base folder that holds it (longest match wins, so a folder
 * nested in the tree labels its own pages).
 */
export function pageLocation(filePath: string, root: string, folders: KnowledgeFolder[]): string {
  const byDepth = [...folders].sort((a, b) => b.path.length - a.path.length)
  for (const f of byDepth) {
    if (filePath.startsWith(f.path + '/')) {
      const rel = filePath.slice(f.path.length + 1)
      // The knowledge base root itself needs no prefix; an extra folder keeps its label.
      return f.path === root ? rel : `${f.label}/${rel}`
    }
  }
  return filePath
}

// ── Tree node ──

interface TreeItemProps {
  node: TreeNode
  depth: number
  selectedPath: string | null
  expanded: Set<string>
  onToggle: (path: string) => void
  onSelectFile: (path: string) => void
}

function TreeItem({ node, depth, selectedPath, expanded, onToggle, onSelectFile }: TreeItemProps) {
  const isOpen = expanded.has(node.path)
  const isSelected = selectedPath === node.path
  const padLeft = 8 + depth * 12

  if (node.type === 'dir') {
    return (
      <>
        <button
          onClick={() => onToggle(node.path)}
          className="flex w-full items-center gap-1.5 py-1 pr-2 text-left text-xs text-fg-1 transition hover:bg-surface-2"
          style={{ paddingLeft: padLeft }}
        >
          {isOpen
            ? <ChevronDown className="h-3 w-3 shrink-0 text-fg-3" />
            : <ChevronRight className="h-3 w-3 shrink-0 text-fg-3" />}
          {isOpen
            ? <FolderOpen className="h-3.5 w-3.5 shrink-0 text-fg-2" />
            : <Folder className="h-3.5 w-3.5 shrink-0 text-fg-2" />}
          <span className="truncate font-medium">{node.name}</span>
        </button>
        {isOpen && node.children?.map(child => (
          <TreeItem
            key={child.path}
            node={child}
            depth={depth + 1}
            selectedPath={selectedPath}
            expanded={expanded}
            onToggle={onToggle}
            onSelectFile={onSelectFile}
          />
        ))}
      </>
    )
  }

  return (
    <button
      onClick={() => onSelectFile(node.path)}
      className={`flex w-full items-center gap-1.5 py-1 pr-2 text-left text-xs transition ${
        isSelected
          ? 'bg-accent/15 text-accent'
          : 'text-fg-2 hover:bg-surface-2 hover:text-fg-0'
      }`}
      style={{ paddingLeft: padLeft + 16 }}
    >
      <FileText className={`h-3.5 w-3.5 shrink-0 ${isSelected ? 'text-accent' : 'text-fg-3'}`} />
      <span className="truncate">{node.name.replace(/\.md$/i, '')}</span>
    </button>
  )
}

// ── Editor pane ──

interface EditorPaneProps {
  file: FileResponse
  onContentChange: (markdown: string) => void
}

function EditorPane({ file, onContentChange }: EditorPaneProps) {
  const editor = useCreateBlockNote({ schema: docsSchema })
  const loadingRef = useRef(true)

  // Load file content into the editor whenever the file path changes.
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
        // Allow the change emitted by replaceBlocks to flush before re-enabling.
        setTimeout(() => {
          loadingRef.current = false
        }, 50)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [file.path, file.content, editor])

  // Subscribe to edits and forward markdown back up. Convert mermaid blocks
  // back to ```mermaid code fences so the markdown serializer handles them.
  useEffect(() => {
    const handle = editor.onChange(() => {
      if (loadingRef.current) return
      const serializable = blocksMermaidOut(editor.document as DocsBlock[])
      const md = editor.blocksToMarkdownLossy(serializable as Parameters<typeof editor.blocksToMarkdownLossy>[0])
      Promise.resolve(md).then(onContentChange)
    })
    return () => {
      if (typeof handle === 'function') handle()
    }
  }, [editor, onContentChange])

  return (
    <div className="docs-editor flex-1 overflow-y-auto bg-surface-0">
      <BlockNoteView editor={editor} theme="dark" />
    </div>
  )
}

// ── Main ──

export function DocsPage({ workspace = 'all' }: { workspace?: string }) {
  const [kbRoot, setKbRoot] = useState<string>('')
  const [folders, setFolders] = useState<KnowledgeFolder[]>([])
  const [treeData, setTreeData] = useState<TreeNode[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [treeLoading, setTreeLoading] = useState(true)

  const [file, setFile] = useState<FileResponse | null>(null)
  const [fileLoading, setFileLoading] = useState(false)
  const [pendingMarkdown, setPendingMarkdown] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  // File import (starter pack `knowledge-import`, obj 719936) lives on this page.
  const importOn = useKnowledgeImportEnabled()
  const [importing, setImporting] = useState(false)
  const [treeVersion, setTreeVersion] = useState(0)

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // One knowledge base, one tree (obj 720348). Reloads after an import.
  useEffect(() => {
    setTreeLoading(true)
    api.get<TreeResponse>('/docs/tree')
      .then(data => {
        setTreeData(data.tree || [])
        setKbRoot(data.root || '')
        setFolders(data.folders || [])
      })
      .catch(() => setTreeData([]))
      .finally(() => setTreeLoading(false))
  }, [treeVersion])

  const toggleDir = useCallback((p: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(p)) next.delete(p)
      else next.add(p)
      return next
    })
  }, [])

  const selectFile = useCallback(async (p: string) => {
    setFileLoading(true)
    setSaveState('idle')
    setSaveError(null)
    setPendingMarkdown(null)
    setDrawerOpen(false)
    setImporting(false)
    try {
      const data = await api.get<FileResponse>(`/docs/file?path=${encodeURIComponent(p)}`)
      setFile(data)
    } catch {
      setFile(null)
    } finally {
      setFileLoading(false)
    }
  }, [])

  const performSave = useCallback(async (markdown: string) => {
    if (!file || !file.writable) return
    setSaveState('saving')
    setSaveError(null)
    try {
      await api.put('/docs/file', { path: file.path, content: markdown })
      setSaveState('saved')
      setPendingMarkdown(null)
      // Update file with new content so reloads start from saved state
      setFile(prev => (prev ? { ...prev, content: markdown } : prev))
      setTimeout(() => setSaveState(s => (s === 'saved' ? 'idle' : s)), 1500)
    } catch (err) {
      setSaveState('error')
      setSaveError(err instanceof Error ? err.message : 'Save failed')
    }
  }, [file])

  // Forward markdown updates from the editor; debounce auto-save to 3s.
  const handleContentChange = useCallback((markdown: string) => {
    setPendingMarkdown(markdown)
    setSaveState('idle')
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      performSave(markdown)
    }, 3000)
  }, [performSave])

  const handleManualSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    if (pendingMarkdown !== null) performSave(pendingMarkdown)
  }, [pendingMarkdown, performSave])

  // Cleanup pending timer when file changes / unmount.
  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
    }
  }, [file?.path])

  const breadcrumb = useMemo(() => {
    if (!file) return null
    return { rootLabel: 'Knowledge base', rel: pageLocation(file.path, kbRoot, folders) }
  }, [file, kbRoot, folders])

  const sidebar = (
    <div className="flex h-full w-64 flex-col border-r border-line bg-surface-1">
      {/* One knowledge base — no source picker (obj 720348) */}
      <div className="border-b border-line-soft p-3">
        <h1 className="px-0.5 font-display text-[15px] font-semibold tracking-[-0.01em] text-fg-0">Knowledge base</h1>
      </div>

      {/* Tree */}
      <div className="flex-1 overflow-y-auto py-2">
        {treeLoading ? (
          <div className="p-3" aria-label="Loading pages"><SkeletonText lines={6} /></div>
        ) : treeData.length === 0 ? (
          <div className="p-3 text-xs text-fg-3">
            {importOn ? 'No pages yet. Import files to start your knowledge base.' : 'No pages yet.'}
          </div>
        ) : (
          treeData.map(node => (
            <TreeItem
              key={node.path}
              node={node}
              depth={0}
              selectedPath={file?.path ?? null}
              expanded={expanded}
              onToggle={toggleDir}
              onSelectFile={selectFile}
            />
          ))
        )}
      </div>
    </div>
  )

  return (
    <div className="flex h-full bg-surface-0">
      {/* Desktop sidebar */}
      <div className="hidden md:flex">{sidebar}</div>

      {/* Mobile drawer */}
      {drawerOpen && (
        <>
          <div
            className="fixed inset-0 z-40 bg-surface-0/70 md:hidden"
            onClick={() => setDrawerOpen(false)}
          />
          <div className="cc-sheet-in fixed inset-y-0 left-0 z-50 md:hidden">
            {sidebar}
          </div>
        </>
      )}

      {/* Editor area */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Toolbar / breadcrumb */}
        <div className="flex items-center justify-between gap-2 border-b border-line bg-surface-1 px-3 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <button
              onClick={() => setDrawerOpen(true)}
              className="rounded-sm p-1.5 text-fg-2 transition hover:bg-surface-2 hover:text-fg-0 md:hidden"
              aria-label="Open the page list"
            >
              <Menu className="h-4 w-4" />
            </button>
            {importing ? (
              <div className="text-xs font-medium text-fg-0">Import files</div>
            ) : breadcrumb ? (
              <div className="min-w-0 truncate text-xs">
                <span className="text-fg-2">{breadcrumb.rootLabel}</span>
                <span className="mx-1.5 text-fg-3">/</span>
                <span className="font-mono text-fg-0">{breadcrumb.rel}</span>
              </div>
            ) : (
              <div className="text-xs text-fg-3">No page selected</div>
            )}
          </div>
          <div className="flex items-center gap-2">
            {importOn && !importing && (
              <Button size="sm" onClick={() => setImporting(true)} leftIcon={<Upload className="h-3.5 w-3.5" aria-hidden="true" />}>
                Import files
              </Button>
            )}
            {file && !file.writable && (
              <span className="rounded-xs bg-status-review/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-status-review">
                Read-only
              </span>
            )}
            {saveState === 'saving' && (
              <span className="text-[10px] text-fg-3">Saving…</span>
            )}
            {saveState === 'saved' && (
              <span className="text-[10px] text-status-done">Saved</span>
            )}
            {saveState === 'error' && (
              <span className="text-[10px] text-flag-blocked" title={saveError ?? ''}>
                Save failed
              </span>
            )}
            {pendingMarkdown !== null && saveState === 'idle' && file?.writable && (
              <span className="text-[10px] text-fg-3">Unsaved</span>
            )}
            {!importing && <button
              onClick={handleManualSave}
              disabled={!file?.writable || pendingMarkdown === null || saveState === 'saving'}
              className="inline-flex items-center gap-1.5 rounded-sm bg-accent px-3 py-1 text-xs font-medium text-accent-fg transition hover:bg-accent-hover active:bg-accent-press disabled:cursor-not-allowed disabled:bg-surface-3 disabled:text-fg-3"
            >
              <Save className="h-3 w-3" />
              Save
            </button>}
          </div>
        </div>

        {/* Body */}
        {importing ? (
          <KnowledgeImportPanel
            workspace={workspace}
            onClose={() => { setImporting(false); setTreeVersion(v => v + 1) }}
          />
        ) : fileLoading ? (
          <div className="flex flex-1 items-center justify-center text-sm text-fg-3">
            Loading file…
          </div>
        ) : file ? (
          <EditorPane key={file.path} file={file} onContentChange={handleContentChange} />
        ) : (
          <div className="flex flex-1 items-center justify-center px-4">
            <EmptyState
              icon={<FileText className="h-5 w-5" />}
              title="No page open"
              description={importOn
                ? 'Pick a page from the list to read or edit it, or import spreadsheets, PDFs and Word files to turn them into pages.'
                : 'Pick a page from the list to read or edit it.'}
              action={importOn ? (
                <Button variant="primary" onClick={() => setImporting(true)} leftIcon={<Upload className="h-4 w-4" aria-hidden="true" />}>
                  Import files
                </Button>
              ) : undefined}
            />
          </div>
        )}
      </div>
    </div>
  )
}
