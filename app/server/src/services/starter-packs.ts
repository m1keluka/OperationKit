import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { getDb } from '../db/index.js'
import { AGENTS_DIR } from '../config.js'
import { createAgent, getAgent, updateAgent } from './agent-registry.js'
import type { AgentKind } from '@operationkit/shared'
import { getWorkspace, invalidateWorkspacesCache, updateWorkspace } from './workspaces.js'
import { getInternalApiSecret } from '../middleware/internal-secret.js'

/**
 * Starter packs (obj 719936, shared with 719937 / installer 719935).
 *
 * A starter pack is a folder of DATA, not code: a `pack.json` manifest, the
 * agent persona files it brings, optional sample files and a plain-language
 * README/DEMO. Pack-specific behaviour lives in ordinary routes; the manifest
 * names a `setup.path` the loader calls after registering agents/routines.
 *
 *   <packs dir>/<id>/pack.json
 *   <packs dir>/<id>/agents/<slug>.md
 *   <packs dir>/<id>/sample-data/…
 *   <packs dir>/<id>/README.md, DEMO.md
 *
 * Packs dirs searched (first hit per id wins): $STARTER_PACKS_DIR,
 * app/server/src/starter-packs (bind-mounted on live installs), app/starter-packs
 * (present in the image via the Dockerfile's `COPY . .`).
 *
 * On/off state: settings key `starter_pack:<id>` = '1' | '0'.
 * Entry points: scripts/starter-pack.sh → /api/internal/starter-packs (localhost
 * + X-Internal-Secret), and the admin routes under /api/starter-packs.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))

export interface PackAgent {
  slug: string
  label?: string
  prompt_file?: string
  kind?: AgentKind
  mono?: string | null
  badge_tw?: string | null
}

export interface PackRoutine {
  name: string
  cron_expr: string
  objective_template: Record<string, unknown>
}

export interface PackManifest {
  id: string
  name: string
  description?: string
  version?: string
  agents?: PackAgent[]
  routines?: PackRoutine[]
  settings?: Record<string, string>
  setup?: { path: string; disable_path?: string }
  sample_data?: string
  demo?: string
}

export interface StarterPack {
  manifest: PackManifest
  dir: string
}

export interface PackStatus {
  id: string
  name: string
  description: string
  version: string | null
  enabled: boolean
  dir: string
  agents: string[]
  routines: string[]
  has_sample_data: boolean
  demo: string | null
}

const ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/

export function packsDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const dirs = [
    env.STARTER_PACKS_DIR,
    path.resolve(HERE, '../starter-packs'),
    path.resolve(HERE, '../../../starter-packs'),
  ].filter((d): d is string => !!d)
  return [...new Set(dirs)]
}

export function settingKey(id: string): string {
  return `starter_pack:${id}`
}

/** Validate a parsed manifest. Returns a list of problems (empty = valid). */
export function validateManifest(m: unknown, folderName?: string): string[] {
  const errs: string[] = []
  if (!m || typeof m !== 'object') return ['pack.json must be a JSON object']
  const o = m as Record<string, unknown>
  const id = (o.id ?? o.slug) as unknown
  if (typeof id !== 'string' || !ID_RE.test(id)) errs.push('id must be a lowercase slug (a-z, 0-9, -)')
  else if (folderName && id !== folderName) errs.push(`id "${id}" must match its folder name "${folderName}"`)
  if (typeof o.name !== 'string' || !o.name.trim()) errs.push('name is required')
  if (o.agents !== undefined) {
    if (!Array.isArray(o.agents)) errs.push('agents must be an array')
    else o.agents.forEach((a, i) => {
      if (!a || typeof a.slug !== 'string' || !ID_RE.test(a.slug)) errs.push(`agents[${i}].slug must be a lowercase slug`)
      if (a?.prompt_file !== undefined && (typeof a.prompt_file !== 'string' || a.prompt_file.includes('..') || path.isAbsolute(a.prompt_file))) {
        errs.push(`agents[${i}].prompt_file must be a relative path inside the pack`)
      }
    })
  }
  if (o.routines !== undefined) {
    if (!Array.isArray(o.routines)) errs.push('routines must be an array')
    else o.routines.forEach((r, i) => {
      if (!r || typeof r.name !== 'string' || !r.name.trim()) errs.push(`routines[${i}].name is required`)
      if (typeof r?.cron_expr !== 'string' || r.cron_expr.trim().split(/\s+/).length !== 5) errs.push(`routines[${i}].cron_expr must be a 5-field cron`)
      if (!r?.objective_template || typeof r.objective_template !== 'object') errs.push(`routines[${i}].objective_template must be an object`)
    })
  }
  if (o.setup !== undefined) {
    const s = o.setup as Record<string, unknown>
    for (const k of ['path', 'disable_path'] as const) {
      if (s?.[k] === undefined && k === 'disable_path') continue
      if (typeof s?.[k] !== 'string' || !(s[k] as string).startsWith('/api/internal/')) errs.push(`setup.${k} must start with /api/internal/`)
    }
  }
  if (o.settings !== undefined && (typeof o.settings !== 'object' || Array.isArray(o.settings))) errs.push('settings must be an object')
  return errs
}

export function listPacks(env: NodeJS.ProcessEnv = process.env): StarterPack[] {
  const found = new Map<string, StarterPack>()
  for (const root of packsDirs(env)) {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (!e.isDirectory() || found.has(e.name)) continue
      const dir = path.join(root, e.name)
      const file = path.join(dir, 'pack.json')
      if (!fs.existsSync(file)) continue
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
        const errs = validateManifest(raw, e.name)
        if (errs.length) { console.warn(`[starter-packs] skipping ${file}: ${errs.join('; ')}`); continue }
        raw.id = raw.id ?? raw.slug
        found.set(e.name, { manifest: raw as PackManifest, dir })
      } catch (err) {
        console.warn(`[starter-packs] skipping ${file}: ${(err as Error).message}`)
      }
    }
  }
  return [...found.values()].sort((a, b) => a.manifest.id.localeCompare(b.manifest.id))
}

export function getPack(id: string, env: NodeJS.ProcessEnv = process.env): StarterPack | undefined {
  return listPacks(env).find(p => p.manifest.id === id)
}

export function isPackEnabled(id: string): boolean {
  try {
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(settingKey(id)) as { value: string } | undefined
    return row?.value === '1'
  } catch {
    return false
  }
}

function setSetting(key: string, value: string): void {
  getDb().prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}

export function packStatus(p: StarterPack): PackStatus {
  const m = p.manifest
  const sample = m.sample_data ? path.join(p.dir, m.sample_data) : null
  return {
    id: m.id,
    name: m.name,
    description: m.description ?? '',
    version: m.version ?? null,
    enabled: isPackEnabled(m.id),
    dir: p.dir,
    agents: (m.agents ?? []).map(a => a.slug),
    routines: (m.routines ?? []).map(r => r.name),
    has_sample_data: !!sample && fs.existsSync(sample),
    demo: m.demo ?? null,
  }
}

export interface EnableOptions {
  workspace: string
  withSamples?: boolean
  dryRun?: boolean
  /** Base URL for the setup call; defaults to this server on loopback. */
  baseUrl?: string
  fetchImpl?: typeof fetch
  agentsDir?: string
}

export interface EnableResult {
  id: string
  workspace: string
  dry_run: boolean
  steps: string[]
}

export class PackError extends Error {
  constructor(message: string, readonly status = 400) { super(message) }
}

async function callSetup(p: StarterPack, which: 'path' | 'disable_path', opts: EnableOptions, steps: string[]): Promise<void> {
  const target = p.manifest.setup?.[which]
  if (!target) return
  if (opts.dryRun) { steps.push(`would POST ${target}`); return }
  const base = opts.baseUrl ?? `http://127.0.0.1:${process.env.PORT || 3002}`
  const res = await (opts.fetchImpl ?? fetch)(`${base}${target}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': getInternalApiSecret() },
    body: JSON.stringify({ workspace: opts.workspace, with_samples: opts.withSamples !== false }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new PackError(`setup ${target} failed: HTTP ${res.status} ${body.slice(0, 300)}`, 502)
  }
  steps.push(`setup ${target}: ok`)
}

/**
 * Switch a pack on for one workspace. Idempotent: every step is an upsert,
 * so re-running (or running after a partial failure) converges.
 */
export async function enablePack(id: string, opts: EnableOptions): Promise<EnableResult> {
  const p = getPack(id)
  if (!p) throw new PackError(`no starter pack named "${id}"`, 404)
  // The workspace may have been written by another process (install-bootstrap.ts
  // runs from a separate `docker exec`), so a cache miss re-reads the table once
  // before giving up (obj 720210).
  let ws = getWorkspace(opts.workspace)
  if (!ws) { invalidateWorkspacesCache(); ws = getWorkspace(opts.workspace) }
  if (!ws) throw new PackError(`no workspace named "${opts.workspace}"`, 404)
  const m = p.manifest
  const steps: string[] = []
  const dry = !!opts.dryRun
  const agentsDir = opts.agentsDir ?? AGENTS_DIR

  // 1. Agents: persona file into the agents dir (never overwrite a customised
  //    copy), then the registry row, then the workspace's agent pool.
  const pool = new Set(ws.default_agent_pool)
  for (const a of m.agents ?? []) {
    const promptRel = a.prompt_file ?? `agents/${a.slug}.md`
    const src = path.join(p.dir, promptRel)
    const dest = path.join(agentsDir, `${a.slug}.md`)
    if (!fs.existsSync(src)) throw new PackError(`pack ${id}: agent file missing: ${promptRel}`, 500)
    if (!fs.existsSync(dest)) {
      if (!dry) { fs.mkdirSync(agentsDir, { recursive: true }); fs.copyFileSync(src, dest) }
      steps.push(`${dry ? 'would copy' : 'copied'} agent persona ${a.slug}.md`)
    } else steps.push(`agent persona ${a.slug}.md already present (kept)`)

    const fields = {
      label: a.label ?? a.slug,
      prompt_file: `${a.slug}.md`,
      kind: a.kind ?? 'executive',
      mono: a.mono ?? null,
      badge_tw: a.badge_tw ?? null,
    } as const
    if (!dry) {
      if (getAgent(a.slug)) updateAgent(a.slug, { ...fields, archived: false })
      else createAgent({ slug: a.slug, ...fields })
    }
    steps.push(`${dry ? 'would register' : 'registered'} agent ${a.slug}`)
    pool.add(a.slug)
  }
  if ((m.agents ?? []).length && !dry) updateWorkspace(opts.workspace, { default_agent_pool: [...pool] })

  // 2. Routines: upsert by name, pinned to this workspace, switched on.
  for (const r of m.routines ?? []) {
    const template = JSON.stringify({ ...r.objective_template, workspace: opts.workspace })
    if (!dry) {
      getDb().prepare(
        `INSERT INTO routines (name, cron_expr, objective_template, enabled) VALUES (?, ?, ?, 1)
         ON CONFLICT(name) DO UPDATE SET cron_expr = excluded.cron_expr,
           objective_template = excluded.objective_template, enabled = 1`,
      ).run(r.name, r.cron_expr, template)
    }
    steps.push(`${dry ? 'would schedule' : 'scheduled'} routine "${r.name}" (${r.cron_expr})`)
  }
  if ((m.routines ?? []).length && !dry) setSetting('routines_enabled', '1')

  // 3. Pack settings.
  for (const [k, v] of Object.entries(m.settings ?? {})) {
    if (!dry) setSetting(k, String(v))
    steps.push(`${dry ? 'would set' : 'set'} setting ${k}`)
  }

  // 4. Mark enabled BEFORE setup so a setup route can check the flag; roll
  //    back on setup failure so a half-enabled pack never shows as on.
  if (!dry) setSetting(settingKey(id), '1')
  try {
    await callSetup(p, 'path', opts, steps)
  } catch (err) {
    if (!dry) setSetting(settingKey(id), '0')
    throw err
  }
  steps.push(`${dry ? 'would switch' : 'switched'} pack ${id} on`)
  return { id, workspace: opts.workspace, dry_run: dry, steps }
}

/** Switch a pack off. Agents, notes and data are kept; routines stop firing. */
export async function disablePack(id: string, opts: EnableOptions): Promise<EnableResult> {
  const p = getPack(id)
  if (!p) throw new PackError(`no starter pack named "${id}"`, 404)
  const steps: string[] = []
  const dry = !!opts.dryRun
  for (const r of p.manifest.routines ?? []) {
    if (!dry) getDb().prepare('UPDATE routines SET enabled = 0 WHERE name = ?').run(r.name)
    steps.push(`${dry ? 'would pause' : 'paused'} routine "${r.name}"`)
  }
  await callSetup(p, 'disable_path', opts, steps)
  if (!dry) setSetting(settingKey(id), '0')
  steps.push(`${dry ? 'would switch' : 'switched'} pack ${id} off (agents and data kept)`)
  return { id, workspace: opts.workspace, dry_run: dry, steps }
}
