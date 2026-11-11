import { useState } from 'react'
import { Tabs } from '../ui'
import type { TabItem } from '../ui'
import { WorkspacesTab } from '../config/WorkspacesTab'
import { UsersTab } from '../config/UsersTab'

const TABS: TabItem[] = [
  { key: 'orgs', label: 'Organizations' },
  { key: 'users', label: 'Users' },
]

export function SettingsOrg() {
  const [tab, setTab] = useState('orgs')
  return (
    <div>
      <div className="mb-4">
        <Tabs items={TABS} value={tab} onChange={setTab} />
      </div>
      {tab === 'orgs' ? <WorkspacesTab /> : <UsersTab />}
    </div>
  )
}
