import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import type { Objective, SessionIntel, Workspace } from '@operationkit/shared'
import { useAuth } from '../context/AuthContext'
import { useObjectives } from '../hooks/useObjectives'
import { groupObjectives } from '../lib/groupObjectives'
import { api } from '../lib/api'
import { filesFromIntel, mergeAttachments, type TouchedFile } from '../lib/touchedFiles'
import { SessionViewer } from '../components/SessionViewer'
import { ObjectiveModal } from '../components/ObjectiveModal'
import { FileRail } from './FileRail'
import { SubObjectiveRail } from './SubObjectiveRail'

function idFromPath(pathname: string, param?: string): number {
  if (param && Number.isFinite(Number(param))) return Number(param)
  const m = pathname.match(/^\/(?:preview\/)?o\/(\d+)/)
  return m ? Number(m[1]) : NaN
}

export function PreviewWorkspace({ workspaces }: { workspaces: Workspace[] }) {
  const { id: paramId } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const objectiveId = idFromPath(location.pathname, paramId)
  const { objectives, changeStatus, createObjective, updateObjective, deleteObjective } = useObjectives(workspaces)
  const { user } = useAuth()
  const [detail, setDetail] = useState<Objective | null>(null)
  const [intel, setIntel] = useState<SessionIntel[]>([])
  const [uploads, setUploads] = useState<Array<{ name: string; path: string }>>([])
  const [error, setError] = useState<string | null>(null)
  const [designMode, setDesignMode] = useState(false)
  const [editing, setEditing] = useState(false)
  // Defensive: a non-admin member of one org still gets a scoped workspace
  // while selectedWorkspaces is resolving from [] to [org] in App.tsx.
  const modalWorkspace: Workspace = (() => {
    if (workspaces.length === 1) return workspaces[0]
    if (workspaces.length === 0 && user?.role !== 'admin') {
      const userWs = user?.workspaces
      if (userWs?.length === 1) return userWs[0].workspace as Workspace
    }
    return 'all'
  })()

  useEffect(() => {
    if (!Number.isFinite(objectiveId)) return
    let cancelled = false
    setError(null)
    setDetail(null)
    setDesignMode(false)
    api.get<Objective>(`/objectives/${objectiveId}`)
      .then(row => { if (!cancelled) setDetail(row) })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : 'Not found') })
    api.get<SessionIntel[]>(`/objectives/${objectiveId}/intel`)
      .then(rows => { if (!cancelled) setIntel(Array.isArray(rows) ? rows : []) })
      .catch(() => { if (!cancelled) setIntel([]) })
    api.get<{ files: Array<{ name: string; path: string }> }>(`/objectives/${objectiveId}/uploads`)
      .then(data => { if (!cancelled) setUploads(data.files || []) })
      .catch(() => { if (!cancelled) setUploads([]) })
    return () => { cancelled = true }
  }, [objectiveId])

  const fromBoard = objectives.find(o => o.id === objectiveId)
  const objective = detail ?? fromBoard ?? null

  const children = useMemo(() => {
    const grouped = groupObjectives(objectives)
    if (objective) return grouped.childrenByParent.get(objective.id) ?? []
    return objectives.filter(o => o.parent_id === objectiveId)
  }, [objectives, objective, objectiveId])

  const files: TouchedFile[] = useMemo(
    () => mergeAttachments(filesFromIntel(intel), uploads),
    [intel, uploads],
  )

  if (!Number.isFinite(objectiveId)) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
        <p className="text-sm text-fg-2">That URL is missing an objective id.</p>
        <button type="button" className="text-sm text-accent hover:underline" onClick={() => navigate('/')}>
          Back to the board
        </button>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
        <p className="text-sm text-fg-2">{error}</p>
        <button type="button" className="text-sm text-accent hover:underline" onClick={() => navigate('/')}>
          Back to the board
        </button>
      </div>
    )
  }

  if (!objective) {
    return <div className="flex flex-1 items-center justify-center text-sm text-fg-2">Opening objective…</div>
  }

  return (
    <div className="flex min-h-0 flex-1">
      {!designMode && (
        <SubObjectiveRail
          items={children}
          activeId={objective.id}
          onOpen={o => navigate(`/o/${o.id}`)}
        />
      )}
      <div className="relative min-h-0 min-w-0 flex-1">
        <SessionViewer
          objective={objective}
          chrome="page"
          onClose={() => navigate('/')}
          onChangeStatus={(oid, status) => { void changeStatus(oid, status) }}
          onDesignModeChange={setDesignMode}
          onEdit={() => setEditing(true)}
        />
      </div>
      {!designMode && <FileRail files={files} />}
      {editing && (
        <ObjectiveModal
          objective={objective}
          workspace={(objective.workspace as Workspace) || modalWorkspace}
          onClose={() => setEditing(false)}
          onCreate={createObjective}
          onUpdate={async (id, data) => {
            const updated = await updateObjective(id, data)
            setDetail(prev => prev ? { ...prev, ...updated } : updated)
            setEditing(false)
            return updated
          }}
          onDelete={async (id) => {
            await deleteObjective(id)
            navigate('/')
          }}
        />
      )}
    </div>
  )
}
