import { useState } from 'react'
import { Card, Tabs, CopyButton } from '../ui'
import type { TabItem } from '../ui'
import { SkillGraphTab } from '../SkillGraph'
import { AgentsSkillsTab } from '../config/AgentsSkillsTab'
import { AssignmentsTab } from '../config/AssignmentsTab'

const TABS: TabItem[] = [
  { key: 'roster', label: 'Agents & Skills' },
  { key: 'assignments', label: 'Assignments' },
  { key: 'graph', label: 'Skill Graph' },
]

const SETUP_PROMPT =
  `Configure a new agent, skill, and (if it needs non-default scoping) an assignment on Command Center, for me:\n\n` +
  `- Agent: who does the work — a named profile with a model, effort level, and default workspace.\n` +
  `- Skill: how-to instructions an agent follows for a kind of task.\n` +
  `- Tool: an integration an agent can reach (see Settings → Integrations) — connect it there, then reference ` +
  `it from the skill/agent.\n` +
  `- Assignment (only if needed): scopes an agent or skill to one organization, project, or user instead of ` +
  `applying globally.\n\n` +
  `Ask me what the agent/skill is for, then use the Command Center API (docs/api/README.md, GET /api/openapi.json) ` +
  `to set it up rather than describing steps for me to click through.`

export function SettingsAgents() {
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
          organization, project, or user instead of it applying everywhere.
        </p>
        <div className="flex items-start justify-between gap-3 rounded-md border border-line bg-surface-1 p-3">
          <p className="max-w-prose text-[11.5px] leading-relaxed text-fg-3">
            Prefer to set this up by talking to an assistant instead of clicking through forms? Copy this prompt.
          </p>
          <CopyButton value={SETUP_PROMPT} label="Copy setup prompt" />
        </div>
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
