import { useState } from 'react'
import { Card, Tabs } from '../ui'
import type { TabItem } from '../ui'
import { SkillGraphTab } from '../SkillGraph'
import { AgentsSkillsTab } from '../config/AgentsSkillsTab'
import { AssignmentsTab } from '../config/AssignmentsTab'

const TABS: TabItem[] = [
  { key: 'roster', label: 'Agents & Skills' },
  { key: 'assignments', label: 'Assignments' },
  { key: 'graph', label: 'Skill Graph' },
]

export function SettingsAgents() {
  const [tab, setTab] = useState('roster')
  return (
    <div>
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
