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
      <p className="mb-4 max-w-prose text-[12.5px] leading-relaxed text-fg-2">
        Organizations and the people who can see them. An organization (workspace) is a boundary — its own board,
        secrets and membership — not a label; most teams only ever need one.
      </p>
      <div className="mb-4">
        <Tabs items={TABS} value={tab} onChange={setTab} />
      </div>
      {tab === 'orgs' ? <WorkspacesTab /> : <UsersTab />}
    </div>
  )
}
