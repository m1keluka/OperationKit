/**
 * Agent templates: install, import, export and the local gallery (obj 719986).
 *
 * The agent FILE is the source of truth: `<agent files dir>/<slug>/agent.yaml`
 * (`AGENT_FILES_DIR`, default `<AI_WORKSPACE_DIR>/agents`). Installing writes
 * that file and upserts two things the rest of the app already reads:
 *   - the `agents` registry row (label, monogram, colour) — board pickers;
 *   - one `routines` row per schedule, created SWITCHED OFF so nothing runs
 *     until a person turns it on.
 * Metadata the registry has no column for (version/author/description/origin)
 * lives in the small `agent_files` table, keyed by slug.
 *
 * Templates are agent files that are not installed yet. Two places are read,
 * first hit per slug wins:
 *   1. `AGENT_TEMPLATES_DIR` / `<AI_WORKSPACE_DIR>/agent-templates` — local
 *      templates an operator (or, later, a marketplace) drops in;
 *   2. `app/server/src/agent-templates` — the starter templates shipped here.
 * See docs/agents/marketplace.md for how a shared marketplace plugs in.
 *
 * Sandboxing: everything here runs in the server process. Worker sessions
 * (SESSION_ISOLATION=docker) never read these files; the persona text reaches
 * them inlined in the prompt (prompt-builder-workdir.ts → readAgentInstructions).
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import type Database from 'better-sqlite3'
import { getDb } from '../db/index.js'
import { AI_WORKSPACE_DIR, AGENTS_DIR } from '../config.js'
import {
  AGENT_COLOUR_TOKENS,
  AGENT_SLUG_RE,
  parseAgentFile,
  serializeAgentYaml,
  type AgentFileDef,
  type AgentFileProblem,
} from './agent-file.js'
import { createAgent, getAgent, updateAgent } from './agent-registry.js'
import { listWorkspaces } from './workspaces.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

export type AgentOrigin = 'template' | 'import' | 'export'

export interface TemplateSummary {
  slug: string
  name: string
  description: string
  avatar: string | null
  colour: string | null
  version: string
  author: string
  tools: string[]
  knowledge_folders: string[]
  schedules: number
  /** 'starter' = shipped with the app; 'local' = dropped into the local templates dir. */
  source: 'starter' | 'local'
  installed: boolean
  installed_version: string | null
  update_available: boolean
}

export interface InstalledAgentSummary {
  slug: string
  name: string
  description: string
  version: string | null
  author: string | null
  /** How it got here. null = an agent created before agent files existed. */
  origin: AgentOrigin | null
  template_slug: string | null
  has_file: boolean
  archived: boolean
  installed_at: string | null
  updated_at: string | null
}

export class AgentInstallError extends Error {
  constructor(
    public status: number,
    message: string,
    public errors: AgentFileProblem[] = [],
    public warnings: AgentFileProblem[] = [],
  ) {
    super(message)
  }
}

// ── Locations ───────────────────────────────────────────────────────────────

export function agentFilesDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENT_FILES_DIR || AGENTS_DIR
}

export function localTemplatesDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENT_TEMPLATES_DIR || path.join(AI_WORKSPACE_DIR, 'agent-templates')
}

export function starterTemplatesDir(): string {
  return path.resolve(HERE, '../agent-templates')
}

/** Folders an import-by-path may read from. Anything else is refused, so the
 *  UI's "import from server path" can never read arbitrary server files. */
export function importRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    agentFilesDir(env),
    localTemplatesDir(env),
    starterTemplatesDir(),
    env.AGENT_IMPORTS_DIR || path.join(AI_WORKSPACE_DIR, 'agent-imports'),
  ].map(d => path.resolve(d))
}

function findAgentFileIn(dir: string): string | null {
  for (const name of ['agent.yaml', 'agent.yml', 'agent.md']) {
    const p = path.join(dir, name)
    if (fs.existsSync(p)) return p
  }
  return null
}

/** Path of an installed agent's file, or null. */
export function installedAgentFilePath(slug: string): string | null {
  if (!AGENT_SLUG_RE.test(slug)) return null
  return findAgentFileIn(path.join(agentFilesDir(), slug))
}

/** Read + validate an installed agent's file. Returns null when absent/invalid. */
export function loadInstalledAgentFile(slug: string): AgentFileDef | null {
  const p = installedAgentFilePath(slug)
  if (!p) return null
  try {
    const r = parseAgentFile(fs.readFileSync(p, 'utf-8'), { filename: p })
    return r.ok ? r.agent : null
  } catch {
    return null
  }
}

// ── Metadata table ──────────────────────────────────────────────────────────

export function initAgentFilesSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_files (
      slug TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      version TEXT NOT NULL,
      author TEXT NOT NULL,
      origin TEXT NOT NULL CHECK(origin IN ('template', 'import', 'export')),
      template_slug TEXT,
      file_path TEXT NOT NULL,
      installed_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
}

let schemaReady = false
function db(): Database.Database {
  const d = getDb()
  if (!schemaReady) {
    initAgentFilesSchema(d)
    schemaReady = true
  }
  return d
}

interface AgentFileRow {
  slug: string
  name: string
  description: string
  version: string
  author: string
  origin: AgentOrigin
  template_slug: string | null
  file_path: string
  installed_at: string
  updated_at: string
}

function getAgentFileRow(slug: string): AgentFileRow | undefined {
  return db().prepare('SELECT * FROM agent_files WHERE slug = ?').get(slug) as AgentFileRow | undefined
}

// ── Templates ───────────────────────────────────────────────────────────────

interface TemplateEntry {
  def: AgentFileDef
  path: string
  source: 'starter' | 'local'
}

function scanTemplates(): { entries: TemplateEntry[]; problems: Array<{ path: string; errors: AgentFileProblem[] }> } {
  const seen = new Set<string>()
  const entries: TemplateEntry[] = []
  const problems: Array<{ path: string; errors: AgentFileProblem[] }> = []
  const dirs: Array<[string, 'starter' | 'local']> = [
    [localTemplatesDir(), 'local'],
    [starterTemplatesDir(), 'starter'],
  ]
  for (const [dir, source] of dirs) {
    let names: string[] = []
    try {
      names = fs.readdirSync(dir).sort()
    } catch {
      continue
    }
    for (const n of names) {
      if (seen.has(n) || !AGENT_SLUG_RE.test(n)) continue
      const p = findAgentFileIn(path.join(dir, n))
      if (!p) continue
      const r = parseAgentFile(fs.readFileSync(p, 'utf-8'), { filename: p })
      if (!r.ok) {
        problems.push({ path: p, errors: r.errors })
        continue
      }
      seen.add(n)
      entries.push({ def: r.agent, path: p, source })
    }
  }
  return { entries, problems }
}

export function getTemplate(slug: string): TemplateEntry | undefined {
  return scanTemplates().entries.find(e => e.def.slug === slug)
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(/[-+]/)[0].split('.').map(Number)
  const pb = b.split(/[-+]/)[0].split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d) return d
  }
  return 0
}

export function listTemplates(): { templates: TemplateSummary[]; problems: Array<{ path: string; errors: AgentFileProblem[] }> } {
  const { entries, problems } = scanTemplates()
  const templates = entries.map(({ def, source }) => {
    const row = getAgentFileRow(def.slug)
    const reg = getAgent(def.slug)
    const installed = !!row && !!reg && !reg.archived
    return {
      slug: def.slug,
      name: def.name,
      description: def.description,
      avatar: def.avatar,
      colour: def.colour,
      version: def.version,
      author: def.author,
      tools: def.tools,
      knowledge_folders: def.knowledge_folders,
      schedules: def.schedules.length,
      source,
      installed,
      installed_version: installed ? row!.version : null,
      update_available: installed && compareVersions(def.version, row!.version) > 0,
    }
  })
  return { templates, problems }
}

export function listInstalledAgents(): InstalledAgentSummary[] {
  const rows = db().prepare('SELECT * FROM agent_files').all() as AgentFileRow[]
  const bySlug = new Map(rows.map(r => [r.slug, r]))
  // Every registry agent is exportable, so list them all; file-backed ones
  // carry version/author.
  const regRows = getDb()
    .prepare('SELECT slug, label, archived FROM agents ORDER BY sort_order, slug')
    .all() as Array<{ slug: string; label: string; archived: number }>
  return regRows.map(r => {
    const f = bySlug.get(r.slug)
    return {
      slug: r.slug,
      name: f?.name ?? r.label,
      description: f?.description ?? '',
      version: f?.version ?? null,
      author: f?.author ?? null,
      origin: f?.origin ?? null,
      template_slug: f?.template_slug ?? null,
      has_file: !!installedAgentFilePath(r.slug),
      archived: r.archived === 1,
      installed_at: f?.installed_at ?? null,
      updated_at: f?.updated_at ?? null,
    }
  })
}

// ── Install / import ────────────────────────────────────────────────────────

export interface InstallOptions {
  /** Replace an existing agent with the same slug. Default false → 409. */
  overwrite?: boolean
  origin?: AgentOrigin
  templateSlug?: string | null
  /** Workspace that schedule-created routines file their cards into. */
  workspace?: string | null
}

export interface InstallResult {
  slug: string
  action: 'created' | 'updated'
  file_path: string
  routines: string[]
  warnings: AgentFileProblem[]
}

function monogram(def: AgentFileDef): string {
  const a = def.avatar?.trim()
  if (a) return a
  const parts = def.slug.split('-').filter(Boolean)
  return (parts.length >= 2 ? parts[0][0] + parts[1][0] : def.slug.slice(0, 2)).toUpperCase()
}

function defaultWorkspace(requested?: string | null): string | null {
  const all = listWorkspaces()
  if (requested && all.some(w => w.slug === requested)) return requested
  return all[0]?.slug ?? null
}

function routineName(slug: string, scheduleName: string): string {
  return `agent:${slug}:${scheduleName}`
}

function syncSchedules(def: AgentFileDef, workspace: string | null): string[] {
  const d = getDb()
  const names: string[] = []
  const upsert = d.prepare(
    `INSERT INTO routines (name, cron_expr, objective_template, enabled)
     VALUES (?, ?, ?, 0)
     ON CONFLICT(name) DO UPDATE SET cron_expr = excluded.cron_expr,
       objective_template = excluded.objective_template`,
  )
  for (const s of def.schedules) {
    const name = routineName(def.slug, s.name)
    const tpl: Record<string, unknown> = {
      title: `${def.name}: ${s.name}`,
      description: s.prompt,
      agent_context: def.slug,
      type: 'task',
    }
    if (workspace) tpl.workspace = workspace
    upsert.run(name, s.cron, JSON.stringify(tpl))
    names.push(name)
  }
  // A schedule removed from the file must stop firing: switch it off (never
  // delete — its run history stays).
  const prefix = `agent:${def.slug}:`
  const existing = d.prepare("SELECT name FROM routines WHERE substr(name, 1, ?) = ?").all(prefix.length, prefix) as Array<{ name: string }>
  for (const r of existing) {
    if (!names.includes(r.name)) d.prepare('UPDATE routines SET enabled = 0 WHERE name = ?').run(r.name)
  }
  return names
}

/** Validate + write + register. The single path every entry point goes through. */
export function installAgentFromText(text: string, filename: string | undefined, opts: InstallOptions = {}): InstallResult {
  const parsed = parseAgentFile(text, { filename })
  if (!parsed.ok) {
    throw new AgentInstallError(400, 'The agent file has problems — nothing was changed.', parsed.errors, parsed.warnings)
  }
  return installAgentDef(parsed.agent, { ...opts }, parsed.warnings)
}

export function installAgentDef(def: AgentFileDef, opts: InstallOptions = {}, warnings: AgentFileProblem[] = []): InstallResult {
  const existing = getAgent(def.slug)
  const fileRow = getAgentFileRow(def.slug)
  if (existing && !existing.archived && !opts.overwrite) {
    throw new AgentInstallError(
      409,
      `An agent called "${def.slug}" already exists. Replace it (the Replace button, or --overwrite in the script), or change the slug in the file.`,
    )
  }

  const dir = path.join(agentFilesDir(), def.slug)
  fs.mkdirSync(dir, { recursive: true })
  // A .md copy left from an earlier import would shadow nothing (yaml wins), but
  // remove it so there is exactly one file per agent.
  for (const stale of ['agent.yml', 'agent.md']) {
    const p = path.join(dir, stale)
    if (fs.existsSync(p)) fs.rmSync(p)
  }
  const filePath = path.join(dir, 'agent.yaml')
  const tmp = `${filePath}.tmp-${process.pid}`
  fs.writeFileSync(tmp, serializeAgentYaml(def), 'utf-8')
  fs.renameSync(tmp, filePath)

  const colour = AGENT_COLOUR_TOKENS[def.colour ?? 'grey']
  const regFields = {
    label: def.name,
    mono: monogram(def),
    badge_hex: colour.hex,
    badge_tw: colour.tw,
    archived: false,
  }
  if (existing) updateAgent(def.slug, regFields)
  else createAgent({ slug: def.slug, kind: 'executive', workdir_kind: 'workspace', sort_order: 50, ...regFields })

  const origin = opts.origin ?? 'import'
  db().prepare(
    `INSERT INTO agent_files (slug, name, description, version, author, origin, template_slug, file_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(slug) DO UPDATE SET name = excluded.name, description = excluded.description,
       version = excluded.version, author = excluded.author, origin = excluded.origin,
       template_slug = excluded.template_slug, file_path = excluded.file_path,
       updated_at = datetime('now')`,
  ).run(def.slug, def.name, def.description, def.version, def.author, origin, opts.templateSlug ?? null, filePath)

  const routines = syncSchedules(def, defaultWorkspace(opts.workspace))
  return { slug: def.slug, action: existing || fileRow ? 'updated' : 'created', file_path: filePath, routines, warnings }
}

export function installTemplate(slug: string, opts: Omit<InstallOptions, 'origin' | 'templateSlug'> = {}): InstallResult {
  const t = getTemplate(slug)
  if (!t) throw new AgentInstallError(404, `No template called "${slug}".`)
  return installAgentDef(t.def, { ...opts, origin: 'template', templateSlug: slug })
}

/** Import from a path on the server, restricted to importRoots(). */
export function importAgentFromPath(p: string, opts: InstallOptions = {}): InstallResult {
  if (typeof p !== 'string' || !p.trim()) throw new AgentInstallError(400, 'path is required')
  let resolved = path.resolve(p.trim())
  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
    const f = findAgentFileIn(resolved)
    if (!f) throw new AgentInstallError(404, `No agent.yaml or agent.md in ${p}`)
    resolved = f
  }
  let real: string
  try {
    real = fs.realpathSync(resolved)
  } catch {
    throw new AgentInstallError(404, `File not found: ${p}`)
  }
  const roots = importRoots().map(r => {
    try { return fs.realpathSync(r) } catch { return r }
  })
  if (!roots.some(r => real === r || real.startsWith(r + path.sep))) {
    throw new AgentInstallError(
      403,
      `For safety, files can only be imported from these folders: ${roots.join(', ')}. Copy the file there, or upload it instead.`,
    )
  }
  if (!/\.(ya?ml|md)$/i.test(real)) throw new AgentInstallError(400, 'Agent files end in .yaml, .yml or .md')
  return installAgentFromText(fs.readFileSync(real, 'utf-8'), real, opts)
}

// ── Export ──────────────────────────────────────────────────────────────────

/**
 * The agent as a shareable file. File-backed agents export their file
 * (re-serialized, so it is canonical). Older registry-only agents are converted:
 * their persona Markdown becomes `system_prompt`.
 */
export function exportAgent(slug: string): { filename: string; content: string; def: AgentFileDef } {
  const reg = getAgent(slug)
  const fromFile = loadInstalledAgentFile(slug)
  if (fromFile) return { filename: `${slug}.agent.yaml`, content: serializeAgentYaml(fromFile), def: fromFile }
  if (!reg) throw new AgentInstallError(404, `No agent called "${slug}".`)

  let prompt = ''
  const promptFile = path.join(AGENTS_DIR, `${reg.prompt_file || slug}.md`)
  try {
    prompt = fs.readFileSync(promptFile, 'utf-8').trim()
  } catch {
    /* no persona file on this install */
  }
  // Strip a legacy YAML front-matter block from the persona file — it is the
  // old skills/profile header, not instructions.
  if (prompt.startsWith('---\n')) {
    const end = prompt.indexOf('\n---', 4)
    if (end !== -1) prompt = prompt.slice(prompt.indexOf('\n', end + 4) + 1).trim()
  }
  if (!prompt) prompt = `You are the ${reg.label} agent.`
  const colour = (Object.entries(AGENT_COLOUR_TOKENS).find(([, v]) => v.tw === reg.badge_tw)?.[0] ?? null) as AgentFileDef['colour']
  const def: AgentFileDef = {
    name: reg.label,
    slug,
    description: '',
    avatar: reg.mono && [...reg.mono].length <= 2 ? reg.mono : null,
    colour,
    system_prompt: prompt,
    knowledge_folders: [],
    tools: [],
    model: null,
    provider: null,
    schedules: [],
    version: '1.0.0',
    author: 'unknown',
  }
  // Re-validate so an export can never produce a file our own importer rejects
  // (e.g. a persona that embeds a credential).
  const check = parseAgentFile(serializeAgentYaml(def), { filename: `${slug}/agent.yaml` })
  if (!check.ok) {
    throw new AgentInstallError(422, `"${slug}" cannot be exported as-is.`, check.errors)
  }
  return { filename: `${slug}.agent.yaml`, content: serializeAgentYaml(check.agent), def: check.agent }
}

// ── Installer switch ────────────────────────────────────────────────────────

/**
 * `STARTER_AGENT_TEMPLATES` — installer switch. Comma-separated template slugs,
 * or `all` for every shipped starter. Installs each one that is not already
 * present; never overwrites an existing agent, so it is safe on every boot.
 */
export function installStarterTemplatesFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = (env.STARTER_AGENT_TEMPLATES || '').trim()
  if (!raw || raw === '0' || raw.toLowerCase() === 'none') return []
  const { templates } = listTemplates()
  const wanted = raw.toLowerCase() === 'all'
    ? templates.filter(t => t.source === 'starter').map(t => t.slug)
    : raw.split(',').map(s => s.trim()).filter(Boolean)
  const done: string[] = []
  for (const slug of wanted) {
    if (getAgent(slug) && !getAgent(slug)!.archived) continue
    try {
      installTemplate(slug)
      done.push(slug)
    } catch (err) {
      console.warn(`[agent-templates] starter "${slug}" not installed: ${(err as Error).message}`)
    }
  }
  if (done.length) console.log(`[agent-templates] installed starter templates: ${done.join(', ')}`)
  return done
}
