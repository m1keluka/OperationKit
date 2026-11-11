/**
 * Agents & Skills Settings tab — extracted from ConfigPage.tsx (behavior frozen).
 */
import { useState, useEffect, useCallback } from 'react'
import { FileCode2, Sparkles } from 'lucide-react'
import {
  Card, Button, Badge, EmptyState, Skeleton, cn,
} from '../ui'
import { api } from '../../lib/api'
import { formatBytes, formatName } from './config-form'

interface AgentInfo {
  name: string
  filename: string
  slug: string
  size: number
  modifiedAt: string
  assignable: boolean
  kind: 'executive' | 'routing-only'
  label: string
}

interface SkillInfo {
  name: string
  description: string
  dirname: string
  size: number
  fileCount: number
}

// Subset of GET /admin/skill-graph — the okit-validated agent -> skill -> tool
// layer graph, read from `skills:`/`tools:` frontmatter (obj-2387, re-sourced in
// obj 707012). It replaces registry.json's hand-maintained `graph` block, which
// described the same edges from stale, unvalidated data.
//
// The frontmatter layer declares no skill->skill dependency, no `tier` and no
// `handoffs_to`, so this tab shows none of them: those affordances were dropped
// with the block rather than kept alive on data nothing validates.
interface GraphSkill {
  parent: string | null
  subskills: string[]
  tools: string[]
  agents_always: string[]
  agents_available: string[]
  // Retained registry.json stats (facts about a node, not edges).
  description?: string
  usage_count?: number
  failure_count?: number
  needs_improvement?: boolean
}
interface GraphAgent {
  always: string[]
  available: string[]
}
interface SkillGraphData {
  source?: string
  generated_at?: string
  skills?: Record<string, GraphSkill>
  agents?: Record<string, GraphAgent>
}

export function AgentsSkillsTab() {
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [registry, setRegistry] = useState<SkillGraphData>({})
  const [selected, setSelected] = useState<{ type: 'agent' | 'skill'; key: string } | null>(null)
  const [fileContent, setFileContent] = useState('')
  const [showFile, setShowFile] = useState(false)
  const [loading, setLoading] = useState(true)
  const [viewMode, setViewMode] = useState<'agents' | 'skills'>('agents')

  useEffect(() => {
    Promise.all([
      api.get<{ agents: AgentInfo[]; skills: SkillInfo[] }>('/admin/agents')
        .then(data => { setAgents(data.agents || []); setSkills(data.skills || []) })
        .catch(() => {}),
      // The okit-validated layer graph — single source of truth for agent↔skill
      // wiring, plus the retained usage stats. Same endpoint the SkillGraph tab consumes.
      api.get<SkillGraphData>('/admin/skill-graph')
        .then(data => setRegistry(data || {}))
        .catch(() => {}),
    ]).finally(() => setLoading(false))
  }, [])

  const loadFile = useCallback(async (filePath: string) => {
    setFileContent('')
    try {
      const data = await api.get<{ content: string }>(`/admin/file?path=${encodeURIComponent(filePath)}`)
      setFileContent(data.content)
    } catch {}
  }, [])

  function selectAgent(slug: string) {
    setSelected({ type: 'agent', key: slug })
    setShowFile(false)
    loadFile(`agents/${slug}.md`)
  }

  function selectSkill(name: string) {
    setSelected({ type: 'skill', key: name })
    setShowFile(false)
    loadFile(`skills/${name}/SKILL.md`)
  }

  // ── Derived agent↔skill cross-links from the frontmatter layer graph ──
  const graph = registry.agents || {}
  const regSkills = registry.skills || {}

  // Skills an agent declares (always ∪ available) in its `skills:` frontmatter.
  function skillsForAgent(slug: string): string[] {
    const node = graph[slug]
    if (!node) return []
    return Array.from(new Set([...(node.always || []), ...(node.available || [])])).sort()
  }
  // Agents that consume a skill — the reverse edge, precomputed server-side from
  // the same declarations, so both directions are one validated graph.
  function agentsForSkill(name: string): string[] {
    const rs = regSkills[name]
    if (!rs) return []
    return Array.from(new Set([...(rs.agents_always || []), ...(rs.agents_available || [])])).sort()
  }

  if (loading) {
    return (
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        <Card inset>
          <div className="flex border-b border-line">
            <Skeleton className="m-2 h-7 flex-1" />
            <Skeleton className="m-2 h-7 flex-1" />
          </div>
          <div className="space-y-1.5 p-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full rounded-md" />
            ))}
          </div>
        </Card>
        <Card>
          <Skeleton className="h-5 w-40" />
          <div className="mt-4 space-y-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className={cn('h-3', i % 3 === 2 ? 'w-2/5' : 'w-full')} />
            ))}
          </div>
        </Card>
      </div>
    )
  }

  const items = viewMode === 'agents' ? agents : skills

  // A clickable cross-link chip that switches the selection to another node.
  const LinkChip = ({ label, onClick, tone = 'neutral' as const }: { label: string; onClick: () => void; tone?: 'neutral' | 'info' | 'accent' }) => (
    <button
      onClick={onClick}
      className="transition-transform hover:scale-[1.03] focus:outline-none focus:ring-1 focus:ring-accent rounded-full"
    >
      <Badge tone={tone} mono>{label}</Badge>
    </button>
  )

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
      {/* Browser column */}
      <Card inset>
        <div className="flex border-b border-line">
          {(['agents', 'skills'] as const).map(m => (
            <button
              key={m}
              onClick={() => setViewMode(m)}
              className={cn(
                'flex-1 px-4 py-2.5 text-[12px] font-medium capitalize transition-colors',
                viewMode === m
                  ? 'border-b-2 border-accent text-accent'
                  : 'text-fg-3 hover:text-fg-1',
              )}
            >
              {m} ({m === 'agents' ? agents.length : skills.length})
            </button>
          ))}
        </div>
        <div className="max-h-[60vh] space-y-0.5 overflow-y-auto p-2">
          {items.length === 0 && (
            <EmptyState compact icon={<FileCode2 className="h-5 w-5" />} title={`No ${viewMode}`} />
          )}
          {viewMode === 'agents' && agents.map(agent => (
            <button
              key={agent.filename}
              onClick={() => selectAgent(agent.slug)}
              className={cn(
                'w-full rounded-md px-3 py-2.5 text-left transition-colors',
                selected?.type === 'agent' && selected.key === agent.slug
                  ? 'bg-[var(--accent-tint)] text-accent-hover'
                  : 'text-fg-1 hover:bg-surface-3',
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[13px] font-medium">{agent.label || formatName(agent.name)}</span>
                <Badge tone={agent.kind === 'executive' ? 'accent' : 'neutral'}>
                  {agent.kind === 'executive' ? 'executive' : 'routing-only'}
                </Badge>
              </div>
              <div className="mt-0.5 flex items-center gap-2 font-mono text-[10px] text-fg-3">
                <span>{formatBytes(agent.size)}</span>
                <span>· {skillsForAgent(agent.slug).length} skills</span>
                {!agent.assignable && <span className="text-flag-blocked">· not assignable</span>}
              </div>
            </button>
          ))}
          {viewMode === 'skills' && skills.map(skill => {
            const rs = regSkills[skill.name]
            const consumers = agentsForSkill(skill.name)
            return (
              <button
                key={skill.dirname}
                onClick={() => selectSkill(skill.dirname)}
                className={cn(
                  'w-full rounded-md px-3 py-2.5 text-left transition-colors',
                  selected?.type === 'skill' && selected.key === skill.dirname
                    ? 'bg-[var(--accent-tint)] text-accent-hover'
                    : 'text-fg-1 hover:bg-surface-3',
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[13px] font-medium">{formatName(skill.name)}</span>
                  {rs?.needs_improvement && <Badge tone="verify">needs work</Badge>}
                </div>
                {skill.description && (
                  <div className="mt-0.5 line-clamp-2 text-[11px] text-fg-3">{skill.description}</div>
                )}
                <div className="mt-1 flex flex-wrap items-center gap-2 font-mono text-[10px] text-fg-3">
                  <span>{consumers.length} agent{consumers.length !== 1 ? 's' : ''}</span>
                  {typeof rs?.usage_count === 'number' && <span>· {rs.usage_count} uses</span>}
                  {!!rs?.failure_count && <span className="text-flag-blocked">· {rs.failure_count} fails</span>}
                </div>
              </button>
            )
          })}
        </div>
      </Card>

      {/* Detail column — interactive metadata + cross-links (obj-2387) */}
      <Card inset>
        {!selected ? (
          <EmptyState
            icon={<Sparkles className="h-5 w-5" />}
            title="Nothing selected"
            description="Pick an agent or skill to see its wiring, usage, and cross-links."
          />
        ) : selected.type === 'agent' ? (
          (() => {
            const agent = agents.find(a => a.slug === selected.key)
            const agentSkills = skillsForAgent(selected.key)
            return (
              <div className="p-4 space-y-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="info">agent</Badge>
                  <Badge tone={agent?.kind === 'executive' ? 'accent' : 'neutral'}>
                    {agent?.kind === 'executive' ? 'executive' : 'routing-only / sub-agent'}
                  </Badge>
                  <Badge tone={agent?.assignable ? 'accent' : 'neutral'}>
                    {agent?.assignable ? 'assignable' : 'not assignable'}
                  </Badge>
                  <h3 className="font-display text-[15px] font-semibold text-fg-0">
                    {agent?.label || formatName(selected.key)}
                  </h3>
                </div>
                {agent?.kind === 'routing-only' && (
                  <p className="text-[11px] text-fg-3">
                    Normally invoked via the CLAUDE.md routing table or spawned as a sub-agent.
                    Still selectable as an objective's primary agent.
                  </p>
                )}
                <div>
                  <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-fg-3">
                    Skills used ({agentSkills.length})
                  </div>
                  {agentSkills.length === 0 ? (
                    <p className="text-[12px] text-fg-3">
                      This agent declares no <code className="font-mono text-fg-2">skills:</code> in its frontmatter.
                    </p>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {agentSkills.map(s => (
                        <LinkChip key={s} label={s} tone="accent" onClick={() => {
                          const match = skills.find(sk => sk.dirname === s || sk.name === s)
                          selectSkill(match ? match.dirname : s)
                          setViewMode('skills')
                        }} />
                      ))}
                    </div>
                  )}
                </div>
                <FileToggle showFile={showFile} setShowFile={setShowFile} content={fileContent} />
              </div>
            )
          })()
        ) : (
          (() => {
            const rs = regSkills[selected.key]
            const consumers = agentsForSkill(selected.key)
            return (
              <div className="p-4 space-y-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="accent">skill</Badge>
                  {rs?.parent && <Badge tone="neutral">sub-skill of {rs.parent}</Badge>}
                  {rs?.needs_improvement && <Badge tone="verify">needs work</Badge>}
                  <h3 className="font-display text-[15px] font-semibold text-fg-0">{formatName(selected.key)}</h3>
                </div>
                {rs?.description && <p className="text-[12px] leading-relaxed text-fg-2">{rs.description}</p>}
                <div className="flex flex-wrap gap-4 text-[12px] text-fg-2">
                  <span><span className="font-mono text-fg-0">{rs?.usage_count ?? 0}</span> uses</span>
                  <span><span className={cn('font-mono', rs?.failure_count ? 'text-flag-blocked' : 'text-fg-0')}>{rs?.failure_count ?? 0}</span> failures</span>
                </div>
                <div>
                  <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-fg-3">
                    Consuming agents ({consumers.length})
                  </div>
                  {consumers.length === 0 ? (
                    <p className="text-[12px] text-fg-3">
                      No agent declares this skill — it is routed by slug or reached through a parent skill.
                    </p>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {consumers.map(a => (
                        <LinkChip key={a} label={a} tone="info" onClick={() => { selectAgent(a); setViewMode('agents') }} />
                      ))}
                    </div>
                  )}
                </div>
                {/* Tools the skill declares — the skill -> tool layer edge. This
                    replaces the old "Depends on"/"Depended on by" chips, which were
                    fed by an unvalidated skill->skill block the frontmatter layer
                    does not declare (obj 707012). */}
                <div>
                  <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-fg-3">
                    Tools reached ({rs?.tools?.length ?? 0})
                  </div>
                  {!rs?.tools?.length ? (
                    <p className="text-[12px] text-fg-3">Declares no tools.</p>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {rs.tools.map(t => (
                        <Badge key={t} tone="neutral">{t}</Badge>
                      ))}
                    </div>
                  )}
                </div>
                {!!rs?.subskills?.length && (
                  <div>
                    <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-fg-3">
                      Sub-skills ({rs.subskills.length})
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {rs.subskills.map(s => (
                        <LinkChip key={s} label={s} tone="accent" onClick={() => selectSkill(s)} />
                      ))}
                    </div>
                  </div>
                )}
                <FileToggle showFile={showFile} setShowFile={setShowFile} content={fileContent} />
              </div>
            )
          })()
        )}
      </Card>
    </div>
  )
}

// Collapsible raw-definition viewer — preserves the old read-only file reader
// under a toggle so the tab is interactive-first but still shows the source md.
function FileToggle({ showFile, setShowFile, content }: { showFile: boolean; setShowFile: (v: boolean) => void; content: string }) {
  return (
    <div className="border-t border-line pt-3">
      <Button size="sm" variant="ghost" onClick={() => setShowFile(!showFile)}>
        {showFile ? 'Hide definition' : 'View definition'}
      </Button>
      {showFile && (
        <pre className="mt-2 max-h-[40vh] overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-surface-1 p-4 font-mono text-[12px] leading-relaxed text-fg-1">
          {content || 'Loading…'}
        </pre>
      )}
    </div>
  )
}
