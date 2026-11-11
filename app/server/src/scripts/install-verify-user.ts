#!/usr/bin/env tsx
/**
 * install-verify-user — a short-lived account for install/verify.sh (obj 719935).
 *
 * verify.sh must prove that password sign-in works and that a card runs end to
 * end, without knowing the client admin's password. It creates a throw-away
 * admin `ok-verify` with a random password, signs in with it, and removes it
 * when done. Reads ONE JSON object on stdin (never argv):
 *   {"action":"create","username":"ok-verify","password":"…","workspace":"slug"}
 *   {"action":"remove","username":"ok-verify"}
 * Prints only non-secret status lines.
 */
import fs from 'fs'
import bcrypt from 'bcrypt'
import { getDb, initDb } from '../db/index.js'

export interface VerifyUserInput {
  action: 'create' | 'remove'
  username: string
  password?: string
  workspace?: string
}

const VERIFY_NAME = /^ok-verify[a-z0-9-]{0,20}$/

export function parseVerifyUserInput(raw: unknown): VerifyUserInput {
  const v = (raw || {}) as Record<string, unknown>
  const action = v.action === 'create' || v.action === 'remove' ? v.action : null
  if (!action) throw new Error('action must be create or remove')
  const username = typeof v.username === 'string' ? v.username : ''
  // Guard rail: this script can only ever touch its own throw-away accounts.
  if (!VERIFY_NAME.test(username)) throw new Error('username must start with ok-verify')
  if (action === 'create') {
    if (typeof v.password !== 'string' || v.password.length < 20) throw new Error('password must be 20+ chars')
    if (typeof v.workspace !== 'string' || !v.workspace) throw new Error('workspace required')
  }
  return { action, username, password: v.password as string | undefined, workspace: v.workspace as string | undefined }
}

export async function runVerifyUser(input: VerifyUserInput, log: (s: string) => void = console.log): Promise<void> {
  const db = getDb()
  if (input.action === 'remove') {
    const r = db.prepare('DELETE FROM users WHERE username = ?').run(input.username)
    log(`verify user ${input.username}: ${r.changes ? 'removed' : 'not present'}`)
    return
  }
  const hash = await bcrypt.hash(input.password!, 10)
  db.prepare(
    `INSERT INTO users (username, password_hash, role, must_change_password) VALUES (?, ?, 'admin', 0)
     ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash, role = 'admin', must_change_password = 0`,
  ).run(input.username, hash)
  const { id } = db.prepare('SELECT id FROM users WHERE username = ?').get(input.username) as { id: number }
  db.prepare(
    `INSERT INTO user_workspaces (user_id, workspace, role) VALUES (?, ?, 'admin')
     ON CONFLICT(user_id, workspace) DO UPDATE SET role = 'admin'`,
  ).run(id, input.workspace)
  log(`verify user ${input.username}: ready`)
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!)
if (isMain) {
  try {
    const input = parseVerifyUserInput(JSON.parse(fs.readFileSync(0, 'utf8')))
    initDb()
    await runVerifyUser(input)
  } catch (err) {
    console.error(`verify-user: failed — ${(err as Error).message}`)
    process.exit(1)
  }
}
