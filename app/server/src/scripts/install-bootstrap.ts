#!/usr/bin/env tsx
/**
 * install-bootstrap — first-run setup for a client install (obj 719935).
 *
 * Run by install.sh inside the app container. Reads ONE JSON object on stdin
 * (so the setup password never lands on argv or in `ps`):
 *
 *   {"client_slug","client_name","admin_username","setup_password",
 *    "setup_hours"?: 72, "agents"?: ["general","coo"], "reset"?: false}
 *
 * Effects (idempotent):
 *   - creates the client workspace if it does not exist
 *   - creates the admin user if it does not exist, with the one-time setup
 *     password, must_change_password=1 and an expiry; grants workspace admin.
 *     An existing admin is left alone unless `reset` is true (install/admin-password.sh).
 *   - sets the workspace's default agent pool to `agents` when given, and
 *     archives every other agent so the board only offers the enabled ones
 *   - archives every other workspace (the code base seeds sample workspaces on
 *     boot; a client should only ever see its own). Archive, never delete:
 *     boot-time seeding is INSERT OR IGNORE, so archived rows stay archived.
 *
 * Prints only non-secret status lines. Never prints the password.
 */
import fs from 'fs'
import bcrypt from 'bcrypt'
import { getDb, initDb } from '../db/index.js'
import { createWorkspace, getWorkspace, updateWorkspace } from '../services/workspaces.js'

export interface BootstrapInput {
  client_slug: string
  client_name: string
  admin_username: string
  setup_password: string
  setup_hours?: number
  agents?: string[]
  reset?: boolean
}

const SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/
const USERNAME = /^[a-z][a-z0-9._-]{1,31}$/

export function validateBootstrapInput(raw: unknown): BootstrapInput {
  const v = (raw || {}) as Record<string, unknown>
  const str = (k: string) => (typeof v[k] === 'string' ? (v[k] as string).trim() : '')
  const input: BootstrapInput = {
    client_slug: str('client_slug'),
    client_name: str('client_name'),
    admin_username: str('admin_username'),
    setup_password: typeof v.setup_password === 'string' ? v.setup_password : '',
    setup_hours: typeof v.setup_hours === 'number' ? v.setup_hours : 72,
    agents: Array.isArray(v.agents) ? v.agents.filter((a): a is string => typeof a === 'string') : undefined,
    reset: v.reset === true,
  }
  if (!SLUG.test(input.client_slug)) throw new Error('client_slug invalid')
  if (!input.client_name) throw new Error('client_name required')
  if (!USERNAME.test(input.admin_username)) throw new Error('admin_username invalid')
  if (input.setup_password.length < 16) throw new Error('setup_password must be at least 16 characters')
  if (!(input.setup_hours! > 0 && input.setup_hours! <= 24 * 30)) throw new Error('setup_hours out of range')
  return input
}

export async function runBootstrap(input: BootstrapInput, log: (s: string) => void = console.log): Promise<void> {
  const db = getDb()

  if (!getWorkspace(input.client_slug)) {
    createWorkspace({
      slug: input.client_slug,
      name: input.client_name,
      short_label: input.client_name.slice(0, 24),
      default_agent_pool: input.agents ?? [],
    })
    log(`workspace ${input.client_slug}: created`)
  } else {
    if (input.agents) updateWorkspace(input.client_slug, { default_agent_pool: input.agents })
    log(`workspace ${input.client_slug}: exists`)
  }

  const expires = new Date(Date.now() + input.setup_hours! * 3600_000).toISOString()
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(input.admin_username) as { id: number } | undefined
  let userId: number
  if (!existing) {
    const hash = await bcrypt.hash(input.setup_password, 12)
    const r = db.prepare(
      `INSERT INTO users (username, password_hash, role, must_change_password, password_setup_expires_at)
       VALUES (?, ?, 'admin', 1, ?)`,
    ).run(input.admin_username, hash, expires)
    userId = Number(r.lastInsertRowid)
    log(`admin ${input.admin_username}: created (must choose a new password at first sign-in; setup password expires ${expires})`)
  } else if (input.reset) {
    const hash = await bcrypt.hash(input.setup_password, 12)
    db.prepare(
      `UPDATE users SET password_hash = ?, role = 'admin', must_change_password = 1, password_setup_expires_at = ? WHERE id = ?`,
    ).run(hash, expires, existing.id)
    userId = existing.id
    log(`admin ${input.admin_username}: new one-time setup password issued (expires ${expires})`)
  } else {
    userId = existing.id
    log(`admin ${input.admin_username}: exists — password unchanged`)
  }

  const others = db.prepare('UPDATE workspaces SET archived = 1 WHERE slug != ? AND archived = 0').run(input.client_slug)
  if (others.changes) log(`archived ${others.changes} sample workspace(s) — only ${input.client_slug} is visible`)
  if (input.agents?.length) {
    const marks = input.agents.map(() => '?').join(',')
    db.prepare(`UPDATE agents SET archived = 0 WHERE slug IN (${marks})`).run(...input.agents)
    const off = db.prepare(`UPDATE agents SET archived = 1 WHERE slug NOT IN (${marks}) AND archived = 0`).run(...input.agents)
    log(`agents enabled: ${input.agents.join(', ')}${off.changes ? ` (${off.changes} others archived)` : ''}`)
  }

  db.prepare(
    `INSERT INTO user_workspaces (user_id, workspace, role) VALUES (?, ?, 'admin')
     ON CONFLICT(user_id, workspace) DO UPDATE SET role = 'admin'`,
  ).run(userId, input.client_slug)
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!)
if (isMain) {
  try {
    const input = validateBootstrapInput(JSON.parse(fs.readFileSync(0, 'utf8')))
    initDb()
    await runBootstrap(input)
    console.log('bootstrap: ok')
  } catch (err) {
    console.error(`bootstrap: failed — ${(err as Error).message}`)
    process.exit(1)
  }
}
