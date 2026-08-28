import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen, Menu, Save } from 'lucide-react'
import { api } from '../lib/api'
import { EmptyState } from './ui'
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

interface TreeResponse {
  root: string
  roots: string[]
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

const ROOT_LABELS: Record<string, string> = {
  '/home/operator/second-brain': 'Second Brain',
  '/home/operator/second-brain/workspaces/example': 'Example',
  '/home/operator/second-brain/shared': 'Shared',
  '/home/operator/ai-workspace': 'AI Workspace',
  '/home/operator/ai-workspace/agents': 'Agents',
  '/home/operator/ai-workspace/skills': 'Skills',
  '/home/operator/projects/command-center-infra': 'OperationKit',
}

function labelForRoot(path: string): string {
  if (ROOT_LABELS[path]) return ROOT_LABELS[path]
  // Fallback: use last path segment
  return path.split('/').pop() || path
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

export function DocsPage() {
  const [activeRoot, setActiveRoot] = useState<string>('')
  const [availableRoots, setAvailableRoots] = useState<string[]>([])
  const [treeData, setTreeData] = useState<TreeNode[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [treeLoading, setTreeLoading] = useState(true)

  const [file, setFile] = useState<FileResponse | null>(null)
  const [fileLoading, setFileLoading] = useState(false)
  const [pendingMarkdown, setPendingMarkdown] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Load tree when active root changes. On first load, discover available roots from API.
  useEffect(() => {
    if (!activeRoot) return
    setTreeLoading(true)
    api.get<TreeResponse>(`/docs/tree?root=${encodeURIComponent(activeRoot)}`)
      .then(data => {
        setTreeData(data.tree || [])
        // Capture available roots from the API response
        if (data.roots && data.roots.length > 0 && availableRoots.length === 0) {
          setAvailableRoots(data.roots)
        }
      })
      .catch(() => setTreeData([]))
      .finally(() => setTreeLoading(false))
  }, [activeRoot])

  // Bootstrap: fetch initial root list from API
  useEffect(() => {
    api.get<TreeResponse>('/docs/tree')
      .then(data => {
        if (data.roots && data.roots.length > 0) {
          setAvailableRoots(data.roots)
          setActiveRoot(data.root || data.roots[0])
        }
      })
      .catch(() => {})
  }, [])

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
    // Try available roots first, then fall back to known labels
    const allRoots = [...availableRoots, ...Object.keys(ROOT_LABELS)]
    for (const root of allRoots) {
      if (file.path.startsWith(root)) {
        const rel = file.path.slice(root.length).replace(/^\//, '')
        return { rootLabel: labelForRoot(root), rel }
      }
    }
    return { rootLabel: '', rel: file.path }
  }, [file, availableRoots])

  const sidebar = (
    <div className="flex h-full w-64 flex-col border-r border-line bg-surface-1">
      {/* Root switcher */}
      <div className="border-b border-line-soft p-3">
        <div className="mb-1.5 px-0.5 text-[10px] font-semibold uppercase text-fg-3" style={{ letterSpacing: '0.08em' }}>
          Source
        </div>
        <select
          value={activeRoot}
          onChange={e => {
            setActiveRoot(e.target.value)
            setExpanded(new Set())
          }}
          className="w-full rounded-sm border border-line bg-surface-0 px-2 py-1.5 text-xs text-fg-0 transition focus:border-accent focus:outline-none"
        >
          {availableRoots.map(path => (
            <option key={path} value={path}>
              {labelForRoot(path)}
            </option>
          ))}
        </select>
      </div>

      {/* Tree */}
      <div className="flex-1 overflow-y-auto py-2">
        {treeLoading ? (
          <div className="p-3 text-xs text-fg-3">Loading…</div>
        ) : treeData.length === 0 ? (
          <div className="p-3 text-xs text-fg-3">No markdown files found.</div>
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
            className="fixed inset-0 z-40 bg-black/60 md:hidden"
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
              aria-label="Open files"
            >
              <Menu className="h-4 w-4" />
            </button>
            {breadcrumb ? (
              <div className="min-w-0 truncate text-xs">
                <span className="text-fg-2">{breadcrumb.rootLabel}</span>
                <span className="mx-1.5 text-fg-3">/</span>
                <span className="font-mono text-fg-0">{breadcrumb.rel}</span>
              </div>
            ) : (
              <div className="text-xs text-fg-3">No file selected</div>
            )}
          </div>
          <div className="flex items-center gap-2">
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
            <button
              onClick={handleManualSave}
              disabled={!file?.writable || pendingMarkdown === null || saveState === 'saving'}
              className="inline-flex items-center gap-1.5 rounded-sm bg-accent px-3 py-1 text-xs font-medium text-accent-fg transition hover:bg-accent-hover active:bg-accent-press disabled:cursor-not-allowed disabled:bg-surface-3 disabled:text-fg-3"
            >
              <Save className="h-3 w-3" />
              Save
            </button>
          </div>
        </div>

        {/* Body */}
        {fileLoading ? (
          <div className="flex flex-1 items-center justify-center text-sm text-fg-3">
            Loading file…
          </div>
        ) : file ? (
          <EditorPane key={file.path} file={file} onContentChange={handleContentChange} />
        ) : (
          <div className="flex flex-1 items-center justify-center px-4">
            <EmptyState
              icon={<FileText className="h-5 w-5" />}
              title="No document open"
              description="Pick a markdown file from the tree to read or edit it."
            />
          </div>
        )}
      </div>
    </div>
  )
}
