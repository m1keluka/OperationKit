// Phase 1 Personal CRM — vault contact parser + index rebuilder + backfill seeds.
//
// Vault frontmatter is the source of truth; this module derives the SQLite
// `contacts_index` cache from disk. Existing 21 contacts use a partial schema
// (no email/phone/company/role/follow_up_days yet) — the parser tolerates
// missing optional fields and keeps confidence='high' unless the file says
// otherwise (Phase 3 stubs land with confidence='low').

import fs from 'fs'
import path from 'path'
import type Database from 'better-sqlite3'

// ── Types ────────────────────────────────────────────────────────────────────

type FrontmatterValue = string | number | string[] | null
export type Frontmatter = Record<string, FrontmatterValue>

export interface ContactRow {
  vault_path: string
  name: string
  email: string | null
  phone: string | null
  company: string | null
  role: string | null
  tags: string                 // JSON-stringified array
  follow_up_days: number | null
  last_interaction: string | null   // YYYY-MM-DD
  next_touchpoint: string | null    // YYYY-MM-DD (computed)
  confidence: string
  workspace: string | null
}

export interface ReindexResult {
  indexed: number
  errors: Array<{ path: string; error: string }>
  files_scanned: number
  dry_run: boolean
}

export interface SeedResult {
  matches: number
  bumped: number
  dry_run: boolean
}

// ── Frontmatter parser ──────────────────────────────────────────────────────

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---/

export function parseFrontmatter(source: string): Frontmatter | null {
  const m = source.match(FRONTMATTER_RE)
  if (!m) return null

  const out: Frontmatter = {}
  const lines = m[1].split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    // Block-array continuation lines are handled inline below, so a bare `- foo`
    // here means we already advanced past its parent and can skip.
    if (/^\s*-\s/.test(line)) { i++; continue }
    if (!line.trim() || line.trim().startsWith('#')) { i++; continue }

    const kvMatch = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/)
    if (!kvMatch) { i++; continue }
    const key = kvMatch[1]
    const rawValue = kvMatch[2].trim()

    if (rawValue === '') {
      // Possible block array on following indented lines
      const items: string[] = []
      let j = i + 1
      while (j < lines.length) {
        const sub = lines[j].match(/^\s+-\s*(.+)\s*$/)
        if (!sub) break
        items.push(stripQuotes(sub[1].trim()))
        j++
      }
      if (items.length > 0) {
        out[key] = items
        i = j
        continue
      }
      out[key] = null
      i++
      continue
    }

    out[key] = coerceValue(rawValue)
    i++
  }
  return out
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1).replace(/\\"/g, '"')
  }
  return s
}

function coerceValue(raw: string): FrontmatterValue {
  // Inline array: [a, b, c] or ["a","b"]
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1).trim()
    if (!inner) return []
    return inner.split(',').map(s => stripQuotes(s.trim()))
  }
  // Quoted string
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return stripQuotes(raw)
  }
  // Integer
  if (/^-?\d+$/.test(raw)) return parseInt(raw, 10)
  // Date / generic string — store as text; date validation happens elsewhere
  return raw
}

// ── Date math ───────────────────────────────────────────────────────────────

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/

export function computeNextTouchpoint(
  lastInteraction: string | null,
  followUpDays: number | null
): string | null {
  if (!lastInteraction || !DATE_ONLY_RE.test(lastInteraction)) return null
  if (followUpDays == null || !Number.isFinite(followUpDays)) return null
  // Use UTC math to avoid TZ drift around midnight
  const t = Date.UTC(
    parseInt(lastInteraction.slice(0, 4), 10),
    parseInt(lastInteraction.slice(5, 7), 10) - 1,
    parseInt(lastInteraction.slice(8, 10), 10)
  )
  const next = new Date(t + followUpDays * 24 * 60 * 60 * 1000)
  return next.toISOString().slice(0, 10)
}

// ── Contact file → row ──────────────────────────────────────────────────────

export function parseContactFile(vaultRoot: string, fullPath: string): ContactRow | null {
  let content: string
  try {
    content = fs.readFileSync(fullPath, 'utf-8')
  } catch {
    return null
  }
  const fm = parseFrontmatter(content)
  if (!fm) return null
  if (fm.type !== 'contact') return null
  if (typeof fm.name !== 'string' || !fm.name.trim()) return null

  const tags = Array.isArray(fm.tags) ? fm.tags : []
  const followUpDays = typeof fm.follow_up_days === 'number' ? fm.follow_up_days : null
  const lastInteraction = typeof fm.last_interaction === 'string' && DATE_ONLY_RE.test(fm.last_interaction)
    ? fm.last_interaction
    : null

  const vaultPath = path.relative(vaultRoot, fullPath).split(path.sep).join('/')

  return {
    vault_path: vaultPath,
    name: fm.name.trim(),
    email: typeof fm.email === 'string' && fm.email ? fm.email : null,
    phone: typeof fm.phone === 'string' && fm.phone ? fm.phone : null,
    company: typeof fm.company === 'string' && fm.company ? fm.company : null,
    role: typeof fm.role === 'string' && fm.role ? fm.role : null,
    tags: JSON.stringify(tags),
    follow_up_days: followUpDays,
    last_interaction: lastInteraction,
    next_touchpoint: computeNextTouchpoint(lastInteraction, followUpDays),
    confidence: typeof fm.confidence === 'string' && fm.confidence ? fm.confidence : 'high',
    workspace: typeof fm.workspace === 'string' && fm.workspace
      ? fm.workspace
      : inferWorkspaceFromPath(vaultPath),
  }
}

function inferWorkspaceFromPath(vaultPath: string): string | null {
  // workspaces/<ws>/contacts/<file>.md → <ws>
  const m = vaultPath.match(/^workspaces\/([^/]+)\/contacts\//)
  if (m) return m[1]
  if (vaultPath.startsWith('personal/contacts/')) return 'personal'
  return null
}

// ── Disk scan ───────────────────────────────────────────────────────────────

// Directories to scan for contact files. Glob-style: each entry is relative to
// vaultRoot. Future-proof for personal/ + future workspaces (per PRD §3).
const CONTACT_DIRS = [
  'contacts',
  'personal/contacts',
  'workspaces/example/contacts',
  'workspaces/example-project/contacts',
  'workspaces/operator/contacts',
  'workspaces/personal/contacts',
]

export function scanContactsDir(vaultRoot: string): ContactRow[] {
  const rows: ContactRow[] = []
  for (const rel of CONTACT_DIRS) {
    const dir = path.join(vaultRoot, rel)
    if (!fs.existsSync(dir)) continue
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith('.md')) continue
      const full = path.join(dir, entry)
      const row = parseContactFile(vaultRoot, full)
      if (row) rows.push(row)
    }
  }
  return rows
}

// ── Index rebuild ───────────────────────────────────────────────────────────

export function rebuildContactsIndex(
  db: Database.Database,
  vaultRoot: string,
  opts: { dryRun?: boolean } = {}
): ReindexResult {
  const dryRun = opts.dryRun ?? false
  const errors: Array<{ path: string; error: string }> = []
  let rows: ContactRow[]
  try {
    rows = scanContactsDir(vaultRoot)
  } catch (err) {
    return {
      indexed: 0,
      errors: [{ path: vaultRoot, error: err instanceof Error ? err.message : String(err) }],
      files_scanned: 0,
      dry_run: dryRun,
    }
  }

  if (dryRun) {
    return { indexed: rows.length, errors, files_scanned: rows.length, dry_run: true }
  }

  const insert = db.prepare(`
    INSERT OR REPLACE INTO contacts_index (
      vault_path, name, email, phone, company, role, tags,
      follow_up_days, last_interaction, next_touchpoint, confidence, workspace, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `)

  const tx = db.transaction((items: ContactRow[]) => {
    // Replace the whole table — files deleted from disk should not linger in the index.
    db.prepare('DELETE FROM contacts_index').run()
    for (const r of items) {
      try {
        insert.run(
          r.vault_path, r.name, r.email, r.phone, r.company, r.role, r.tags,
          r.follow_up_days, r.last_interaction, r.next_touchpoint, r.confidence, r.workspace
        )
      } catch (err) {
        errors.push({ path: r.vault_path, error: err instanceof Error ? err.message : String(err) })
      }
    }
  })
  tx(rows)

  return { indexed: rows.length - errors.length, errors, files_scanned: rows.length, dry_run: false }
}

// ── Backfill seeds: meetings ────────────────────────────────────────────────

interface MeetingFrontmatter {
  date?: string
  attendees?: string[]
}

function normName(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, ' ')
}

function extractEmail(s: string): string | null {
  const m = s.match(/<([^>]+@[^>]+)>|([^\s<>"]+@[^\s<>"]+)/)
  if (!m) return null
  return (m[1] || m[2] || '').toLowerCase().trim()
}

export function seedLastInteractionFromMeetings(
  db: Database.Database,
  vaultRoot: string,
  opts: { sinceDays: number; dryRun?: boolean }
): SeedResult {
  const dryRun = opts.dryRun ?? false
  const cutoff = new Date(Date.now() - opts.sinceDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

  const meetings = db.prepare(
    'SELECT id, meeting_date, vault_path FROM granola_processed_meetings WHERE meeting_date >= ?'
  ).all(cutoff) as Array<{ id: string; meeting_date: string | null; vault_path: string | null }>

  const contacts = db.prepare(
    'SELECT vault_path, name, email, last_interaction FROM contacts_index'
  ).all() as Array<{ vault_path: string; name: string; email: string | null; last_interaction: string | null }>

  // Build lookup: lowercased email and normalized name → contact row
  const byEmail = new Map<string, typeof contacts[number]>()
  const byName = new Map<string, typeof contacts[number]>()
  for (const c of contacts) {
    if (c.email) byEmail.set(c.email.toLowerCase().trim(), c)
    byName.set(normName(c.name), c)
  }

  // Compute the latest meeting date per contact
  const latest = new Map<string, string>() // vault_path → meeting_date
  let totalMatches = 0

  for (const meeting of meetings) {
    if (!meeting.meeting_date || !meeting.vault_path) continue
    const full = path.join(vaultRoot, meeting.vault_path)
    if (!fs.existsSync(full)) continue
    let content: string
    try { content = fs.readFileSync(full, 'utf-8') } catch { continue }
    const fm = parseFrontmatter(content) as unknown as MeetingFrontmatter | null
    const attendees = Array.isArray(fm?.attendees) ? fm!.attendees : []

    for (const attendee of attendees) {
      if (typeof attendee !== 'string' || !attendee.trim()) continue
      const email = extractEmail(attendee)
      let match = email ? byEmail.get(email) : undefined
      if (!match) match = byName.get(normName(attendee))
      if (!match) continue
      totalMatches++
      const prev = latest.get(match.vault_path)
      if (!prev || meeting.meeting_date > prev) {
        latest.set(match.vault_path, meeting.meeting_date)
      }
    }
  }

  let bumped = 0
  if (!dryRun && latest.size > 0) {
    const update = db.prepare(
      `UPDATE contacts_index
         SET last_interaction = ?,
             next_touchpoint = CASE
               WHEN follow_up_days IS NOT NULL
               THEN date(?, '+' || follow_up_days || ' days')
               ELSE next_touchpoint
             END,
             updated_at = datetime('now')
       WHERE vault_path = ?
         AND (last_interaction IS NULL OR last_interaction < ?)`
    )
    const tx = db.transaction(() => {
      for (const [vaultPath, date] of latest) {
        const res = update.run(date, date, vaultPath, date)
        if (res.changes > 0) bumped++
      }
    })
    tx()
  } else if (dryRun) {
    // Report bumps that WOULD happen (newer than current)
    const cur = new Map(contacts.map(c => [c.vault_path, c.last_interaction]))
    for (const [vaultPath, date] of latest) {
      const prev = cur.get(vaultPath)
      if (!prev || date > prev) bumped++
    }
  }

  return { matches: totalMatches, bumped, dry_run: dryRun }
}

// ── Phase 2: Query helpers for /api/contacts ─────────────────────────────────

export type ContactSort = 'overdue' | 'name' | 'recent'

export interface ListOpts {
  sort?: ContactSort
  tag?: string
  workspace?: string
}

export interface ContactSummary {
  vault_path: string
  name: string
  email: string | null
  phone: string | null
  company: string | null
  role: string | null
  tags: string[]
  follow_up_days: number | null
  last_interaction: string | null
  next_touchpoint: string | null
  confidence: string
  workspace: string | null
  updated_at: string
}

// SQLite rows store tags as a JSON string; this shape mirrors that without
// pretending the column is already parsed.
interface ContactRowFromDb {
  vault_path: string
  name: string
  email: string | null
  phone: string | null
  company: string | null
  role: string | null
  tags: string
  follow_up_days: number | null
  last_interaction: string | null
  next_touchpoint: string | null
  confidence: string
  workspace: string | null
  updated_at: string
}

function rowToSummary(r: ContactRowFromDb): ContactSummary {
  let tags: string[] = []
  try {
    const parsed = JSON.parse(r.tags || '[]')
    if (Array.isArray(parsed)) tags = parsed.filter(t => typeof t === 'string')
  } catch {
    // bad JSON — treat as empty
  }
  return { ...r, tags }
}

export function listContacts(db: Database.Database, opts: ListOpts = {}): ContactSummary[] {
  const where: string[] = []
  const params: unknown[] = []
  if (opts.workspace) {
    where.push('workspace = ?')
    params.push(opts.workspace)
  }
  if (opts.tag) {
    // Tags are JSON-encoded strings; case-insensitive substring match
    // (`json_each` would be cleaner but adds a join — overkill at ≤500 rows).
    where.push("LOWER(tags) LIKE ?")
    params.push(`%"${opts.tag.toLowerCase()}"%`)
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''

  let orderSql: string
  switch (opts.sort) {
    case 'name':
      orderSql = 'ORDER BY LOWER(name) ASC'
      break
    case 'recent':
      // Recent = most recent interaction first; NULLs last
      orderSql = "ORDER BY (last_interaction IS NULL), last_interaction DESC, LOWER(name) ASC"
      break
    case 'overdue':
    default:
      // Overdue = earliest next_touchpoint first; NULLs (no cadence) last
      orderSql = "ORDER BY (next_touchpoint IS NULL), next_touchpoint ASC, LOWER(name) ASC"
      break
  }

  const rows = db.prepare(`SELECT * FROM contacts_index ${whereSql} ${orderSql}`).all(...params) as ContactRowFromDb[]
  return rows.map(rowToSummary)
}

export function getContactByPath(db: Database.Database, vaultPath: string): ContactSummary | null {
  const row = db.prepare('SELECT * FROM contacts_index WHERE vault_path = ?').get(vaultPath) as ContactRowFromDb | undefined
  return row ? rowToSummary(row) : null
}

// Reads the .md file at vaultPath (resolved under vaultRoot). Returns null if
// the file doesn't exist or escapes vaultRoot.
export function readContactFile(vaultRoot: string, vaultPath: string): { content: string; absolute: string } | null {
  const absolute = path.resolve(vaultRoot, vaultPath)
  const rootResolved = path.resolve(vaultRoot)
  if (absolute !== rootResolved && !absolute.startsWith(rootResolved + path.sep)) return null
  try {
    const content = fs.readFileSync(absolute, 'utf-8')
    return { content, absolute }
  } catch {
    return null
  }
}

// ── Phase 2: Frontmatter writer ─────────────────────────────────────────────

// Mirrors the parser's accepted shapes. Strings with YAML-special chars get
// quoted; integers stay bare; arrays render inline (`[a, b]`) because that's
// what the existing 21 contact files use.
function needsQuoting(s: string): boolean {
  return /[:#&*?!|>'"%@`,\[\]\{\}]/.test(s) || /^\s|\s$/.test(s) || /^-\s/.test(s) || s === ''
}

function serializeScalar(v: FrontmatterValue): string {
  if (v === null || v === undefined) return ''
  if (Array.isArray(v)) {
    return '[' + v.map(item => {
      const s = String(item)
      return needsQuoting(s) ? `"${s.replace(/"/g, '\\"')}"` : s
    }).join(', ') + ']'
  }
  if (typeof v === 'number') return String(v)
  const s = String(v)
  return needsQuoting(s) ? `"${s.replace(/"/g, '\\"')}"` : s
}

export function serializeFrontmatter(fm: Frontmatter): string {
  const lines: string[] = ['---']
  for (const [key, value] of Object.entries(fm)) {
    if (value === undefined) continue
    lines.push(`${key}: ${serializeScalar(value as FrontmatterValue)}`)
  }
  lines.push('---')
  return lines.join('\n')
}

// Splits a contact .md into frontmatter object + body string. Body excludes
// the trailing `---` line. For files without frontmatter the entire content
// is treated as body.
export function splitContactFile(content: string): { frontmatter: Frontmatter; body: string } {
  const m = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/)
  if (!m) return { frontmatter: {}, body: content }
  const fm = parseFrontmatter(content) || {}
  const body = content.slice(m[0].length)
  return { frontmatter: fm, body }
}

// ── Phase 2: Create + Patch ─────────────────────────────────────────────────

export interface CreateContactInput {
  name: string
  workspace?: string                  // 'example' | 'example-project' | 'operator' | 'personal'
  email?: string | null
  phone?: string | null
  company?: string | null
  role?: string | null
  tags?: string[]
  follow_up_days?: number | null
  last_interaction?: string | null
  confidence?: string
  body?: string                       // optional initial markdown body
  extra?: Frontmatter                 // anything else (relationship, category, etc.)
}

export interface CreateContactResult {
  vault_path: string                  // relative
  absolute_path: string
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '') // strip accents
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

// vaultPath template per PRD: workspaces/<ws>/contacts/<slug>.md  (or
// personal/contacts/<slug>.md when workspace='personal').
function defaultVaultPath(workspace: string, name: string): string {
  const slug = slugify(name) || 'contact'
  if (workspace === 'personal') return `personal/contacts/${slug}.md`
  return `workspaces/${workspace}/contacts/${slug}.md`
}

export function createContact(
  db: Database.Database,
  vaultRoot: string,
  input: CreateContactInput
): CreateContactResult {
  if (!input.name?.trim()) throw new Error('name is required')
  const workspace = input.workspace?.trim() || 'personal'
  const vaultPath = defaultVaultPath(workspace, input.name)
  const absolute = path.resolve(vaultRoot, vaultPath)
  const rootResolved = path.resolve(vaultRoot)
  if (!absolute.startsWith(rootResolved + path.sep)) {
    throw new Error('vault path escapes root')
  }
  if (fs.existsSync(absolute)) throw new Error(`Contact file already exists: ${vaultPath}`)

  const fm: Frontmatter = {
    type: 'contact',
    name: input.name.trim(),
    workspace,
    ...(input.extra || {}),
  }
  if (input.email) fm.email = input.email
  if (input.phone) fm.phone = input.phone
  if (input.company) fm.company = input.company
  if (input.role) fm.role = input.role
  if (input.tags && input.tags.length > 0) fm.tags = input.tags
  if (input.follow_up_days != null) fm.follow_up_days = input.follow_up_days
  if (input.last_interaction) fm.last_interaction = input.last_interaction
  if (input.confidence) fm.confidence = input.confidence

  const body = input.body && input.body.trim() ? `\n${input.body.trim()}\n` : '\n'
  const fileContents = `${serializeFrontmatter(fm)}\n${body}`

  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  fs.writeFileSync(absolute, fileContents, 'utf-8')

  // Reindex this single row so subsequent reads see it without a full rebuild.
  const row = parseContactFile(vaultRoot, absolute)
  if (row) upsertRow(db, row)

  return { vault_path: vaultPath, absolute_path: absolute }
}

export type ContactPatch = Partial<Omit<CreateContactInput, 'name' | 'workspace'>> & {
  name?: string
  body_append?: string
  // Allow overwriting any other frontmatter key the caller knows about
  extra?: Frontmatter
}

export function patchContact(
  db: Database.Database,
  vaultRoot: string,
  vaultPath: string,
  patch: ContactPatch
): ContactSummary {
  const file = readContactFile(vaultRoot, vaultPath)
  if (!file) throw new Error(`Contact not found: ${vaultPath}`)

  const { frontmatter, body } = splitContactFile(file.content)

  if (patch.name && patch.name.trim()) frontmatter.name = patch.name.trim()
  if ('email' in patch) frontmatter.email = patch.email ?? null
  if ('phone' in patch) frontmatter.phone = patch.phone ?? null
  if ('company' in patch) frontmatter.company = patch.company ?? null
  if ('role' in patch) frontmatter.role = patch.role ?? null
  if ('tags' in patch && patch.tags !== undefined) frontmatter.tags = patch.tags ?? []
  if ('follow_up_days' in patch) frontmatter.follow_up_days = patch.follow_up_days ?? null
  if ('last_interaction' in patch) frontmatter.last_interaction = patch.last_interaction ?? null
  if ('confidence' in patch && patch.confidence) frontmatter.confidence = patch.confidence
  if (patch.extra) {
    for (const [k, v] of Object.entries(patch.extra)) frontmatter[k] = v as FrontmatterValue
  }

  const newBody = patch.body_append
    ? `${body.replace(/\n+$/, '')}\n\n${patch.body_append.trim()}\n`
    : body
  const newContent = `${serializeFrontmatter(frontmatter)}\n${newBody.startsWith('\n') ? newBody : '\n' + newBody}`

  fs.writeFileSync(file.absolute, newContent, 'utf-8')

  const row = parseContactFile(vaultRoot, file.absolute)
  if (!row) throw new Error('Patched file failed to parse — rolling back is your job')
  upsertRow(db, row)

  return rowToSummary({ ...row, updated_at: new Date().toISOString() } as ContactRowFromDb)
}

function upsertRow(db: Database.Database, r: ContactRow): void {
  db.prepare(`
    INSERT OR REPLACE INTO contacts_index (
      vault_path, name, email, phone, company, role, tags,
      follow_up_days, last_interaction, next_touchpoint, confidence, workspace, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    r.vault_path, r.name, r.email, r.phone, r.company, r.role, r.tags,
    r.follow_up_days, r.last_interaction, r.next_touchpoint, r.confidence, r.workspace
  )
}

// ── Phase 2: LLM extractor ──────────────────────────────────────────────────

export interface ExtractCreate {
  name: string
  workspace: string
  vault_path: string                  // suggested relative path
  frontmatter: Frontmatter            // free-form; will be filtered on apply
  body: string
  confidence: 'low' | 'medium' | 'high'
}

export interface ExtractUpdate {
  vault_path: string
  name: string                        // for display only
  patch: Frontmatter                  // merge into existing frontmatter
  body_append?: string
  confidence: 'low' | 'medium' | 'high'
}

export interface ExtractDiff {
  creates: ExtractCreate[]
  updates: ExtractUpdate[]
  notes?: string
}

interface ContactCatalogEntry {
  vault_path: string
  name: string
  workspace: string | null
  email: string | null
}

function buildContactCatalog(db: Database.Database): ContactCatalogEntry[] {
  return db.prepare(
    'SELECT vault_path, name, workspace, email FROM contacts_index ORDER BY LOWER(name)'
  ).all() as ContactCatalogEntry[]
}

const EXTRACT_SYSTEM = [
  'You are a contact-extraction assistant for a personal CRM. The user pastes free-form text',
  '(call notes, intro emails, meeting recaps) and you return a JSON diff that updates a',
  'markdown-backed vault.',
  '',
  'Output JSON ONLY with this shape:',
  '{',
  '  "creates": [{"name": "...", "workspace": "example|example-project|operator|personal",',
  '               "vault_path": "workspaces/<ws>/contacts/<slug>.md OR personal/contacts/<slug>.md",',
  '               "frontmatter": {"email": "...", "phone": "...", "company": "...", "role": "...",',
  '                              "tags": ["..."], "follow_up_days": 30, "last_interaction": "YYYY-MM-DD",',
  '                              "relationship": "..."},',
  '               "body": "## About\\n...", "confidence": "low|medium|high"}],',
  '  "updates": [{"vault_path": "...", "name": "...",',
  '               "patch": {"email": "...", "tags": ["...merged..."]},',
  '               "body_append": "## YYYY-MM-DD: ...", "confidence": "..."}],',
  '  "notes": "freeform comment for the operator"',
  '}',
  '',
  'Rules:',
  '- If the extracted person matches a known contact by name or email, emit an UPDATE — never a duplicate create.',
  '- Vault paths for new contacts must be slug-cased and end in .md.',
  '- Workspace heuristic: business contacts mentioned alongside Example/clients → example; example-project → example-project; cross-personal → personal; default operator.',
  '- Set confidence=low when only a name is mentioned, high when email/phone/role are confirmed.',
  '- Never invent emails or phone numbers.',
  '- Return {} for creates/updates if no people are found.',
].join('\n')

export async function extractContactsFromText(
  db: Database.Database,
  text: string
): Promise<ExtractDiff> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set')

  const catalog = buildContactCatalog(db)
  const userPrompt = [
    'Known contacts (use vault_path to reference for updates):',
    JSON.stringify(catalog, null, 2),
    '',
    'New text to extract:',
    '---',
    text.trim(),
    '---',
    '',
    'Return the JSON diff now.',
  ].join('\n')

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4000,
      temperature: 0,
      system: EXTRACT_SYSTEM,
      messages: [{ role: 'user', content: userPrompt }],
    }),
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 300)}`)
  }

  const data = await res.json() as { content?: Array<{ type: string; text?: string }> }
  const content = data.content?.find(b => b.type === 'text')?.text?.trim() || ''
  const cleaned = content.replace(/^```json?\s*\n?/, '').replace(/\n?```$/, '').trim()
  let parsed: ExtractDiff
  try {
    parsed = JSON.parse(cleaned) as ExtractDiff
  } catch (err) {
    throw new Error(`LLM returned non-JSON: ${cleaned.slice(0, 300)}`)
  }
  return {
    creates: Array.isArray(parsed.creates) ? parsed.creates : [],
    updates: Array.isArray(parsed.updates) ? parsed.updates : [],
    notes: typeof parsed.notes === 'string' ? parsed.notes : undefined,
  }
}

export interface ApplyResult {
  created: Array<{ vault_path: string }>
  updated: Array<{ vault_path: string }>
  errors: Array<{ vault_path: string; error: string }>
}

// Applies a (possibly operator-edited) diff. Each entry is independent —
// failures don't roll back successful neighbors, so the operator can retry.
export function applyExtractDiff(
  db: Database.Database,
  vaultRoot: string,
  diff: ExtractDiff
): ApplyResult {
  const result: ApplyResult = { created: [], updated: [], errors: [] }

  for (const c of diff.creates || []) {
    try {
      const fm = c.frontmatter || {}
      const tags = Array.isArray(fm.tags) ? (fm.tags as string[]) : undefined
      const created = createContact(db, vaultRoot, {
        name: c.name,
        workspace: c.workspace,
        email: typeof fm.email === 'string' ? fm.email : null,
        phone: typeof fm.phone === 'string' ? fm.phone : null,
        company: typeof fm.company === 'string' ? fm.company : null,
        role: typeof fm.role === 'string' ? fm.role : null,
        tags,
        follow_up_days: typeof fm.follow_up_days === 'number' ? fm.follow_up_days : null,
        last_interaction: typeof fm.last_interaction === 'string' ? fm.last_interaction : null,
        confidence: c.confidence || 'low',
        body: c.body,
        extra: Object.fromEntries(
          Object.entries(fm).filter(([k]) => !['email', 'phone', 'company', 'role', 'tags', 'follow_up_days', 'last_interaction'].includes(k))
        ),
      })
      result.created.push({ vault_path: created.vault_path })
    } catch (err) {
      result.errors.push({
        vault_path: c.vault_path || c.name,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  for (const u of diff.updates || []) {
    try {
      const patch: ContactPatch = {}
      const p = u.patch || {}
      if ('email' in p) patch.email = typeof p.email === 'string' ? p.email : null
      if ('phone' in p) patch.phone = typeof p.phone === 'string' ? p.phone : null
      if ('company' in p) patch.company = typeof p.company === 'string' ? p.company : null
      if ('role' in p) patch.role = typeof p.role === 'string' ? p.role : null
      if ('tags' in p) patch.tags = Array.isArray(p.tags) ? (p.tags as string[]) : []
      if ('follow_up_days' in p) patch.follow_up_days = typeof p.follow_up_days === 'number' ? p.follow_up_days : null
      if ('last_interaction' in p) patch.last_interaction = typeof p.last_interaction === 'string' ? p.last_interaction : null
      if (u.body_append) patch.body_append = u.body_append
      patchContact(db, vaultRoot, u.vault_path, patch)
      result.updated.push({ vault_path: u.vault_path })
    } catch (err) {
      result.errors.push({
        vault_path: u.vault_path,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return result
}

// ── Backfill seeds: Gmail ───────────────────────────────────────────────────

export function seedLastInteractionFromGmail(
  db: Database.Database,
  opts: { sinceDays: number; dryRun?: boolean }
): SeedResult {
  const dryRun = opts.dryRun ?? false
  const cutoff = new Date(Date.now() - opts.sinceDays * 24 * 60 * 60 * 1000).toISOString()

  const events = db.prepare(
    `SELECT from_address, classified_at FROM gmail_triage
     WHERE label = 'live' AND classified_at >= ?`
  ).all(cutoff) as Array<{ from_address: string | null; classified_at: string }>

  const contacts = db.prepare(
    'SELECT vault_path, email, last_interaction FROM contacts_index WHERE email IS NOT NULL'
  ).all() as Array<{ vault_path: string; email: string; last_interaction: string | null }>

  const byEmail = new Map<string, typeof contacts[number]>()
  for (const c of contacts) byEmail.set(c.email.toLowerCase().trim(), c)

  const latest = new Map<string, string>()
  let totalMatches = 0

  for (const ev of events) {
    if (!ev.from_address) continue
    const email = extractEmail(ev.from_address)
    if (!email) continue
    const match = byEmail.get(email)
    if (!match) continue
    totalMatches++
    const date = ev.classified_at.slice(0, 10)
    const prev = latest.get(match.vault_path)
    if (!prev || date > prev) latest.set(match.vault_path, date)
  }

  let bumped = 0
  if (!dryRun && latest.size > 0) {
    const update = db.prepare(
      `UPDATE contacts_index
         SET last_interaction = ?,
             next_touchpoint = CASE
               WHEN follow_up_days IS NOT NULL
               THEN date(?, '+' || follow_up_days || ' days')
               ELSE next_touchpoint
             END,
             updated_at = datetime('now')
       WHERE vault_path = ?
         AND (last_interaction IS NULL OR last_interaction < ?)`
    )
    const tx = db.transaction(() => {
      for (const [vaultPath, date] of latest) {
        const res = update.run(date, date, vaultPath, date)
        if (res.changes > 0) bumped++
      }
    })
    tx()
  } else if (dryRun) {
    const cur = new Map(contacts.map(c => [c.vault_path, c.last_interaction]))
    for (const [vaultPath, date] of latest) {
      const prev = cur.get(vaultPath)
      if (!prev || date > prev) bumped++
    }
  }

  return { matches: totalMatches, bumped, dry_run: dryRun }
}
