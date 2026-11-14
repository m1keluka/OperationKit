/**
 * Body of the Registry tab on the Agents & Skills page (/agents). Despite the
 * file name it is no longer rendered under Settings (obj 900684).
 */
import { useState } from 'react'
import { Card, Tabs, CopyButton } from '../ui'
import type { TabItem } from '../ui'
import { SkillGraphTab } from '../SkillGraph'
import { AgentsSkillsTab } from '../config/AgentsSkillsTab'
import { AssignmentsTab } from '../config/AssignmentsTab'
import { SETUP_PROMPT } from '../agents/CreateAgentGuide'

const TABS: TabItem[] = [
  { key: 'roster', label: 'Roster' },
  { key: 'assignments', label: 'Assignments' },
  { key: 'graph', label: 'Skill Graph' },
]

// The setup prompt now lives with the Agents page's create guide (obj 900672).

/** `showSetupPrompt` is off inside the Agents page, whose create guide already offers it (obj 900672). */
export function SettingsAgents({ showSetupPrompt = true }: { showSetupPrompt?: boolean } = {}) {
  const [tab, setTab] = useState('roster')
  return (
    <div>
      <div className="mb-4 space-y-2">
        <p className="max-w-prose text-[12.5px] leading-relaxed text-fg-2">
          <span className="font-medium text-fg-1">Agents</span> are who does the work.{' '}
          <span className="font-medium text-fg-1">Skills</span> are how-to instructions an agent follows.{' '}
          <span className="font-medium text-fg-1">Tools</span> are the integrations and MCP connections an agent
          can reach — manage those in{' '}
          <a
            href="/settings/integrations"
            className="text-accent-hover underline-offset-2 hover:text-accent hover:underline"
          >
            Settings → Integrations
          </a>
          . <span className="font-medium text-fg-1">Assignments</span> (below) narrow an agent or skill to one
          workspace, project, or user instead of it applying everywhere.
        </p>
        {showSetupPrompt && (
          <div className="flex items-start justify-between gap-3 rounded-md border border-line bg-surface-1 p-3">
            <p className="max-w-prose text-[12px] leading-relaxed text-fg-3">
              Prefer to set this up by talking to an assistant instead of clicking through forms? Copy this prompt.
            </p>
            <CopyButton value={SETUP_PROMPT} label="Copy setup prompt" />
          </div>
        )}
      </div>
      <div className="mb-4">
        <Tabs items={TABS} value={tab} onChange={setTab} />
      </div>
      {tab === 'roster' && <AgentsSkillsTab />}
      {tab === 'assignments' && <AssignmentsTab />}
      {tab === 'graph' && (
        <Card inset className="h-[70vh] overflow-hidden">
          <SkillGraphTab />
        </Card>
      )}
    </div>
  )
}
