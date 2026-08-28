import bcrypt from 'bcrypt'
import { initDb } from './index.js'

const db = initDb()

const SALT_ROUNDS = 12

async function seed() {
  const users = [
    { username: 'mike', password: 'changeme', role: 'admin', workspaces: [
      { workspace: 'example', role: 'admin' },
      { workspace: 'example-project', role: 'admin' },
      { workspace: 'personal', role: 'admin' },
    ]},
    { username: 'ava', password: 'changeme', role: 'member', workspaces: [
      { workspace: 'example', role: 'member' },
    ]},
  ]

  const insertUser = db.prepare(
    'INSERT OR IGNORE INTO users (username, password_hash, role) VALUES (?, ?, ?)'
  )
  const grantWs = db.prepare(
    'INSERT OR IGNORE INTO user_workspaces (user_id, workspace, role) VALUES (?, ?, ?)'
  )
  const lookupUser = db.prepare('SELECT id FROM users WHERE username = ?')

  for (const user of users) {
    const hash = await bcrypt.hash(user.password, SALT_ROUNDS)
    insertUser.run(user.username, hash, user.role)
    const row = lookupUser.get(user.username) as { id: number } | undefined
    if (!row) continue
    for (const ws of user.workspaces) {
      grantWs.run(row.id, ws.workspace, ws.role)
    }
    console.log(`Seeded user: ${user.username} (${user.role}) — workspaces: ${user.workspaces.map(w => w.workspace).join(', ')}`)
  }

  console.log('Seed complete. Change passwords after first login!')
}

seed().catch(console.error)
