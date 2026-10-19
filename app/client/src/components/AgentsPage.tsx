import { useState, useMemo, useCallback, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { AlertTriangle, Check, Copy, FileWarning, Network, List, Users } from 'lucide-react'
import type { Workspace } from '@operationkit/shared'
import { useProjects } from '../hooks/useProjects'
import { useBoardLayer } from '../hooks/useBoardLayer'
import { GraphCanvas } from './SkillGraph'
import { MarkdownEditor } from './MarkdownEditor'
import {
  PageContainer,
  PageHeader,
  Toolbar,
  Tabs,
  Card,
  Badge,
  Button,
  IconButton,
  Alert,
  EmptyState,
  Skeleton,
  SkeletonText,
  cn,
  type TabItem,
} from './ui'
import {
  fetchLayerFile,
  orphanCount,
  toCanvasPayload,
  type BoardLayerPayload,
  type LayerFile,
  type LayerFileKind,
} from '../lib/board-layer'

/**
 * Agents tab (obj 712126) — BOARD-SCOPED visibility into the OperationKit layer.
 *
 * Relationship to the pre-existing /settings/agents surface: that one is the
 * REGISTRY admin (roster CRUD, assignments, and the whole-workspace skill
 * graph). This one is read-only and answers a board question — for the
 * objectives sitting in a given project (e.g. 16 Acquisition Sites), which
 * agent persona / workspace overlay / skill / tool markdown do those sessions
 * actually run on, where does each file live, and which declared files are
 * missing. No CRUD lives here; the settings surface is linked from the header
 * rather than duplicated.
 *
 * Honesty: every edge shown is a DECLARED frontmatter edge (same rule as
 * SkillGraph.tsx). A declared skill/tool whose file is absent is the defect
 * this tab exists to reveal, so it is rendered with a MISSING marker and
 * counted in the header — never hidden.
 */

const ALL = 'all'

interface AgentsPageProps {
  workspace: Workspace
  /** Test seam: render against a fixture instead of hitting the API. */
  fixture?: BoardLayerPayload
  /** Test seam: resolve layer-file reads without the API. */
  loadFile?: (kind: LayerFileKind, slug: string, workspace?: string) => Promise<LayerFile>
}

type NodeKind = LayerFileKind

interface Selection {
  kind: NodeKind
  slug: string
  /** The path the graph/list claims — shown immediately, before the fetch lands. */
  path: string
  exists: boolean
}

const KIND_TONE = {
  agent: 'info',
  overlay: 'info',
  skill: 'accent',
  tool: 'verify',
} as const

const VIEW_TABS: TabItem[] = [
  { key: 'list', label: 'Layers' },
  { key: 'graph', label: 'Graph' },
]

export function AgentsPage({ workspace, fixture, loadFile }: AgentsPageProps) {
  const [params, setParams] = useSearchParams()
  const { projects } = useProjects(workspace)

  // Scope lives in the URL so a reload (or a shared link) lands on the same
  // project rather than silently resetting to all-of-workspace.
  const projectParam = params.get('project') ?? ALL
  const projectId = projectParam === ALL ? null : Number(projectParam)
  const scopedId = projectId != null && Number.isFinite(projectId) ? projectId : null

  // The layer graph is per-workspace: 'all' (the multi-workspace board
  // selection) has no single ~/ai-workspace to read, so useBoardLayer
  // deliberately does not fetch. Without an explicit branch for it below,
  // every render condition is false and the tab renders BLANK — no
  // spinner, no error, no explanation (found on the live tab, obj 712134).
  const needsWorkspace = !fixture && (!workspace || workspace === 'all')

  const live = useBoardLayer(fixture ? null : workspace, scopedId)
  const data = fixture ?? live.data
  const loading = fixture ? false : live.loading
  const error = fixture ? null : live.error

  const [view, setView] = useState('list')
  const [selected, setSelected] = useState<Selection | null>(null)

  const setScope = useCallback((next: string) => {
    const p = new URLSearchParams(params)
    if (next === ALL) p.delete('project')
    else p.set('project', next)
    setParams(p, { replace: true })
    setSelected(null)
  }, [params, setParams])

  // Index by slug so a graph click can resolve the node's declared path.
  const skillBySlug = useMemo(
    () => new Map((data?.skills ?? []).map(s => [s.slug, s])),
    [data],
  )
  const toolBySlug = useMemo(
    () => new Map((data?.tools ?? []).map(t => [t.slug, t])),
    [data],
  )
  const agentBySlug = useMemo(
    () => new Map((data?.agents ?? []).map(a => [a.slug, a])),
    [data],
  )

  const openNode = useCallback((kind: NodeKind, slug: string) => {
    if (kind === 'agent') {
      const a = agentBySlug.get(slug)
      setSelected({ kind, slug, path: a?.persona_file ?? '', exists: a?.persona_exists ?? false })
      return
    }
    if (kind === 'overlay') {
      const a = agentBySlug.get(slug)
      setSelected({ kind, slug, path: a?.overlay_file ?? '', exists: a?.overlay_exists ?? false })
      return
    }
    if (kind === 'skill') {
      const s = skillBySlug.get(slug)
      // A declared-but-unregistered skill has no row at all — that is exactly
      // the dangling edge case, and it must still open (as missing) rather
      // than being unclickable.
      setSelected({ kind, slug, path: s?.file ?? '', exists: s?.exists ?? false })
      return
    }
    const t = toolBySlug.get(slug)
    setSelected({ kind, slug, path: t?.file ?? '', exists: t?.exists ?? false })
  }, [agentBySlug, skillBySlug, toolBySlug])

  const orphans = orphanCount(data?.orphans)
  const missingFiles = useMemo(() => {
    if (!data) return 0
    return (
      data.agents.filter(a => !a.persona_exists).length +
      data.agents.filter(a => a.overlay_file && !a.overlay_exists).length +
      data.skills.filter(s => !s.exists).length +
      data.tools.filter(t => !t.exists).length
    )
  }, [data])

  const scopeLabel = projectParam === ALL
    ? `All of ${workspace}`
    : data?.scope.project_name ?? projects.find(p => String(p.id) === projectParam)?.name ?? `Project ${projectParam}`

  return (
    <PageContainer width="wide">
      <PageHeader
        title="Agents"
        breadcrumbs={[{ label: workspace }, { label: 'Agents' }]}
        description="The agent, skill and tool markdown a project's sessions actually run on. Read-only — the roster and assignments live in Settings."
        actions={
          <Button variant="ghost" size="sm" onClick={() => { window.location.assign('/settings/agents') }}>
            Agent registry ›
          </Button>
        }
      />

      <Toolbar
        className="mb-4"
        left={
          <>
            <label className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.08em] text-fg-3">
              Project
              <select
                aria-label="Project scope"
                value={projectParam}
                onChange={e => setScope(e.target.value)}
                className="rounded-md border border-line bg-surface-1 px-2.5 py-1.5 text-[13px] normal-case tracking-normal text-fg-0 focus:border-accent focus:outline-none"
              >
                <option value={ALL}>All of {workspace}</option>
                {projects.map(p => (
                  <option key={p.id} value={String(p.id)}>{p.id} · {p.name}</option>
                ))}
                {projectParam !== ALL && !projects.some(p => String(p.id) === projectParam) && (
                  <option value={projectParam}>{scopeLabel}</option>
                )}
              </select>
            </label>
            <Tabs items={VIEW_TABS} value={view} onChange={setView} />
          </>
        }
        right={
          data ? (
            <span className="font-mono text-[11px] text-fg-2">
              {data.agents.length} agents · {data.skills.length} skills · {data.tools.length} tools
            </span>
          ) : undefined
        }
      />

      {needsWorkspace && (
        <EmptyState
          icon={<Users className="h-5 w-5" />}
          title="Pick a single workspace"
          description="The agent → skill → tool layer is defined per workspace, so this tab cannot show 'all'. Choose one workspace in the top-left selector and the layer for its projects appears here."
        />
      )}

      {!needsWorkspace && loading && <LoadingState />}

      {!needsWorkspace && !loading && error && (
        <EmptyState
          icon={<Network className="h-5 w-5" />}
          title="Board layer unavailable"
          description={error}
          action={<Button variant="secondary" size="sm" onClick={() => { void live.refresh() }}>Retry</Button>}
        />
      )}

      {!needsWorkspace && !loading && !error && data && data.agents.length === 0 && (
        <EmptyState
          icon={<Users className="h-5 w-5" />}
          title="No agents in this scope"
          description={`Nothing on the board for ${scopeLabel} is routed to an agent yet, so there is no layer to show.`}
        />
      )}

      {!needsWorkspace && !loading && !error && data && data.agents.length > 0 && (
        <>
          {(orphans > 0 || missingFiles > 0) && (
            <Alert tone="alarm" title={`${missingFiles} declared file${missingFiles === 1 ? '' : 's'} missing`} className="mb-4">
              {orphans > 0 ? (
                <ul className="space-y-0.5">
                  {data.orphans.agents_without_persona.length > 0 && (
                    <li>Agents with no persona file: <span className="font-mono">{data.orphans.agents_without_persona.join(', ')}</span></li>
                  )}
                  {data.orphans.skills_declared_missing.length > 0 && (
                    <li>Skills declared by an agent but absent on disk: <span className="font-mono">{data.orphans.skills_declared_missing.join(', ')}</span></li>
                  )}
                  {data.orphans.tools_declared_missing.length > 0 && (
                    <li>Tools declared by a skill but absent on disk: <span className="font-mono">{data.orphans.tools_declared_missing.join(', ')}</span></li>
                  )}
                </ul>
              ) : (
                <p>Every node below carries a declared path; the flagged ones have no file at that path.</p>
              )}
            </Alert>
          )}

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="min-w-0">
              {view === 'list' ? (
                <LayerList data={data} onOpen={openNode} selected={selected} />
              ) : (
                <Card inset className="h-[70vh] overflow-hidden">
                  <GraphCanvas
                    data={toCanvasPayload(data)}
                    onOpenNode={(layer, slug) => openNode(layer as NodeKind, slug)}
                    alarmLabel="file missing"
                  />
                </Card>
              )}
            </div>
            <div className="min-w-0">
              <FileViewer selection={selected} workspace={workspace} loadFile={loadFile} />
            </div>
          </div>
        </>
      )}
    </PageContainer>
  )
}

// ── Loading ────────────────────────────────────────────────────────────────

function LoadingState() {
  return (
    <div className="grid gap-4 lg:grid-cols-2" aria-busy="true" aria-label="Loading the board layer">
      <Card>
        <div className="space-y-3 p-4">
          {[0, 1, 2].map(i => (
            <div key={i} className="space-y-2">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-2/3" />
            </div>
          ))}
        </div>
      </Card>
      <Card>
        <div className="space-y-2 p-4">
          <Skeleton className="h-4 w-56" />
          <SkeletonText lines={8} />
        </div>
      </Card>
    </div>
  )
}

// ── Missing marker ─────────────────────────────────────────────────────────

/**
 * The single visible defect indicator. Used for every exists:false node and
 * every dangling declared edge, so one glyph means one thing everywhere.
 */
function MissingChip({ what = 'file missing' }: { what?: string }) {
  return (
    <span data-testid="missing-marker">
      <Badge tone="alarm">
        <AlertTriangle className="mr-1 inline h-3 w-3 align-[-1px]" aria-hidden="true" />
        {what}
      </Badge>
    </span>
  )
}

function PathLine({ path, exists }: { path: string; exists: boolean }) {
  return (
    <div className="mt-1 flex items-center gap-1.5 break-all font-mono text-[10.5px] text-fg-3">
      {exists ? null : <FileWarning className="h-3 w-3 shrink-0 text-signal-alarm" aria-hidden="true" />}
      {path || <span className="italic">no path declared</span>}
    </div>
  )
}

// ── Layer list ─────────────────────────────────────────────────────────────

function NodeButton({
  label, kind, path, exists, meta, active, onClick,
}: {
  label: string
  kind: NodeKind
  path: string
  exists: boolean
  meta?: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'w-full rounded-md border px-2.5 py-2 text-left transition-colors duration-fast ease-out',
        'active:bg-surface-3',
        active ? 'border-[color:var(--accent-line)] bg-[var(--accent-tint)]' : 'border-line hover:bg-surface-2',
      )}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={KIND_TONE[kind]}>{kind}</Badge>
        <span className="font-mono text-[12px] font-medium text-fg-0">{label}</span>
        {!exists && <MissingChip />}
        {meta && <span className="text-[11px] text-fg-3">{meta}</span>}
      </div>
      <PathLine path={path} exists={exists} />
    </button>
  )
}

function LayerList({
  data, onOpen, selected,
}: {
  data: BoardLayerPayload
  onOpen: (kind: NodeKind, slug: string) => void
  selected: Selection | null
}) {
  const skillBySlug = useMemo(() => new Map(data.skills.map(s => [s.slug, s])), [data])
  const isActive = (kind: NodeKind, slug: string) => selected?.kind === kind && selected.slug === slug

  return (
    <div className="space-y-3">
      {data.agents.map(agent => {
        const declared = [
          ...agent.skills_always.map(s => ({ slug: s, always: true })),
          ...agent.skills_available.map(s => ({ slug: s, always: false })),
        ]
        return (
          <Card key={agent.slug}>
            <div className="space-y-3 p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-display text-[14px] font-semibold text-fg-0">{agent.label}</span>
                    <Badge mono>{agent.slug}</Badge>
                    <Badge tone={agent.objective_count > 0 ? 'accent' : 'neutral'}>
                      {agent.objective_count} objective{agent.objective_count === 1 ? '' : 's'}
                    </Badge>
                    {!agent.assignable && <Badge>routing-only</Badge>}
                  </div>
                </div>
              </div>

              {/* Persona + overlay are BOTH reachable: a real session is handed
                  the persona file and the workspace overlay concatenated. */}
              <div className="space-y-1.5">
                <NodeButton
                  label={`${agent.slug} persona`}
                  kind="agent"
                  path={agent.persona_file}
                  exists={agent.persona_exists}
                  active={isActive('agent', agent.slug)}
                  onClick={() => onOpen('agent', agent.slug)}
                />
                {agent.overlay_file && (
                  <NodeButton
                    label={`${agent.slug} workspace overlay`}
                    kind="overlay"
                    path={agent.overlay_file}
                    exists={agent.overlay_exists}
                    meta="concatenated onto the persona"
                    active={isActive('overlay', agent.slug)}
                    onClick={() => onOpen('overlay', agent.slug)}
                  />
                )}
              </div>

              <div>
                <div className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-fg-3">
                  Skills ({declared.length})
                </div>
                <div className="space-y-1.5">
                  {declared.length === 0 && (
                    <p className="text-[12px] text-fg-3">This agent declares no skills.</p>
                  )}
                  {declared.map(({ slug, always }) => {
                    const skill = skillBySlug.get(slug)
                    const dangling = !skill || agent.missing_skills.includes(slug)
                    return (
                      <div key={`${agent.slug}:${slug}`}>
                        <NodeButton
                          label={slug}
                          kind="skill"
                          path={skill?.file ?? ''}
                          exists={Boolean(skill?.exists) && !dangling}
                          meta={always ? 'always' : 'available'}
                          active={isActive('skill', slug)}
                          onClick={() => onOpen('skill', slug)}
                        />
                        {skill && skill.tools.length > 0 && (
                          <div className="ml-4 mt-1.5 space-y-1.5 border-l border-line pl-3">
                            {skill.tools.map(toolSlug => {
                              const tool = data.tools.find(t => t.slug === toolSlug)
                              return (
                                <NodeButton
                                  key={`${slug}:${toolSlug}`}
                                  label={toolSlug}
                                  kind="tool"
                                  path={tool?.file ?? ''}
                                  exists={Boolean(tool?.exists)}
                                  active={isActive('tool', toolSlug)}
                                  onClick={() => onOpen('tool', toolSlug)}
                                />
                              )
                            })}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>
          </Card>
        )
      })}
    </div>
  )
}

// ── File viewer ────────────────────────────────────────────────────────────

/**
 * Renders the selected node's markdown IN PLACE. Reuses MarkdownEditor in its
 * `readOnly` mode rather than adding a second markdown renderer — read-only
 * there means no Edit affordance and no save path at all, so this tab cannot
 * become an accidental write surface.
 */
function FileViewer({
  selection, workspace, loadFile,
}: {
  selection: Selection | null
  workspace: string
  loadFile?: (kind: LayerFileKind, slug: string, workspace?: string) => Promise<LayerFile>
}) {
  const [file, setFile] = useState<LayerFile | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!selection) { setFile(null); setError(null); return }
    let cancelled = false
    setLoading(true)
    setFile(null)
    setError(null)
    const read = loadFile ?? fetchLayerFile
    read(selection.kind, selection.slug, workspace)
      .then(f => { if (!cancelled) setFile(f) })
      .catch(err => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Could not read the file')
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [selection, workspace, loadFile])

  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1600)
    return () => clearTimeout(t)
  }, [copied])

  if (!selection) {
    return (
      <Card className="h-full">
        <div className="grid h-full min-h-[320px] place-items-center p-6">
          <EmptyState
            icon={<List className="h-5 w-5" />}
            title="Pick a node"
            description="Select an agent, overlay, skill or tool to read its markdown here, with its resolved path."
          />
        </div>
      </Card>
    )
  }

  const path = file?.path || selection.path
  const missing = file ? !file.exists : !selection.exists

  return (
    <Card className="lg:sticky lg:top-4">
      <div key={`hdr:${selection.kind}:${selection.slug}`} className="cc-land border-b border-line p-4">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={KIND_TONE[selection.kind]}>{selection.kind}</Badge>
          <span className="font-mono text-[12.5px] font-medium text-fg-0">{selection.slug}</span>
          {missing && <MissingChip />}
        </div>
        <div className="mt-2 flex items-start gap-2">
          <code
            data-testid="viewer-path"
            className="min-w-0 flex-1 break-all rounded-md bg-surface-2 px-2 py-1.5 font-mono text-[11px] text-fg-2"
          >
            {path || 'no path declared'}
          </code>
          <IconButton
            label={copied ? 'Path copied' : 'Copy path'}
            disabled={!path}
            onClick={() => {
              if (!path) return
              void navigator.clipboard?.writeText(path)
              setCopied(true)
            }}
          >
            {copied
              ? <Check className="h-4 w-4 text-signal-verify" />
              : <Copy className="h-4 w-4" />}
          </IconButton>
        </div>
        {file && (
          <div className="mt-1.5 font-mono text-[10.5px] text-fg-3">{file.bytes} bytes</div>
        )}
      </div>

      <div key={`${selection.kind}:${selection.slug}`} className="cc-land max-h-[62vh] overflow-y-auto p-4">
        {loading && <SkeletonText lines={10} />}
        {!loading && error && (
          <Alert tone="alarm">{error}</Alert>
        )}
        {!loading && !error && missing && (
          <EmptyState
            icon={<FileWarning className="h-5 w-5" />}
            title="File missing on disk"
            description={`${selection.slug} is declared in the layer graph but ${path || 'its path'} does not exist. This is a real defect in the OperationKit layer, not a display problem.`}
          />
        )}
        {!loading && !error && !missing && file && (
          <MarkdownEditor value={file.content} readOnly onSave={() => {}} />
        )}
      </div>
    </Card>
  )
}
