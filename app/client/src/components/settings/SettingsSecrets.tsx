import { useState } from 'react'
import { Tabs } from '../ui'
import { SecretsPage } from '../SecretsPage'
import { TestCredentialsPage } from '../TestCredentialsPage'

export function SettingsSecrets() {
  const [sub, setSub] = useState<'keys' | 'test'>('keys')
  return (
    <div>
      <div className="mb-4">
        <Tabs
          items={[
            { key: 'keys', label: 'Keys' },
            { key: 'test', label: 'Test credentials' },
          ]}
          value={sub}
          onChange={k => setSub(k as 'keys' | 'test')}
        />
      </div>
      {sub === 'keys' ? <SecretsPage embedded /> : <TestCredentialsPage embedded />}
    </div>
  )
}
