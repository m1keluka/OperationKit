#!/usr/bin/env node
// Create the E2E admin in the scratch DB once the server has migrated it.
//   node seed-admin.mjs <db-path> <username> <password>
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const [dbPath, username, password] = process.argv.slice(2)
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../app/server')
const require = createRequire(path.join(appDir, 'package.json'))
const Database = require('better-sqlite3')
const bcrypt = require('bcrypt')
const db = new Database(dbPath)
const hash = bcrypt.hashSync(password, 10)
const cols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name)
const extra = cols.includes('must_change_password') ? ', must_change_password' : ''
db.prepare(`INSERT OR REPLACE INTO users (username, password_hash, role${extra}) VALUES (?, ?, 'admin'${extra ? ', 0' : ''})`).run(username, hash)
console.log(`[seed-admin] admin "${username}" ready`)
