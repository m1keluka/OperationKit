import { useState, useEffect, useCallback, useRef } from 'react'
import type { ActivityEvent, ServerMessage, Workspace } from '@operationkit/shared'
import { useWebSocket } from '../hooks/useWebSocket'
import { api } from '../lib/api'

const EVENT_STYLES: Record<string, { icon: string; color: string; bg: string }> = {
  session_start: { icon: '▶', color: 'text-blue-400', bg: 'bg-blue-500/10' },
  session_end: { icon: '■', color: 'text-gray-400', bg: 'bg-gray-500/10' },
  task_start: { icon: '◉', color: 'text-blue-400', bg: 'bg-blue-500/10' },
  task_pass: { icon: '✓', color: 'text-emerald-400', bg: 'bg-emerald-500/10' },
  task_fail: { icon: '✗', color: 'text-red-400', bg: 'bg-red-500/10' },
  progress: { icon: '→', color: 'text-cyan-400', bg: 'bg-cyan-500/10' },
  decision: { icon: '◆', color: 'text-amber-400', bg: 'bg-amber-500/10' },
  blocker: { icon: '!', color: 'text-red-400', bg: 'bg-red-500/10' },
  file_change: { icon: '~', color: 'text-purple-400', bg: 'bg-purple-500/10' },
  milestone: { icon: '★', color: 'text-yellow-400', bg: 'bg-yellow-500/10' },
  error: { icon: '✗', color: 'text-red-500', bg: 'bg-red-500/10' },
}

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000)
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}

interface ProjectFeedProps {
  workspace: Workspace
}

interface FeedData {
  events: ActivityEvent[]
  stats: Record<string, number>
  active_objectives: Array<{
    id: number; title: string; status: string; agent_context: string;
    session_id: string | null;
    last_session_summary: string | null; has_blockers: number;
  }>
  has_more: boolean
}

export function ProjectFeed({ workspace }: ProjectFeedProps) {
  const [projects, setProjects] = useState<Array<{ name: string; description: string }>>([])
  const [selectedProject, setSelectedProject] = useState<string | null>(null)
  const [feed, setFeed] = useState<FeedData | null>(null)
  const [loading, setLoading] = useState(false)
  const feedRef = useRef<HTMLDivElement>(null)

  // Load projects from workspaces config
  useEffect(() => {
    api.get<{ workspaces: Record<string, { projects: Array<{ name: string; description: string }> }> }>('/workspaces-config')
      .then(data => {
        if (!data?.workspaces) return
        const ws = data.workspaces[workspace === 'all' ? 'example' : workspace]
        if (ws?.projects) {
          setProjects(ws.projects)
          if (!selectedProject && ws.projects.length > 0) {
            setSelectedProject(ws.projects[0].name)
          }
        }
      })
      .catch(() => {})
  }, [workspace])

  // Fetch feed when project changes
  useEffect(() => {
    if (!selectedProject) return
    setLoading(true)
    const ws = workspace === 'all' ? 'example' : workspace
    api.get<FeedData>(`/projects/${encodeURIComponent(selectedProject)}/feed?workspace=${ws}&limit=100`)
      .then(data => setFeed(data))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [selectedProject, workspace])

  // WebSocket for live updates
  const handleWsMessage = useCallback((msg: ServerMessage) => {
    if (msg.type === 'activity') {
      const event = msg.payload
      // Match the selected project AND the active workspace — the workspace
      // guard is the client fix for the live view-leak bug (obj 1001).
      const inWorkspace = workspace === 'all' || event.workspace === workspace
      if (event.project === selectedProject && inWorkspace) {
        setFeed(prev => {
          if (!prev) return prev
          return { ...prev, events: [event, ...prev.events] }
        })
      }
    }
  }, [selectedProject, workspace])

  useWebSocket(handleWsMessage)

  return (
    <div className="flex h-full flex-col">
      {/* Project selector */}
      <div className="flex items-center gap-3 border-b border-border px-4 py-3 sm:px-6">
        <h2 className="text-sm font-medium text-white">Activity Feed</h2>
        <div className="flex items-center gap-1 overflow-x-auto">
          {projects.map(p => (
            <button
              key={p.name}
              onClick={() => setSelectedProject(p.name)}
              className={`whitespace-nowrap rounded px-2.5 py-1 text-xs font-medium transition ${
                selectedProject === p.name
                  ? 'bg-accent/20 text-accent'
                  : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              {p.name}
            </button>
          ))}
        </div>
      </div>

      {!selectedProject && (
        <div className="flex flex-1 items-center justify-center text-gray-600 text-sm">
          Select a project to view activity
        </div>
      )}

      {selectedProject && (
        <div className="flex flex-1 flex-col overflow-hidden sm:flex-row">
          {/* Main feed timeline */}
          <div className="flex-1 overflow-y-auto p-4 sm:p-6" ref={feedRef}>
            {loading && (
              <div className="text-center text-gray-500 text-xs py-4">Loading feed...</div>
            )}

            {/* Stats bar */}
            {feed?.stats && (
              <div className="mb-4 flex flex-wrap gap-3">
                {Number(feed.stats.sessions_completed) > 0 && (
                  <div className="rounded bg-surface-raised border border-border px-3 py-1.5">
                    <span className="text-[10px] uppercase tracking-wider text-gray-500">Sessions</span>
                    <p className="text-sm font-medium text-white">{feed.stats.sessions_completed}</p>
                  </div>
                )}
                {Number(feed.stats.blockers) > 0 && (
                  <div className="rounded bg-surface-raised border border-border px-3 py-1.5">
                    <span className="text-[10px] uppercase tracking-wider text-gray-500">Blockers</span>
                    <p className="text-sm font-medium text-amber-400">{feed.stats.blockers}</p>
                  </div>
                )}
              </div>
            )}

            {/* Timeline */}
            {feed?.events && feed.events.length > 0 ? (
              <div className="relative">
                {/* Vertical line */}
                <div className="absolute left-3 top-0 bottom-0 w-px bg-border" />

                <div className="space-y-1">
                  {feed.events.map(event => {
                    const style = EVENT_STYLES[event.event_type] || EVENT_STYLES.progress
                    const meta = event.metadata as Record<string, unknown> | null

                    return (
                      <div key={event.id} className="relative flex items-start gap-3 pl-7">
                        {/* Dot on the timeline */}
                        <div className={`absolute left-1.5 top-2 h-3 w-3 rounded-full border-2 border-surface ${style.bg}`}>
                          <span className={`absolute inset-0 flex items-center justify-center text-[7px] ${style.color}`}>
                            {style.icon}
                          </span>
                        </div>

                        <div className={`flex-1 rounded border border-border p-2.5 ${style.bg}`}>
                          <div className="flex items-center justify-between gap-2">
                            <span className={`text-xs font-medium ${style.color}`}>{event.title}</span>
                            <span className="shrink-0 text-[10px] text-gray-600">{timeAgo(event.created_at)}</span>
                          </div>
                          {event.detail && (
                            <p className="mt-1 text-xs text-gray-400 line-clamp-3">{event.detail}</p>
                          )}
                          {meta && (
                            <div className="mt-1.5 flex flex-wrap gap-1.5">
                              {Number(meta.cost_usd) > 0 ? (
                                <span className="rounded bg-surface-overlay px-1.5 py-0.5 text-[9px] text-gray-500">
                                  ${Number(meta.cost_usd).toFixed(2)}
                                </span>
                              ) : null}
                              {Number(meta.duration_ms) > 0 ? (
                                <span className="rounded bg-surface-overlay px-1.5 py-0.5 text-[9px] text-gray-500">
                                  {Math.round(Number(meta.duration_ms) / 1000)}s
                                </span>
                              ) : null}
                              {Number(meta.files_created) > 0 ? (
                                <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[9px] text-emerald-400">
                                  +{Number(meta.files_created)} files
                                </span>
                              ) : null}
                              {Number(meta.files_modified) > 0 ? (
                                <span className="rounded bg-blue-500/10 px-1.5 py-0.5 text-[9px] text-blue-400">
                                  ~{Number(meta.files_modified)} files
                                </span>
                              ) : null}
                              {meta.severity ? (
                                <span className={`rounded px-1.5 py-0.5 text-[9px] ${
                                  meta.severity === 'critical' ? 'bg-red-500/20 text-red-400' :
                                  meta.severity === 'moderate' ? 'bg-amber-500/20 text-amber-400' :
                                  'bg-gray-500/20 text-gray-400'
                                }`}>
                                  {String(meta.severity)}
                                </span>
                              ) : null}
                            </div>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            ) : !loading ? (
              <div className="text-center text-gray-600 text-sm py-8">
                No activity yet for {selectedProject}. Start an objective linked to this project to see events here.
              </div>
            ) : null}
          </div>

          {/* Sidebar: active objectives */}
          {feed?.active_objectives && feed.active_objectives.length > 0 && (
            <div className="w-full border-t border-border p-4 sm:w-64 sm:border-t-0 sm:border-l sm:overflow-y-auto">
              <h3 className="mb-3 text-[10px] font-medium uppercase tracking-wider text-gray-500">
                Active Work
              </h3>
              <div className="space-y-2">
                {feed.active_objectives.map(obj => (
                  <div key={obj.id} className="rounded border border-border bg-surface-raised p-2">
                    <p className="text-xs font-medium text-white line-clamp-2">{obj.title}</p>
                    <div className="mt-1 flex items-center gap-1.5">
                      <span className={`rounded px-1 py-0.5 text-[9px] ${
                        obj.status === 'working' ? 'bg-blue-500/20 text-blue-400' : 'bg-amber-500/20 text-amber-400'
                      }`}>
                        {obj.status}
                      </span>
                      <span className="text-[9px] text-gray-500">{obj.agent_context.toUpperCase()}</span>
                    </div>
                    {obj.last_session_summary && (
                      <p className="mt-1 text-[10px] text-gray-500 line-clamp-2 italic">{obj.last_session_summary}</p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
