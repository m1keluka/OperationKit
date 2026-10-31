import bcrypt from 'bcrypt'
import { initDb } from './index.js'

const db = initDb()

const SALT_ROUNDS = 12

// obj 719935: no built-in default password. Dev/preview seeding must pass
// SEED_PASSWORD explicitly; real installs never run this file (install.sh uses
// scripts/install-bootstrap.ts, which forces a new password at first sign-in).
const SEED_PASSWORD = process.env.SEED_PASSWORD || ''

async function seed() {
  if (SEED_PASSWORD.length < 8) {
    console.error('seed: set SEED_PASSWORD (8+ chars). There is no default password.')
    process.exit(2)
  }
  const users = [
    { username: 'mike', password: SEED_PASSWORD, role: 'admin', workspaces: [
      { workspace: 'example', role: 'admin' },
      { workspace: 'example-project', role: 'admin' },
      { workspace: 'personal', role: 'admin' },
    ]},
    { username: 'ava', password: SEED_PASSWORD, role: 'member', workspaces: [
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
