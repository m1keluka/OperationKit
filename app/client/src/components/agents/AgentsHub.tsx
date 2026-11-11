/**
 * The one Agents page (obj 900495). There used to be three surfaces:
 *
 *   /settings/agents   — registry admin: roster, assignments, skill graph
 *   /agents            — board-layer view (which markdown a project runs on)
 *   /agent-templates   — template gallery, import / export
 *
 * They are now tabs of /agents (`?tab=registry|board|templates`); the two old
 * URLs redirect here (App.tsx). The tab bodies are the same components, so no
 * behaviour moved — only where you find them.
 */
import type { Workspace } from '@operationkit/shared'
import { useSearchParams } from 'react-router-dom'
import { PageContainer, PageHeader, Tabs, type TabItem } from '../ui'
import { AgentsPage } from '../AgentsPage'
import { AgentTemplatesPage } from '../AgentTemplatesPage'
import { SettingsAgents } from '../settings/SettingsAgents'
import { AGENTS_TABS, type AgentsTab } from '../../lib/routes'

const TABS: TabItem[] = [
  { key: 'registry', label: 'Registry' },
  { key: 'board', label: 'Board layer' },
  { key: 'templates', label: 'Templates' },
]

const COPY: Record<AgentsTab, string> = {
  registry: 'Every agent and skill on this install, who can use them, and how they connect.',
  board: 'Which agent, skill and tool files a project’s sessions actually run on.',
  templates: 'Add a starter agent, or import and export agent files.',
}

/** Resolve the active tab. Old `/agents?project=…` links meant the board-layer view. */
export function resolveAgentsTab(params: URLSearchParams): AgentsTab {
  const t = params.get('tab')
  if (t && (AGENTS_TABS as readonly string[]).includes(t)) return t as AgentsTab
  return params.has('project') ? 'board' : 'registry'
}

export function AgentsHub({ workspace }: { workspace: Workspace }) {
  const [params, setParams] = useSearchParams()
  const tab = resolveAgentsTab(params)

  const select = (next: string) => {
    // Each tab owns its own query params; switching starts that tab clean.
    setParams(next === 'registry' ? {} : { tab: next }, { replace: true })
  }

  return (
    <PageContainer width="wide">
      <PageHeader title="Agents" description={COPY[tab]} />
      <div className="mb-5">
        <Tabs items={TABS} value={tab} onChange={select} />
      </div>
      {tab === 'registry' && <SettingsAgents />}
      {tab === 'board' && <AgentsPage workspace={workspace} embedded />}
      {tab === 'templates' && <AgentTemplatesPage embedded />}
    </PageContainer>
  )
}
