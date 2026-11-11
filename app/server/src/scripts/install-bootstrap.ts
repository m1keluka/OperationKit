#!/usr/bin/env tsx
/**
 * install-bootstrap — first-run setup for a client install (obj 719935).
 *
 * Run by install.sh inside the app container. Reads ONE JSON object on stdin
 * (so the setup password never lands on argv or in `ps`):
 *
 *   {"client_slug","client_name","admin_username","setup_password",
 *    "setup_hours"?: 72, "agents"?: ["general","coo"], "reset"?: false,
 *    "admin_email"?: "alex@client.com", "access_one_login"?: false}
 *
 * Effects (idempotent):
 *   - creates the client workspace if it does not exist
 *   - creates the admin user if it does not exist, with the one-time setup
 *     password, must_change_password=1 and an expiry; grants workspace admin.
 *     An existing admin is left alone unless `reset` is true (install/admin-password.sh).
 *   - `access_one_login` (obj 900108): this install signs people in at the
 *     Cloudflare Access door and the admin is being linked to their Access
 *     email, so they have no password to change — the forced change is NOT set.
 *     The setup password stays as a break-glass login and still EXPIRES at
 *     password_setup_expires_at. If the email link is refused (someone else
 *     holds it) the admin has no Access identity, so the forced change is put
 *     back: nobody ends up with a permanent, unchangeable setup password.
 *   - links the admin to `admin_email` (obj 720332): behind Cloudflare Access the
 *     verified Access email signs that user in without the password page. Refused
 *     (warning, not an error) if another user already holds the email.
 *   - sets the workspace's default agent pool to `agents` when given, and
 *     archives every other agent so the board only offers the enabled ones
 *   - archives every other EMPTY workspace (the code base seeds sample
 *     workspaces on boot; a client should only ever see its own). A workspace
 *     that holds cards is a real business and is left visible — see
 *     `archiveSampleWorkspaces`. Archive, never delete: boot-time seeding is
 *     INSERT OR IGNORE, so archived rows stay archived.
 *
 * Prints only non-secret status lines. Never prints the password.
 */
import fs from 'fs'
import bcrypt from 'bcrypt'
import { getDb, initDb } from '../db/index.js'
import { createWorkspace, getWorkspace, updateWorkspace } from '../services/workspaces.js'
import { archiveSampleWorkspaces } from '../services/install-sample-workspaces.js'
import { initSessionEnvModeForFreshInstall } from '../services/secret-env-policy.js'

export interface BootstrapInput {
  client_slug: string
  client_name: string
  admin_username: string
  setup_password: string
  setup_hours?: number
  agents?: string[]
  reset?: boolean
  admin_email?: string
  /** This install uses Cloudflare Access one-login (obj 900108). */
  access_one_login?: boolean
}

const SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/
const USERNAME = /^[a-z][a-z0-9._-]{1,31}$/
const EMAIL = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/

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
    admin_email: str('admin_email').toLowerCase() || undefined,
    access_one_login: v.access_one_login === true,
  }
  if (!SLUG.test(input.client_slug)) throw new Error('client_slug invalid')
  if (!input.client_name) throw new Error('client_name required')
  if (!USERNAME.test(input.admin_username)) throw new Error('admin_username invalid')
  if (input.setup_password.length < 16) throw new Error('setup_password must be at least 16 characters')
  if (input.admin_email && !EMAIL.test(input.admin_email)) throw new Error('admin_email invalid')
  if (!(input.setup_hours! > 0 && input.setup_hours! <= 24 * 30)) throw new Error('setup_hours out of range')
  // One login needs an email to sign in WITH. Without one there is no Access
  // identity for this admin, so the forced change stays on.
  if (!input.admin_email) input.access_one_login = false
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
    // D4 (obj 900540): a brand-new install starts with session env ENFORCED
    // (allowlist only). Only when no mode row exists and the store is empty, so
    // an existing install re-running the installer keeps migration mode.
    log(`session secrets: ${initSessionEnvModeForFreshInstall(db)} mode (allowlist; docs/security.md)`)
  } else {
    if (input.agents) updateWorkspace(input.client_slug, { default_agent_pool: input.agents })
    log(`workspace ${input.client_slug}: exists`)
  }

  const expires = new Date(Date.now() + input.setup_hours! * 3600_000).toISOString()
  // obj 900108: with one login there is no password for this person to change,
  // so do not force a change they can never perform. The setup password is kept
  // as break-glass and still expires.
  const oneLogin = input.access_one_login === true
  const forceChange = oneLogin ? 0 : 1
  const howTheySignIn = oneLogin
    ? 'signs in through the Access door; the setup password is break-glass only and expires'
    : 'must choose a new password at first sign-in; setup password expires'
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(input.admin_username) as { id: number } | undefined
  let userId: number
  let created = false
  if (!existing) {
    const hash = await bcrypt.hash(input.setup_password, 12)
    const r = db.prepare(
      `INSERT INTO users (username, password_hash, role, must_change_password, password_setup_expires_at)
       VALUES (?, ?, 'admin', ?, ?)`,
    ).run(input.admin_username, hash, forceChange, expires)
    userId = Number(r.lastInsertRowid)
    created = true
    log(`admin ${input.admin_username}: created (${howTheySignIn} ${expires})`)
  } else if (input.reset) {
    const hash = await bcrypt.hash(input.setup_password, 12)
    db.prepare(
      `UPDATE users SET password_hash = ?, role = 'admin', must_change_password = ?, password_setup_expires_at = ? WHERE id = ?`,
    ).run(hash, forceChange, expires, existing.id)
    userId = existing.id
    created = true
    log(`admin ${input.admin_username}: new one-time setup password issued (expires ${expires})`)
  } else {
    userId = existing.id
    log(`admin ${input.admin_username}: exists — password unchanged`)
  }

  if (input.admin_email) {
    const holder = db.prepare('SELECT username FROM users WHERE lower(trim(email)) = ? AND id != ?')
      .get(input.admin_email, userId) as { username: string } | undefined
    if (holder) {
      log(`admin ${input.admin_username}: NOT linked to ${input.admin_email} — user ${holder.username} already has that email`)
      if (oneLogin && created) {
        // No Access identity after all — put the forced change back rather than
        // leave an admin whose only credential never has to be replaced.
        db.prepare('UPDATE users SET must_change_password = 1 WHERE id = ?').run(userId)
        log(`admin ${input.admin_username}: must choose a new password at first sign-in (no Access email to sign in with)`)
      }
    } else {
      db.prepare('UPDATE users SET email = ? WHERE id = ?').run(input.admin_email, userId)
      log(`admin ${input.admin_username}: linked to ${input.admin_email} (Cloudflare Access sign-in)`)
    }
  }

  const sample = archiveSampleWorkspaces(db, input.client_slug)
  if (sample.archived.length) log(`archived ${sample.archived.length} empty sample workspace(s): ${sample.archived.join(', ')}`)
  if (sample.kept.length) log(`left visible (not samples — they hold cards): ${sample.kept.map(k => `${k.slug} (${k.cards} card(s))`).join(', ')}`)
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
