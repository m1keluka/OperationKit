// Phase 5 Personal CRM — Internal vault + rolodex-history endpoints used by
// the Telegram Rolodex sibling process. All endpoints are localhost-only;
// the bot calls them from inside the same container (no auth header, no
// session cookies — isLocalhost is the gate).
//
// Path safety: every vault path the bot supplies is treated as untrusted.
// `resolveVaultPath` rejects anything that escapes the vault root, including
// post-symlink path traversal. Tests in routes/internal-vault.test.ts cover
// the rejections.

import { Router } from 'express'
import fs from 'fs'
import path from 'path'
import { getDb } from '../db/index.js'
import { rebuildContactsIndex, parseFrontmatter } from '../services/contacts.js'

const VAULT_BASE = process.env.VAULT_PATH || '/home/operator/second-brain'

// Allowed top-level dirs for contact files. Mirrors CONTACT_DIRS in services/contacts.ts
// but enumerated here so we can validate writes without depending on a scan.
const ALLOWED_CONTACT_DIRS = [
  'contacts',
  'personal/contacts',
  'workspaces/example/contacts',
  'workspaces/example-project/contacts',
  'workspaces/personal/contacts',
  'workspaces/personal/contacts',
]

// Whitelist of frontmatter fields the bot may update. Refusing arbitrary keys
// keeps the bot from quietly rewriting `type`, `vault_path`, etc.
const UPDATABLE_FIELDS = new Set([
  'name', 'email', 'phone', 'company', 'role',
  'tags', 'follow_up_days', 'last_interaction', 'confidence',
  'workspace', 'next_touchpoint',
])

// ── Helpers ────────────────────────────────────────────────────────────────

export interface VaultPathResolution {
  ok: boolean
  absolute?: string
  relative?: string
  error?: string
}

/**
 * Validates a vault-relative path. Rejects absolute paths, parent-traversal
 * sequences, symlink escapes, and non-.md files. Returns the absolute path
 * the caller may pass to fs.* and the canonical vault-relative form.
 */
export function resolveVaultPath(rel: string, opts: { mustExist?: boolean } = {}): VaultPathResolution {
  if (typeof rel !== 'string' || !rel) return { ok: false, error: 'path required' }
  if (rel.startsWith('/')) return { ok: false, error: 'path must be vault-relative' }
  if (!rel.endsWith('.md')) return { ok: false, error: 'only .md files are accessible' }
  // Normalize separators
  const normalized = rel.split('/').filter(Boolean).join('/')
  if (normalized.split('/').some(seg => seg === '..' || seg === '.')) {
    return { ok: false, error: 'path traversal not allowed' }
  }
  const absolute = path.join(VAULT_BASE, normalized)
  // Verify the resolved absolute path is still inside the vault. path.join handles
  // the . / .. tokens we already rejected, but defense-in-depth.
  const realBase = fs.realpathSync(VAULT_BASE)
  let realAbs: string
  if (opts.mustExist) {
    try {
      realAbs = fs.realpathSync(absolute)
    } catch {
      return { ok: false, error: 'file not found' }
    }
  } else {
    // For writes / creations the file may not exist yet — resolve the parent dir.
    const parent = path.dirname(absolute)
    try {
      const realParent = fs.realpathSync(parent)
      realAbs = path.join(realParent, path.basename(absolute))
    } catch {
      return { ok: false, error: 'parent directory does not exist' }
    }
  }
  if (realAbs !== realBase && !realAbs.startsWith(realBase + path.sep)) {
    return { ok: false, error: 'path escapes vault root' }
  }
  return { ok: true, absolute: realAbs, relative: normalized }
}

function slugify(s: string): string {
  return s.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
function todayUTC(): string {
  return new Date().toISOString().slice(0, 10)
}

function frontmatterDirsForWorkspace(ws: string): string {
  // Map a workspace slug to its contacts directory. Falls back to personal.
  switch (ws) {
    case 'personal': return 'personal/contacts'
    case 'example': return 'workspaces/example/contacts'
    case 'example-project': return 'workspaces/example-project/contacts'
    case 'personal': return 'workspaces/personal/contacts'
    case 'example2': return 'workspaces/example2/contacts'
    case 'shabo-dl': return 'workspaces/shabo-dl/contacts'
    default: return 'personal/contacts'
  }
}

/** Split a markdown file into frontmatter block, body. */
function splitFrontmatter(content: string): { fm: string; body: string } {
  const m = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/)
  if (!m) return { fm: '', body: content }
  return { fm: m[1], body: m[2] }
}

function reassembleMarkdown(fmYaml: string, body: string): string {
  return `---\n${fmYaml.trim()}\n---\n${body.startsWith('\n') ? body : '\n' + body}`
}

/** Patch a single key in a YAML frontmatter block. Adds the key if missing.
 *  Handles scalar values only (no arrays / blocks). */
function patchFrontmatterScalar(fm: string, key: string, value: string | number | null): string {
  const lines = fm.split('\n')
  const keyRe = new RegExp(`^${key}:\\s*.*$`)
  let found = false
  const out = lines.map(line => {
    if (keyRe.test(line)) {
      found = true
      if (value === null) return null // signal removal
      return `${key}: ${formatYamlScalar(value)}`
    }
    return line
  }).filter(l => l !== null) as string[]
  if (!found && value !== null) out.push(`${key}: ${formatYamlScalar(value)}`)
  return out.join('\n')
}

function formatYamlScalar(v: string | number): string {
  if (typeof v === 'number') return String(v)
  // Quote if it contains special YAML chars or looks like a number/bool
  if (/[:#\[\]{},&*!|>'"%@`]/.test(v) || /^(true|false|yes|no|null|~|\d)/i.test(v)) {
    return `"${v.replace(/"/g, '\\"')}"`
  }
  return v
}

function computeNextTouchpointLocal(lastInteraction: string | null, followUpDays: number | null): string | null {
  if (!lastInteraction || !DATE_RE.test(lastInteraction)) return null
  if (followUpDays == null || !Number.isFinite(followUpDays)) return null
  const t = Date.UTC(
    parseInt(lastInteraction.slice(0, 4), 10),
    parseInt(lastInteraction.slice(5, 7), 10) - 1,
    parseInt(lastInteraction.slice(8, 10), 10)
  )
  return new Date(t + followUpDays * 86_400_000).toISOString().slice(0, 10)
}

// ── Router ─────────────────────────────────────────────────────────────────

const router = Router()

// Localhost guard for the whole router. Defined inline so we don't have to
// export isLocalhost from index.ts.
router.use((req, res, next) => {
  const ip = req.ip || req.socket.remoteAddress || ''
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return next()
  res.status(403).json({ error: 'Internal API: localhost only' })
})

// ── vault_search ───────────────────────────────────────────────────────────
// Query against contacts_index. Future phases can extend this to grep notes.
router.post('/vault/search', (req, res) => {
  const { query, limit } = (req.body || {}) as { query?: string; limit?: number }
  if (!query || typeof query !== 'string') {
    res.status(400).json({ error: 'query required' })
    return
  }
  const cap = Math.min(Math.max(Number(limit) || 20, 1), 100)
  const like = `%${query.toLowerCase()}%`
  const rows = getDb().prepare(`
    SELECT vault_path, name, email, phone, company, role, tags, workspace,
           last_interaction, next_touchpoint, confidence
      FROM contacts_index
     WHERE lower(name)    LIKE ?
        OR lower(email)   LIKE ?
        OR lower(company) LIKE ?
        OR lower(role)    LIKE ?
     ORDER BY name COLLATE NOCASE
     LIMIT ?
  `).all(like, like, like, like, cap)
  res.json({ query, results: rows })
})

// ── vault_read ─────────────────────────────────────────────────────────────
router.post('/vault/read', (req, res) => {
  const { path: rel } = (req.body || {}) as { path?: string }
  const resolved = resolveVaultPath(rel || '', { mustExist: true })
  if (!resolved.ok) {
    res.status(400).json({ error: resolved.error })
    return
  }
  try {
    const content = fs.readFileSync(resolved.absolute!, 'utf-8')
    res.json({ path: resolved.relative, content, bytes: content.length })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'read failed' })
  }
})

// ── vault_append_note ──────────────────────────────────────────────────────
// Appends a timestamped section to the body of a contact note. Heading is
// optional — when present, the bot can group related notes (e.g. "Notes",
// "Background", "Goals"). When absent, appends under "## Notes".
router.post('/vault/append-note', (req, res) => {
  const { path: rel, heading, text } = (req.body || {}) as {
    path?: string; heading?: string; text?: string
  }
  if (!text || typeof text !== 'string') {
    res.status(400).json({ error: 'text required' })
    return
  }
  const resolved = resolveVaultPath(rel || '', { mustExist: true })
  if (!resolved.ok) {
    res.status(400).json({ error: resolved.error })
    return
  }
  const useHeading = heading?.trim() || 'Notes'
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ')
  const block = `\n## ${useHeading}\n- ${stamp} — ${text.trim()}\n`
  try {
    fs.appendFileSync(resolved.absolute!, block, 'utf-8')
    res.json({ ok: true, path: resolved.relative, appended_bytes: block.length })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'append failed' })
  }
})

// ── vault_append_touchpoint ────────────────────────────────────────────────
// Records an interaction. Updates frontmatter `last_interaction` if the new
// date is newer, recomputes `next_touchpoint`, appends a line under
// `## Touchpoints`, and refreshes contacts_index for this row.
router.post('/vault/append-touchpoint', (req, res) => {
  const { path: rel, date, summary, channel } = (req.body || {}) as {
    path?: string; date?: string; summary?: string; channel?: string
  }
  if (!summary || typeof summary !== 'string') {
    res.status(400).json({ error: 'summary required' })
    return
  }
  const useDate = date && DATE_RE.test(date) ? date : todayUTC()
  const resolved = resolveVaultPath(rel || '', { mustExist: true })
  if (!resolved.ok) {
    res.status(400).json({ error: resolved.error })
    return
  }
  try {
    const content = fs.readFileSync(resolved.absolute!, 'utf-8')
    const { fm, body } = splitFrontmatter(content)
    const parsed = parseFrontmatter(content) || {}
    const prevLast = typeof parsed.last_interaction === 'string' ? parsed.last_interaction : null
    const followUpDays = typeof parsed.follow_up_days === 'number' ? parsed.follow_up_days : null

    let newFm = fm
    let updatedLast = prevLast
    if (!prevLast || useDate > prevLast) {
      newFm = patchFrontmatterScalar(newFm, 'last_interaction', useDate)
      updatedLast = useDate
      const nextTp = computeNextTouchpointLocal(useDate, followUpDays)
      if (nextTp) newFm = patchFrontmatterScalar(newFm, 'next_touchpoint', nextTp)
    }

    // Append the touchpoint line under ## Touchpoints (create section if missing).
    const channelTag = channel ? ` [${channel}]` : ''
    const newLine = `- ${useDate}${channelTag} — ${summary.trim()}`
    let newBody = body
    if (/^##\s+Touchpoints\b/m.test(newBody)) {
      // Insert under existing heading (before the next ## or end of file)
      newBody = newBody.replace(/(##\s+Touchpoints\b[^\n]*\n)((?:(?!^##\s).)*)/ms, (_m, h, content) => {
        // Drop trailing whitespace from existing section, then append our line
        const trimmed = content.replace(/\s+$/, '')
        return `${h}${trimmed ? trimmed + '\n' : ''}${newLine}\n\n`
      })
    } else {
      newBody = `${newBody.replace(/\s+$/, '')}\n\n## Touchpoints\n${newLine}\n`
    }

    fs.writeFileSync(resolved.absolute!, reassembleMarkdown(newFm, newBody), 'utf-8')

    // Refresh just this row in contacts_index by rebuilding the whole table.
    // The vault is small enough that this is sub-second; doing a targeted update
    // would require duplicating the parser path math.
    try { rebuildContactsIndex(getDb(), VAULT_BASE) } catch { /* best-effort */ }

    res.json({ ok: true, path: resolved.relative, last_interaction: updatedLast })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'touchpoint failed' })
  }
})

// ── vault_update_field ─────────────────────────────────────────────────────
router.post('/vault/update-field', (req, res) => {
  const { path: rel, field, value } = (req.body || {}) as {
    path?: string; field?: string; value?: string | number | null
  }
  if (!field || typeof field !== 'string' || !UPDATABLE_FIELDS.has(field)) {
    res.status(400).json({ error: `field must be one of: ${[...UPDATABLE_FIELDS].join(', ')}` })
    return
  }
  if (value !== null && typeof value !== 'string' && typeof value !== 'number') {
    res.status(400).json({ error: 'value must be string, number, or null' })
    return
  }
  const resolved = resolveVaultPath(rel || '', { mustExist: true })
  if (!resolved.ok) {
    res.status(400).json({ error: resolved.error })
    return
  }
  try {
    const content = fs.readFileSync(resolved.absolute!, 'utf-8')
    const { fm, body } = splitFrontmatter(content)
    const newFm = patchFrontmatterScalar(fm, field, value)
    // If last_interaction or follow_up_days changed, also recompute next_touchpoint.
    let finalFm = newFm
    if (field === 'last_interaction' || field === 'follow_up_days') {
      const reparsed = parseFrontmatter(reassembleMarkdown(newFm, body)) || {}
      const li = typeof reparsed.last_interaction === 'string' ? reparsed.last_interaction : null
      const fd = typeof reparsed.follow_up_days === 'number' ? reparsed.follow_up_days : null
      const nt = computeNextTouchpointLocal(li, fd)
      if (nt) finalFm = patchFrontmatterScalar(finalFm, 'next_touchpoint', nt)
    }
    fs.writeFileSync(resolved.absolute!, reassembleMarkdown(finalFm, body), 'utf-8')
    try { rebuildContactsIndex(getDb(), VAULT_BASE) } catch { /* best-effort */ }
    res.json({ ok: true, path: resolved.relative, field, value })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'update failed' })
  }
})

// ── vault_create_contact ───────────────────────────────────────────────────
router.post('/vault/create-contact', (req, res) => {
  const {
    name, email, phone, company, role, workspace, tags, follow_up_days, notes,
  } = (req.body || {}) as {
    name?: string; email?: string; phone?: string; company?: string; role?: string;
    workspace?: string; tags?: string[]; follow_up_days?: number; notes?: string;
  }
  if (!name || typeof name !== 'string' || !name.trim()) {
    res.status(400).json({ error: 'name required' })
    return
  }
  const ws = (workspace && typeof workspace === 'string') ? workspace : 'personal'
  const dir = frontmatterDirsForWorkspace(ws)
  const slug = slugify(name)
  if (!slug) {
    res.status(400).json({ error: 'name produces empty slug' })
    return
  }
  const rel = `${dir}/${slug}.md`
  const resolved = resolveVaultPath(rel, { mustExist: false })
  if (!resolved.ok) {
    res.status(400).json({ error: resolved.error })
    return
  }
  if (fs.existsSync(resolved.absolute!)) {
    res.status(409).json({ error: 'contact already exists', path: resolved.relative })
    return
  }
  // Ensure parent dir exists.
  fs.mkdirSync(path.dirname(resolved.absolute!), { recursive: true })

  const fmLines = [
    'type: contact',
    `name: ${formatYamlScalar(name.trim())}`,
  ]
  if (email)   fmLines.push(`email: ${formatYamlScalar(email)}`)
  if (phone)   fmLines.push(`phone: ${formatYamlScalar(phone)}`)
  if (company) fmLines.push(`company: ${formatYamlScalar(company)}`)
  if (role)    fmLines.push(`role: ${formatYamlScalar(role)}`)
  if (Array.isArray(tags) && tags.length) {
    fmLines.push(`tags: [${tags.map(t => formatYamlScalar(String(t))).join(', ')}]`)
  }
  if (typeof follow_up_days === 'number') fmLines.push(`follow_up_days: ${follow_up_days}`)
  fmLines.push(`workspace: ${ws}`)
  fmLines.push('confidence: high')

  const body = notes
    ? `\n# ${name.trim()}\n\n## Notes\n${notes.trim()}\n`
    : `\n# ${name.trim()}\n`

  const content = `---\n${fmLines.join('\n')}\n---\n${body}`
  try {
    fs.writeFileSync(resolved.absolute!, content, 'utf-8')
    try { rebuildContactsIndex(getDb(), VAULT_BASE) } catch { /* best-effort */ }
    res.json({ ok: true, path: resolved.relative })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'create failed' })
  }
})

// ── vault_recent_interactions ──────────────────────────────────────────────
// Pulls recent Granola meetings and Gmail snippets for a contact, matched by
// the contact's email (primary) and name (fallback for meetings only).
router.post('/vault/recent-interactions', (req, res) => {
  const { path: rel, limit } = (req.body || {}) as { path?: string; limit?: number }
  const resolved = resolveVaultPath(rel || '', { mustExist: true })
  if (!resolved.ok) {
    res.status(400).json({ error: resolved.error })
    return
  }
  const cap = Math.min(Math.max(Number(limit) || 10, 1), 50)
  const db = getDb()
  const contact = db.prepare(
    'SELECT vault_path, name, email FROM contacts_index WHERE vault_path = ?'
  ).get(resolved.relative) as { vault_path: string; name: string; email: string | null } | undefined
  if (!contact) {
    res.status(404).json({ error: 'contact not indexed (run /api/contacts/reindex)', path: resolved.relative })
    return
  }
  const email = contact.email?.toLowerCase().trim() || ''

  // Gmail snippets — email-only match.
  let emails: Array<{ from: string; subject: string; snippet: string; classified_at: string }> = []
  if (email) {
    emails = db.prepare(`
      SELECT from_address AS "from", subject, snippet, classified_at
        FROM gmail_triage
       WHERE lower(from_address) LIKE ?
       ORDER BY classified_at DESC
       LIMIT ?
    `).all(`%${email}%`, cap) as typeof emails
  }

  // Granola meetings — scan recent processed meetings and filter by attendee.
  // Cap at the 200 most recent to bound work; we still return up to `cap`.
  const meetings: Array<{ id: string; title: string; meeting_date: string; vault_path: string }> = []
  const recentMeetings = db.prepare(`
    SELECT id, title, meeting_date, vault_path
      FROM granola_processed_meetings
     WHERE vault_path IS NOT NULL AND meeting_date IS NOT NULL
     ORDER BY meeting_date DESC
     LIMIT 200
  `).all() as Array<{ id: string; title: string | null; meeting_date: string; vault_path: string }>
  const lowerName = contact.name.toLowerCase().trim()
  for (const m of recentMeetings) {
    if (meetings.length >= cap) break
    const full = path.join(VAULT_BASE, m.vault_path)
    let content: string
    try { content = fs.readFileSync(full, 'utf-8') } catch { continue }
    const fm = parseFrontmatter(content) || {}
    const attendees = Array.isArray(fm.attendees) ? fm.attendees : []
    let matched = false
    for (const att of attendees) {
      if (typeof att !== 'string') continue
      const lower = att.toLowerCase()
      if (email && lower.includes(email)) { matched = true; break }
      if (lowerName && lower.includes(lowerName)) { matched = true; break }
    }
    if (matched) {
      meetings.push({ id: m.id, title: m.title ?? '', meeting_date: m.meeting_date, vault_path: m.vault_path })
    }
  }

  res.json({ contact: { name: contact.name, email: contact.email }, meetings, emails })
})

// ── rolodex_history ────────────────────────────────────────────────────────
// GET: load history for a chat. Returns empty array if chat is new.
router.get('/rolodex/history/:chatId', (req, res) => {
  const chatId = String(req.params.chatId)
  const row = getDb().prepare(
    'SELECT chat_id, user_id, history, updated_at FROM rolodex_threads WHERE chat_id = ?'
  ).get(chatId) as { chat_id: string; user_id: string; history: string; updated_at: string } | undefined
  if (!row) {
    res.json({ chat_id: chatId, user_id: null, history: [], updated_at: null })
    return
  }
  let history: unknown[] = []
  try { history = JSON.parse(row.history) } catch { /* tolerate corrupt rows */ }
  res.json({ chat_id: row.chat_id, user_id: row.user_id, history, updated_at: row.updated_at })
})

// POST: save (upsert) history.
router.post('/rolodex/history', (req, res) => {
  const { chat_id, user_id, history } = (req.body || {}) as {
    chat_id?: string; user_id?: string; history?: unknown[]
  }
  if (!chat_id || typeof chat_id !== 'string') {
    res.status(400).json({ error: 'chat_id required' })
    return
  }
  if (!user_id || typeof user_id !== 'string') {
    res.status(400).json({ error: 'user_id required' })
    return
  }
  if (!Array.isArray(history)) {
    res.status(400).json({ error: 'history must be an array' })
    return
  }
  getDb().prepare(`
    INSERT INTO rolodex_threads (chat_id, user_id, history, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(chat_id) DO UPDATE SET
      user_id    = excluded.user_id,
      history    = excluded.history,
      updated_at = datetime('now')
  `).run(chat_id, user_id, JSON.stringify(history))
  res.json({ ok: true, chat_id })
})

export default router
